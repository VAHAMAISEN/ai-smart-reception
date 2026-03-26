/**
 * @fileoverview PoC 用の受付フローを担う Express ルートと通話状態管理。
 *
 * ざっくりした流れ:
 * 1. 着信 Webhook（`/api/incomingCall`）でセッションを作り、必要なら ACS で応答する。
 * 2. ACS からのコールバック（`/api/callbacks/callAutomation`）で録音・案内・音声認識・転送を進める。
 * 3. 録音 Blob や Event Grid（`/api/events/blobCreated`）から Whisper / Chat で要約し Teams に送る。
 *
 * データは本番相当でもメモリ内 `state` が主（再起動で消える）。検証用のモック API も同じファイルにある。
 *
 * @see {@link registerPocRoutes} 実際に `app` へルートを登録する関数
 */

// ---------------------------------------------------------------------------
// 依存モジュール（ファイル操作 / HTTP / ログ / Azure SDK）
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const pino = require('pino');
const { BlobServiceClient } = require('@azure/storage-blob');
const { CallAutomationClient } = require('@azure/communication-call-automation');

// ---------------------------------------------------------------------------
// 定数: データファイルパス・Blob コンテナ名・タイムアウト・リトライ上限
// （値を変えると動作が変わるので、運用で触る可能性があるものはここに集約）
// ---------------------------------------------------------------------------
const EMPLOYEE_CSV_PATH = path.join(__dirname, 'data', 'employees.csv');
const FAQ_CSV_PATH = path.join(__dirname, 'data', 'faq.csv');
/** 伝言 JSON を置く Blob コンテナ名（設定と一致させる）。 */
const MESSAGE_CONTAINER = 'call-messages';
/** 通話録音をコピー・保存するコンテナ名。 */
const RECORDING_CONTAINER = 'call-recordings';
/** OpenAI 要約結果 JSON を置くコンテナ名。 */
const SUMMARY_CONTAINER = 'openai-results';
/** Teams 転送がこの時間内に接続しなければタイムアウト扱いにする（ミリ秒）。 */
const TRANSFER_TIMEOUT_MS = 20000;
/** 伝言収集で「聞き取れなかった」とき、同じプロンプトを繰り返す最大回数。 */
const RETRY_PROMPT_LIMIT = 2;
/** 録音イベントの二重処理防止用キーを、メモリに何件まで覚えておくかの上限。 */
const PROCESSED_ASYNC_KEY_LIMIT = 500;
/** テストやフォールバック用の「例の発話」全文（認識が空のときの代替など）。 */
const DEFAULT_TRANSCRIPT = '\u55b6\u696d\u90e8 \u4f50\u85e4\u3055\u3093\u306b\u3064\u306a\u3044\u3067\u304f\u3060\u3055\u3044\u3002\u7528\u4ef6\u306f\u898b\u7a4d\u306e\u76f8\u8ac7\u3067\u3059\u3002\u6c0f\u540d\u306f\u7530\u4e2d\u3001\u96fb\u8a71\u756a\u53f7\u306f09012345678\u3067\u3059\u3002';
/** 通話開始直後に流す「用件を話してください」系の案内文。 */
const GUIDANCE_PROMPT = '\u304a\u4e16\u8a71\u306b\u306a\u3063\u3066\u304a\u308a\u307e\u3059\u3002\u3054\u7528\u4ef6\u3092\u304a\u8a71\u3057\u304f\u3060\u3055\u3044\u3002';
/** 担当者へ転送を試みる直前に流す「お待ちください」系の案内。 */
const WAITING_PROMPT = '\u8ee2\u9001\u5148\u3092\u78ba\u8a8d\u3057\u3066\u304a\u308a\u307e\u3059\u3002\u305d\u306e\u307e\u307e\u304a\u5f85\u3061\u304f\u3060\u3055\u3044\u3002';
/** 担当者不在・転送失敗時に伝言を録音させるためのプロンプト。 */
const ABSENT_PROMPT = '\u62c5\u5f53\u8005\u304c\u5fdc\u7b54\u3067\u304d\u306a\u3044\u305f\u3081\u3001\u4f1d\u8a00\u3092\u304a\u9810\u304b\u308a\u3057\u307e\u3059\u3002\u3054\u7528\u4ef6\u3001\u304a\u540d\u524d\u3001\u304a\u96fb\u8a71\u756a\u53f7\u3092\u304a\u8a71\u3057\u304f\u3060\u3055\u3044\u3002';
/** 伝言保存後に流す「承りました」系の完了アナウンス。 */
const COMPLETION_PROMPT = '\u78ba\u304b\u306b\u627f\u308a\u307e\u3057\u305f\u3002\u62c5\u5f53\u8005\u306b\u5171\u6709\u3044\u305f\u3057\u307e\u3059\u3002';

/**
 * サーバー1プロセス内で共有するメモリ状態（PoC 用の簡易ストア）。
 *
 * - sessions: 通話ごとのセッション（キーは sessionId）
 * - asyncJobs: Whisper / 要約など非同期ジョブの履歴（直近のみ保持）
 * - logs: 検証 UI 向けに返すログエントリ（件数上限あり）
 * - processedAsyncKeys: 同じ録音イベントを二重に処理しないためのキー集合
 */
const state = {
    sessions: new Map(),
    asyncJobs: [],
    logs: [],
    processedAsyncKeys: new Set(),
    processedAsyncKeyOrder: []
};

/**
 * 運用向け（App Service のアプリケーション設定など）。
 *
 * 次の変数はいずれも省略可能で、未設定時は右の既定と同じ動きになる。
 * 運用でレベルを変えたいときだけ設定すればよい。
 *
 * - `POC_LOG_LEVEL` … サーバー標準出力（Pino）に出す最小レベル。既定: `info`
 * - `POC_LOG_MEMORY_MIN` … `/api/poc/state` 経由で検証 UI に返すメモリログの最小レベル。既定: `info`
 *
 * 値は `trace` / `debug` / `info` / `warn` / `error` / `fatal`。
 * `POC_LOG_MEMORY_MIN` が未知の文字列のときは比較上 `info` と同等扱い。
 */

/** 重要度が低い順。右に行くほど重大（比較は配列インデックスで行う）。 */
const LOG_LEVEL_SEVERITY_ORDER = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** Pino の最小ログレベル（未設定時は info＝本番向け）。App Service の値の前後空白は無視する。 */
const POC_LOG_LEVEL = ((process.env.POC_LOG_LEVEL ?? '').trim().toLowerCase() || 'info');

/**
 * /api/poc/state の logs に載せる最小レベル。
 * debug は既定で除外し、STT 全文など詳細がブラウザ経由で残らないようにする。
 */
const POC_LOG_MEMORY_MIN = ((process.env.POC_LOG_MEMORY_MIN ?? '').trim().toLowerCase() || 'info');

/**
 * レベル名を「重要度インデックス」に変換する（0=trace … 大きいほど重大）。
 *
 * @param {string} level
 * @returns {number}
 */
