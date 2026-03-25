const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { BlobServiceClient } = require('@azure/storage-blob');
const { CallAutomationClient } = require('@azure/communication-call-automation');

const EMPLOYEE_CSV_PATH = path.join(__dirname, 'data', 'employees.csv');
const FAQ_CSV_PATH = path.join(__dirname, 'data', 'faq.csv');
const MESSAGE_CONTAINER = 'call-messages';
const RECORDING_CONTAINER = 'call-recordings';
const SUMMARY_CONTAINER = 'openai-results';
const TRANSFER_TIMEOUT_MS = 20000;
const RETRY_PROMPT_LIMIT = 2;
const PROCESSED_ASYNC_KEY_LIMIT = 500;
const DEFAULT_TRANSCRIPT = '\u55b6\u696d\u90e8 \u4f50\u85e4\u3055\u3093\u306b\u3064\u306a\u3044\u3067\u304f\u3060\u3055\u3044\u3002\u7528\u4ef6\u306f\u898b\u7a4d\u306e\u76f8\u8ac7\u3067\u3059\u3002\u6c0f\u540d\u306f\u7530\u4e2d\u3001\u96fb\u8a71\u756a\u53f7\u306f09012345678\u3067\u3059\u3002';
const GUIDANCE_PROMPT = '\u304a\u4e16\u8a71\u306b\u306a\u3063\u3066\u304a\u308a\u307e\u3059\u3002\u3054\u7528\u4ef6\u3092\u304a\u8a71\u3057\u304f\u3060\u3055\u3044\u3002';
const WAITING_PROMPT = '\u8ee2\u9001\u5148\u3092\u78ba\u8a8d\u3057\u3066\u304a\u308a\u307e\u3059\u3002\u305d\u306e\u307e\u307e\u304a\u5f85\u3061\u304f\u3060\u3055\u3044\u3002';
const ABSENT_PROMPT = '\u62c5\u5f53\u8005\u304c\u5fdc\u7b54\u3067\u304d\u306a\u3044\u305f\u3081\u3001\u4f1d\u8a00\u3092\u304a\u9810\u304b\u308a\u3057\u307e\u3059\u3002\u3054\u7528\u4ef6\u3001\u304a\u540d\u524d\u3001\u304a\u96fb\u8a71\u756a\u53f7\u3092\u304a\u8a71\u3057\u304f\u3060\u3055\u3044\u3002';
const COMPLETION_PROMPT = '\u78ba\u304b\u306b\u627f\u308a\u307e\u3057\u305f\u3002\u62c5\u5f53\u8005\u306b\u5171\u6709\u3044\u305f\u3057\u307e\u3059\u3002';

const state = {
    sessions: new Map(),
    asyncJobs: [],
    logs: [],
    processedAsyncKeys: new Set(),
    processedAsyncKeyOrder: []
};

const createId = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

const logEvent = (type, payload) => {
    const entry = {
        type,
        payload,
        timestamp: new Date().toISOString()
    };
    state.logs.unshift(entry);
    state.logs = state.logs.slice(0, 100);
    console.log(`[poc] ${type}`, payload);
};

const safeJsonParse = (value, fallback) => {
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
};

const decodeUnicodeEscapes = (value) =>
    String(value || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

const parseCsvLine = (line) => {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (inQuotes && line[index + 1] === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (character === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
        } else {
            current += character;
        }
    }

    values.push(current.trim());
    return values;
};

const loadEmployees = () => {
    if (!fs.existsSync(EMPLOYEE_CSV_PATH)) {
        return [];
    }

    const raw = fs.readFileSync(EMPLOYEE_CSV_PATH, 'utf8').trim();
    if (!raw) {
        return [];
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines[0]);

    return lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        const item = {};
        headers.forEach((header, index) => {
            item[header] = decodeUnicodeEscapes(values[index] || '');
        });
        item.enabled = String(item.enabled).toLowerCase() === 'true';
        item.priority = Number(item.priority || '999');
        return item;
    }).filter((item) => item.enabled);
};

const loadFaqs = () => {
    if (!fs.existsSync(FAQ_CSV_PATH)) {
        return [];
    }

    const raw = fs.readFileSync(FAQ_CSV_PATH, 'utf8').trim();
    if (!raw) {
        return [];
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines[0]);

    return lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        const item = {};
        headers.forEach((header, index) => {
            item[header] = decodeUnicodeEscapes(values[index] || '');
        });
        return item;
    }).filter((item) => item.keyword && item.answer);
};

const parseMockEventRequest = (requestBody) => {
    if (Array.isArray(requestBody)) {
        return {
            events: requestBody,
            mockOverrides: {}
        };
    }

    if (Array.isArray(requestBody?.events)) {
        return {
            events: requestBody.events,
            mockOverrides: requestBody.mockOverrides ?? {}
        };
    }

    return {
        events: [requestBody],
        mockOverrides: requestBody?.mockOverrides ?? {}
    };
};

const handleSubscriptionValidation = (requestBody, res) => {
    const { events } = parseMockEventRequest(requestBody);
    const validationEvent = events.find((event) => (event?.eventType || event?.type) === 'Microsoft.EventGrid.SubscriptionValidationEvent');
    if (!validationEvent) {
        return false;
    }

    res.status(200).json({
        validationResponse: validationEvent.data.validationCode
    });
    return true;
};

const createSpeechResult = (overrides = {}) => ({
    recognizedText: overrides.recognizedText || DEFAULT_TRANSCRIPT,
    confidence: overrides.confidence ?? 0.92,
    language: 'ja-JP',
    timestamp: new Date().toISOString()
});

const extractCustomerName = (recognizedText) => {
    const direct = recognizedText.match(/(?:\u304a\u5ba2\u69d8\u306e\u6c0f\u540d\u306f|\u6c0f\u540d\u306f|\u540d\u524d\u306f|\u79c1\u306f)([^ \u3001\u3002,]+)(?:\u3067\u3059|\u3068\u7533\u3057\u307e\u3059)?/u);
    if (direct) {
        return direct[1];
    }

    const fallback = recognizedText.match(/([^ \u3001\u3002,]+)(?:\u3067\u3059|\u3068\u7533\u3057\u307e\u3059)/u);
    return fallback ? fallback[1] : '';
};

const extractPhoneNumber = (recognizedText, fallbackPhone) => {
    if (fallbackPhone) {
        return fallbackPhone;
    }

    const normalized = recognizedText.replace(/[^\d]/g, '');
    return normalized.length >= 10 ? normalized : '';
};

const findEmployee = (recognizedText, employees) => {
    const sortedEmployees = [...employees].sort((left, right) => left.priority - right.priority);
    return sortedEmployees.find((employee) =>
        recognizedText.includes(employee.department) && recognizedText.includes(employee.display_name)
    ) || null;
};

