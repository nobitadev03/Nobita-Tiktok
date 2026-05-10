// ============================================================
// 👥 USERS API ROUTES
// ============================================================

const express = require('express');
const router = express.Router();
const UserService = require('../services/UserService');
const StatsService = require('../services/StatsService');
const { requireAdminToken, parseUserId } = require('../middleware/auth');

/**
 * GET /api/users - Get all users
 * @route GET /api/users
 * @access Private (requires admin token)
 * @returns {Array} Users array
 */
router.get('/', requireAdminToken, (req, res) => {
    try {
        const users = UserService.getAllUsers();
        res.json({
            success: true,
            count: users.length,
            data: users,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * GET /api/users/:userId - Get specific user
 * @route GET /api/users/:userId
 * @access Private (requires admin token)
 */
router.get('/:userId', requireAdminToken, (req, res) => {
    try {
        const userId = parseUserId(req.params.userId);
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid user ID',
            });
        }

        const user = UserService.getById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found',
            });
        }

        res.json({
            success: true,
            data: user,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * GET /api/users/top/:limit - Get top users
 * @route GET /api/users/top/:limit
 * @access Private (requires admin token)
 */
router.get('/top/:limit', requireAdminToken, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.params.limit || 10), 100);
        const topUsers = UserService.getTopUsers(limit);

        res.json({
            success: true,
            count: topUsers.length,
            data: topUsers,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * POST /api/users/:userId/ban - Ban user
 * @route POST /api/users/:userId/ban
 * @access Private (requires admin token)
 */
router.post('/:userId/ban', requireAdminToken, (req, res) => {
    try {
        const userId = parseUserId(req.params.userId);
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid user ID',
            });
        }

        UserService.ban(userId);
        StatsService.logActivity('admin', `User ${userId} banned`, userId);

        res.json({
            success: true,
            message: `User ${userId} has been banned`,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * POST /api/users/:userId/unban - Unban user
 * @route POST /api/users/:userId/unban
 * @access Private (requires admin token)
 */
router.post('/:userId/unban', requireAdminToken, (req, res) => {
    try {
        const userId = parseUserId(req.params.userId);
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid user ID',
            });
        }

        UserService.unban(userId);
        StatsService.logActivity('admin', `User ${userId} unbanned`, userId);

        res.json({
            success: true,
            message: `User ${userId} has been unbanned`,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

module.exports = router;