const logLevelSeverityIndex = (level) => {
    const key = String(level).toLowerCase();
    const idx = LOG_LEVEL_SEVERITY_ORDER.indexOf(key);
    return idx === -1 ? LOG_LEVEL_SEVERITY_ORDER.indexOf('info') : idx;
};

const pinoLogger = pino({
    level: POC_LOG_LEVEL,
    name: 'poc-server'
});

/**
 * ログや ID 用にほぼ一意な文字列を生成する（PoC 用途で十分なランダム性）。
 *
 * @param {string} prefix 先頭に付ける識別子（例: `session`）
 * @returns {string} `prefix-時刻-乱数` 形式
 */
const createId = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

/**
 * Pino 出力と state.logs の単一入口。コンソールは JSON 一行（Pino 既定）。
 * payload のキーはログ集約・エンコーディング都合で英語（camelCase）に統一する。
 *
 * @param {'trace'|'debug'|'info'|'warn'|'error'|'fatal'} level
 * @param {string} type イベント種別（画面表示用・日本語可）
 * @param {Record<string, unknown>} payload 付加フィールド（キーは英語）
 */
const logEvent = (level, type, payload) => {
    const lv = String(level || 'info').toLowerCase();
    const safeLevel = LOG_LEVEL_SEVERITY_ORDER.includes(lv) ? lv : 'info';
    const logFn = pinoLogger[safeLevel] ? pinoLogger[safeLevel].bind(pinoLogger) : pinoLogger.info.bind(pinoLogger);
    logFn({ pocEvent: type, ...payload }, type);

    // メモリ保持は「しきい値未満の詳しさ」は捨てる（例: min=info なら trace/debug は API に載せない）
    if (logLevelSeverityIndex(safeLevel) < logLevelSeverityIndex(POC_LOG_MEMORY_MIN)) {
        return;
    }

    const entry = {
        level: safeLevel,
        type,
        payload,
        timestamp: new Date().toISOString()
    };
    state.logs.unshift(entry);
    state.logs = state.logs.slice(0, 100);
};

/**
 * ログ用に文字列を短く切り詰める。
 *
 * 認識テキストなど長文がコンソールやメモリ保持ログを圧迫しないようにする。
 *
 * @param {string} value 元文字列
 * @param {number} maxLength 最大文字数
 * @returns {string}
 */
