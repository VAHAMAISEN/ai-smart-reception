# AI Smart Reception PoC

This project is an App Service centered PoC for inbound PSTN handling.

- Real-time path: `IncomingCall -> answerCall -> recognize -> optimistic transfer -> timeout fallback -> message save`
- Async path: `RecordingFileStatusUpdated and/or BlobCreated -> Whisper -> gpt-5.2 summary/classification -> Teams webhook`
- Verification UI: mock incoming call, session state, employee CSV, async AI results

## Runtime overview

- Incoming call webhook: `/api/incomingCall`
- Call Automation callback: `/api/callbacks/callAutomation`
- Storage event webhook: `/api/events/blobCreated`
- Verification state: `/api/poc/state`
- Verification helpers:
  - `/api/poc/mockIncomingCall`
  - `/api/poc/mockBlobCreated`
  - `/api/poc/employees`
  - `/api/poc/faqs`

## Configuration

Required App Settings:

- `ACS_CONNECTION_STRING`
- `AZURE_STORAGE_CONNECTION_STRING`
- `COGNITIVE_SERVICES_ENDPOINT`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_OPENAI_API_DEPLOYMENT_NAME`
- `AZURE_OPENAI_WHISPER_API_VERSION`
- `AZURE_OPENAI_WHISPER_DEPLOYMENT_NAME`
- `TEAMS_SUCCESS_WEBHOOK_URL`

Optional:

- `APPINSIGHTS_CONNECTION_STRING`
- `RECORDING_DESTINATION_CONTAINER_URL`

Blob containers expected by the PoC:

- `call-recordings`
- `call-messages`

If `RECORDING_DESTINATION_CONTAINER_URL` is omitted, the server derives
`https://<storage-account>.blob.core.windows.net/call-recordings` from
`AZURE_STORAGE_CONNECTION_STRING`.

For BYOS recording, the ACS resource must also have permission to write to the
target storage account/container.

Employee routing file:

- `Project/data/employees.csv`

FAQ routing file:

- `Project/data/faq.csv`

## Local run

From `Project/`:

```powershell
npm install
npm run start-local
```

Open `http://localhost:5000`.

## Example mock requests

Incoming call:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:5000/api/poc/mockIncomingCall `
  -ContentType 'application/json' `
  -Body '{"recognizedText":"\u55b6\u696d\u90e8 \u4f50\u85e4\u3055\u3093\u306b\u3064\u306a\u3044\u3067\u304f\u3060\u3055\u3044\u3002\u7528\u4ef6\u306f\u898b\u7a4d\u306e\u76f8\u8ac7\u3067\u3059\u3002\u6c0f\u540d\u306f\u7530\u4e2d\u3001\u96fb\u8a71\u756a\u53f7\u306f09012345678\u3067\u3059\u3002","phoneNumber":"+819012345678","transferOutcome":"timeout"}'
```

FAQ answer only:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:5000/api/poc/mockIncomingCall `
  -ContentType 'application/json' `
  -Body '{"recognizedText":"\u8cde\u5473\u671f\u9650\u3092\u6559\u3048\u3066\u304f\u3060\u3055\u3044","phoneNumber":"+819012345678"}'
```

Async post-processing:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:5000/api/poc/mockBlobCreated `
  -ContentType 'application/json' `
  -Body '{"sessionId":"<session-id>","transcript":"\u4f50\u85e4\u3055\u3093\u306f\u4e0d\u5728\u3067\u3057\u305f\u3002\u898b\u7a4d\u306e\u4ef6\u3067\u6298\u308a\u8fd4\u3057\u304a\u9858\u3044\u3057\u307e\u3059\u3002\u6c0f\u540d\u306f\u7530\u4e2d\u3001\u96fb\u8a71\u756a\u53f7\u306f09012345678\u3067\u3059\u3002"}'
```

## Cloud Shell container deployment

This repository is containerized from the **repo root**, not from `Project/`.

Expected structure after unzip:

```text
communication-services-web-calling-tutorial-main/
  Dockerfile
  .dockerignore
  Project/
```

Recommended Cloud Shell steps:

```bash
cd /home/<your-user>

mv communication-services-web-calling-tutorial-main communication-services-web-calling-tutorial-main.bak.$(date +%Y%m%d%H%M%S) 2>/dev/null || true
rm -f communication-services-web-calling-tutorial-main.zip
```

Upload the zip manually from your local PC, then:

```bash
unzip communication-services-web-calling-tutorial-main.zip -d communication-services-web-calling-tutorial-main

cd /home/<your-user>/communication-services-web-calling-tutorial-main

az acr build \
  --registry pocasracr01 \
  --image ai-smart-reception:latest \
  .
```

Apply App Service settings before first restart:

```bash
cd /home/<your-user>/communication-services-web-calling-tutorial-main/Project

az webapp config appsettings set \
  --resource-group ai-smart-reception \
  --name poc-asr-asp01 \
  --settings "@appsettings.json"
```

Point the Web App to the newly built image:

```bash
az webapp config container set \
  --name poc-asr-asp01 \
  --resource-group ai-smart-reception \
  --docker-custom-image-name pocasracr01.azurecr.io/ai-smart-reception:latest \
  --docker-registry-server-url https://pocasracr01.azurecr.io

az webapp restart \
  --name poc-asr-asp01 \
  --resource-group ai-smart-reception

az webapp log tail \
  --name poc-asr-asp01 \
  --resource-group ai-smart-reception
```

Notes:

- The container listens on `8080`.
- `WEBSITES_PORT=8080` is included in `Project/appsettings.json` and should be applied to App Service.
- The app starts from `Project/package.json`.
- `Dockerfile` installs devDependencies because `webpack-dev-server` is used at runtime.
- `Dockerfile` uses `npm install` instead of `npm ci` because the current checked-in
  `Project/package-lock.json` is not fully synchronized with `Project/package.json`.
- `COGNITIVE_SERVICES_ENDPOINT`, `ACS_CONNECTION_STRING`, Storage, OpenAI, and Teams webhook settings must be present in `Project/appsettings.json`.
