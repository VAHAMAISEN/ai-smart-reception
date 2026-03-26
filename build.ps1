<#
.SYNOPSIS
    ACRビルド & App Serviceデプロイ スクリプト
.DESCRIPTION
    カレントディレクトリのDockerfileをACR上でビルドし、
    確認後にApp Serviceへデプロイする。
    Dockerfileと同じ階層にこのファイルを置いて実行する。

    想定読者: エンジニア以外でも「Azure に新しいコンテナ版を載せたい」場合に、
    対話プロンプトに従えば同じ手順を再現できるようにしています。
.NOTES
    前提: Azure CLI (az) が入り、`az login` でサブスクリプションに入れること。
    変数 $ACR_NAME 等は環境に合わせてスクリプト上部で編集してください。
    ビルドはクラウド側（ACR の `az acr build`）で行うため、ローカルに Docker が無くても動きます。
    再起動後のログストリームは一度切れることがあり、切断後は数秒おきに自動再接続します（終了は Ctrl+C）。
#>

# ============================================
#  設定
# ============================================
$ACR_NAME       = "pocasracr01"
$IMAGE_NAME     = "ai-smart-reception"
$APP_NAME       = "poc-asr-asp01"
$RESOURCE_GROUP = "ai-smart-reception"

# タグ自動生成: fix-yyyyMMdd-HHmm
$TAG = "fix-$(Get-Date -Format 'yyyyMMdd-HHmm')"
$FULL_IMAGE = "${IMAGE_NAME}:${TAG}"
$ACR_IMAGE  = "${ACR_NAME}.azurecr.io/${FULL_IMAGE}"

# 再起動直後に log tail するとストリームがすぐ切れて以降ログが出ないことがあるため、先に待機する。
$LOG_TAIL_WAIT_AFTER_RESTART_SEC = 30
# ストリーム終了後、再度 az webapp log tail するまでの待ち（コンテナ起動が遅いと何度か繰り返す）。
$LOG_TAIL_RECONNECT_DELAY_SEC = 8

# ============================================
#  事前チェック
# ============================================
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ACR ビルド & デプロイ" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Dockerfile の存在確認
if (-not (Test-Path ".\Dockerfile")) {
    Write-Host "[エラー] カレントディレクトリに Dockerfile が見つかりません。" -ForegroundColor Red
    Write-Host "  Dockerfile があるフォルダでこのスクリプトを実行してください。" -ForegroundColor Red
    Write-Host ""
    Read-Host "Enter キーで終了します"
    exit 1
}

# Azure CLI の確認
$azCmd = Get-Command az -ErrorAction SilentlyContinue
if (-not $azCmd) {
    Write-Host "[エラー] Azure CLI がインストールされていません。" -ForegroundColor Red
    Write-Host "  先に setup-azure-cli.ps1 を実行してください。" -ForegroundColor Red
    Write-Host ""
    Read-Host "Enter キーで終了します"
    exit 1
}

# ログイン状態の確認
Write-Host "Azure ログイン状態を確認中..." -ForegroundColor Gray
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "[情報] 未ログインです。ブラウザで認証します..." -ForegroundColor Yellow
    az login
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[エラー] ログインに失敗しました。" -ForegroundColor Red
        Read-Host "Enter キーで終了します"
        exit 1
    }
} else {
    Write-Host "[OK] ログイン済み: $($account.user.name)" -ForegroundColor Green
    Write-Host "  サブスクリプション: $($account.name)" -ForegroundColor Gray
}
Write-Host ""

# ============================================
#  Step 1: ACR ビルド
# ============================================
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "  Step 1: ACR 上でイメージをビルド" -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "  レジストリ   : $ACR_NAME" -ForegroundColor Gray
Write-Host "  イメージ     : $FULL_IMAGE" -ForegroundColor Gray
Write-Host "  ビルド対象   : $(Get-Location)" -ForegroundColor Gray
Write-Host ""

Write-Host "ビルド中..." -ForegroundColor Yellow
az acr build --registry $ACR_NAME --image $FULL_IMAGE .

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[エラー] ACR ビルドに失敗しました。" -ForegroundColor Red
    Read-Host "Enter キーで終了します"
    exit 1
}

Write-Host ""
Write-Host "[OK] ビルド完了: $FULL_IMAGE" -ForegroundColor Green
Write-Host ""

# ============================================
#  Step 2: デプロイ確認
# ============================================
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "  Step 2: App Service へデプロイ" -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "  App Service  : $APP_NAME" -ForegroundColor Gray
Write-Host "  新イメージ   : $ACR_IMAGE" -ForegroundColor Gray
Write-Host ""

$confirm = Read-Host "このイメージを App Service にデプロイしますか？ (y/n)"
if ($confirm -ne "y") {
    Write-Host ""
    Write-Host "[中止] デプロイをスキップしました。ビルド済みイメージは ACR に残っています:" -ForegroundColor Yellow
    Write-Host "  $ACR_IMAGE" -ForegroundColor Gray
    Write-Host ""
    Read-Host "Enter キーで終了します"
    exit 0
}

# ============================================
#  Step 3: コンテナイメージ切り替え
# ============================================
Write-Host ""
Write-Host "コンテナイメージを切り替え中..." -ForegroundColor Yellow

az webapp config container set `
    --name $APP_NAME `
    --resource-group $RESOURCE_GROUP `
    --docker-custom-image-name $ACR_IMAGE `
    --docker-registry-server-url "https://${ACR_NAME}.azurecr.io"

if ($LASTEXITCODE -ne 0) {
    Write-Host "[エラー] コンテナイメージの切り替えに失敗しました。" -ForegroundColor Red
    Read-Host "Enter キーで終了します"
    exit 1
}

Write-Host "[OK] コンテナイメージを更新しました。" -ForegroundColor Green
Write-Host ""

# ============================================
#  Step 4: App Service 再起動
# ============================================
Write-Host "App Service を再起動中..." -ForegroundColor Yellow
az webapp restart --name $APP_NAME --resource-group $RESOURCE_GROUP

if ($LASTEXITCODE -ne 0) {
    Write-Host "[エラー] 再起動に失敗しました。" -ForegroundColor Red
    Read-Host "Enter キーで終了します"
    exit 1
}

Write-Host "[OK] App Service を再起動しました。" -ForegroundColor Green
Write-Host ""

# ============================================
#  Step 5: ログ確認
# ============================================
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "  Step 5: ログストリーム" -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "  再起動後 ${LOG_TAIL_WAIT_AFTER_RESTART_SEC} 秒待ってから接続します（起動が遅い場合はスクリプト先頭の変数を増やしてください）。" -ForegroundColor Gray
Write-Host "  切断後は ${LOG_TAIL_RECONNECT_DELAY_SEC} 秒ごとに自動再接続します。終了は Ctrl+C。" -ForegroundColor Gray
Write-Host ""

Start-Sleep -Seconds $LOG_TAIL_WAIT_AFTER_RESTART_SEC

while ($true) {
    az webapp log tail --name $APP_NAME --resource-group $RESOURCE_GROUP
    Write-Host ""
    Write-Host "[情報] ログストリームが終了しました。${LOG_TAIL_RECONNECT_DELAY_SEC} 秒後に再接続します… (終了は Ctrl+C)" -ForegroundColor Yellow
    Start-Sleep -Seconds $LOG_TAIL_RECONNECT_DELAY_SEC
}