const truncateForLog = (value, maxLength = 120) => {
    const text = String(value || '');
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength)}…`;
};

/**
 * ログ表示用に保留アクション種別を日本語へ変換する。
 *
 * @param {string} type 内部の pendingAction.type
 * @returns {string}
 */
const pendingActionTypeLabelForLog = (type) => {
    const labels = {
        'faq-end': 'FAQ終了',
        'faq-transfer': 'FAQから転送',
        'transfer-execute': '転送実行',
        'guidance-recognize': '案内後の認識',
        'message-complete': '伝言完了'
    };
    return labels[type] || String(type || '');
};

/**
 * ログ表示用に転送モックの結果を日本語へ変換する。
 *
 * @param {string} outcome モックの転送結果
 * @returns {string}
 */
const mockTransferOutcomeLabelForLog = (outcome) => {
    if (outcome === 'connected') {
        return '接続';
    }
    if (outcome === 'timeout') {
        return 'タイムアウト';
    }
    return outcome ? String(outcome) : '未指定';
};

/**
 * JSON 文字列をパースし、失敗時は呼び出し側の既定値を返す。
 *
 * @param {string} value パース対象
 * @param {unknown} fallback 失敗時の戻り値
 * @returns {unknown}
 */
const safeJsonParse = (value, fallback) => {
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
};

/**
 * CSV 内の `\uXXXX` 形式を実際の文字に戻す（エディタ互換用）。
 *
 * @param {string} value 元文字列
 * @returns {string}
 */
const decodeUnicodeEscapes = (value) =>
    String(value || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

/**
 * 1 行分の CSV をカンマ分割する（ダブルクォート内のカンマはフィールド内として扱う）。
 *
 * @param {string} line CSV の 1 行
 * @returns {string[]} セルの配列
 */
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

/**
 * `data/employees.csv` から有効な担当者一覧を読み込む。
 *
 * @returns {Array<Record<string, unknown>>} `enabled=true` の行のみ（priority 昇順で後続処理で並べ替え）
 */
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

/**
 * `data/faq.csv` から FAQ 一覧を読み込む。
 *
 * @returns {Array<Record<string, unknown>>} keyword / answer が揃った行のみ
 */
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

/**
 * Event Grid やモック POST のボディを「イベント配列 + 上書きオプション」に正規化する。
 *
 * 配列そのもの・`{ events: [...] }`・単一オブジェクトのいずれでも受け付ける。
 *
 * @param {unknown} requestBody リクエスト JSON
 * @returns {{ events: unknown[], mockOverrides: Record<string, unknown> }}
 */
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

/**
 * Azure Event Grid の購読検証リクエストなら HTTP 200 で validationCode を返して終了する。
 *
 * @param {unknown} requestBody リクエスト JSON
 * @param {import('express').Response} res Express レスポンス
 * @returns {boolean} 検証イベントを処理した場合 true（呼び出し側は return する）
 */
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

/**
 * モックやテスト用の「音声認識結果」オブジェクトを組み立てる。
 *
 * @param {Record<string, unknown>} [overrides] recognizedText など上書き
 * @returns {{ recognizedText: string, confidence: number, language: string, timestamp: string }}
 */
const createSpeechResult = (overrides = {}) => ({
    recognizedText: overrides.recognizedText || DEFAULT_TRANSCRIPT,
    confidence: overrides.confidence ?? 0.92,
    language: 'ja-JP',
    timestamp: new Date().toISOString()
});

/**
 * 認識テキストからお客様の名前らしき部分を正規表現で抜き出す（ルールベース）。
 *
 * @param {string} recognizedText STT 全文
 * @returns {string} 取れなければ空文字
 */
const extractCustomerName = (recognizedText) => {
    const direct = recognizedText.match(/(?:\u304a\u5ba2\u69d8\u306e\u6c0f\u540d\u306f|\u6c0f\u540d\u306f|\u540d\u524d\u306f|\u79c1\u306f)([^ \u3001\u3002,]+)(?:\u3067\u3059|\u3068\u7533\u3057\u307e\u3059)?/u);
    if (direct) {
        return direct[1];
    }

    const fallback = recognizedText.match(/([^ \u3001\u3002,]+)(?:\u3067\u3059|\u3068\u7533\u3057\u307e\u3059)/u);
    return fallback ? fallback[1] : '';
};

/**
 * 認識テキストから数字だけ抜き出して電話番号候補にする。既知の発信番号があれば優先。
 *
 * @param {string} recognizedText STT 全文
 * @param {string} [fallbackPhone] 通話元など別経路の番号
 * @returns {string} 10 桁未満なら空文字
 */
const extractPhoneNumber = (recognizedText, fallbackPhone) => {
    if (fallbackPhone) {
        return fallbackPhone;
    }

    const normalized = recognizedText.replace(/[^\d]/g, '');
    return normalized.length >= 10 ? normalized : '';
};

/**
 * 発話に「部署名」と「表示名」の両方が含まれる最初の社員を返す（priority が小さいほど優先）。
 *
 * @param {string} recognizedText STT 全文
 * @param {Array<Record<string, unknown>>} employees loadEmployees の結果
 * @returns {Record<string, unknown>|null}
 */
const findEmployee = (recognizedText, employees) => {
    const sortedEmployees = [...employees].sort((left, right) => left.priority - right.priority);
    return sortedEmployees.find((employee) =>
        recognizedText.includes(employee.department) && recognizedText.includes(employee.display_name)
    ) || null;
};

/**
 * 用件テキストから部署名・担当者名を除いた「残り」を用件として使う。
 *
 * @param {string} recognizedText STT 全文
 * @param {Record<string, unknown>|null} employee マッチした社員（無ければ全文トリム）
 * @returns {string}
 */
const extractRequirement = (recognizedText, employee) => {
    if (!employee) {
        return recognizedText.trim();
    }

    return recognizedText
        .replace(employee.department, '')
        .replace(employee.display_name, '')
        .trim();
};

/**
 * 発話に FAQ のキーワードが含まれる最初の 1 件を返す（先頭一致の find）。
 *
 * @param {string} recognizedText STT 全文
 * @param {Array<Record<string, unknown>>} faqs loadFaqs の結果
 * @returns {Record<string, unknown>|null}
 */
const findFaqMatch = (recognizedText, faqs) =>
    faqs.find((faq) => recognizedText.includes(faq.keyword)) || null;

/**
 * Event Grid / ACS イベントから短い種別名を得る（例: `Microsoft.Communication.IncomingCall` → `IncomingCall`）。
 *
 * @param {Record<string, unknown>} event イベントオブジェクト
 * @returns {string}
 */
const normalizeEventType = (event) => {
    const raw = event?.eventType || event?.type || '';
    const parts = String(raw).split('.');
    return parts[parts.length - 1];
};

/**
 * 接続文字列があれば Azure Blob クライアントを返す。未設定なら null（Blob 系処理はスキップ）。
 *
 * @param {Record<string, unknown>} config アプリ設定
 * @returns {import('@azure/storage-blob').BlobServiceClient|null}
 */
const getStorageClient = (config) => {
    if (!config.storageConnectionString) {
        return null;
    }
    return BlobServiceClient.fromConnectionString(config.storageConnectionString);
};

/**
 * コンテナが無ければ作成する（冪等）。
 *
 * @param {import('@azure/storage-blob').BlobServiceClient} blobServiceClient
 * @param {string} containerName
 * @returns {Promise<import('@azure/storage-blob').ContainerClient>}
 */
const ensureContainer = async (blobServiceClient, containerName) => {
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();
    return containerClient;
};

/**
 * オブジェクトを JSON 化して Blob にアップロードする。
 *
 * @param {Record<string, unknown>} config
 * @param {string} containerName
 * @param {string} blobName
 * @param {unknown} content シリアライズする値
 * @returns {Promise<string|null>} 公開 URL またはストレージ未設定時は null
 */
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

/**
 * Incoming Webhook URL が設定されていれば Teams にテキスト投稿する。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session セッション（ログ用）
 * @param {string} messageText 送信本文
 * @returns {Promise<Record<string, unknown>>} skipped / deliveredAt など
 */
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

/**
 * 伝言内容を Teams 通知用のプレーンテキストに整形する。
 *
 * @param {Record<string, unknown>} session
 * @returns {string}
 */
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

// ---------------------------------------------------------------------------
// ACS SDK の識別子・応答オブジェクトは循環参照を含むことがあるため、
// セッションに載せるときはプレーンなコピーだけに絞る（JSON 化・ログで壊れないようにする）。
// ---------------------------------------------------------------------------

// 2026-03-23: SDKオブジェクトの循環参照でJSON化に失敗するため、必要最小限の値のみを抽出する形に変更。
// const identifierToPlainObject = (identifier) => safeJsonParse(JSON.stringify(identifier || {}), {});

/**
 * 通話の From/To 等の identifier を、保存用のただのオブジェクトに変換する。
 *
 * @param {Record<string, unknown>|null|undefined} identifier SDK の識別子
 * @returns {Record<string, string>}
 */
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

/**
 * `answerCall` の戻り値から、接続 ID など必要なフィールドだけを取り出す。
 *
 * @param {Record<string, unknown>|null|undefined} answerResult
 * @returns {{ callConnectionId: string, serverCallId: string, targets: Record<string, string>[] }}
 */
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

/**
 * 接続文字列からストレージアカウント名を抜き出す（録音先 URL 組み立て用）。
 *
 * @param {string} connectionString
 * @returns {string}
 */
const getStorageAccountNameFromConnectionString = (connectionString) => {
    const match = String(connectionString || '').match(/AccountName=([^;]+)/i);
    return match ? match[1] : '';
};

/**
 * 録音ファイルの保存先コンテナ URL を決める（明示設定がなければ接続文字列から推測）。
 *
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
const deriveRecordingContainerUrl = (config) => {
    if (config.recordingContainerUrl) {
        return config.recordingContainerUrl;
    }

    const accountName = getStorageAccountNameFromConnectionString(config.storageConnectionString);
    return accountName ? `https://${accountName}.blob.core.windows.net/${RECORDING_CONTAINER}` : '';
};

/**
 * SDK が期待する「相手の識別子」形式へ変換する（電話 / Teams / CommunicationUser など）。
 *
 * @param {Record<string, unknown>|null|undefined} identifier
 * @returns {Record<string, unknown>|null}
 */
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

/**
 * 着信イベントから新しい通話セッションを生成し `state.sessions` に登録する。
 *
 * モック時は認識結果からルート・顧客情報を即埋め、本番は `incoming` のまま ACS 応答待ち。
 *
 * @param {Record<string, unknown>} event IncomingCall 相当のイベント
 * @param {Record<string, unknown>} overrides モック用の上書き（isMock, recognizedText 等）
 * @param {Array<Record<string, unknown>>} employees
 * @returns {Record<string, unknown>} セッションオブジェクト
 */
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
        recordingStopRequested: false,
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
    logEvent('info', '着信:セッション登録', {
        sessionId: sessionId,
        serverCallId: session.serverCallId
    });
    // App Service ログストリーム等での到達確認用（answer 前に必ず1回／セッション単位）。
    logEvent('debug', 'PoC:到達チェック', {
        checkpoint: 'セッションが作成されました',
        sessionId: sessionId,
        serverCallId: session.serverCallId
    });
    logEvent('debug', 'フロー:セッション作成', {
        sessionId: sessionId,
        serverCallId: session.serverCallId,
        sessionStatus: session.status,
        firstRouteFound: session.route.found,
        isMock: session.isMock
    });
    return session;
};

/**
 * Blob に保存する伝言 JSON のペイロードを組み立てる。
 *
 * @param {Record<string, unknown>} session
 * @param {Record<string, unknown>} [overrides] transcript など上書き
 * @returns {Record<string, unknown>}
 */
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

