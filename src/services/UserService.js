// ============================================================
// 👥 USER SERVICE
// ============================================================

const { db_users } = require('../database');
const logger = require('../logger');

class UserService {
    /**
     * Get or create user
     */
    static getOrCreate(userId, userData) {
        try {
            return db_users.getOrCreate(userId, userData);
        } catch (err) {
            logger.error(`❌ Error creating user ${userId}: ${err.message}`);
            return null;
        }
    }

    /**
     * Get user by ID
     */
    static getById(userId) {
        return db_users.getById(userId);
    }

    /**
     * Update last active time
     */
    static updateLastActive(userId) {
        db_users.updateLastActive(userId);
    }

    /**
     * Increment user download count
     */
    static incrementDownloads(userId) {
        db_users.incrementDownloads(userId);
    }

    /**
     * Ban user
     */
    static ban(userId) {
        db_users.ban(userId);
        logger.info(`🚫 User ${userId} banned`);
    }

    /**
     * Unban user
     */
    static unban(userId) {
        db_users.unban(userId);
        logger.info(`✅ User ${userId} unbanned`);
    }

    /**
     * Check if user is banned
     */
    static isBanned(userId) {
        const user = db_users.getById(userId);
        return user ? user.is_banned === 1 : false;
    }

    /**
     * Get top users by downloads
     */
    static getTopUsers(limit = 10) {
        return db_users.getTopUsers(limit);
    }

    /**
     * Get all banned users
     */
    static getBannedUsers() {
        return db_users.getBannedUsers();
    }

    /**
     * Get all users
     */
    static getAllUsers() {
        return db_users.getAll();
    }

    /**
     * Get user count
     */
    static getUserCount() {
        return db_users.getAll().length;
    }
}

module.exports = UserService;
