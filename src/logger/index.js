// ============================================================
// 📝 LOGGER MODULE (Winston)
// ============================================================

const fs = require('fs');
const path = require('path');

// Check if winston is available, fallback to console
let winston;
try {
    winston = require('winston');
} catch (e) {
    console.warn('⚠️ Winston not installed, using console logging');
}

const config = require('../config');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../', config.logging.dir);
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Create logger
let logger;

if (winston) {
    logger = winston.createLogger({
        level: config.logging.level,
        format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            winston.format.splat(),
            winston.format.json()
        ),
        defaultMeta: { service: 'nobita-bot' },
        transports: [
            // Error logs
            new winston.transports.File({
                filename: path.join(logsDir, 'error.log'),
                level: 'error',
                maxsize: 5242880, // 5MB
                maxFiles: 5,
            }),
            // Combined logs
            new winston.transports.File({
                filename: path.join(logsDir, 'combined.log'),
                maxsize: 5242880,
                maxFiles: 14,
            }),
            // Console
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.printf(({ level, message, timestamp }) => {
                        return `${timestamp} [${level}]: ${message}`;
                    })
                ),
            }),
        ],
    });
} else {
    // Fallback: simple console logger
    logger = {
        info: (msg) => console.log(`ℹ️  [INFO] ${new Date().toISOString()}: ${msg}`),
        error: (msg) => console.error(`❌ [ERROR] ${new Date().toISOString()}: ${msg}`),
        warn: (msg) => console.warn(`⚠️  [WARN] ${new Date().toISOString()}: ${msg}`),
        debug: (msg) => console.debug(`🐛 [DEBUG] ${new Date().toISOString()}: ${msg}`),
    };
}

module.exports = logger;
