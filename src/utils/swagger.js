// ============================================================
// 📚 SWAGGER API DOCUMENTATION
// ============================================================

const swaggerJsdoc = require('swagger-jsdoc');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Nobita Bot API',
            version: '3.1.0',
            description: 'API documentation for Nobita Video Downloader Bot',
            contact: {
                name: 'Admin',
                email: 'admin@nobita.bot',
            },
        },
        servers: [
            {
                url: '/api',
                description: 'Development server',
            },
        ],
        components: {
            securitySchemes: {
                BearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
    },
    apis: ['./src/routes/*.js'],
};

const specs = swaggerJsdoc(options);

module.exports = specs;
