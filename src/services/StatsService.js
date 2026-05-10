// ============================================================
// 📊 STATISTICS SERVICE
// ============================================================

const { db_stats, db_logs } = require('../database');
const { calculateSuccessRate } = require('../utils/helpers');

class StatsService {
    /**
     * Get today's statistics
     */
    static getTodayStats() {
        const todayStats = db_stats.getTodayStats();
        return {
            ...todayStats,
            successRate: calculateSuccessRate(
                todayStats.successful_downloads,
                todayStats.total_requests
            ),
        };
    }

    /**
     * Increment successful download count
     */
    static recordSuccess() {
        db_stats.incrementTotal();
        db_stats.incrementSuccessful();
    }

    /**
     * Increment failed download count
     */
    static recordFailure() {
        db_stats.incrementTotal();
        db_stats.incrementFailed();
    }

    /**
     * Log activity
     */
    static logActivity(type, message, userId = null) {
        db_logs.add(type, message, userId);
    }

    /**
     * Get recent activity logs
     */
    static getRecentActivity(limit = 50) {
        return db_logs.getRecent(limit);
    }

    /**
     * Cleanup old logs
     */
    static cleanupOldLogs() {
        return db_logs.cleanup();
    }
}

module.exports = StatsService;