const extractRequirement = (recognizedText, employee) => {
    if (!employee) {
        return recognizedText.trim();
    }

    return recognizedText
        .replace(employee.department, '')
        .replace(employee.display_name, '')
        .trim();
};

const findFaqMatch = (recognizedText, faqs) =>
    faqs.find((faq) => recognizedText.includes(faq.keyword)) || null;

const normalizeEventType = (event) => {
    const raw = event?.eventType || event?.type || '';
    const parts = String(raw).split('.');
    return parts[parts.length - 1];
};

const getStorageClient = (config) => {
    if (!config.storageConnectionString) {
        return null;
    }
    return BlobServiceClient.fromConnectionString(config.storageConnectionString);
};

const ensureContainer = async (blobServiceClient, containerName) => {
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();
    return containerClient;
};

const saveJsonToBlob = async (config, containerName, blobName, content) => {
    const blobServiceClient = getStorageClient(config);
    if (!blobServiceClient) {
        return null;
    }

    const containerClient = await ensureContainer(blobServiceClient, containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const body = JSON.stringify(content, null, 2);
    await blockBlobClient.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: {
            blobContentType: 'application/json'
        }
    });
    return blockBlobClient.url;
};

const postTeamsMessage = async (config, session, messageText) => {
    if (!config.teamsWebhookUrl) {
        return {
            skipped: true,
            reason: 'TEAMS_SUCCESS_WEBHOOK_URL is not configured'
        };
    }

    await axios.post(config.teamsWebhookUrl, { text: messageText }, {
        headers: {
            'Content-Type': 'application/json'
        }
    });

    return {
        skipped: false,
        deliveredAt: new Date().toISOString(),
        sessionId: session.id
    };
};

const buildTeamsMessage = (session) => {
    const lines = [
        '\u4f50\u85e4\u5b9b\u306e\u4f1d\u8a00',
        `\u53d7\u4ed8\u6642\u523b: ${session.updatedAt || session.createdAt}`,
        `\u9867\u5ba2\u540d: ${session.customerName || '\u672a\u53d6\u5f97'}`,
        `\u96fb\u8a71\u756a\u53f7: ${session.customerPhone || '\u672a\u53d6\u5f97'}`,
        `\u7528\u4ef6: ${session.requirement || '\u672a\u53d6\u5f97'}`
    ];

    if (session.aiSummary?.summary) {
        lines.push(`AI summary: ${session.aiSummary.summary}`);
    }

    return lines.join('\n');
};

// 2026-03-23: SDKオブジェクトの循環参照でJSON化に失敗するため、必要最小限の値のみを抽出する形に変更。
// const identifierToPlainObject = (identifier) => safeJsonParse(JSON.stringify(identifier || {}), {});
const identifierToPlainObject = (identifier) => {
    if (!identifier || typeof identifier !== 'object') {
        return {};
    }

    return {
        rawId: identifier.rawId || '',
        kind: identifier.kind || '',
        communicationUserId: identifier.communicationUserId || '',
        microsoftTeamsUserId: identifier.microsoftTeamsUserId || '',
        phoneNumber: identifier.phoneNumber?.value || identifier.phoneNumber || '',
        id: identifier.id || ''
    };
};

// 2026-03-23: answerCallの戻り値を丸ごと保持すると循環参照を含むため、セッション保持用に安全な最小構造へ変換。
const answerResultToPlainObject = (answerResult) => {
    if (!answerResult || typeof answerResult !== 'object') {
        return {};
    }

    const props = answerResult.callConnectionProperties || {};

    return {
        callConnectionId: props.callConnectionId || answerResult.callConnectionId || '',
        serverCallId: props.serverCallId || answerResult.serverCallId || '',
        targets: Array.isArray(props.targets)
            ? props.targets.map((item) => identifierToPlainObject(item))
            : []
    };
};

const getStorageAccountNameFromConnectionString = (connectionString) => {
    const match = String(connectionString || '').match(/AccountName=([^;]+)/i);
    return match ? match[1] : '';
};

const deriveRecordingContainerUrl = (config) => {
    if (config.recordingContainerUrl) {
        return config.recordingContainerUrl;
    }

    const accountName = getStorageAccountNameFromConnectionString(config.storageConnectionString);
    return accountName ? `https://${accountName}.blob.core.windows.net/${RECORDING_CONTAINER}` : '';
};

const toCallAutomationIdentifier = (identifier) => {
    if (!identifier) {
        return null;
    }

    if (identifier.phoneNumber?.value) {
        return { phoneNumber: identifier.phoneNumber.value };
    }

    if (identifier.communicationUserId) {
        return { communicationUserId: identifier.communicationUserId };
    }

    if (identifier.microsoftTeamsUserId) {
        return {
            microsoftTeamsUserId: identifier.microsoftTeamsUserId,
            isAnonymous: identifier.isAnonymous || false,
            cloud: identifier.cloud || 'public'
        };
    }

    if (identifier.kind === 'phoneNumber' && identifier.rawId && identifier.rawId.startsWith('4:')) {
        return { phoneNumber: identifier.rawId.replace(/^4:/, '') };
    }

    return identifier;
};

const createSession = (event, overrides, employees) => {
    const speech = createSpeechResult(overrides);
    const callerPhone = event?.data?.from?.phoneNumber?.value || '';
    const employee = findEmployee(speech.recognizedText, employees);
    const sessionId = createId('session');

    const session = {
        id: sessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: overrides.isMock ? (employee ? 'transferring' : 'message-required') : 'incoming',
        incomingCallContext: event?.data?.incomingCallContext || 'MOCK_CONTEXT_TOKEN',
        serverCallId: event?.data?.serverCallId || createId('server-call'),
        from: identifierToPlainObject(event?.data?.from || { rawId: '4:mock-caller', kind: 'unknown' }),
        to: identifierToPlainObject(event?.data?.to || { rawId: '8:acs:mock-resource', kind: 'phoneNumber' }),
        callerPhone,
        rawTranscript: speech.recognizedText,
        speechResult: overrides.isMock ? speech : null,
        route: {
            department: employee?.department || '',
            displayName: employee?.display_name || '',
            teamsUserId: employee?.teams_user_id || '',
            found: Boolean(employee)
        },
        customerName: overrides.isMock ? extractCustomerName(speech.recognizedText) : '',
        customerPhone: overrides.isMock ? extractPhoneNumber(speech.recognizedText, callerPhone) : callerPhone,
        requirement: overrides.isMock ? extractRequirement(speech.recognizedText, employee) : '',
        retryCount: 0,
        transfer: {
            status: employee ? 'initiated' : 'pending',
            startedAt: null,
            timeoutMs: TRANSFER_TIMEOUT_MS,
            targetTeamsUserId: employee?.teams_user_id || '',
            operationContext: '',
            timerId: null
        },
        message: null,
        messageBlobUrl: null,
        recordingBlobUrl: overrides.recordingBlobUrl || '',
        recordingBlobUrls: overrides.recordingBlobUrls || [],
        recordingId: '',
        answerCallResult: null,
        callConnectionId: '',
        callbackUri: '',
        lastCallbackEvent: '',
        isMock: Boolean(overrides.isMock),
        mockTransferOutcome: overrides.transferOutcome || 'timeout',
        pendingAction: null,
        aiSummary: null,
        asyncJobIds: []
    };

    state.sessions.set(sessionId, session);
    logEvent('incoming-call.accepted', {
        sessionId,
        serverCallId: session.serverCallId
    });
    return session;
};

