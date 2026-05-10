// ============================================================
// 💾 DATABASE MODULE (SQLite3)
// ============================================================

const sqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../logger');

// Ensure data directory exists
const dataDir = path.dirname(config.database.path);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database
let db;

try {
    db = new sqlite3(config.database.path);
    db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
    logger.info('✅ Database connected: ' + config.database.path);
} catch (err) {
    logger.error('❌ Database connection error: ' + err.message);
    process.exit(1);
}

// ============================================================
// TABLE SCHEMAS
// ============================================================

function initializeTables() {
    try {
        // Users table
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                download_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_banned INTEGER DEFAULT 0,
                is_muted INTEGER DEFAULT 0,
                is_vip INTEGER DEFAULT 0,
                is_premium INTEGER DEFAULT 0,
                warnings INTEGER DEFAULT 0,
                rate_limit_override INTEGER,
                custom_welcome TEXT
            )
        `);

        // Stats table
        db.exec(`
            CREATE TABLE IF NOT EXISTS stats (
                id INTEGER PRIMARY KEY,
                date DATE,
                total_requests INTEGER DEFAULT 0,
                successful_downloads INTEGER DEFAULT 0,
                failed_downloads INTEGER DEFAULT 0,
                unique_users INTEGER DEFAULT 0,
                UNIQUE(date)
            )
        `);

        // Platform stats table
        db.exec(`
            CREATE TABLE IF NOT EXISTS platform_stats (
                id INTEGER PRIMARY KEY,
                platform TEXT,
                count INTEGER DEFAULT 0,
                date DATE DEFAULT CURRENT_DATE,
                UNIQUE(platform, date)
            )
        `);

        // Activity logs table
        db.exec(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY,
                type TEXT,
                message TEXT,
                user_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Hourly stats table
        db.exec(`
            CREATE TABLE IF NOT EXISTS hourly_stats (
                id INTEGER PRIMARY KEY,
                hour INTEGER,
                count INTEGER DEFAULT 0,
                date DATE DEFAULT CURRENT_DATE,
                UNIQUE(hour, date)
            )
        `);

        // Create indexes for performance
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_users_banned ON users(is_banned);
            CREATE INDEX IF NOT EXISTS idx_users_vip ON users(is_vip);
            CREATE INDEX IF NOT EXISTS idx_activity_logs_date ON activity_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_stats_date ON stats(date);
        `);

        logger.info('✅ Database tables initialized');
    } catch (err) {
        logger.error('❌ Error initializing tables: ' + err.message);
    }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

const db_users = {
    getOrCreate: (userId, userData) => {
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO users (id, username, first_name, last_name)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(userId, userData.username, userData.first_name, userData.last_name);
        return db_users.getById(userId);
    },

    getById: (userId) => {
        const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
        return stmt.get(userId);
    },

    updateLastActive: (userId) => {
        const stmt = db.prepare('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = ?');
        stmt.run(userId);
    },

    incrementDownloads: (userId) => {
        const stmt = db.prepare('UPDATE users SET download_count = download_count + 1 WHERE id = ?');
        stmt.run(userId);
    },

    ban: (userId) => {
        const stmt = db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?');
        stmt.run(userId);
    },

    unban: (userId) => {
        const stmt = db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?');
        stmt.run(userId);
    },

    getTopUsers: (limit = 10) => {
        const stmt = db.prepare('SELECT * FROM users ORDER BY download_count DESC LIMIT ?');
        return stmt.all(limit);
    },

    getBannedUsers: () => {
        const stmt = db.prepare('SELECT id FROM users WHERE is_banned = 1');
        return stmt.all().map(row => row.id);
    },

    getAll: () => {
        const stmt = db.prepare('SELECT * FROM users');
        return stmt.all();
    },
};

const db_stats = {
    getTodayStats: () => {
        const stmt = db.prepare(`
            SELECT * FROM stats WHERE date = CURRENT_DATE
        `);
        let stats = stmt.get();
        if (!stats) {
            db.prepare(`
                INSERT INTO stats (date) VALUES (CURRENT_DATE)
            `).run();
            stats = stmt.get();
        }
        return stats;
    },

    incrementSuccessful: () => {
        const today = new Date().toISOString().split('T')[0];
        db.prepare(`
            UPDATE stats SET successful_downloads = successful_downloads + 1 WHERE date = ?
        `).run(today);
    },

    incrementFailed: () => {
        const today = new Date().toISOString().split('T')[0];
        db.prepare(`
            UPDATE stats SET failed_downloads = failed_downloads + 1 WHERE date = ?
        `).run(today);
    },

    incrementTotal: () => {
        const today = new Date().toISOString().split('T')[0];
        db.prepare(`
            UPDATE stats SET total_requests = total_requests + 1 WHERE date = ?
        `).run(today);
    },
};

const db_logs = {
    add: (type, message, userId = null) => {
        const stmt = db.prepare(`
            INSERT INTO activity_logs (type, message, user_id) VALUES (?, ?, ?)
        `);
        stmt.run(type, message, userId);
    },

    getRecent: (limit = 50) => {
        const stmt = db.prepare(`
            SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?
        `);
        return stmt.all(limit);
    },

    cleanup: () => {
        // Delete logs older than 30 days
        const stmt = db.prepare(`
            DELETE FROM activity_logs WHERE created_at < datetime('now', '-30 days')
        `);
        return stmt.run();
    },
};

// Initialize tables on module load
initializeTables();

module.exports = {
    db,
    db_users,
    db_stats,
    db_logs,
};
