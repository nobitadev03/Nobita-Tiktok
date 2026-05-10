// ============================================================
// ⚙️ CONFIGURATION MODULE
// ============================================================

require('dotenv').config();

module.exports = {
    // Telegram Bot
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        adminId: parseInt(process.env.ADMIN_USER_ID || '0'),
        apiUrl: 'https://api.telegram.org',
    },

    // Server
    server: {
        port: parseInt(process.env.PORT || '3000'),
        env: process.env.NODE_ENV || 'development',
        url: process.env.RENDER_EXTERNAL_URL || process.env.BOT_URL || 'http://localhost:3000',
    },

    // Database
    database: {
        type: process.env.DB_TYPE || 'sqlite',
        path: process.env.DB_PATH || './data/bot.db',
        // For future PostgreSQL support:
        // host: process.env.DB_HOST,
        // port: process.env.DB_PORT,
        // name: process.env.DB_NAME,
        // user: process.env.DB_USER,
        // password: process.env.DB_PASSWORD,
    },

    // Dashboard & Security
    dashboard: {
        token: process.env.DASHBOARD_TOKEN || 'nobita_admin',
        enablePanel: true,
        autoCleanup: true,
        cleanupInterval: 24 * 60 * 60 * 1000, // 24 hours
    },

    // Performance
    performance: {
        maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT_REQUESTS || '5'),
        rateLimitWindow: 10000,
        defaultRateLimit: 3,
        maxFileSizeMB: 50,
        timeoutMs: 60000,
    },

    // Caching
    cache: {
        mp3Ttl: 30 * 60 * 1000,
        slideshowTtl: 30 * 60 * 1000,
        quizTtl: 10 * 60 * 1000,
    },

    // Bot Settings
    bot: {
        version: '3.1.0',
        name: 'Nobita Downloader',
        captionText: '┏━━━━━━━━━━━━━━━━━━┓\n┃  🎬 NOBITA DOWNLOADER \n┗━━━━━━━━━━━━━━━━━━┛\n\n👤 Admin: @phamtheson\n⭐ Powered by Nobita Bot v3.1',
        features: {
            supportTikTokHD: true,
            mp3Button: true,
            funMode: true,
            funChance: 0.3,
            autoDeleteProcessing: true,
            notifyAdmin: true,
            autoBanSpam: true,
        },
    },

    // Logging
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        dir: './logs',
        maxSize: '10m',
        maxFiles: 14,
    },

    // Validation
    validate: () => {
        if (!module.exports.telegram.token) {
            throw new Error('❌ TELEGRAM_BOT_TOKEN is required in .env');
        }
        if (module.exports.telegram.adminId === 0) {
            console.warn('⚠️ ADMIN_USER_ID not set, admin commands disabled');
        }
    },
};
