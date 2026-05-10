// ============================================================
// 🔐 AUTHENTICATION MIDDLEWARE
// ============================================================

const config = require('../config');
const logger = require('../logger');

/**
 * Extract dashboard token from request
 */
function getDashboardToken(req) {
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return req.query.token || req.body?.token || req.headers['x-dashboard-token'] || bearer;
}

/**
 * Middleware: Require valid dashboard token
 */
function requireAdminToken(req, res, next) {
    const token = getDashboardToken(req);
    
    if (!config.dashboard.token || token !== config.dashboard.token) {
        logger.warn(`❌ Unauthorized access attempt from ${req.ip}`);
        return res.status(401).json({ 
            success: false, 
            error: 'Unauthorized - Invalid token' 
        });
    }
    
    next();
}

/**
 * Parse and validate User ID
 */
function parseUserId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Middleware: Validate user ID in request
 */
function validateUserId(req, res, next) {
    const userId = req.body.userId || req.params.userId || req.query.userId;
    const parsedId = parseUserId(userId);
    
    if (!parsedId) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid userId format' 
        });
    }
    
    req.userId = parsedId;
    next();
}

/**
 * Middleware: Error handler
 */
function errorHandler(err, req, res, next) {
    logger.error(`🚨 Error: ${err.message}`);
    
    res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Internal server error',
        ...(config.server.env === 'development' && { stack: err.stack })
    });
}

/**
 * Middleware: Request logger
 */
function requestLogger(req, res, next) {
    logger.info(`📨 ${req.method} ${req.path} from ${req.ip}`);
    next();
}

module.exports = {
    getDashboardToken,
    requireAdminToken,
    validateUserId,
    parseUserId,
    errorHandler,
    requestLogger,
};