const buildMessagePayload = (session, overrides = {}) => {
    const transcript = overrides.messageTranscript || overrides.transcript || session.rawTranscript;
    return {
        sessionId: session.id,
        serverCallId: session.serverCallId,
        customerName: session.customerName || extractCustomerName(transcript),
        customerPhone: session.customerPhone || extractPhoneNumber(transcript, session.callerPhone || ''),
        targetDepartment: session.route.department || '\u55b6\u696d\u90e8',
        targetPerson: session.route.displayName || '\u4f50\u85e4',
        messageText: transcript,
        createdAt: new Date().toISOString()
    };
};

const sanitizeBlobFilePart = (value, fallback = 'unknown') =>
    String(value || fallback)
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, '_');

const buildMessageBlobName = (messagePayload) => {
    const createdAtPart = sanitizeBlobFilePart(String(messagePayload.createdAt || '').replace(/[.:]/g, '-'), 'no-createdAt');
    const sessionPart = sanitizeBlobFilePart(messagePayload.sessionId, 'no-session');
    return `${createdAtPart}_${sessionPart}.json`;
};

const buildSummaryBlobName = (job) => {
    const createdAtPart = sanitizeBlobFilePart(String(job?.createdAt || '').replace(/[.:]/g, '-'), 'no-createdAt');
    const sessionPart = sanitizeBlobFilePart(job?.sessionId, 'no-session');
    return `${createdAtPart}_${sessionPart}.json`;
};

const buildRecordingBlobName = (session, sourceUrl, index = 0, totalCount = 1) => {
    const createdAtPart = sanitizeBlobFilePart(String(session?.createdAt || '').replace(/[.:]/g, '-'), 'no-createdAt');
    const sessionPart = sanitizeBlobFilePart(session?.id, 'no-session');
    const parsed = new URL(sourceUrl);
    const extension = path.extname(parsed.pathname) || '.wav';
    const chunkSuffix = totalCount > 1 ? `_part${String(index + 1).padStart(2, '0')}` : '';
    return `${createdAtPart}_${sessionPart}${chunkSuffix}${extension}`;
};

const copyBlobToContainer = async (config, sourceUrl, targetContainerName, targetBlobName) => {
    const blobServiceClient = getStorageClient(config);
    if (!blobServiceClient) {
        logEvent('blob.copy.skipped', {
            targetContainerName,
            targetBlobName,
            reason: 'storage-client-unavailable'
        });
        return '';
    }

    const { containerName: sourceContainerName, blobName: sourceBlobName } = parseBlobUrl(sourceUrl);
    logEvent('blob.copy.started', {
        sourceContainerName,
        sourceBlobName,
        targetContainerName,
        targetBlobName
    });
    const sourceContainerClient = blobServiceClient.getContainerClient(sourceContainerName);
    const sourceBlobClient = sourceContainerClient.getBlobClient(sourceBlobName);
    const download = await sourceBlobClient.download();
    const chunks = [];

    await new Promise((resolve, reject) => {
        download.readableStreamBody.on('data', (chunk) => chunks.push(chunk));
        download.readableStreamBody.on('end', resolve);
        download.readableStreamBody.on('error', reject);
    });

    const targetContainerClient = await ensureContainer(blobServiceClient, targetContainerName);
    const targetBlobClient = targetContainerClient.getBlockBlobClient(targetBlobName);
    const body = Buffer.concat(chunks);
    await targetBlobClient.upload(body, body.byteLength);
    logEvent('blob.copy.completed', {
        sourceContainerName,
        sourceBlobName,
        targetContainerName,
        targetBlobName,
        byteLength: body.byteLength
    });
    return targetBlobClient.url;
};

const persistRecordingsForSession = async (config, session, recordingUrls) => {
    if (!session || !Array.isArray(recordingUrls) || recordingUrls.length === 0) {
        return [];
    }

    const renamedUrls = [];

    for (let index = 0; index < recordingUrls.length; index += 1) {
        const sourceUrl = recordingUrls[index];
        const targetBlobName = buildRecordingBlobName(session, sourceUrl, index, recordingUrls.length);
        try {
            const renamedUrl = await copyBlobToContainer(config, sourceUrl, RECORDING_CONTAINER, targetBlobName);
            if (renamedUrl) {
                renamedUrls.push(renamedUrl);
            }
        } catch (error) {
            logEvent('recording.persist.failed', {
                sessionId: session.id,
                sourceUrl,
                targetBlobName,
                message: error.message
            });
        }
    }

    return renamedUrls;
};

const persistAiSummaryForJob = async (config, job) => {
    if (!job) {
        return '';
    }

    const url = await saveJsonToBlob(
        config,
        SUMMARY_CONTAINER,
        buildSummaryBlobName(job),
        job
    );
    logEvent('summary.persisted', {
        sessionId: job.sessionId,
        jobId: job.id,
        summaryBlobUrl: url
    });
    return url;
};

const createAiSummaryFallback = (session, transcript) => ({
    summary: `Customer ${session.customerName || 'unknown'} asked for ${session.route.displayName || 'Sato'}. Requirement: ${session.requirement || transcript}`,
    category: transcript.includes('\u898b\u7a4d') ? '\u55b6\u696d' : '\u4e00\u822c',
    nextAction: '\u62c5\u5f53\u8005\u3078\u6298\u308a\u8fd4\u3057\u9023\u7d61',
    customerName: session.customerName || '',
    customerPhone: session.customerPhone || '',
    targetDepartment: session.route.department || '',
    targetPerson: session.route.displayName || '',
    urgency: transcript.includes('\u81f3\u6025') ? 'high' : 'medium',
    confidence: 0.78
});