/**
 * Blob のファイル名に使えない文字を除去し、空白をアンダースコアにする。
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
const sanitizeBlobFilePart = (value, fallback = 'unknown') =>
    String(value || fallback)
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, '_');

/**
 * 伝言 JSON 用の Blob 名（日時 + sessionId）を生成する。
 *
 * @param {Record<string, unknown>} messagePayload
 * @returns {string}
 */
const buildMessageBlobName = (messagePayload) => {
    const createdAtPart = sanitizeBlobFilePart(String(messagePayload.createdAt || '').replace(/[.:]/g, '-'), 'no-createdAt');
    const sessionPart = sanitizeBlobFilePart(messagePayload.sessionId, 'no-session');
    return `${createdAtPart}_${sessionPart}.json`;
};

/**
 * AI 要約ジョブ用の Blob 名を生成する。
 *
 * @param {Record<string, unknown>|null|undefined} job
 * @returns {string}
 */
const buildSummaryBlobName = (job) => {
    const createdAtPart = sanitizeBlobFilePart(String(job?.createdAt || '').replace(/[.:]/g, '-'), 'no-createdAt');
    const sessionPart = sanitizeBlobFilePart(job?.sessionId, 'no-session');
    return `${createdAtPart}_${sessionPart}.json`;
};

/**
 * 録音ファイルを自コンテナにコピーするときの名前（分割録音なら part 番号付き）。
 *
 * @param {Record<string, unknown>} session
 * @param {string} sourceUrl 元 Blob の URL
 * @param {number} [index] チャンク index
 * @param {number} [totalCount] チャンク総数
 * @returns {string}
 */
const buildRecordingBlobName = (session, sourceUrl, index = 0, totalCount = 1) => {
    const createdAtPart = sanitizeBlobFilePart(String(session?.createdAt || '').replace(/[.:]/g, '-'), 'no-createdAt');
    const sessionPart = sanitizeBlobFilePart(session?.id, 'no-session');
    const parsed = new URL(sourceUrl);
    const extension = path.extname(parsed.pathname) || '.wav';
    const chunkSuffix = totalCount > 1 ? `_part${String(index + 1).padStart(2, '0')}` : '';
    return `${createdAtPart}_${sessionPart}${chunkSuffix}${extension}`;
};

/**
 * ストレージ内の別コンテナへ Blob をダウンロード→再アップロードで複製する。
 *
 * @param {Record<string, unknown>} config
 * @param {string} sourceUrl コピー元の絶対 URL
 * @param {string} targetContainerName 宛先コンテナ
 * @param {string} targetBlobName 宛先 Blob 名
 * @returns {Promise<string>} 新しい Blob の URL（失敗・未設定時は空文字）
 */
const copyBlobToContainer = async (config, sourceUrl, targetContainerName, targetBlobName) => {
    const blobServiceClient = getStorageClient(config);
    if (!blobServiceClient) {
        logEvent('warn', 'Blob:コピー省略', {
            targetContainer: targetContainerName,
            targetBlobName: targetBlobName,
            reason: 'ストレージクライアント利用不可'
        });
        return '';
    }

    const { containerName: sourceContainerName, blobName: sourceBlobName } = parseBlobUrl(sourceUrl);
    logEvent('debug', 'Blob:コピー開始', {
        sourceContainer: sourceContainerName,
        sourceBlobName: sourceBlobName,
        targetContainer: targetContainerName,
        targetBlobName: targetBlobName
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
    logEvent('debug', 'Blob:コピー完了', {
        sourceContainer: sourceContainerName,
        sourceBlobName: sourceBlobName,
        targetContainer: targetContainerName,
        targetBlobName: targetBlobName,
        byteLength: body.byteLength
    });
    return targetBlobClient.url;
};

/**
 * ACS が返した録音 URL 群を、自前の `RECORDING_CONTAINER` にまとめてコピーする。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @param {string[]} recordingUrls
 * @returns {Promise<string[]>} コピー後の URL（失敗分はスキップ）
 */
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
            logEvent('error', '録音:永続化失敗', {
                sessionId: session.id,
                sourceUrl: sourceUrl,
                targetBlobName: targetBlobName,
                errorMessage: error.message
            });
        }
    }

    return renamedUrls;
};

/**
 * 非同期ジョブ 1 件分の要約結果を `SUMMARY_CONTAINER` に JSON で保存する。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} job
 * @returns {Promise<string>} Blob URL または空
 */
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
    logEvent('info', 'AI要約:保存済み', {
        sessionId: job.sessionId,
        jobId: job.id,
        summaryBlobUrl: url
    });
    return url;
};

/**
 * OpenAI が使えない・失敗したときに返す固定フォーマットの要約オブジェクト。
 *
 * @param {Record<string, unknown>} session
 * @param {string} transcript
 * @returns {Record<string, unknown>}
 */
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

/**
 * Azure OpenAI Chat Completions で通話内容を構造化 JSON 要約する。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @param {string} transcript 要約対象テキスト
 * @returns {Promise<Record<string, unknown>>}
 */
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

/**
 * Blob の HTTPS URL からコンテナ名と Blob 名（パス）を分解する。
 *
 * @param {string} url
 * @returns {{ containerName: string, blobName: string }}
 */
const parseBlobUrl = (url) => {
    const parsed = new URL(url);
    const [, containerName, ...blobParts] = parsed.pathname.split('/');
    return {
        containerName,
        blobName: blobParts.join('/')
    };
};

/**
 * Event Grid の subject から serverCallId を取り出す（URL エンコードを戻す）。
 *
 * @param {string} subject
 * @returns {string}
 */
const getServerCallIdFromSubject = (subject) => {
    const match = String(subject || '').match(/\/serverCallId\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : '';
};

/**
 * 録音関連イベントから、実ファイルの contentLocation URL の配列を得る。
 *
 * @param {Record<string, unknown>} event
 * @returns {string[]}
 */
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

/**
 * 引数のうち最初の「空でない配列」を返す（録音 URL の候補を優先順に試す用途）。
 *
 * @param {...unknown} candidates
 * @returns {unknown[]}
 */
const firstNonEmptyArray = (...candidates) => {
    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length > 0) {
            return candidate.filter(Boolean);
        }
    }
    return [];
};

/**
 * 同じ録音イベントを二度処理しないようキーを記録する（上限超えたら古いものから削除）。
 *
 * @param {string} key
 * @returns {void}
 */
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

/**
 * イベント・セッション・上書きから録音 ID を一貫して取得する。
 *
 * @param {Record<string, unknown>|null|undefined} session
 * @param {Record<string, unknown>} event
 * @param {Record<string, unknown>} [overrides]
 * @returns {string}
 */
const getRecordingIdentity = (session, event, overrides = {}) =>
    overrides.recordingId ||
    event?.data?.recordingId ||
    event?.data?.recordingStorageInfo?.recordingId ||
    session?.recordingId ||
    '';

/**
 * 録音 Blob をダウンロードし、Whisper デプロイで文字起こしする（複数 URL は連結）。
 *
 * @param {Record<string, unknown>} config
 * @param {string[]} blobUrls
 * @param {string} [transcriptOverride] 指定時は API を呼ばずそのまま返す
 * @returns {Promise<string>}
 */
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

