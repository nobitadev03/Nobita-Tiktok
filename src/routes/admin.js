// ============================================================
// 🔧 ADMIN API ROUTES
// ============================================================

const express = require('express');
const router = express.Router();
const config = require('../config');
const StatsService = require('../services/StatsService');
const UserService = require('../services/UserService');
const { requireAdminToken } = require('../middleware/auth');
const logger = require('../logger');

/**
 * GET /api/admin/health - Health check
 * @route GET /api/admin/health
 * @access Public
 */
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: config.bot.version,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /api/admin/config - Get bot configuration
 * @route GET /api/admin/config
 * @access Private (requires admin token)
 */
router.get('/config', requireAdminToken, (req, res) => {
    res.json({
        success: true,
        config: {
            bot: config.bot,
            performance: config.performance,
            dashboard: config.dashboard,
            logging: config.logging,
        },
    });
});

/**
 * POST /api/admin/broadcast - Send broadcast message
 * @route POST /api/admin/broadcast
 * @access Private (requires admin token)
 */
router.post('/broadcast', requireAdminToken, (req, res) => {
    const { message, target } = req.body;

    if (!message) {
        return res.status(400).json({
            success: false,
            error: 'Message is required',
        });
    }

    // TODO: Implement broadcast logic with bot.sendMessage
    StatsService.logActivity('admin', `Broadcast sent: "${message.substring(0, 50)}..."`);
    logger.info(`📢 Broadcasting message to ${target || 'all'} users`);

    res.json({
        success: true,
        message: 'Broadcast queued for sending',
    });
});

/**
 * POST /api/admin/announce - Send announcement
 * @route POST /api/admin/announce
 * @access Private (requires admin token)
 */
router.post('/announce', requireAdminToken, (req, res) => {
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({
            success: false,
            error: 'Message is required',
        });
    }

    StatsService.logActivity('admin', `Announcement: "${message.substring(0, 50)}..."`);
    logger.info('📌 Announcement posted');

    res.json({
        success: true,
        message: 'Announcement sent',
    });
});

/**
 * POST /api/admin/cleanup - Cleanup old logs
 * @route POST /api/admin/cleanup
 * @access Private (requires admin token)
 */
router.post('/cleanup', requireAdminToken, (req, res) => {
    try {
        const result = StatsService.cleanupOldLogs();
        logger.info('🧹 Cleanup completed');

        res.json({
            success: true,
            message: 'Cleanup completed',
            changes: result.changes,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * POST /api/admin/restart - Restart bot
 * @route POST /api/admin/restart
 * @access Private (requires admin token)
 */
router.post('/restart', requireAdminToken, (req, res) => {
    res.json({
        success: true,
        message: 'Restart request received. Bot will restart shortly.',
    });

    logger.info('🔄 Restart requested by admin');
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

module.exports = router;
