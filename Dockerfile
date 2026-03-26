# -----------------------------------------------------------------------------
# AI スマート受付 PoC をコンテナで動かすための Docker イメージ定義です。
# Azure Container Registry（ACR）でビルドし、App Service for Containers から起動する想定です。
# -----------------------------------------------------------------------------

FROM node:20-bookworm-slim

WORKDIR /app/Project

# 依存関係だけ先にコピーして npm install することで、ソース変更時の Docker レイヤーキャッシュを効かせます。
COPY Project/package.json Project/package-lock.json ./

# リポジトリにコミットされた lock が package.json とずれている場合があるため、
# `npm ci` ではなく `npm install` で解決可能にしています（ACR ビルド失敗を避ける目的）。
RUN npm install

# アプリ本体（サーバー・フロントソース・設定 JSON など）をコピー。
COPY Project/ ./

# コンテナ外からアクセスできるよう 0.0.0.0 で待ち受け。App Service もこの形を期待します。
ENV HOST=0.0.0.0
ENV port=8080
# 開発モードのまま起動（サンプル既定）。本番では production への切り替えを検討してください。
ENV NODE_ENV=development

EXPOSE 8080

# package.json の `start`（通常は webpack-dev-server または node サーバー）を起動。
CMD ["npm", "start"]