/**
 * 録音イベントをきっかけに Whisper → 要約 → Blob 保存 →（未送信なら）Teams 通知まで行う。
 *
 * 同一 `asyncKey` はスキップして二重処理を防ぐ。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>|null} session 紐付け可能なら要約をセッションにも載せる
 * @param {Record<string, unknown>} blobEvent BlobCreated 等
 * @param {Record<string, unknown>} [overrides] transcript や sessionId の上書き
 * @returns {Promise<Record<string, unknown>>}
 */
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
        logEvent('warn', 'フロー:非同期ジョブ重複のためスキップ', {
            sessionId: session?.id || overrides.sessionId || '',
            asyncKeyPreview: truncateForLog(asyncKey, 96)
        });
        return {
            skipped: true,
            reason: 'duplicate-recording-event',
            asyncKey,
            sessionId: session?.id || overrides.sessionId || ''
        };
    }

    logEvent('debug', 'フロー:非同期ジョブ開始', {
        sessionId: session?.id || overrides.sessionId || '',
        blobUrlCount: blobUrls.length,
        eventType: normalizeEventType(blobEvent) || '不明'
    });

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

        logEvent('info', '非同期ジョブ:完了', {
            jobId: job.id,
            sessionId: job.sessionId,
            summaryBlobUrl: job.summaryBlobUrl
        });
        return job;
    } catch (error) {
        logEvent('error', '非同期ジョブ:失敗', {
            sessionId: session?.id || overrides.sessionId || '',
            asyncKey: asyncKey,
            errorMessage: error.message
        });
        throw error;
    }
};

// ---------------------------------------------------------------------------
// 転送タイムアウト用タイマー・ACS クライアント・セッション検索
// ---------------------------------------------------------------------------

/**
 * 転送待ちの setTimeout をクリアする（重複タイムアウト防止）。
 *
 * @param {Record<string, unknown>} session
 * @returns {void}
 */
const clearTransferTimer = (session) => {
    if (session.transfer.timerId) {
        clearTimeout(session.transfer.timerId);
        session.transfer.timerId = null;
    }
};

/**
 * リバースプロキシ（App Service 等）を考慮した公開ベース URL を組み立てる。
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
const getBaseUrl = (req) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${protocol}://${host}`;
};

/**
 * ACS Call Automation 用クライアントを生成する。
 *
 * @param {Record<string, unknown>} config
 * @returns {import('@azure/communication-call-automation').CallAutomationClient}
 */
const getCallAutomationClient = (config) => new CallAutomationClient(config.connectionString);

/**
 * セッションに紐づく `CallConnection` を取得する（ID が無ければ null）。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @returns {import('@azure/communication-call-automation').CallConnection|null}
 */
const getCallConnection = (config, session) => {
    if (!session.callConnectionId) {
        return null;
    }
    return getCallAutomationClient(config).getCallConnection(session.callConnectionId);
};

/**
 * serverCallId でセッションを 1 件探す。
 *
 * @param {string} serverCallId
 * @returns {Record<string, unknown>|undefined}
 */
const findSessionByServerCallId = (serverCallId) =>
    Array.from(state.sessions.values()).find((item) => item.serverCallId === serverCallId);

/**
 * コールバックイベントに含まれる ID（serverCallId / callConnectionId）でセッションを特定する。
 *
 * @param {Record<string, unknown>} event
 * @returns {Record<string, unknown>|undefined}
 */
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

// ---------------------------------------------------------------------------
// 通話メディア: 音声再生・認識・録音・切断
// ---------------------------------------------------------------------------

/**
 * 日本語ニューラル音声でテキストを再生する（`operationContext` は後続の PlayCompleted と対応付け）。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @param {string} text 読み上げ文
 * @param {string} operationContext SDK に渡す文脈キー
 * @returns {Promise<void>}
 */