const callChatCompletions = async (config, session, transcript) => {
    if (!config.openAiEndpoint || !config.openAiApiKey || !config.openAiDeploymentName) {
        return createAiSummaryFallback(session, transcript);
    }

    const url = `${config.openAiEndpoint.replace(/\/$/, '')}/openai/deployments/${config.openAiDeploymentName}/chat/completions?api-version=${config.openAiApiVersion}`;
    const response = await axios.post(url, {
        messages: [
            {
                role: 'system',
                content: 'You summarize phone call transcripts for a reception PoC. Return JSON only with summary, category, nextAction, customerName, customerPhone, targetDepartment, targetPerson, urgency, confidence.'
            },
            {
                role: 'user',
                content: JSON.stringify({
                    transcript,
                    customerName: session?.customerName || '',
                    customerPhone: session?.customerPhone || '',
                    targetDepartment: session?.route?.department || '',
                    targetPerson: session?.route?.displayName || ''
                })
            }
        ],
        response_format: {
            type: 'json_object'
        }
    }, {
        headers: {
            'api-key': config.openAiApiKey,
            'Content-Type': 'application/json'
        }
    });

    const content = response.data?.choices?.[0]?.message?.content;
    return safeJsonParse(content, createAiSummaryFallback(session || { route: {} }, transcript));
};

const parseBlobUrl = (url) => {
    const parsed = new URL(url);
    const [, containerName, ...blobParts] = parsed.pathname.split('/');
    return {
        containerName,
        blobName: blobParts.join('/')
    };
};

const getServerCallIdFromSubject = (subject) => {
    const match = String(subject || '').match(/\/serverCallId\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : '';
};

const getRecordingContentLocations = (event) => {
    const chunks = event?.data?.recordingStorageInfo?.recordingChunks;
    if (Array.isArray(chunks) && chunks.length > 0) {
        return chunks
            .map((chunk) => chunk?.contentLocation || '')
            .filter(Boolean);
    }
    const singleLocation = event?.data?.recordingStorageInfo?.contentLocation || event?.data?.contentLocation || '';
    return singleLocation ? [singleLocation] : [];
};

const firstNonEmptyArray = (...candidates) => {
    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length > 0) {
            return candidate.filter(Boolean);
        }
    }
    return [];
};

const rememberProcessedAsyncKey = (key) => {
    if (!key || state.processedAsyncKeys.has(key)) {
        return;
    }

    state.processedAsyncKeys.add(key);
    state.processedAsyncKeyOrder.push(key);

    while (state.processedAsyncKeyOrder.length > PROCESSED_ASYNC_KEY_LIMIT) {
        const oldestKey = state.processedAsyncKeyOrder.shift();
        if (oldestKey) {
            state.processedAsyncKeys.delete(oldestKey);
        }
    }
};

const getRecordingIdentity = (session, event, overrides = {}) =>
    overrides.recordingId ||
    event?.data?.recordingId ||
    event?.data?.recordingStorageInfo?.recordingId ||
    session?.recordingId ||
    '';

const transcribeWithWhisper = async (config, blobUrls, transcriptOverride) => {
    if (transcriptOverride) {
        return transcriptOverride;
    }

    if (!blobUrls || blobUrls.length === 0 || !config.storageConnectionString || !config.openAiEndpoint || !config.openAiApiKey || !config.whisperDeploymentName) {
        return '';
    }

    const transcripts = [];

    for (const blobUrl of blobUrls) {
        const { containerName, blobName } = parseBlobUrl(blobUrl);
        const blobServiceClient = getStorageClient(config);
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blobClient = containerClient.getBlobClient(blobName);
        const download = await blobClient.download();
        const chunks = [];

        await new Promise((resolve, reject) => {
            download.readableStreamBody.on('data', (chunk) => chunks.push(chunk));
            download.readableStreamBody.on('end', resolve);
            download.readableStreamBody.on('error', reject);
        });

        const form = new FormData();
        form.append('file', Buffer.concat(chunks), {
            filename: path.basename(blobName) || 'recording.wav',
            contentType: 'audio/wav'
        });

        const url = `${config.openAiEndpoint.replace(/\/$/, '')}/openai/deployments/${config.whisperDeploymentName}/audio/transcriptions?api-version=${config.whisperApiVersion}`;
        const response = await axios.post(url, form, {
            headers: {
                'api-key': config.openAiApiKey,
                ...form.getHeaders()
            },
            maxBodyLength: Infinity
        });

        if (response.data?.text) {
            transcripts.push(response.data.text);
        }
    }

    return transcripts.join('\n').trim();
};

const createAsyncJob = async (config, session, blobEvent, overrides = {}) => {
    const blobUrls = firstNonEmptyArray(
        overrides.recordingBlobUrls,
        overrides.recordingBlobUrl ? [overrides.recordingBlobUrl] : null,
        getRecordingContentLocations(blobEvent),
        blobEvent?.data?.url ? [blobEvent.data.url] : null,
        session?.recordingBlobUrls,
        session?.recordingBlobUrl ? [session.recordingBlobUrl] : null
    );
    const recordingIdentity = getRecordingIdentity(session, blobEvent, overrides);
    const asyncKey = overrides.asyncKey ||
        recordingIdentity ||
        (blobUrls.length > 0 ? blobUrls.join('|') : `${session?.id || overrides.sessionId || 'unknown'}:${blobEvent?.id || 'no-event'}`);

    if (state.processedAsyncKeys.has(asyncKey)) {
        return {
            skipped: true,
            reason: 'duplicate-recording-event',
            asyncKey,
            sessionId: session?.id || overrides.sessionId || ''
        };
    }

    try {
        const transcript = await transcribeWithWhisper(
            config,
            blobUrls,
            overrides.transcript
        );

        const summary = await callChatCompletions(config, session, transcript || session?.rawTranscript || '');
        const job = {
            id: createId('async-job'),
            createdAt: new Date().toISOString(),
            sessionId: session?.id || overrides.sessionId || '',
            blobUrl: blobUrls[0] || '',
            blobUrls,
            transcript: transcript || session?.rawTranscript || '',
            summary
        };

        rememberProcessedAsyncKey(asyncKey);
        state.asyncJobs.unshift(job);
        state.asyncJobs = state.asyncJobs.slice(0, 50);

        if (session) {
            session.aiSummary = summary;
            session.updatedAt = new Date().toISOString();
            session.asyncJobIds.push(job.id);
        }

        job.summaryBlobUrl = await persistAiSummaryForJob(config, job);

        if (session) {
            session.aiSummaryBlobUrl = job.summaryBlobUrl;
            if (!session.teamsWebhook || session.teamsWebhook.skipped || !session.teamsWebhook.deliveredAt) {
                session.teamsWebhook = await postTeamsMessage(config, session, buildTeamsMessage(session));
            }
        }

        logEvent('async-job.completed', {
            jobId: job.id,
            sessionId: job.sessionId,
            summaryBlobUrl: job.summaryBlobUrl
        });
        return job;
    } catch (error) {
        logEvent('async-job.failed', {
            sessionId: session?.id || overrides.sessionId || '',
            asyncKey,
            message: error.message
        });
        throw error;
    }
};

