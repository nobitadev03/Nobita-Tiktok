// ============================================================
// 🔧 UTILITY HELPERS
// ============================================================

/**
 * Sleep helper for delays
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Format uptime
 */
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

/**
 * Escape markdown special characters
 */
function escapeMd(text) {
    return String(text).replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&');
}

/**
 * Parse platform from URL
 */
function detectPlatform(url) {
    if (!url) return null;
    
    const platforms = {
        tiktok: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
        douyin: ['douyin.com', 'dy.com'],
        instagram: ['instagram.com', 'instagr.am'],
        facebook: ['facebook.com', 'fb.watch', 'fb.com'],
        youtube: ['youtube.com', 'youtu.be'],
        twitter: ['twitter.com', 'x.com'],
        reddit: ['reddit.com'],
    };

    for (const [platform, domains] of Object.entries(platforms)) {
        if (domains.some(domain => url.includes(domain))) {
            return platform;
        }
    }
    return null;
}

/**
 * Generate random string
 */
function generateRandomString(length = 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Validate URL
 */
function isValidUrl(url) {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

/**
 * Chunk array
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * Get current hour (0-23)
 */
function getCurrentHour() {
    return new Date().getHours();
}

/**
 * Get current date string (YYYY-MM-DD)
 */
function getCurrentDateString() {
    return new Date().toISOString().split('T')[0];
}

/**
 * Retry function with exponential backoff
 */
async function retry(fn, maxRetries = 3, delayMs = 1000) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (i < maxRetries - 1) {
                await sleep(delayMs * Math.pow(2, i));
            }
        }
    }
    throw lastError;
}

/**
 * Calculate success rate
 */
function calculateSuccessRate(successful, total) {
    return total > 0 ? ((successful / total) * 100).toFixed(1) : 0;
}

module.exports = {
    sleep,
    formatBytes,
    formatUptime,
    escapeMd,
    detectPlatform,
    generateRandomString,
    isValidUrl,
    chunkArray,
    getCurrentHour,
    getCurrentDateString,
    retry,
    calculateSuccessRate,
};