const playTextPrompt = async (config, session, text, operationContext) => {
    const callConnection = getCallConnection(config, session);
    if (!callConnection) {
        logEvent('warn', 'フロー:再生スキップ', {
            sessionId: session.id,
            operationContext: operationContext,
            reason: '通話接続なし'
        });
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

/**
 * 通話を切断する（接続や API が無い場合は何もしない）。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @returns {Promise<void>}
 */
const tryHangUpCall = async (config, session) => {
    const callConnection = getCallConnection(config, session);
    if (!callConnection || typeof callConnection.hangUp !== 'function') {
        return;
    }

    try {
        await callConnection.hangUp(true);
    } catch (error) {
        logEvent('warn', '通話:切断失敗', {
            sessionId: session.id,
            errorMessage: error.message
        });
    }
};

/**
 * 再生完了などで保留していた「次の一手」（転送実行・FAQ 後処理など）を実行する。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @returns {Promise<void>}
 */
const applyPendingAction = async (config, session) => {
    const pendingAction = session.pendingAction;
    if (pendingAction) {
        logEvent('debug', 'フロー:保留アクション実行', {
            sessionId: session.id,
            pendingTypeLabel: pendingActionTypeLabelForLog(pendingAction.type),
            operationContext: pendingAction.operationContext || ''
        });
    }
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
                logEvent('error', '転送:タイムアウト処理失敗', {
                    sessionId: session.id,
                    errorMessage: error.message
                });
            });
        }, TRANSFER_TIMEOUT_MS);

        try {
            await callConnection.transferCallToParticipant({
                microsoftTeamsUserId: session.route.teamsUserId
            }, {
                operationContext: session.transfer.operationContext
            });

            logEvent('info', '転送:要求送信', {
                sessionId: session.id,
                teamsUserId: session.route.teamsUserId
            });
        } catch (error) {
            clearTransferTimer(session);
            session.transfer.status = 'failed';
            session.status = 'message-required';
            logEvent('error', '転送:要求失敗', {
                sessionId: session.id,
                errorMessage: error.message
            });
            await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
        }
        return;
    }

    if (pendingAction.type === 'guidance-recognize') {
        session.updatedAt = new Date().toISOString();
        logEvent('debug', '案内:認識開始', {
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

/**
 * 保留アクションに紐づく音声再生が失敗したときのフォールバック（伝言収集や切断へ）。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @param {string} operationContext
 * @returns {Promise<void>}
 */
const handlePendingActionPlaybackFailure = async (config, session, operationContext) => {
    logEvent('error', 'FAQ:再生失敗', {
        sessionId: session.id,
        operationContext: operationContext
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

/**
 * 発信者向けに連続認識を開始する（任意で直前にプロンプトを再生）。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @param {string} operationContext 認識結果と対応付けるキー
 * @param {string} [promptText] 認識前に流す案内（省略可）
 * @returns {Promise<void>}
 */
const startRecognize = async (config, session, operationContext, promptText) => {
    const callConnection = getCallConnection(config, session);
    if (!callConnection) {
        logEvent('warn', 'フロー:認識開始スキップ', {
            sessionId: session.id,
            operationContext: operationContext,
            reason: '通話接続なし'
        });
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

    logEvent('debug', 'フロー:音声認識開始', {
        sessionId: session.id,
        operationContext: operationContext,
        hasPlaybackPrompt: Boolean(promptText)
    });

    await callMedia.startRecognizing(toCallAutomationIdentifier(session.from), options);
};

/**
 * 通話の録音を開始し、コールバック URL で状態通知を受け取る設定にする。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @returns {Promise<void>}
 */
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
        session.recordingStopRequested = false;
        logEvent('info', '録音:開始', {
            sessionId: session.id,
            recordingId: session.recordingId
        });
    } catch (error) {
        logEvent('error', '録音:開始失敗', {
            sessionId: session.id,
            errorMessage: error.message
        });
    }
};

/**
 * 進行中の録音を停止する（二重停止や ID なしはスキップ）。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @param {string} [reason] ログ用の理由ラベル
 * @returns {Promise<boolean>} 停止要求を送れたか
 */
const stopRecordingForSession = async (config, session, reason = 'manual-stop') => {
    if (!session?.recordingId) {
        logEvent('warn', '録音:停止スキップ', {
            sessionId: session?.id || '',
            reason: '録音IDなし'
        });
        return false;
    }

    if (session.recordingStopRequested) {
        logEvent('warn', '録音:停止スキップ', {
            sessionId: session.id,
            recordingId: session.recordingId,
            reason: '既に停止要求済み'
        });
        return false;
    }

    try {
        session.recordingStopRequested = true;
        await getCallAutomationClient(config).getCallRecording().stop(session.recordingId);
        logEvent('info', '録音:停止要求', {
            sessionId: session.id,
            recordingId: session.recordingId,
            reason: reason === 'message-saved' ? '伝言保存後' : reason === 'manual-stop' ? '手動停止' : String(reason)
        });
        return true;
    } catch (error) {
        session.recordingStopRequested = false;
        logEvent('error', '録音:停止失敗', {
            sessionId: session.id,
            recordingId: session.recordingId,
            reason: reason === 'message-saved' ? '伝言保存後' : reason === 'manual-stop' ? '手動停止' : String(reason),
            errorMessage: error.message
        });
        return false;
    }
};

/**
 * Recognize 完了イベントから認識テキストを取り出す（フィールド名の揺れを吸収）。
 *
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
const extractRecognizedText = (event) =>
    event?.data?.speechResult?.speech ?? event?.data?.speechResult?.text ?? event?.data?.recognitionResult?.text ?? '';

/**
 * 転送がタイムアウトしたときにタイマー解除し、伝言収集へ移行する。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @returns {Promise<void>}
 */
const transferTimeoutHandler = async (config, session) => {
    if (session.transfer.status === 'connected' || session.status === 'message-saved') {
        return;
    }

    clearTransferTimer(session);
    session.transfer.status = 'timeout';
    session.status = 'message-required';
    session.updatedAt = new Date().toISOString();
    logEvent('warn', '転送:タイムアウト', {
        sessionId: session.id,
        teamsUserId: session.transfer.targetTeamsUserId
    });

    await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
};

/**
 * 担当者への転送を試みる。実接続が無いモックでは `mockTransferOutcome` で結果をシミュレート。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @returns {Promise<void>}
 */
const attemptTransfer = async (config, session) => {
    logEvent('debug', 'フロー:転送試行', {
        sessionId: session.id,
        hasTeamsUserId: Boolean(session.route.teamsUserId),
        isMock: session.isMock
    });

    if (!session.route.teamsUserId) {
        logEvent('warn', 'フロー:転送先なし', { sessionId: session.id });
        session.status = 'message-required';
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
        return;
    }

    const callConnection = getCallConnection(config, session);
    if (!callConnection) {
        if (session.isMock) {
            logEvent('debug', 'フロー:転送（モック分岐）', {
                sessionId: session.id,
                mockTransferOutcome: mockTransferOutcomeLabelForLog(session.mockTransferOutcome || 'timeout')
            });
            if (session.mockTransferOutcome === 'connected') {
                session.transfer.status = 'connected';
                session.status = 'human-connected';
                session.updatedAt = new Date().toISOString();
            } else {
                session.transfer.status = 'timeout';
                session.status = 'message-required';
                await finalizeMessageFallback(config, session, session.rawTranscript || DEFAULT_TRANSCRIPT);
            }
        } else {
            logEvent('warn', 'フロー:転送スキップ（接続なし）', { sessionId: session.id });
        }
        return;
    }

    logEvent('debug', 'フロー:転送待ち案内を予約', { sessionId: session.id });
    session.pendingAction = {
        type: 'transfer-execute',
        operationContext: 'wait-for-transfer'
    };
    try {
        await playTextPrompt(config, session, WAITING_PROMPT, 'wait-for-transfer');
    } catch (error) {
        logEvent('error', '転送:待ち案内失敗', {
            sessionId: session.id,
            errorMessage: error.message
        });
        session.pendingAction = null;
        session.status = 'message-required';
        session.updatedAt = new Date().toISOString();
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
    }
};

/**
 * 伝言を Blob に保存し、完了アナウンス→（モックなら即）切断まで進める。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @param {string} transcript 伝言として扱うテキスト
 * @returns {Promise<void>}
 */
const finalizeMessageFallback = async (config, session, transcript) => {
    logEvent('debug', 'フロー:伝言確定開始', {
        sessionId: session.id,
        transcriptPreview: truncateForLog(transcript || session.rawTranscript || '', 100)
    });
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

    logEvent('info', '伝言:保存済み', {
        sessionId: session.id,
        messageBlobUrl: session.messageBlobUrl
    });

    try {
        await stopRecordingForSession(config, session, 'message-saved');
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
        logEvent('error', '伝言:完了案内失敗', {
            sessionId: session.id,
            errorMessage: error.message
        });
        session.pendingAction = null;
        await tryHangUpCall(config, session);
    }
};

/**
 * ACS Call Automation の RecognizeCompleted を処理する。
 *
 * 認識テキストが欠落した場合はリトライまたはガイダンスへ戻す。
 *
 * @param {object} config サーバー設定
 * @param {object} session 通話セッション
 * @param {object} event コールバックイベント
 * @param {Array<object>} employees 転送先社員一覧
 * @param {Array<object>} faqs FAQ 一覧
 * @returns {Promise<void>}
 */
const handleRecognizeCompleted = async (config, session, event, employees, faqs) => {
    const operationContext = event?.data?.operationContext || '';
    const recognizedText = extractRecognizedText(event);

    logEvent('debug', 'フロー:認識完了を処理', {
        sessionId: session.id,
        operationContext: operationContext,
        hasText: Boolean(recognizedText),
        textPreview: recognizedText ? truncateForLog(recognizedText, 100) : ''
    });

    if (recognizedText) {
        logEvent('debug', 'STT:認識全文', {
            sessionId: session.id,
            operationContext: operationContext,
            recognizedText: recognizedText,
            confidence: event?.data?.speechResult?.confidence ?? null
        });
    }

    if (!recognizedText) {
        if (operationContext === 'collect-message') {
            session.retryCount += 1;
            if (session.retryCount <= RETRY_PROMPT_LIMIT) {
                logEvent('debug', 'フロー:認識空欄・伝言を再試行', {
                    sessionId: session.id,
                    retryCount: session.retryCount,
                    retryLimit: RETRY_PROMPT_LIMIT
                });
                await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
                return;
            }
            logEvent('debug', 'フロー:認識空欄・既定文で伝言確定', { sessionId: session.id });
            await finalizeMessageFallback(config, session, session.rawTranscript || DEFAULT_TRANSCRIPT);
            return;
        }

        logEvent('debug', 'フロー:認識空欄・案内へ戻す', { sessionId: session.id });
        await startRecognize(config, session, 'collect-routing', GUIDANCE_PROMPT);
        return;
    }

    if (operationContext === 'collect-message') {
        logEvent('debug', 'フロー:音声から伝言を取得', {
            sessionId: session.id,
            textPreview: truncateForLog(recognizedText, 100)
        });
        await finalizeMessageFallback(config, session, recognizedText);
        return;
    }

    const faq = findFaqMatch(recognizedText, faqs);
    if (faq) {
        const faqAction = faq.action || 'end';
        const faqActionLabel = faqAction === 'transfer' ? '転送' : faqAction === 'end' ? '終了' : String(faqAction);
        logEvent('debug', 'フロー:FAQに一致', {
            sessionId: session.id,
            keyword: faq.keyword,
            action: faqActionLabel
        });
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
        logEvent('debug', 'フロー:担当者が見つからない', {
            sessionId: session.id,
            textPreview: truncateForLog(recognizedText, 80)
        });
        session.status = 'message-required';
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
        return;
    }

    logEvent('debug', 'フロー:担当者に一致', {
        sessionId: session.id,
        displayName: employee.display_name || '',
        department: employee.department || ''
    });
    await attemptTransfer(config, session);
};

/**
 * 音声認識が失敗したときの分岐（伝言モードはリトライ、それ以外は案内へ戻す）。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @param {Record<string, unknown>} event
 * @returns {Promise<void>}
 */
const handleRecognizeFailed = async (config, session, event) => {
    const operationContext = event?.data?.operationContext || '';
    logEvent('warn', '認識:失敗', {
        sessionId: session.id,
        operationContext: operationContext,
        reason: event?.data?.resultInformation?.message || '不明'
    });

    if (operationContext === 'collect-message') {
        session.retryCount += 1;
        if (session.retryCount <= RETRY_PROMPT_LIMIT) {
            logEvent('debug', 'フロー:認識失敗・伝言を再試行', {
                sessionId: session.id,
                retryCount: session.retryCount,
                retryLimit: RETRY_PROMPT_LIMIT
            });
            await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
            return;
        }
        logEvent('debug', 'フロー:認識失敗・既定文で伝言確定', { sessionId: session.id });
        await finalizeMessageFallback(config, session, session.rawTranscript || DEFAULT_TRANSCRIPT);
        return;
    }

    logEvent('debug', 'フロー:認識失敗・案内へ戻す', { sessionId: session.id });
    await startRecognize(config, session, 'collect-routing', GUIDANCE_PROMPT);
};

/**
 * 転送承認・失敗の ACS イベントを処理する。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} session
 * @param {string} eventType `CallTransferAccepted` または `CallTransferFailed`
 * @param {Record<string, unknown>} event
 * @returns {Promise<void>}
 */
const handleTransferEvent = async (config, session, eventType, event) => {
    if (eventType === 'CallTransferAccepted') {
        clearTransferTimer(session);
        session.transfer.status = 'connected';
        session.status = 'human-connected';
        session.updatedAt = new Date().toISOString();
        logEvent('info', '転送:接続済み', {
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
        logEvent('error', '転送:失敗', {
            sessionId: session.id,
            resultInformation: event?.data?.resultInformation || null
        });
        logEvent('info', 'フロー:転送失敗から伝言収集へ', { sessionId: session.id });
        await startRecognize(config, session, 'collect-message', ABSENT_PROMPT);
    }
};

// ---------------------------------------------------------------------------
// ローカル検証用: Event Grid 形式に近いモックイベントを組み立てる
// ---------------------------------------------------------------------------

/**
 * テスト POST 用の疑似 `Microsoft.Communication.IncomingCall` 配列を返す。
 *
 * @param {Record<string, unknown>} [body] from / serverCallId など上書き
 * @returns {Record<string, unknown>[]}
 */
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

/**
 * テスト POST 用の疑似 `Microsoft.Storage.BlobCreated` 配列を返す。
 *
 * @param {Record<string, unknown>} [body] url / blobName など
 * @returns {Record<string, unknown>[]}
 */
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

/**
 * PoC 関連の HTTP ルートを Express `app` に登録する（本番 Webhook とデバッグ API を含む）。
 *
 * @param {import('express').Application} app
 * @param {Record<string, unknown>} config 接続文字列・OpenAI・Webhook 等
 * @returns {void}
 */
const registerPocRoutes = (app, config) => {
    // --- 検証 UI・設定確認向け（認証なし想定のため本番ではネットワーク制限推奨）---
    /** 社員マスタ（転送先）CSV を JSON で返す。 */
    app.get('/api/poc/employees', async (req, res) => {
        res.status(200).json({ employees: loadEmployees() });
    });

    /** FAQ CSV の内容をそのまま JSON で返す。 */
    app.get('/api/poc/faqs', async (req, res) => {
        res.status(200).json({ faqs: loadFaqs() });
    });

    /** メモリ上のセッション・非同期ジョブ・ログなど PoC 全体のスナップショット（デバッグ用）。 */
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

    /** 着信〜認識〜転送/伝言までを、実 ACS なしでシミュレートする。 */
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

    /** 録音 Blob 作成イベントを模し、Whisper/要約パイプラインだけ試す。 */
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

    // --- ACS / Event Grid から呼ばれる本番系エンドポイント ---
    /** Event Grid または ACS からの着信通知。購入検証・モック・実 answerCall をここで分岐。 */
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
            logEvent('debug', '着信:応答オプション', {
                sessionId: session.id,
                cognitiveEndpointConfigured: Boolean(config.cognitiveServicesEndpoint),
                cognitiveServicesEndpoint: config.cognitiveServicesEndpoint || '',
                hasCallIntelligenceOptions: Boolean(answerOptions.callIntelligenceOptions),
                callbackUrl: session.callbackUri
            });

            const answerResult = await client.answerCall(session.incomingCallContext, session.callbackUri, answerOptions);
            // 2026-03-23: answerResult全体のJSON化をやめ、必要最小限の値のみ保存する。
            session.answerCallResult = answerResultToPlainObject(answerResult);
            session.callConnectionId = session.answerCallResult.callConnectionId || '';
            session.serverCallId = session.answerCallResult.serverCallId || session.serverCallId;
            session.status = 'answered';
            session.updatedAt = new Date().toISOString();

            logEvent('info', 'フロー:着信応答完了', {
                sessionId: session.id,
                callConnectionId: session.callConnectionId,
                serverCallId: session.serverCallId
            });

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

    /** ACS Call Automation のイベント受け口（接続・認識・再生・転送・録音などすべて）。 */
    app.post('/api/callbacks/callAutomation', async (req, res) => {
        try {
            const { events } = parseMockEventRequest(req.body);
            const employees = loadEmployees();
            const faqs = loadFaqs();

            logEvent('debug', 'フロー:コールバック受信', {
                eventCount: events.length,
                eventTypes: events.map((item) => normalizeEventType(item))
            });

            // 1 リクエストに複数イベントが載ることがあるため順に処理する
            for (const event of events) {
                const eventType = normalizeEventType(event);
                const session = findSessionForCallbackEvent(event);
                if (!session) {
                    logEvent('warn', 'フロー:コールバック（セッション未解決）', {
                        eventType: eventType,
                        serverCallId: event?.data?.serverCallId || '',
                        callConnectionId: event?.data?.callConnectionId || event?.callConnectionId || ''
                    });
                    continue;
                }

                session.updatedAt = new Date().toISOString();
                session.lastCallbackEvent = eventType;

                // 通話が確立 → 録音開始 → 案内音声 → 案内終了後に認識開始（pendingAction）
                if (eventType === 'CallConnected') {
                    session.status = 'connected';
                    // 2026-03-23: Recognize 開始時点での状態を確認するための一時ログ。
                    logEvent('info', '通話:接続済み', {
                        sessionId: session.id,
                        callConnectionId: session.callConnectionId,
                        cognitiveEndpointConfigured: Boolean(config.cognitiveServicesEndpoint),
                        cognitiveServicesEndpoint: config.cognitiveServicesEndpoint || ''
                    });
                    // 2026-03-23: 通話未確立状態での録音開始失敗を避けるため、録音開始は CallConnected 後へ移動。
                    await startRecordingForSession(config, session);
                    // 2026-03-23: ガイダンス再生と認識開始を分離し、少なくとも案内は先に流す。
                    session.pendingAction = {
                        type: 'guidance-recognize',
                        operationContext: 'guidance-play'
                    };
                    logEvent('info', '案内:再生要求', {
                        sessionId: session.id,
                        callConnectionId: session.callConnectionId,
                        operationContext: 'guidance-play'
                    });
                    await playTextPrompt(config, session, GUIDANCE_PROMPT, 'guidance-play');
                    continue;
                }

                // 話者の発話が確定（FAQ / 転送 / 伝言の分岐は handleRecognizeCompleted）
                if (eventType === 'RecognizeCompleted') {
                    await handleRecognizeCompleted(config, session, event, employees, faqs);
                    continue;
                }

                // ノイズ等で認識失敗 → リトライまたは案内へ戻す
                if (eventType === 'RecognizeFailed') {
                    await handleRecognizeFailed(config, session, event);
                    continue;
                }

                // Teams 転送の結果（成功なら人間対応中、失敗なら伝言へ）
                if (eventType === 'CallTransferAccepted' || eventType === 'CallTransferFailed') {
                    await handleTransferEvent(config, session, eventType, event);
                    continue;
                }

                // 音声再生が終わったら、保留中の次処理（転送実行・FAQ 後続など）を起動
                if (eventType === 'PlayCompleted') {
                    const operationContext = event?.data?.operationContext || '';
                    if (operationContext === 'guidance-play') {
                        logEvent('info', '案内:再生完了', {
                            sessionId: session.id,
                            callConnectionId: session.callConnectionId,
                            operationContext: operationContext
                        });
                    }
                    if (session.pendingAction?.operationContext === operationContext) {
                        if (operationContext !== 'guidance-play') {
                            logEvent('debug', 'フロー:再生完了（保留へ）', {
                                sessionId: session.id,
                                operationContext: operationContext,
                                pendingTypeLabel: pendingActionTypeLabelForLog(session.pendingAction.type)
                            });
                        }
                        await applyPendingAction(config, session);
                    }
                    continue;
                }

                // 案内や FAQ 回答の再生に失敗したときの救済
                if (eventType === 'PlayFailed') {
                    const operationContext = event?.data?.operationContext || '';
                    if (operationContext === 'guidance-play') {
                        logEvent('error', '案内:再生失敗', {
                            sessionId: session.id,
                            callConnectionId: session.callConnectionId,
                            operationContext: operationContext,
                            resultInformation: event?.data?.resultInformation || null
                        });
                    }
                    if (session.pendingAction?.operationContext === operationContext) {
                        await handlePendingActionPlaybackFailure(config, session, operationContext);
                    }
                    continue;
                }

                // 相手が切電
                if (eventType === 'CallDisconnected') {
                    clearTransferTimer(session);
                    session.status = session.status === 'human-connected' ? 'completed' : session.status;
                    logEvent('info', '通話:切断', {
                        sessionId: session.id,
                        callConnectionId: session.callConnectionId
                    });
                    continue;
                }

                // 録音ファイルがストレージ上で利用可能になった通知 → 自コンテナへコピーして URL をセッションに保持
                if (eventType === 'RecordingFileStatusUpdated') {
                    const contentLocations = getRecordingContentLocations(event);
                    logEvent('debug', '録音:ステータス更新を受信', {
                        sessionId: session.id,
                        recordingId: event?.data?.recordingId || event?.data?.recordingStorageInfo?.recordingId || '',
                        recordingChunkCount: contentLocations.length
                    });
                    if (contentLocations.length > 0) {
                        const persistedRecordingUrls = await persistRecordingsForSession(config, session, contentLocations);
                        session.recordingBlobUrl = persistedRecordingUrls[0] || contentLocations[0];
                        session.recordingBlobUrls = persistedRecordingUrls.length > 0 ? persistedRecordingUrls : contentLocations;
                        session.recordingId = event?.data?.recordingId || event?.data?.recordingStorageInfo?.recordingId || session.recordingId;
                        session.recordingStopRequested = true;
                        session.updatedAt = new Date().toISOString();
                        logEvent('info', '録音:ファイル準備完了', {
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

    /** ストレージの Blob 作成や録音完了を Event Grid 経由で受け、要約ジョブを起動する。 */
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

            logEvent('info', 'Blob:作成イベント受信', {
                sessionId: session?.id || mockOverrides.sessionId || '',
                eventType: normalizeEventType(selectedEvent),
                recordingUrlCount: recordingUrls.length
            });

            if (session && recordingUrls.length > 0) {
                const persistedRecordingUrls = await persistRecordingsForSession(config, session, recordingUrls);
                session.recordingBlobUrl = persistedRecordingUrls[0] || recordingUrls[0];
                session.recordingBlobUrls = persistedRecordingUrls.length > 0 ? persistedRecordingUrls : recordingUrls;
                session.recordingId = getRecordingIdentity(session, selectedEvent, mockOverrides);
                session.recordingStopRequested = true;
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

/** 他モジュールから使うのはルート登録関数のみ（サーバー本体が require する）。 */
module.exports = {
    registerPocRoutes
};