const clearTransferTimer = (session) => {
    if (session.transfer.timerId) {
        clearTimeout(session.transfer.timerId);
        session.transfer.timerId = null;
    }
};

const getBaseUrl = (req) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${protocol}://${host}`;
};

const getCallAutomationClient = (config) => new CallAutomationClient(config.connectionString);

const getCallConnection = (config, session) => {
    if (!session.callConnectionId) {
        return null;
    }
    return getCallAutomationClient(config).getCallConnection(session.callConnectionId);
};

const findSessionByServerCallId = (serverCallId) =>
    Array.from(state.sessions.values()).find((item) => item.serverCallId === serverCallId);

const findSessionForCallbackEvent = (event) => {
    const identifiers = [
        event?.data?.serverCallId,
        event?.data?.callConnectionId,
        event?.callConnectionId
    ].filter(Boolean);

    return Array.from(state.sessions.values()).find((session) =>
        identifiers.includes(session.serverCallId) || identifiers.includes(session.callConnectionId)
    );
};

const playTextPrompt = async (config, session, text, operationContext) => {
    const callConnection = getCallConnection(config, session);
    if (!callConnection) {
        return;
    }

    const callMedia = callConnection.getCallMedia();
    await callMedia.playToAll([
        {
            kind: 'textSource',
            text,
            voiceName: 'ja-JP-NanamiNeural'
        }
    ], {
        operationContext
    });
};

const tryHangUpCall = async (config, session) => {
    const callConnection = getCallConnection(config, session);
    if (!callConnection || typeof callConnection.hangUp !== 'function') {
        return;
    }

    try {
        await callConnection.hangUp(true);
    } catch (error) {
        logEvent('call.hangup-failed', {
            sessionId: session.id,
            message: error.message
        });
    }
};

const applyPendingAction = async (config, session) => {
    const pendingAction = session.pendingAction;
    session.pendingAction = null;

    if (!pendingAction) {
        return;
    }

    if (pendingAction.type === 'faq-end') {
        session.status = 'completed';
        session.updatedAt = new Date().toISOString();
        await tryHangUpCall(config, session);
        return;
    }

    if (pendingAction.type === 'faq-transfer') {
        await attemptTransfer(config, session);
        return;
    }

    if (pendingAction.type === 'transfer-execute') {
        const callConnection = getCallConnection(config, session);
        if (!callConnection) {
            return;
        }

        session.transfer.startedAt = new Date().toISOString();
        session.transfer.status = 'initiated';
        session.transfer.operationContext = createId('transfer');
        session.status = 'transferring';
        session.updatedAt = session.transfer.startedAt;

        session.transfer.timerId = setTimeout(() => {
            transferTimeoutHandler(config, session).catch((error) => {
                logEvent('transfer.timeout-handler.failed', {
                    sessionId: session.id,
                    message: error.message
                });
            });
        }, TRANSFER_TIMEOUT_MS);

        try {
            await callConnection.transferCallToParticipant({
                microsoftTeamsUserId: session.route.teamsUserId
            }, {
                operationContext: session.transfer.operationContext
            });

            logEvent('transfer.requested', {
                sessionId: session.id,
                teamsUserId: session.route.teamsUserId
            });
        } catch (error) {
            clearTransferTimer(session);
            session.transfer.status = 'failed';
            session.status = 'message-required';
            logEvent('transfer.request-failed', {
                sessionId: session.id,
                message: error.message
            });
            await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
        }
        return;
    }

    if (pendingAction.type === 'guidance-recognize') {
        session.updatedAt = new Date().toISOString();
        logEvent('guidance.recognize.start', {
            sessionId: session.id,
            callConnectionId: session.callConnectionId
        });
        await startRecognize(config, session, 'collect-routing');
        return;
    }

    if (pendingAction.type === 'message-complete') {
        session.status = 'completed';
        session.updatedAt = new Date().toISOString();
        await tryHangUpCall(config, session);
    }
};

const handlePendingActionPlaybackFailure = async (config, session, operationContext) => {
    logEvent('faq.playback-failed', {
        sessionId: session.id,
        operationContext
    });

    const pendingAction = session.pendingAction;
    session.pendingAction = null;

    if (!pendingAction) {
        return;
    }

    if (pendingAction.type === 'message-complete') {
        session.status = 'completed';
        session.updatedAt = new Date().toISOString();
        await tryHangUpCall(config, session);
        return;
    }

    if (pendingAction.type === 'transfer-execute') {
        session.status = 'message-required';
        session.updatedAt = new Date().toISOString();
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
        return;
    }

    if (pendingAction.type === 'guidance-recognize') {
        session.pendingAction = null;
        session.status = 'message-required';
        session.updatedAt = new Date().toISOString();
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
        return;
    }

    session.status = 'message-required';
    session.updatedAt = new Date().toISOString();
    await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
};

const startRecognize = async (config, session, operationContext, promptText) => {
    const callConnection = getCallConnection(config, session);
    if (!callConnection) {
        return;
    }

    const callMedia = callConnection.getCallMedia();
    const options = {
        kind: 'callMediaRecognizeSpeechOptions',
        interruptPrompt: true,
        initialSilenceTimeoutInSeconds: 20,
        endSilenceTimeoutInSeconds: 2,
        speechLanguage: 'ja-JP',
        operationContext
    };

    if (promptText) {
        options.playPrompt = {
            kind: 'textSource',
            text: promptText,
            voiceName: 'ja-JP-NanamiNeural'
        };
    }

    await callMedia.startRecognizing(toCallAutomationIdentifier(session.from), options);
};

const startRecordingForSession = async (config, session) => {
    try {
        const options = {
            callLocator: {
                kind: 'serverCallLocator',
                id: session.serverCallId
            },
            recordingContent: 'audio',
            recordingChannel: 'unmixed',
            recordingFormat: 'wav',
            recordingStateCallbackEndpointUrl: session.callbackUri
        };

        const recordingContainerUrl = deriveRecordingContainerUrl(config);
        if (recordingContainerUrl) {
            options.recordingStorage = {
                recordingStorageKind: 'azureBlobStorage',
                recordingDestinationContainerUrl: recordingContainerUrl
            };
        }

        const response = await getCallAutomationClient(config).getCallRecording().start(options);
        session.recordingId = response.recordingId || '';
        logEvent('recording.started', {
            sessionId: session.id,
            recordingId: session.recordingId
        });
    } catch (error) {
        logEvent('recording.start-failed', {
            sessionId: session.id,
            message: error.message
        });
    }
};

const extractRecognizedText = (event) =>
    event?.data?.speechResult?.speech ?? event?.data?.speechResult?.text ?? event?.data?.recognitionResult?.text ?? '';

