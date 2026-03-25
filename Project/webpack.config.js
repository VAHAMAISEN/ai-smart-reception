const { CommunicationIdentityClient } = require("@azure/communication-identity");
const HtmlWebPackPlugin = require("html-webpack-plugin");
const bodyParser = require('body-parser');
const serverConfig = require("./serverConfig.json");
const clientConfigFile = require("./clientConfig.json");
const { registerPocRoutes } = require('./pocServer');

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

const clientConfig = {
    appInsightsConnectionString:
        process.env.APPINSIGHTS_CONNECTION_STRING || clientConfigFile.appInsightsConnectionString
};

if (!config.connectionString || config.connectionString.indexOf('endpoint=') === -1) {
    throw new Error("Set ACS_CONNECTION_STRING or update `serverConfig.json` with connection string");
}

const communicationIdentityClient = new CommunicationIdentityClient(config.connectionString);
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
