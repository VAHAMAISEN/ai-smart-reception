/**
 * @fileoverview フロントエンド（React）のバンドル設定と、開発用ミニサーバーの API 定義を兼ねたファイルです。
 *
 * webpack が `src/index.js` から依存を辿って 1 つのバンドルを作り、`webpack-dev-server` が
 * ブラウザ向けに配信します。同じサーバーに body-parser を載せ、ACS トークン発行や PoC API を
 * 同一オリジンで提供するため、フロントから相対 URL のまま `axios` できます。
 *
 * 本番の App Service（コンテナ）では `npm start` 側のサーバーが別途あり得ますが、
 * ローカル検証の中心はこの devServer 構成です。
 */

const { CommunicationIdentityClient } = require("@azure/communication-identity");
const HtmlWebPackPlugin = require("html-webpack-plugin");
const bodyParser = require('body-parser');
const serverConfig = require("./serverConfig.json");
const clientConfigFile = require("./clientConfig.json");
const { registerPocRoutes } = require('./pocServer');

/** サーバー専用。ACS・Storage・OpenAI・Teams Webhook など。環境変数があれば JSON より優先されます。 */
const config = {
    connectionString: process.env.ACS_CONNECTION_STRING || serverConfig.connectionString,
    storageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
    recordingContainerUrl: process.env.RECORDING_DESTINATION_CONTAINER_URL || '',
    cognitiveServicesEndpoint: process.env.COGNITIVE_SERVICES_ENDPOINT || process.env.AZURE_AI_SERVICES_ENDPOINT || '',
    openAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    openAiApiKey: process.env.AZURE_OPENAI_API_KEY || '',
    openAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-01-preview',
    openAiDeploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME || '',
    whisperApiVersion: process.env.AZURE_OPENAI_WHISPER_API_VERSION || '2024-06-01',
    whisperDeploymentName: process.env.AZURE_OPENAI_WHISPER_DEPLOYMENT_NAME || '',
    teamsWebhookUrl: process.env.TEAMS_SUCCESS_WEBHOOK_URL || ''
};

/** ブラウザに公開してよいクライアント設定（例: App Insights 接続文字列）。秘密情報は載せないこと。 */
const clientConfig = {
    appInsightsConnectionString:
        process.env.APPINSIGHTS_CONNECTION_STRING || clientConfigFile.appInsightsConnectionString
};

if (!config.connectionString || config.connectionString.indexOf('endpoint=') === -1) {
    throw new Error("Set ACS_CONNECTION_STRING or update `serverConfig.json` with connection string");
}

/** ACS Identity SDK クライアント。ユーザーの作成とトークン発行に使用。 */
const communicationIdentityClient = new CommunicationIdentityClient(config.connectionString);
/** 開発サーバーの待ち受けポート。コンテナでは環境変数 `port` と揃えることが多いです。 */
const PORT = process.env.port || 8080;

module.exports = {
    devtool: 'inline-source-map',
    mode: 'development',
    entry: "./src/index.js",
    module: {
        rules: [
            {
                test: /\.(js|jsx)$/,
                exclude: /node_modules/,
                use: {
                    loader: "babel-loader"
                }
            },
            {
                test: /\.html$/,
                use: [
                    {
                        loader: "html-loader"
                    }
                ]
            },
            {
                test: /\.css$/,
                use: ["style-loader", "css-loader"]
            }
        ]
    },
    plugins: [
        new HtmlWebPackPlugin({
            template: "./public/index.html",
            filename: "./index.html"
        })
    ],
    devServer: {
        open: true,
        port: PORT,
        static: './public',
        allowedHosts: [
            '.azurewebsites.net'
        ],
        webSocketServer: false,
        // Express 互換の `app` に PoC / トークン API を生やすフック。
        setupMiddlewares: (middlewares, devServer) => {
            if (!devServer) {
                throw new Error('webpack-dev-server is not defined');
            }

            devServer.app.use(bodyParser.json({ limit: '20mb' }));
            devServer.app.use(bodyParser.urlencoded({ extended: true }));

            devServer.app.get('/health', async (req, res) => {
                res.status(200).json({
                    status: 'ok',
                    app: 'ai-smart-reception-poc'
                });
            });

            devServer.app.get('/clientConfig', async (req, res) => {
                res.setHeader('Content-Type', 'application/json');
                res.status(200).json(clientConfig);
            });

            devServer.app.post('/getCommunicationUserToken', async (req, res) => {
                try {
                    const communicationUserId = req.body.communicationUserId;
                    const isJoinOnlyToken = req.body.isJoinOnlyToken === true;
                    const communicationUserIdentifier = communicationUserId
                        ? { communicationUserId }
                        : await communicationIdentityClient.createUser();

                    const communicationUserToken = await communicationIdentityClient.getToken(
                        communicationUserIdentifier,
                        [isJoinOnlyToken ? "voip.join" : "voip"]
                    );

                    res.setHeader('Content-Type', 'application/json');
                    res.status(200).json({
                        communicationUserToken,
                        userId: communicationUserIdentifier
                    });
                } catch (error) {
                    console.error('Error provisioning communication user token', error);
                    res.sendStatus(500);
                }
            });

            registerPocRoutes(devServer.app, config);

            return middlewares;
        }
    }
};