const transferTimeoutHandler = async (config, session) => {
    if (session.transfer.status === 'connected' || session.status === 'message-saved') {
        return;
    }

    clearTransferTimer(session);
    session.transfer.status = 'timeout';
    session.status = 'message-required';
    session.updatedAt = new Date().toISOString();
    logEvent('transfer.timeout', {
        sessionId: session.id,
        teamsUserId: session.transfer.targetTeamsUserId
    });

    await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
};

const attemptTransfer = async (config, session) => {
    if (!session.route.teamsUserId) {
        session.status = 'message-required';
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
        return;
    }

    const callConnection = getCallConnection(config, session);
    if (!callConnection) {
        if (session.isMock) {
            if (session.mockTransferOutcome === 'connected') {
                session.transfer.status = 'connected';
                session.status = 'human-connected';
                session.updatedAt = new Date().toISOString();
            } else {
                session.transfer.status = 'timeout';
                session.status = 'message-required';
                await finalizeMessageFallback(config, session, session.rawTranscript || DEFAULT_TRANSCRIPT);
            }
        }
        return;
    }

    session.pendingAction = {
        type: 'transfer-execute',
        operationContext: 'wait-for-transfer'
    };
    try {
        await playTextPrompt(config, session, WAITING_PROMPT, 'wait-for-transfer');
    } catch (error) {
        logEvent('transfer.waiting-prompt.failed', {
            sessionId: session.id,
            message: error.message
        });
        session.pendingAction = null;
        session.status = 'message-required';
        session.updatedAt = new Date().toISOString();
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
    }
};

const finalizeMessageFallback = async (config, session, transcript) => {
    clearTransferTimer(session);
    session.rawTranscript = transcript || session.rawTranscript;
    if (!session.customerName) {
        session.customerName = extractCustomerName(session.rawTranscript);
    }
    if (!session.customerPhone) {
        session.customerPhone = extractPhoneNumber(session.rawTranscript, session.callerPhone);
    }
    if (!session.requirement) {
        session.requirement = session.rawTranscript;
    }

    const messagePayload = buildMessagePayload(session, {
        transcript: session.rawTranscript
    });
    session.message = messagePayload;
    session.messageBlobUrl = await saveJsonToBlob(
        config,
        MESSAGE_CONTAINER,
        buildMessageBlobName(messagePayload),
        messagePayload
    );
    session.status = 'message-saved';
    session.updatedAt = new Date().toISOString();
    session.teamsWebhook = {
        skipped: true,
        reason: 'awaiting-ai-summary',
        sessionId: session.id
    };

    logEvent('message.saved', {
        sessionId: session.id,
        messageBlobUrl: session.messageBlobUrl
    });

    try {
        session.pendingAction = {
            type: 'message-complete',
            operationContext: 'message-complete'
        };
        await playTextPrompt(config, session, COMPLETION_PROMPT, 'message-complete');
        if (session.isMock) {
            await applyPendingAction(config, session);
            return;
        }
    } catch (error) {
        logEvent('message.completion-prompt.failed', {
            sessionId: session.id,
            message: error.message
        });
        session.pendingAction = null;
        await tryHangUpCall(config, session);
    }
};

const handleRecognizeCompleted = async (config, session, event, employees, faqs) => {
    const operationContext = event?.data?.operationContext || '';
    const recognizedText = extractRecognizedText(event);

    if (!recognizedText) {
        if (operationContext === 'collect-message') {
            session.retryCount += 1;
            if (session.retryCount <= RETRY_PROMPT_LIMIT) {
                await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
                return;
            }
            await finalizeMessageFallback(config, session, session.rawTranscript || DEFAULT_TRANSCRIPT);
            return;
        }

        await startRecognize(config, session, 'collect-routing', GUIDANCE_PROMPT);
        return;
    }

    if (operationContext === 'collect-message') {
        await finalizeMessageFallback(config, session, recognizedText);
        return;
    }

    const faq = findFaqMatch(recognizedText, faqs);
    if (faq) {
        session.rawTranscript = recognizedText;
        session.customerName = extractCustomerName(recognizedText);
        session.customerPhone = extractPhoneNumber(recognizedText, session.callerPhone);
        session.requirement = recognizedText;
        session.faq = {
            keyword: faq.keyword,
            answer: faq.answer,
            action: faq.action || 'end'
        };
        session.status = 'faq-answered';
        session.updatedAt = new Date().toISOString();
        session.pendingAction = {
            type: (faq.action || 'end') === 'transfer' ? 'faq-transfer' : 'faq-end',
            operationContext: `faq-${faq.keyword}`
        };

        await playTextPrompt(config, session, faq.answer, session.pendingAction.operationContext);

        if (session.isMock) {
            await applyPendingAction(config, session);
            return;
        }

        return;
    }

    const employee = findEmployee(recognizedText, employees);
    session.rawTranscript = recognizedText;
    session.customerName = extractCustomerName(recognizedText);
    session.customerPhone = extractPhoneNumber(recognizedText, session.callerPhone);
    session.requirement = extractRequirement(recognizedText, employee);
    session.speechResult = {
        recognizedText,
        confidence: event?.data?.speechResult?.confidence || null,
        language: 'ja-JP',
        timestamp: new Date().toISOString()
    };
    session.route = {
        department: employee?.department || '',
        displayName: employee?.display_name || '',
        teamsUserId: employee?.teams_user_id || '',
        found: Boolean(employee)
    };
    session.transfer.targetTeamsUserId = employee?.teams_user_id || '';
    session.updatedAt = new Date().toISOString();

    if (!employee) {
        session.status = 'message-required';
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
        return;
    }

    await attemptTransfer(config, session);
};

const handleRecognizeFailed = async (config, session, event) => {
    const operationContext = event?.data?.operationContext || '';
    logEvent('recognize.failed', {
        sessionId: session.id,
        operationContext,
        reason: event?.data?.resultInformation?.message || 'unknown'
    });

    if (operationContext === 'collect-message') {
        session.retryCount += 1;
        if (session.retryCount <= RETRY_PROMPT_LIMIT) {
            await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
            return;
        }
        await finalizeMessageFallback(config, session, session.rawTranscript || DEFAULT_TRANSCRIPT);
        return;
    }

    await startRecognize(config, session, 'collect-routing', GUIDANCE_PROMPT);
};

const handleTransferEvent = async (config, session, eventType, event) => {
    if (eventType === 'CallTransferAccepted') {
        clearTransferTimer(session);
        session.transfer.status = 'connected';
        session.status = 'human-connected';
        session.updatedAt = new Date().toISOString();
        logEvent('transfer.connected', {
            sessionId: session.id,
            teamsUserId: session.route.teamsUserId
        });
        return;
    }

    if (eventType === 'CallTransferFailed') {
        clearTransferTimer(session);
        session.transfer.status = 'failed';
        session.status = 'message-required';
        session.updatedAt = new Date().toISOString();
        logEvent('transfer.failed', {
            sessionId: session.id,
            resultInformation: event?.data?.resultInformation || null
        });
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
    }
};

