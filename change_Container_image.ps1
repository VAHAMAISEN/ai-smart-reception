<#
.SYNOPSIS
    App Service のコンテナイメージ切り替えスクリプト
.DESCRIPTION
    ACR のイメージ一覧を表示し、番号で選択して切り替える。
    現在実行中のイメージにはマークを表示する。
    0 を選択するとキャンセルできる。

    用途: すでに ACR に複数タグのイメージがあるとき、「どれを本番 App Service で動かすか」
    をビルドし直さずに切り替えたい場合に使います（ロールバックにも便利です）。
.NOTES
    `build.ps1` が作ったタグ一覧から選ぶ形です。Azure CLI とログインが必要です。
    切り替え後に App Service を再起動するため、短い間ダウンタイムが発生します。
    ログストリームは切断後に自動再接続します（終了は Ctrl+C）。起動が遅いサイトは $LOG_TAIL_WAIT_AFTER_RESTART_SEC を増やしてください。
#>

# ============================================
#  設定
# ============================================
$ACR_NAME       = "pocasracr01"
$IMAGE_NAME     = "ai-smart-reception"
$APP_NAME       = "poc-asr-asp01"
$RESOURCE_GROUP = "ai-smart-reception"

# 再起動直後に log tail するとストリームがすぐ切れて以降ログが出ないことがあるため、先に待機する。
$LOG_TAIL_WAIT_AFTER_RESTART_SEC = 30
# ストリーム終了後、再度 az webapp log tail するまでの待ち。
$LOG_TAIL_RECONNECT_DELAY_SEC = 8

# ============================================
#  事前チェック
# ============================================
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  イメージ切り替えツール" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Azure CLI の確認
$azCmd = Get-Command az -ErrorAction SilentlyContinue
if (-not $azCmd) {
    Write-Host "[エラー] Azure CLI がインストールされていません。" -ForegroundColor Red
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
}
Write-Host ""

# ============================================
#  現在のイメージを取得
# ============================================
Write-Host "現在の設定を取得中..." -ForegroundColor Gray
$containerConfig = az webapp config container show --name $APP_NAME --resource-group $RESOURCE_GROUP -o json 2>$null | ConvertFrom-Json
$currentImage = ($containerConfig | Where-Object { $_.name -eq "DOCKER_CUSTOM_IMAGE_NAME" }).value
# "DOCKER|pocasracr01.azurecr.io/ai-smart-reception:tag" からタグ部分を抽出
$currentTag = if ($currentImage -match ":([^:]+)$") { $Matches[1] } else { "unknown" }

# ============================================
#  タグ一覧を取得
# ============================================
Write-Host "ACR のイメージ一覧を取得中..." -ForegroundColor Gray
$tags = az acr repository show-tags --name $ACR_NAME --repository $IMAGE_NAME --orderby time_desc -o tsv 2>$null

if (-not $tags) {
    Write-Host "[エラー] イメージ一覧を取得できませんでした。" -ForegroundColor Red
    Read-Host "Enter キーで終了します"
    exit 1
}

$tagList = $tags -split "`n" | Where-Object { $_ -ne "" }

# ============================================
#  一覧表示
# ============================================
Write-Host ""
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "  イメージ一覧" -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host ""

for ($i = 0; $i -lt $tagList.Count; $i++) {
    $tag = $tagList[$i].Trim()
    $num = $i + 1

    if ($tag -eq $currentTag) {
        Write-Host "  [$num] $tag  <-- 実行中" -ForegroundColor Green
    } else {
        Write-Host "  [$num] $tag" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "  [0] キャンセル（何もしない）" -ForegroundColor DarkGray
Write-Host ""

# ============================================
#  選択
# ============================================
$selection = Read-Host "切り替え先の番号を入力してください"

# キャンセル
if ($selection -eq "0") {
    Write-Host ""
    Write-Host "[中止] 何も変更しませんでした。" -ForegroundColor Yellow
    Read-Host "Enter キーで終了します"
    exit 0
}

# 入力チェック
$index = $null
if (-not [int]::TryParse($selection, [ref]$index) -or $index -lt 1 -or $index -gt $tagList.Count) {
    Write-Host ""
    Write-Host "[エラー] 無効な番号です。" -ForegroundColor Red
    Read-Host "Enter キーで終了します"
    exit 1
}

$selectedTag = $tagList[$index - 1].Trim()

# 実行中と同じタグを選んだ場合
if ($selectedTag -eq $currentTag) {
    Write-Host ""
    Write-Host "[情報] 選択したイメージは現在実行中のものと同じです。" -ForegroundColor Yellow
    Read-Host "Enter キーで終了します"
    exit 0
}

# ============================================
#  切り替え確認
# ============================================
$ACR_IMAGE = "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${selectedTag}"

Write-Host ""
Write-Host "  現在のイメージ : $currentTag" -ForegroundColor Gray
Write-Host "  切り替え先     : $selectedTag" -ForegroundColor White
Write-Host ""

$confirm = Read-Host "切り替えますか？ (y/n)"
if ($confirm -ne "y") {
    Write-Host ""
    Write-Host "[中止] 何も変更しませんでした。" -ForegroundColor Yellow
    Read-Host "Enter キーで終了します"
    exit 0
}

# ============================================
#  コンテナイメージ切り替え
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
#  App Service 再起動
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
#  ログ確認
# ============================================
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "  ログストリーム" -ForegroundColor Cyan
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