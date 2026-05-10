// ============================================================
// 📊 STATS API ROUTES
// ============================================================

const express = require('express');
const router = express.Router();
const StatsService = require('../services/StatsService');
const UserService = require('../services/UserService');
const { requireAdminToken } = require('../middleware/auth');

/**
 * GET /api/stats - Get today's statistics
 * @route GET /api/stats
 * @access Private (requires admin token)
 * @returns {Object} Statistics object
 */
router.get('/', requireAdminToken, (req, res) => {
    try {
        const stats = StatsService.getTodayStats();
        const allUsers = UserService.getAllUsers();
        const bannedCount = UserService.getBannedUsers().length;

        res.json({
            success: true,
            data: {
                ...stats,
                totalUsers: UserService.getUserCount(),
                bannedUsers: bannedCount,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
            },
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * GET /api/stats/activity - Get activity logs
 * @route GET /api/stats/activity
 * @access Private (requires admin token)
 * @returns {Array} Activity logs
 */
router.get('/activity', requireAdminToken, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || 50), 200);
        const logs = StatsService.getRecentActivity(limit);

        res.json({
            success: true,
            data: logs,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

module.exports = router;