const createMockIncomingCallEvent = (body = {}) => ([
    {
        id: body.id || createId('incoming'),
        type: 'Microsoft.Communication.IncomingCall',
        source: '/subscriptions/mock/resourceGroups/mockRG/providers/Microsoft.Communication/CommunicationServices/mockACS',
        time: new Date().toISOString(),
        specversion: '1.0',
        data: {
            from: {
                rawId: body.fromRawId || '4:mock-caller',
                kind: body.fromKind || 'unknown',
                phoneNumber: body.phoneNumber ? { value: body.phoneNumber } : undefined
            },
            to: {
                rawId: body.toRawId || '8:acs:mock-resource',
                kind: 'phoneNumber'
            },
            incomingCallContext: body.incomingCallContext || 'MOCK_CONTEXT_TOKEN',
            serverCallId: body.serverCallId || createId('server-call')
        }
    }
]);

const createMockBlobCreatedEvent = (body = {}) => ([
    {
        id: body.id || createId('blob'),
        eventType: 'Microsoft.Storage.BlobCreated',
        subject: `/blobServices/default/containers/${RECORDING_CONTAINER}/blobs/${body.blobName || 'mock-recording.wav'}`,
        eventTime: new Date().toISOString(),
        data: {
            url: body.url || `https://mock.blob.core.windows.net/${RECORDING_CONTAINER}/${body.blobName || 'mock-recording.wav'}`
        }
    }
]);

const registerPocRoutes = (app, config) => {
    app.get('/api/poc/employees', async (req, res) => {
        res.status(200).json({ employees: loadEmployees() });
    });

    app.get('/api/poc/faqs', async (req, res) => {
        res.status(200).json({ faqs: loadFaqs() });
    });

    app.get('/api/poc/state', async (req, res) => {
        res.status(200).json({
            employees: loadEmployees(),
            faqs: loadFaqs(),
            sessions: Array.from(state.sessions.values()).map((session) => ({
                ...session,
                transfer: {
                    ...session.transfer,
                    timerId: session.transfer.timerId ? 'scheduled' : null
                }
            })),
            asyncJobs: state.asyncJobs,
            logs: state.logs,
            containers: {
                recordings: RECORDING_CONTAINER,
                messages: MESSAGE_CONTAINER
            },
            transferTimeoutMs: TRANSFER_TIMEOUT_MS,
            retryPromptLimit: RETRY_PROMPT_LIMIT
        });
    });

    app.post('/api/poc/mockIncomingCall', async (req, res) => {
        try {
            const employees = loadEmployees();
            const faqs = loadFaqs();
            const event = createMockIncomingCallEvent(req.body)[0];
            const session = createSession(event, { ...req.body, isMock: true }, employees);
            if (req.body.recognizedText) {
                await handleRecognizeCompleted(config, session, {
                    data: {
                        operationContext: 'collect-routing',
                        speechResult: {
                            speech: req.body.recognizedText,
                            confidence: req.body.confidence || 0.92
                        }
                    }
                }, employees, faqs);
            } else if (session.transfer.status === 'initiated') {
                if ((req.body.transferOutcome || 'timeout') === 'connected') {
                    session.transfer.status = 'connected';
                    session.status = 'human-connected';
                } else {
                    await finalizeMessageFallback(config, session, req.body.transcript || session.rawTranscript);
                }
            }
            res.status(202).json({ session });
        } catch (error) {
            console.error(error);
            res.sendStatus(500);
        }
    });

    app.post('/api/poc/mockBlobCreated', async (req, res) => {
        try {
            const event = createMockBlobCreatedEvent(req.body)[0];
            const session = req.body.sessionId ? state.sessions.get(req.body.sessionId) : null;
            const job = await createAsyncJob(config, session, event, req.body);
            res.status(202).json({ job });
        } catch (error) {
            console.error(error);
            res.sendStatus(500);
        }
    });

    app.post('/api/incomingCall', async (req, res) => {
        try {
            if (handleSubscriptionValidation(req.body, res)) {
                return;
            }

            const { events, mockOverrides } = parseMockEventRequest(req.body);
            const incomingEvent = events.find((event) => normalizeEventType(event) === 'IncomingCall');
            if (!incomingEvent) {
                res.status(400).json({ message: 'No Microsoft.Communication.IncomingCall event found.' });
                return;
            }

            const employees = loadEmployees();
            const faqs = loadFaqs();
            const session = createSession(incomingEvent, mockOverrides, employees);
            session.callbackUri = `${getBaseUrl(req)}/api/callbacks/callAutomation`;

            if (mockOverrides.isMock === true) {
                await handleRecognizeCompleted(config, session, {
                    data: {
                        operationContext: 'collect-routing',
                        speechResult: {
                            speech: mockOverrides.recognizedText || DEFAULT_TRANSCRIPT,
                            confidence: mockOverrides.confidence || 0.92
                        }
                    }
                }, employees, faqs);
                res.status(202).json({ session, mocked: true });
                return;
            }

            const client = getCallAutomationClient(config);
            const answerOptions = {};

            if (config.cognitiveServicesEndpoint) {
                answerOptions.callIntelligenceOptions = {
                    cognitiveServicesEndpoint: config.cognitiveServicesEndpoint
                };
            }

            // 2026-03-23: Cognitive Services 設定が call setup に載っているかを切り分けるための確認ログ。
            logEvent('incoming-call.answer-options', {
                sessionId: session.id,
                hasCognitiveServicesEndpoint: Boolean(config.cognitiveServicesEndpoint),
                cognitiveServicesEndpoint: config.cognitiveServicesEndpoint || '',
                hasCallIntelligenceOptions: Boolean(answerOptions.callIntelligenceOptions),
                callbackUri: session.callbackUri
            });

            const answerResult = await client.answerCall(session.incomingCallContext, session.callbackUri, answerOptions);
            // 2026-03-23: answerResult全体のJSON化をやめ、必要最小限の値のみ保存する。
            session.answerCallResult = answerResultToPlainObject(answerResult);
            session.callConnectionId = session.answerCallResult.callConnectionId || '';
            session.serverCallId = session.answerCallResult.serverCallId || session.serverCallId;
            session.status = 'answered';
            session.updatedAt = new Date().toISOString();

            res.status(202).json({
                sessionId: session.id,
                callConnectionId: session.callConnectionId,
                serverCallId: session.serverCallId,
                callbackUri: session.callbackUri
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({
                message: error.message
            });
        }
    });

    app.post('/api/callbacks/callAutomation', async (req, res) => {
        try {
            const { events } = parseMockEventRequest(req.body);
            const employees = loadEmployees();
            const faqs = loadFaqs();

            for (const event of events) {
                const eventType = normalizeEventType(event);
                const session = findSessionForCallbackEvent(event);
                if (!session) {
                    continue;
                }

                session.updatedAt = new Date().toISOString();
                session.lastCallbackEvent = eventType;

                if (eventType === 'CallConnected') {
                    session.status = 'connected';
                    // 2026-03-23: Recognize 開始時点での状態を確認するための一時ログ。
                    logEvent('call.connected', {
                        sessionId: session.id,
                        callConnectionId: session.callConnectionId,
                        hasCognitiveServicesEndpoint: Boolean(config.cognitiveServicesEndpoint),
                        cognitiveServicesEndpoint: config.cognitiveServicesEndpoint || ''
                    });
                    // 2026-03-23: 通話未確立状態での録音開始失敗を避けるため、録音開始は CallConnected 後へ移動。
                    await startRecordingForSession(config, session);
                    // 2026-03-23: ガイダンス再生と認識開始を分離し、少なくとも案内は先に流す。
                    session.pendingAction = {
                        type: 'guidance-recognize',
                        operationContext: 'guidance-play'
                    };
                    logEvent('guidance.play.requested', {
                        sessionId: session.id,
                        callConnectionId: session.callConnectionId,
                        operationContext: 'guidance-play'
                    });
                    await playTextPrompt(config, session, GUIDANCE_PROMPT, 'guidance-play');
                    continue;
                }

                if (eventType === 'RecognizeCompleted') {
                    await handleRecognizeCompleted(config, session, event, employees, faqs);
                    continue;
                }

                if (eventType === 'RecognizeFailed') {
                    await handleRecognizeFailed(config, session, event);
                    continue;
                }

                if (eventType === 'CallTransferAccepted' || eventType === 'CallTransferFailed') {
                    await handleTransferEvent(config, session, eventType, event);
                    continue;
                }

                if (eventType === 'PlayCompleted') {
                    const operationContext = event?.data?.operationContext || '';
                    if (operationContext === 'guidance-play') {
                        logEvent('guidance.play.completed', {
                            sessionId: session.id,
                            callConnectionId: session.callConnectionId,
                            operationContext
                        });
                    }
                    if (session.pendingAction?.operationContext === operationContext) {
                        await applyPendingAction(config, session);
                    }
                    continue;
                }

                if (eventType === 'PlayFailed') {
                    const operationContext = event?.data?.operationContext || '';
                    if (operationContext === 'guidance-play') {
                        logEvent('guidance.play.failed', {
                            sessionId: session.id,
                            callConnectionId: session.callConnectionId,
                            operationContext,
                            resultInformation: event?.data?.resultInformation || null
                        });
                    }
                    if (session.pendingAction?.operationContext === operationContext) {
                        await handlePendingActionPlaybackFailure(config, session, operationContext);
                    }
                    continue;
                }

                if (eventType === 'CallDisconnected') {
                    clearTransferTimer(session);
                    session.status = session.status === 'human-connected' ? 'completed' : session.status;
                    logEvent('call.disconnected', {
                        sessionId: session.id,
                        callConnectionId: session.callConnectionId
                    });
                    continue;
                }

                if (eventType === 'RecordingFileStatusUpdated') {
                    const contentLocations = getRecordingContentLocations(event);
                    logEvent('recording.status-updated.received', {
                        sessionId: session.id,
                        recordingId: event?.data?.recordingId || event?.data?.recordingStorageInfo?.recordingId || '',
                        recordingChunkCount: contentLocations.length
                    });
                    if (contentLocations.length > 0) {
                        const persistedRecordingUrls = await persistRecordingsForSession(config, session, contentLocations);
                        session.recordingBlobUrl = persistedRecordingUrls[0] || contentLocations[0];
                        session.recordingBlobUrls = persistedRecordingUrls.length > 0 ? persistedRecordingUrls : contentLocations;
                        session.recordingId = event?.data?.recordingId || event?.data?.recordingStorageInfo?.recordingId || session.recordingId;
                        session.updatedAt = new Date().toISOString();
                        logEvent('recording.file-ready', {
                            sessionId: session.id,
                            recordingBlobUrl: session.recordingBlobUrl,
                            recordingChunkCount: contentLocations.length
                        });
                    }
                    continue;
                }
            }

            res.status(202).json({ accepted: true });
        } catch (error) {
            console.error(error);
            res.status(500).json({
                message: error.message
            });
        }
    });

    app.post('/api/events/blobCreated', async (req, res) => {
        try {
            if (handleSubscriptionValidation(req.body, res)) {
                return;
            }

            const { events, mockOverrides } = parseMockEventRequest(req.body);
            const blobEvent = events.find((event) => normalizeEventType(event) === 'BlobCreated');
            const recordingEvent = events.find((event) => normalizeEventType(event) === 'RecordingFileStatusUpdated');
            const selectedEvent = recordingEvent || blobEvent;
            if (!selectedEvent) {
                res.status(400).json({ message: 'No BlobCreated or RecordingFileStatusUpdated event found.' });
                return;
            }

            const session = mockOverrides.sessionId
                ? state.sessions.get(mockOverrides.sessionId)
                : findSessionByServerCallId(
                    selectedEvent?.data?.serverCallId ||
                    getServerCallIdFromSubject(selectedEvent?.subject) ||
                    ''
                );

            const recordingUrls = recordingEvent
                ? getRecordingContentLocations(recordingEvent)
                : (blobEvent?.data?.url ? [blobEvent.data.url] : []);

            logEvent('blob-created.received', {
                sessionId: session?.id || mockOverrides.sessionId || '',
                eventType: normalizeEventType(selectedEvent),
                recordingUrlCount: recordingUrls.length
            });

            if (session && recordingUrls.length > 0) {
                const persistedRecordingUrls = await persistRecordingsForSession(config, session, recordingUrls);
                session.recordingBlobUrl = persistedRecordingUrls[0] || recordingUrls[0];
                session.recordingBlobUrls = persistedRecordingUrls.length > 0 ? persistedRecordingUrls : recordingUrls;
                session.recordingId = getRecordingIdentity(session, selectedEvent, mockOverrides);
                session.updatedAt = new Date().toISOString();
            }

            const job = await createAsyncJob(config, session, selectedEvent, {
                ...mockOverrides,
                recordingId: mockOverrides.recordingId || getRecordingIdentity(session, selectedEvent, mockOverrides),
                recordingBlobUrls: mockOverrides.recordingBlobUrls || recordingUrls,
                recordingBlobUrl: mockOverrides.recordingBlobUrl || recordingUrls[0] || ''
            });
            res.status(202).json({ job });
        } catch (error) {
            console.error(error);
            res.status(500).json({
                message: error.message
            });
        }
    });
};

module.exports = {
    registerPocRoutes
};
