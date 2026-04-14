require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ============================================================
// 🤖 NOBITA BOT v3.0 - Ultimate Edition
// ============================================================

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not defined in .env');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// ============================================================
// 📋 CONFIGURATION
// ============================================================
const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '0');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_REQUESTS || '5');
const BOT_URL = process.env.RENDER_EXTERNAL_URL || process.env.BOT_URL || 'http://localhost:3000';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'nobita_admin';
const DASHBOARD_URL = `${BOT_URL}/dashboard?token=${DASHBOARD_TOKEN}`;
const BOT_VERSION = '3.0';
const BOT_START_TIME = Date.now();

// ============================================================
// 📦 DATA PERSISTENCE
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');

let stats = {
    totalRequests: 0,
    successfulDownloads: 0,
    failedDownloads: 0,
    activeUsers: new Map(),
};

let bannedUsers = new Set();
let mutedUsers = new Set();
let vipUsers = new Set();
let premiumUsers = new Set(); // New: Premium tier between VIP and regular
let mp3Cache = new Map();
let userLimitOverrides = new Map();
let hourlyStats = new Array(24).fill(0);
let dailyStats = { date: new Date().toDateString(), requests: 0, downloads: 0 };
let maintenanceMode = false;
let slowModeUsers = new Map(); // userId -> delayMs
let userWarnings = new Map(); // userId -> count
let customWelcomes = new Map(); // userId -> customWelcome
let botSettings = {
    maxFileSizeMB: 50,
    rateLimitWindow: 10000,
    defaultRateLimit: 3,
    captionText: '👑 Admin: @phamtheson\n⭐ Bot tải video không logo',
    welcomeMsg: '',
    autoDeleteProcessing: true,
    notifyAdmin: true,
    autoBanSpam: true,
    supportTikTokHD: true,
    mp3Button: true,
};

// ============================================================
// 📋 ACTIVITY LOGS (In-memory, latest 50 events)
// ============================================================
const activityLogs = [];

function addActivityLog(type, text) {
    const time = new Date().toLocaleTimeString('vi-VN');
    activityLogs.unshift({ type, text, time });
    if (activityLogs.length > 50) activityLogs.pop();
}

// ============================================================
// 💾 LOAD / SAVE DATA
// ============================================================
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (data.stats) {
                stats.totalRequests = data.stats.totalRequests || 0;
                stats.successfulDownloads = data.stats.successfulDownloads || 0;
                stats.failedDownloads = data.stats.failedDownloads || 0;
                if (data.stats.activeUsers) stats.activeUsers = new Map(data.stats.activeUsers);
            }
            if (data.bannedUsers) bannedUsers = new Set(data.bannedUsers);
            if (data.mutedUsers) mutedUsers = new Set(data.mutedUsers);
            if (data.vipUsers) vipUsers = new Set(data.vipUsers);
            if (data.premiumUsers) premiumUsers = new Set(data.premiumUsers);
            if (data.userLimitOverrides) userLimitOverrides = new Map(data.userLimitOverrides);
            if (data.hourlyStats) hourlyStats = data.hourlyStats;
            if (data.dailyStats) dailyStats = data.dailyStats;
            if (data.slowModeUsers) slowModeUsers = new Map(data.slowModeUsers);
            if (data.userWarnings) userWarnings = new Map(data.userWarnings);
            if (data.botSettings) botSettings = { ...botSettings, ...data.botSettings };
            if (data.maintenanceMode !== undefined) maintenanceMode = data.maintenanceMode;
            console.log('✅ Data loaded successfully.');
        }
    } catch (e) {
        console.error('❌ Error loading data:', e.message);
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            stats: {
                totalRequests: stats.totalRequests,
                successfulDownloads: stats.successfulDownloads,
                failedDownloads: stats.failedDownloads,
                activeUsers: Array.from(stats.activeUsers.entries())
            },
            bannedUsers: Array.from(bannedUsers),
            mutedUsers: Array.from(mutedUsers),
            vipUsers: Array.from(vipUsers),
            premiumUsers: Array.from(premiumUsers),
            userLimitOverrides: Array.from(userLimitOverrides.entries()),
            hourlyStats,
            dailyStats,
            slowModeUsers: Array.from(slowModeUsers.entries()),
            userWarnings: Array.from(userWarnings.entries()),
            botSettings,
            maintenanceMode
        }, null, 2));
    } catch (e) {
        console.error('❌ Error saving data:', e.message);
    }
}

loadData();

// ============================================================
// 🌐 EXPRESS SERVER + DASHBOARD API
// ============================================================
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => res.json({
    status: 'ok',
    uptime: process.uptime(),
    version: BOT_VERSION,
    queue: requestQueue.length,
    processing: processingCount
}));

function requireAdminToken(req, res, next) {
    const t = req.query.token || req.body?.token;
    if (!process.env.DASHBOARD_TOKEN || t !== process.env.DASHBOARD_TOKEN)
        return res.status(401).json({ error: 'Unauthorized', success: false });
    next();
}

app.get('/api/stats', requireAdminToken, (req, res) => {
    const successRate = stats.totalRequests > 0
        ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
    res.json({
        totalRequests: stats.totalRequests,
        successfulDownloads: stats.successfulDownloads,
        failedDownloads: stats.failedDownloads,
        successRate,
        totalUsers: stats.activeUsers.size,
        vipUsers: vipUsers.size,
        premiumUsers: premiumUsers.size,
        bannedUsers: bannedUsers.size,
        mutedUsers: mutedUsers.size,
        queueLength: requestQueue.length,
        processing: processingCount,
        maxConcurrent: MAX_CONCURRENT,
        hourlyStats,
        dailyStats,
        maintenanceMode,
        uptime: process.uptime(),
        version: BOT_VERSION,
        activityLogs // Add activity logs to stats response
    });
});

app.get('/api/users', requireAdminToken, (req, res) => {
    const users = Array.from(stats.activeUsers.entries()).map(([id, data]) => ({
        id, ...data,
        isVip: vipUsers.has(Number(id)),
        isPremium: premiumUsers.has(Number(id)),
        isBanned: bannedUsers.has(Number(id)),
        isMuted: mutedUsers.has(Number(id)),
        warnings: userWarnings.get(Number(id)) || 0,
        rateLimit: userLimitOverrides.has(Number(id)) ? userLimitOverrides.get(Number(id)) : null
    }));
    res.json(users.sort((a, b) => b.count - a.count));
});

// Admin API endpoints
app.post('/api/admin/broadcast', requireAdminToken, async (req, res) => {
    const { message, target } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'No message' });
    res.json({ success: true, message: 'Đang gửi broadcast...' });
    let sent = 0, failed = 0;
    let targets = Array.from(stats.activeUsers.keys());
    if (target === 'vip') targets = targets.filter(id => vipUsers.has(Number(id)));
    if (target === 'premium') targets = targets.filter(id => premiumUsers.has(Number(id)));
    for (const uid of targets) {
        try {
            await bot.sendMessage(uid, `📢 *Thông báo từ Admin:*\n\n${message}`, { parse_mode: 'Markdown' });
            sent++;
        } catch (e) { failed++; }
        await sleep(50);
    }
    if (ADMIN_USER_ID) bot.sendMessage(ADMIN_USER_ID, `✅ Broadcast xong: ${sent} thành công, ${failed} thất bại`).catch(() => { });
});

app.post('/api/admin/dm', requireAdminToken, async (req, res) => {
    const { userId, message } = req.body;
    try {
        await bot.sendMessage(parseInt(userId), `👨‍💻 *Admin:*\n${message}`, { parse_mode: 'Markdown' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/admin/ban', requireAdminToken, (req, res) => {
    const uid = parseInt(req.body.userId);
    if (uid === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'Cannot ban admin' });
    bannedUsers.add(uid); saveData();
    bot.sendMessage(uid, '🚫 Bạn đã bị cấm sử dụng bot.').catch(() => { });
    
    // Log the ban action
    const userToBan = stats.activeUsers.get(uid)?.username || 'user';
    addActivityLog('err', `🚫 Admin đã ban @${userToBan} (ID: ${uid})`);
    
    res.json({ success: true });
});

app.post('/api/admin/unban', requireAdminToken, (req, res) => {
    bannedUsers.delete(parseInt(req.body.userId)); saveData();
    res.json({ success: true });
});

app.post('/api/admin/mute', requireAdminToken, (req, res) => {
    const uid = parseInt(req.body.userId);
    mutedUsers.add(uid); saveData();
    bot.sendMessage(uid, '🔇 Bạn đã bị cấm nhắn tin.').catch(() => { });
    res.json({ success: true });
});

app.post('/api/admin/unmute', requireAdminToken, (req, res) => {
    const uid = parseInt(req.body.userId);
    mutedUsers.delete(uid); saveData();
    bot.sendMessage(uid, '🔊 Bạn đã được mở khóa nhắn tin.').catch(() => { });
    res.json({ success: true });
});

app.post('/api/admin/vip', requireAdminToken, (req, res) => {
    const uid = parseInt(req.body.userId);
    const action = req.body.action;
    const user = stats.activeUsers.get(uid)?.username || 'user';
    
    if (action === 'add') {
        vipUsers.add(uid);
        bot.sendMessage(uid, '🎉 *Chúc mừng!* Bạn đã được nâng cấp lên *VIP*!', { parse_mode: 'Markdown' }).catch(() => { });
        addActivityLog('ok', `⭐ Admin đã cấp VIP cho @${user} (ID: ${uid})`);
    } else {
        vipUsers.delete(uid);
        bot.sendMessage(uid, '⚠️ Quyền VIP của bạn đã bị thu hồi.').catch(() => { });
        addActivityLog('warn', `⚠️ Admin thu hồi VIP của @${user} (ID: ${uid})`);
    }
    saveData(); res.json({ success: true });
});

app.post('/api/admin/maintenance', requireAdminToken, async (req, res) => {
    maintenanceMode = req.body.status === 'on'; saveData();
    res.json({ success: true, maintenanceMode });
    const msg = maintenanceMode
        ? '🔧 *Thông báo:* Bot đang bảo trì, tính năng tải tạm ngưng.'
        : '✅ *Thông báo:* Bot đã hoạt động trở lại!';
    for (const [uid] of stats.activeUsers) {
        try { await bot.sendMessage(uid, msg, { parse_mode: 'Markdown' }); await sleep(50); } catch (e) { }
    }
});

app.post('/api/admin/settings', requireAdminToken, (req, res) => {
    if (req.body.maintenanceMode !== undefined) {
        maintenanceMode = req.body.maintenanceMode === true;
        delete req.body.maintenanceMode;
    }
    botSettings = { ...botSettings, ...req.body };
    saveData(); res.json({ success: true, botSettings });
});

app.get('/api/admin/settings', requireAdminToken, (req, res) => {
    res.json(botSettings);
});

app.post('/api/admin/resetstats', requireAdminToken, (req, res) => {
    stats.totalRequests = 0;
    stats.successfulDownloads = 0;
    stats.failedDownloads = 0;
    hourlyStats = new Array(24).fill(0);
    dailyStats = { date: new Date().toDateString(), requests: 0, downloads: 0 };
    addActivityLog('warn', '🗑️ Admin đã reset thống kê hệ thống');
    saveData();
    res.json({ success: true });
});

app.post('/api/admin/clearmp3', requireAdminToken, (req, res) => {
    mp3Cache.clear();
    addActivityLog('warn', '🗑️ Admin đã xóa MP3 cache');
    res.json({ success: true });
});

app.post('/api/admin/import', requireAdminToken, (req, res) => {
    try {
        const payload = req.body.data;
        if (!payload || typeof payload !== 'object' || !payload.stats) {
            return res.status(400).json({ success: false, error: 'Sai định dạng file backup' });
        }
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
        loadData();
        addActivityLog('warn', '📥 Admin đã nhập dữ liệu backup mới');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/warn', requireAdminToken, async (req, res) => {
    const uid = parseInt(req.body.userId);
    const reason = req.body.reason || 'Vi phạm quy định';
    const count = (userWarnings.get(uid) || 0) + 1;
    userWarnings.set(uid, count);
    saveData();
    try {
        await bot.sendMessage(uid, `⚠️ *Cảnh cáo #${count}:* ${reason}\n\n${count >= 3 ? '🚫 Bạn đã bị ban do vi phạm nhiều lần!' : `Tiếp tục vi phạm sẽ bị ban (${count}/3).`}`, { parse_mode: 'Markdown' });
        if (count >= 3) { bannedUsers.add(uid); saveData(); }
    } catch (e) { }
    res.json({ success: true, warnings: count, autoBanned: count >= 3 });
});

app.post('/api/admin/clearwarnings', requireAdminToken, (req, res) => {
    userWarnings.delete(parseInt(req.body.userId)); saveData();
    res.json({ success: true });
});

app.post('/api/admin/slowmode', requireAdminToken, (req, res) => {
    const uid = parseInt(req.body.userId);
    const delay = parseInt(req.body.delay) || 30000;
    slowModeUsers.set(uid, delay); saveData();
    bot.sendMessage(uid, `⏱️ Tài khoản của bạn đang ở chế độ chậm (${delay / 1000}s giữa mỗi yêu cầu).`).catch(() => { });
    res.json({ success: true });
});

app.delete('/api/admin/slowmode/:userId', requireAdminToken, (req, res) => {
    slowModeUsers.delete(parseInt(req.params.userId)); saveData();
    res.json({ success: true });
});

app.get('/api/admin/export', requireAdminToken, (req, res) => {
    const exportData = {
        exportTime: new Date().toISOString(),
        stats: { totalRequests: stats.totalRequests, successfulDownloads: stats.successfulDownloads, failedDownloads: stats.failedDownloads },
        users: Array.from(stats.activeUsers.entries()).map(([id, d]) => ({ id, ...d, isVip: vipUsers.has(Number(id)), isPremium: premiumUsers.has(Number(id)) }))
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=nobita_export.json');
    res.json(exportData);
});

app.get('/dashboard', (req, res) => {
    if (req.query.token !== process.env.DASHBOARD_TOKEN) return res.status(401).send('<h1>401 Unauthorized</h1>');
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ============================================================
// 🔤 REGEX PATTERNS - Expanded Platform Support
// ============================================================
const PLATFORMS = {
    tiktok: { regex: /(?:https?:\/\/)?(?:(?:www|vt|vm|m|t|v)\.)?(?:tiktok\.com|douyin\.com)\/(?:@[\w.-]+\/video\/\d+|v\/\d+|[\w-]+|share\/video\/\d+)|(?:https?:\/\/)?(?:vm|vt|v)\.(?:tiktok\.com|douyin\.com)\/[\w]+/i, emoji: '🎵', name: 'TikTok/Douyin' },
    facebook: { regex: /(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.com)\/(?:[\w.-]+\/videos\/[\d]+|watch[\/?].*v=[\d]+|video\.php\?v=[\d]+|reel\/[\w]+|share\/v\/[\w]+|share\/r\/[\w]+|[\w.-]+\/posts\/[\w]+)|(?:https?:\/\/)?fb\.watch\/[\w]+/i, emoji: '🐙', name: 'Facebook' },
    youtube: { regex: /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)[\w-]+/i, emoji: '▶️', name: 'YouTube' },
    instagram: { regex: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p)\/[\w-]+/i, emoji: '📸', name: 'Instagram' },
    twitter: { regex: /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[\w]+\/status\/[\d]+/i, emoji: '🐦', name: 'Twitter/X' },
    pinterest: { regex: /(?:https?:\/\/)?(?:www\.)?pinterest\.(?:com|ph|co\.uk|fr|de)\/pin\/[\d]+/i, emoji: '📌', name: 'Pinterest' },
    snapchat: { regex: /(?:https?:\/\/)?(?:www\.)?snapchat\.com\/(?:spotlight|add|discover)\/[\w-]+/i, emoji: '👻', name: 'Snapchat' },
    reddit: { regex: /(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/[\w]+\/comments\/[\w]+/i, emoji: '🤖', name: 'Reddit' },
    bilibili: { regex: /(?:https?:\/\/)?(?:www\.)?bilibili\.com\/video\/(BV[\w]+|av[\d]+)/i, emoji: '📺', name: 'Bilibili' },
};

function detectPlatform(text) {
    for (const [key, p] of Object.entries(PLATFORMS)) {
        const m = text.match(p.regex);
        if (m) return { platform: key, match: m[0] };
    }
    return null;
}

// ============================================================
// 🚦 QUEUE SYSTEM
// ============================================================
const requestQueue = [];
let processingCount = 0;

// ============================================================
// ⚡ RATE LIMITING
// ============================================================
const userRateLimits = new Map();
const userLastRequest = new Map(); // for slow mode

function checkRateLimit(userId) {
    if (isAdmin(userId)) return true;
    const now = Date.now();

    // Slow mode check
    if (slowModeUsers.has(userId)) {
        const delay = slowModeUsers.get(userId);
        const last = userLastRequest.get(userId) || 0;
        if (now - last < delay) return false;
        userLastRequest.set(userId, now);
    }

    const maxReqs = userLimitOverrides.has(userId)
        ? userLimitOverrides.get(userId)
        : isVip(userId) ? 999
            : isPremium(userId) ? 6
                : botSettings.defaultRateLimit;

    if (maxReqs === 0) return false;

    const ul = userRateLimits.get(userId) || { count: 0, resetTime: now + botSettings.rateLimitWindow };
    if (now > ul.resetTime) {
        userRateLimits.set(userId, { count: 1, resetTime: now + botSettings.rateLimitWindow });
        return true;
    }
    if (ul.count >= maxReqs) return false;
    ul.count++;
    userRateLimits.set(userId, ul);
    return true;
}

// ============================================================
// 🛠️ HELPERS
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isAdmin(userId) { return userId === ADMIN_USER_ID; }
function isVip(userId) { return vipUsers.has(userId); }
function isPremium(userId) { return premiumUsers.has(userId); }

function getUserBadge(userId) {
    if (isAdmin(userId)) return '👑';
    if (isVip(userId)) return '⭐';
    if (isPremium(userId)) return '💎';
    return '';
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m ${s % 60}s`;
}

function updateUserStats(userId, username) {
    if (!stats.activeUsers.has(userId)) {
        stats.activeUsers.set(userId, { username: username || 'Unknown', count: 0, lastUsed: Date.now(), history: [], joinedAt: Date.now() });
        addActivityLog('warn', `🆕 User mới tham gia: @${username || 'unknown'} (ID: ${userId})`);
    }
    const user = stats.activeUsers.get(userId);
    user.count++;
    user.lastUsed = Date.now();
    user.username = username || user.username;
    const hour = new Date().getHours();
    hourlyStats[hour] = (hourlyStats[hour] || 0) + 1;
    dailyStats.requests++;
    saveData();
}

function recordHistory(userId, videoUrl, platform) {
    const user = stats.activeUsers.get(userId);
    if (!user) return;
    if (!user.history) user.history = [];
    user.history.unshift({ url: videoUrl, platform, time: Date.now() });
    if (user.history.length > 20) user.history = user.history.slice(0, 20);
    saveData();
}

// Auto-warn on suspicious behavior
async function handleSuspiciousUser(userId, username) {
    const count = (userWarnings.get(userId) || 0) + 1;
    userWarnings.set(userId, count);
    saveData();
    if (ADMIN_USER_ID) {
        bot.sendMessage(ADMIN_USER_ID,
            `⚠️ *Cảnh báo spam:* @${username} (ID: \`${userId}\`)\n🔢 Số lần vi phạm: ${count}`,
            { parse_mode: 'Markdown' }
        ).catch(() => { });
    }
    if (count >= 5) {
        bannedUsers.add(userId); saveData();
        bot.sendMessage(userId, '🚫 Bạn đã bị auto-ban do spam.').catch(() => { });
    }
}

// ============================================================
// 🤖 BOT COMMANDS
// ============================================================
// /start
bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const username = msg.from?.first_name || 'bạn';
    const badge = getUserBadge(userId);
    const supportedPlatforms = Object.values(PLATFORMS).map(p => ` ${p.emoji} ${p.name}`).join('\n');

    await bot.sendMessage(chatId,
        `${badge ? badge + ' ' : ''}👋 Chào *${username}*! Mình là *Nobita Bot v${BOT_VERSION}*\n\n` +
        (maintenanceMode ? '⚠️ *Bot đang bảo trì!* Vui lòng quay lại sau.\n\n' : '') +
        `📹 *Hỗ trợ tải video từ:*\n${supportedPlatforms}\n\n` +
        `💡 Gõ /help để xem đầy đủ lệnh.`,
        {
            parse_mode: 'Markdown',
            reply_markup: isAdmin(userId) ? {
                inline_keyboard: [[{ text: '🖥️ Admin Dashboard', url: DASHBOARD_URL }]]
            } : {}
        }
    );
});

// /help - Tùy theo quyền Admin hay User thường
bot.onText(/^\/help$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const isAdminUser = userId === ADMIN_USER_ID;

    let text = `📖 *Hướng dẫn Nobita Bot v${BOT_VERSION}*\n\n`;

    // Lệnh cho tất cả người dùng
    text += `🔸 *Lệnh cơ bản:*\n`;
    text += `• /start — Khởi động bot\n`;
    text += `• /help — Xem hướng dẫn\n`;
    text += `• /ping — Kiểm tra tốc độ\n`;
    text += `• /status — Trạng thái bot\n`;
    text += `• /platforms — Nền tảng hỗ trợ\n`;
    text += `• /myinfo — Thông tin tài khoản\n`;
    text += `• /history — Lịch sử tải của bạn\n`;
    text += `• /top — Top người dùng tích cực\n`;
    text += `• /report <nội dung> — Báo lỗi cho admin\n\n`;

    text += `💡 Gửi link video bất kỳ để tải (không watermark).\n\n`;

    // Lệnh chỉ Admin thấy
    if (isAdminUser) {
        text += `👑 *Lệnh Admin (Chỉ bạn nhìn thấy):*\n`;
        text += `• /stats — Thống kê đầy đủ\n`;
        text += `• /panel — Mở nhanh panel\n`;
        text += `• /botinfo — Thông tin hệ thống\n`;
        text += `• /users — Danh sách users\n`;
        text += `• /vips — Danh sách VIP\n`;
        text += `• /premiums — Danh sách Premium\n`;
        text += `• /limits — Giới hạn tùy chỉnh\n`;
        text += `• /queue — Xem hàng đợi\n`;
        text += `• /clearqueue — Xóa hàng đợi\n`;
        text += `• /broadcast <text> — Gửi thông báo\n`;
        text += `• /announce <text> — Thông báo quan trọng\n`;
        text += `• /ban <id> — Ban user\n`;
        text += `• /unban <id> — Gỡ ban\n`;
        text += `• /warn <id> [lý do] — Cảnh cáo\n`;
        text += `• /clearwarn <id> — Xóa cảnh cáo\n`;
        text += `• /mute <id> — Khóa nhắn tin\n`;
        text += `• /unmute <id> — Mở khóa\n`;
        text += `• /addvip <id> — Cấp VIP\n`;
        text += `• /removevip <id> — Thu hồi VIP\n`;
        text += `• /premium <id> — Cấp Premium\n`;
        text += `• /removepremium <id> — Thu hồi Premium\n`;
        text += `• /setlimit <id> <số> — Giới hạn request\n`;
        text += `• /resetlimit <id> — Reset giới hạn\n`;
        text += `• /slowmode <id> <giây> — Bật slowmode\n`;
        text += `• /clearslowmode <id> — Tắt slowmode\n`;
        text += `• /caption <text> — Đổi caption\n`;
        text += `• /setmaxsize <MB> — Giới hạn file size\n`;
        text += `• /maintenance on/off — Bật/Tắt bảo trì\n`;
    }

    await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: isAdminUser ? {
            inline_keyboard: [
                [{ text: "🖥️ Mở Admin Dashboard", url: DASHBOARD_URL }]
            ]
        } : {}
    });
});
// /ping
bot.onText(/^\/ping$/, async (msg) => {
    const chatId = msg.chat.id;
    const start = Date.now();
    const m = await bot.sendMessage(chatId, '🏓 Pinging...');
    bot.editMessageText(`🏓 Pong! \`${Date.now() - start}ms\`\n⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}`, {
        chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown'
    });
});

// /status
bot.onText(/^\/status$/, (msg) => {
    const chatId = msg.chat.id;
    const successRate = stats.totalRequests > 0
        ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
    bot.sendMessage(chatId,
        `📊 *Trạng thái Bot v${BOT_VERSION}*\n\n` +
        `${maintenanceMode ? '🔧 Chế độ: BẢO TRÌ' : '✅ Chế độ: HOẠT ĐỘNG'}\n` +
        `⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
        `📥 Tổng tải: ${stats.successfulDownloads.toLocaleString()}\n` +
        `📈 Tỷ lệ: ${successRate}%\n` +
        `👥 Users: ${stats.activeUsers.size}\n` +
        `📋 Hàng đợi: ${requestQueue.length}/${MAX_CONCURRENT}`,
        { parse_mode: 'Markdown' }
    );
});

// /platforms
bot.onText(/^\/platforms$/, (msg) => {
    const list = Object.values(PLATFORMS).map(p => `${p.emoji} *${p.name}*`).join('\n');
    bot.sendMessage(msg.chat.id, `🌐 *Nền tảng được hỗ trợ:*\n\n${list}`, { parse_mode: 'Markdown' });
});

// /myinfo
bot.onText(/^\/myinfo$/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const userData = stats.activeUsers.get(userId);
    const badge = getUserBadge(userId);
    const warnings = userWarnings.get(userId) || 0;
    bot.sendMessage(chatId,
        `👤 *Thông tin tài khoản*\n\n` +
        `🆔 ID: \`${userId}\`\n` +
        `👤 Username: @${msg.from?.username || 'N/A'}\n` +
        `${badge ? `🏷️ Cấp bậc: ${badge} ${isAdmin(userId) ? 'Admin' : isVip(userId) ? 'VIP' : isPremium(userId) ? 'Premium' : 'User'}\n` : ''}` +
        `📥 Đã tải: ${userData?.count || 0} video\n` +
        `${warnings > 0 ? `⚠️ Cảnh cáo: ${warnings}/3\n` : ''}` +
        `📅 Tham gia: ${userData?.joinedAt ? new Date(userData.joinedAt).toLocaleDateString('vi-VN') : 'N/A'}`,
        { parse_mode: 'Markdown' }
    );
});

// /history
bot.onText(/^\/history$/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const userData = stats.activeUsers.get(userId);
    if (!userData?.history?.length) {
        bot.sendMessage(chatId, '📭 Bạn chưa tải video nào.');
        return;
    }
    let msg2 = '📖 *Lịch sử tải (20 gần nhất):*\n\n';
    userData.history.forEach((item, i) => {
        const time = new Date(item.time).toLocaleString('vi-VN');
        const p = PLATFORMS[item.platform];
        const emoji = p ? p.emoji : '🎬';
        const short = item.url.length > 40 ? item.url.substring(0, 40) + '...' : item.url;
        msg2 += `${i + 1}. ${emoji} \`${short}\`\n   🕐 ${time}\n\n`;
    });
    bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' });
});

// /top
bot.onText(/^\/top$/, (msg) => {
    const chatId = msg.chat.id;
    if (stats.activeUsers.size === 0) { bot.sendMessage(chatId, '📭 Chưa có dữ liệu.'); return; }

    // Build sorted list - admin always first
    let entries = Array.from(stats.activeUsers.entries());
    entries.sort((a, b) => {
        const aIsAdmin = Number(a[0]) === ADMIN_USER_ID;
        const bIsAdmin = Number(b[0]) === ADMIN_USER_ID;
        if (aIsAdmin) return -1;
        if (bIsAdmin) return 1;
        return b[1].count - a[1].count;
    });
    const top = entries.slice(0, 10);
    const medals = ['👑', '🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    let topMsg = '🏆 *Top 10 người dùng tích cực:*\n\n';
    top.forEach(([id, data], i) => {
        const badge = getUserBadge(Number(id));
        topMsg += `${medals[i]} ${badge}@${data.username} — *${data.count}* lượt\n`;
    });
    bot.sendMessage(chatId, topMsg, { parse_mode: 'Markdown' });
});

// /report
bot.onText(/^\/report (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (ADMIN_USER_ID) {
        bot.sendMessage(ADMIN_USER_ID,
            `📩 *Report từ @${msg.from?.username || msg.from?.first_name}* (ID: \`${userId}\`):\n\n${match[1]}`,
            { parse_mode: 'Markdown' }
        );
        bot.sendMessage(chatId, '✅ Report đã được gửi tới Admin!');
    }
});

// ============================================================
// 👑 ADMIN COMMANDS
// ============================================================
const ADMIN_CMDS = ['stats', 'users', 'broadcast', 'ban', 'unban', 'queue', 'addvip', 'removevip',
    'vips', 'panel', 'setlimit', 'resetlimit', 'limits', 'maintenance', 'warn', 'clearwarn',
    'slowmode', 'clearslowmode', 'premium', 'removepremium', 'premiums', 'caption',
    'setmaxsize', 'botinfo', 'clearqueue', 'kickqueue', 'announce'];

bot.onText(/^\/(\w+)(?:\s(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const cmd = match[1];
    const args = match[2]?.trim() || '';

    if (!ADMIN_CMDS.includes(cmd)) return;
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Bạn không có quyền dùng lệnh này.');
        return;
    }

    switch (cmd) {
        case 'stats': {
            const rate = stats.totalRequests > 0 ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
            bot.sendMessage(chatId,
                `📊 *Thống kê Bot v${BOT_VERSION}*\n\n` +
                `📥 Tổng requests: ${stats.totalRequests}\n` +
                `✅ Thành công: ${stats.successfulDownloads} (${rate}%)\n` +
                `❌ Thất bại: ${stats.failedDownloads}\n` +
                `👥 Users: ${stats.activeUsers.size} | ⭐ VIP: ${vipUsers.size} | 💎 Premium: ${premiumUsers.size}\n` +
                `🚫 Banned: ${bannedUsers.size} | 🔇 Muted: ${mutedUsers.size}\n` +
                `📋 Hàng đợi: ${requestQueue.length} | ⚙️ Xử lý: ${processingCount}/${MAX_CONCURRENT}\n` +
                `⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
                `📅 Hôm nay: ${dailyStats.requests} requests`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🖥️ Web Dashboard', url: DASHBOARD_URL }]] }
                }
            );
            break;
        }

        case 'panel': {
            const rate = stats.totalRequests > 0 ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
            bot.sendMessage(chatId,
                `🖥️ *Admin Panel*\n\n` +
                `📥 ${stats.totalRequests} requests | ✅ ${stats.successfulDownloads} (${rate}%)\n` +
                `👥 ${stats.activeUsers.size} users | ⭐ ${vipUsers.size} VIP | 💎 ${premiumUsers.size} Premium\n` +
                `🚫 ${bannedUsers.size} banned | 🔇 ${mutedUsers.size} muted | ⚠️ ${userWarnings.size} warned\n` +
                `📋 Queue: ${requestQueue.length} | ⚙️ ${processingCount}/${MAX_CONCURRENT}\n` +
                `🔧 Bảo trì: ${maintenanceMode ? 'BẬT' : 'TẮT'}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🌐 Mở Web Dashboard', url: DASHBOARD_URL }]] }
                }
            );
            break;
        }

        case 'botinfo': {
            bot.sendMessage(chatId,
                `🤖 *Nobita Bot v${BOT_VERSION}*\n\n` +
                `⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
                `💾 Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB\n` +
                `📁 Data file: ${fs.existsSync(DATA_FILE) ? (fs.statSync(DATA_FILE).size / 1024).toFixed(1) + ' KB' : 'N/A'}\n` +
                `🎯 Platforms: ${Object.keys(PLATFORMS).length}\n` +
                `⚙️ Max concurrent: ${MAX_CONCURRENT}\n` +
                `📏 Max file size: ${botSettings.maxFileSizeMB} MB\n` +
                `🚦 Rate limit: ${botSettings.defaultRateLimit}/10s`,
                { parse_mode: 'Markdown' }
            );
            break;
        }

        case 'users': {
            if (stats.activeUsers.size === 0) { bot.sendMessage(chatId, '📭 Chưa có user nào.'); break; }
            let list = '👥 *Danh sách users (top 20):*\n\n';
            Array.from(stats.activeUsers.entries())
                .sort((a, b) => {
                    if (Number(a[0]) === ADMIN_USER_ID) return -1;
                    if (Number(b[0]) === ADMIN_USER_ID) return 1;
                    return b[1].count - a[1].count;
                })
                .slice(0, 20)
                .forEach(([id, d], i) => {
                    const badge = getUserBadge(Number(id));
                    const banned = bannedUsers.has(Number(id)) ? '🚫' : '';
                    const muted = mutedUsers.has(Number(id)) ? '🔇' : '';
                    const warns = userWarnings.get(Number(id)) ? `⚠️${userWarnings.get(Number(id))}` : '';
                    list += `${i + 1}. ${badge}${banned}${muted}${warns} @${d.username} (\`${id}\`) — ${d.count} lần\n`;
                });
            bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
            break;
        }

        case 'broadcast': {
            if (!args) { bot.sendMessage(chatId, '❌ /broadcast <message>\n💡 Thêm "-vip" để chỉ gửi VIP, "-premium" cho Premium'); break; }
            let target = 'all', msg2 = args;
            if (args.startsWith('-vip ')) { target = 'vip'; msg2 = args.slice(5); }
            else if (args.startsWith('-premium ')) { target = 'premium'; msg2 = args.slice(9); }
            let targets = Array.from(stats.activeUsers.keys());
            if (target === 'vip') targets = targets.filter(id => vipUsers.has(Number(id)));
            if (target === 'premium') targets = targets.filter(id => premiumUsers.has(Number(id)));
            let sent = 0, failed = 0;
            for (const uid of targets) {
                try { await bot.sendMessage(uid, `📢 *Thông báo từ Admin:*\n\n${msg2}`, { parse_mode: 'Markdown' }); sent++; }
                catch (e) { failed++; }
                await sleep(50);
            }
            bot.sendMessage(chatId, `✅ Broadcast ${target === 'all' ? 'tất cả' : target}: ${sent} OK, ${failed} lỗi`);
            break;
        }

        case 'announce': {
            // Send pinned announcement
            if (!args) { bot.sendMessage(chatId, '❌ /announce <message>'); break; }
            let sent = 0;
            for (const [uid] of stats.activeUsers) {
                try { await bot.sendMessage(uid, `📌 *THÔNG BÁO QUAN TRỌNG*\n\n${args}`, { parse_mode: 'Markdown' }); sent++; }
                catch (e) { }
                await sleep(50);
            }
            bot.sendMessage(chatId, `📌 Đã gửi thông báo tới ${sent} users`);
            break;
        }

        case 'ban': {
            if (!args) { bot.sendMessage(chatId, '❌ /ban <user_id> [lý do]'); break; }
            const parts = args.split(' ');
            const uid = parseInt(parts[0]);
            const reason = parts.slice(1).join(' ') || 'Vi phạm quy định';
            if (uid === ADMIN_USER_ID) { bot.sendMessage(chatId, '❌ Không thể ban admin!'); break; }
            bannedUsers.add(uid); saveData();
            bot.sendMessage(uid, `🚫 Bạn đã bị ban.\n📝 Lý do: ${reason}`).catch(() => { });
            bot.sendMessage(chatId, `🚫 Đã ban ID: ${uid}\n📝 Lý do: ${reason}`);
            break;
        }

        case 'unban': {
            if (!args) { bot.sendMessage(chatId, '❌ /unban <user_id>'); break; }
            const uid = parseInt(args);
            bannedUsers.delete(uid); userWarnings.delete(uid); saveData();
            bot.sendMessage(uid, '✅ Bạn đã được gỡ ban.').catch(() => { });
            bot.sendMessage(chatId, `✅ Đã unban ID: ${uid}`);
            break;
        }

        case 'warn': {
            const parts = args.split(' ');
            const uid = parseInt(parts[0]);
            const reason = parts.slice(1).join(' ') || 'Vi phạm quy định';
            if (!uid) { bot.sendMessage(chatId, '❌ /warn <user_id> [lý do]'); break; }
            const count = (userWarnings.get(uid) || 0) + 1;
            userWarnings.set(uid, count); saveData();
            bot.sendMessage(uid, `⚠️ *Cảnh cáo #${count}/3:* ${reason}${count >= 3 ? '\n\n🚫 Bạn đã bị auto-ban!' : ''}`, { parse_mode: 'Markdown' }).catch(() => { });
            if (count >= 3) { bannedUsers.add(uid); saveData(); }
            bot.sendMessage(chatId, `⚠️ Đã cảnh cáo ID: ${uid} (${count}/3)${count >= 3 ? ' → Auto-banned' : ''}`);
            break;
        }

        case 'clearwarn': {
            if (!args) { bot.sendMessage(chatId, '❌ /clearwarn <user_id>'); break; }
            userWarnings.delete(parseInt(args)); saveData();
            bot.sendMessage(chatId, `✅ Xóa cảnh cáo ID: ${args}`);
            break;
        }

        case 'slowmode': {
            const parts = args.split(' ');
            if (parts.length < 2) { bot.sendMessage(chatId, '❌ /slowmode <user_id> <giây>'); break; }
            const uid = parseInt(parts[0]);
            const delay = parseInt(parts[1]) * 1000;
            slowModeUsers.set(uid, delay); saveData();
            bot.sendMessage(uid, `⏱️ Tài khoản của bạn đang ở chế độ chậm (${parts[1]}s/request).`).catch(() => { });
            bot.sendMessage(chatId, `⏱️ Đặt slowmode ${parts[1]}s cho ID: ${uid}`);
            break;
        }

        case 'clearslowmode': {
            if (!args) { bot.sendMessage(chatId, '❌ /clearslowmode <user_id>'); break; }
            slowModeUsers.delete(parseInt(args)); saveData();
            bot.sendMessage(chatId, `✅ Xóa slowmode cho ID: ${args}`);
            break;
        }

        case 'addvip': {
            if (!args) { bot.sendMessage(chatId, '❌ /addvip <user_id>'); break; }
            const uid = parseInt(args);
            vipUsers.add(uid); premiumUsers.delete(uid); saveData();
            bot.sendMessage(uid, '🎉 *Chúc mừng!* Bạn đã được nâng cấp lên *VIP* ⭐\n• Không giới hạn tốc độ\n• Ưu tiên hàng đầu', { parse_mode: 'Markdown' }).catch(() => { });
            bot.sendMessage(chatId, `⭐ Đã cấp VIP cho ID: ${uid}`);
            break;
        }

        case 'removevip': {
            if (!args) { bot.sendMessage(chatId, '❌ /removevip <user_id>'); break; }
            const uid = parseInt(args);
            vipUsers.delete(uid); saveData();
            bot.sendMessage(uid, '⚠️ Quyền VIP của bạn đã bị thu hồi.').catch(() => { });
            bot.sendMessage(chatId, `✅ Xóa VIP ID: ${uid}`);
            break;
        }

        case 'vips': {
            if (vipUsers.size === 0) { bot.sendMessage(chatId, '📭 Chưa có VIP.'); break; }
            let list = '⭐ *Danh sách VIP:*\n\n';
            Array.from(vipUsers).forEach((id, i) => {
                const d = stats.activeUsers.get(id);
                list += `${i + 1}. @${d?.username || 'Unknown'} (\`${id}\`)\n`;
            });
            bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
            break;
        }

        case 'premium': {
            if (!args) { bot.sendMessage(chatId, '❌ /premium <user_id>'); break; }
            const uid = parseInt(args);
            premiumUsers.add(uid); saveData();
            bot.sendMessage(uid, '💎 *Chúc mừng!* Bạn đã được nâng cấp lên *Premium* 💎\n• Giới hạn tốc độ tăng 2x\n• Ưu tiên hàng đợi', { parse_mode: 'Markdown' }).catch(() => { });
            bot.sendMessage(chatId, `💎 Đã cấp Premium cho ID: ${uid}`);
            break;
        }

        case 'removepremium': {
            if (!args) { bot.sendMessage(chatId, '❌ /removepremium <user_id>'); break; }
            premiumUsers.delete(parseInt(args)); saveData();
            bot.sendMessage(chatId, `✅ Xóa Premium ID: ${args}`);
            break;
        }

        case 'premiums': {
            if (premiumUsers.size === 0) { bot.sendMessage(chatId, '📭 Chưa có Premium.'); break; }
            let list = '💎 *Danh sách Premium:*\n\n';
            Array.from(premiumUsers).forEach((id, i) => {
                const d = stats.activeUsers.get(id);
                list += `${i + 1}. @${d?.username || 'Unknown'} (\`${id}\`)\n`;
            });
            bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
            break;
        }

        case 'setlimit': {
            const parts = args.split(' ');
            if (parts.length < 2) { bot.sendMessage(chatId, '❌ /setlimit <user_id> <số>\n0 = block, 1-10 = limit'); break; }
            const uid = parseInt(parts[0]);
            const limit = parseInt(parts[1]);
            userLimitOverrides.set(uid, limit); saveData();
            bot.sendMessage(chatId, limit === 0 ? `🚫 Đã chặn tải cho ID: ${uid}` : `⚠️ Giới hạn ${limit}/10s cho ID: ${uid}`);
            break;
        }

        case 'resetlimit': {
            if (!args) { bot.sendMessage(chatId, '❌ /resetlimit <user_id>'); break; }
            userLimitOverrides.delete(parseInt(args)); saveData();
            bot.sendMessage(chatId, `✅ Reset giới hạn cho ID: ${args}`);
            break;
        }

        case 'limits': {
            if (userLimitOverrides.size === 0) { bot.sendMessage(chatId, '📭 Không có giới hạn tùy chỉnh.'); break; }
            let list = '⚠️ *Giới hạn tùy chỉnh:*\n\n';
            userLimitOverrides.forEach((limit, id) => {
                const d = stats.activeUsers.get(id);
                list += `• @${d?.username || 'Unknown'} (\`${id}\`) → ${limit === 0 ? '🚫 CHẶN' : `${limit}/10s`}\n`;
            });
            bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
            break;
        }

        case 'maintenance': {
            if (args === 'on' || args === 'off') {
                maintenanceMode = args === 'on'; saveData();
                bot.sendMessage(chatId, maintenanceMode ? '🔧 Đã bật bảo trì.' : '✅ Đã tắt bảo trì.');
            } else {
                bot.sendMessage(chatId, `🔧 Bảo trì: *${maintenanceMode ? 'BẬT' : 'TẮT'}*\n\nDùng /maintenance on|off`, { parse_mode: 'Markdown' });
            }
            break;
        }

        case 'caption': {
            if (!args) { bot.sendMessage(chatId, `📝 Caption hiện tại:\n${botSettings.captionText}\n\nDùng /caption <text> để đổi`); break; }
            botSettings.captionText = args; saveData();
            bot.sendMessage(chatId, `✅ Đã cập nhật caption:\n${args}`);
            break;
        }

        case 'setmaxsize': {
            const size = parseInt(args);
            if (!size || size < 1 || size > 2000) { bot.sendMessage(chatId, '❌ /setmaxsize <MB> (1-2000)'); break; }
            botSettings.maxFileSizeMB = size; saveData();
            bot.sendMessage(chatId, `✅ Max file size: ${size} MB`);
            break;
        }

        case 'queue': {
            if (requestQueue.length === 0 && processingCount === 0) { bot.sendMessage(chatId, '📭 Hàng đợi trống.'); break; }
            let info = `📋 *Hàng đợi:*\n\n⚙️ ${processingCount}/${MAX_CONCURRENT} đang xử lý\n📊 ${requestQueue.length} chờ\n\n`;
            requestQueue.slice(0, 8).forEach((r, i) => {
                const badge = getUserBadge(r.userId);
                info += `${i + 1}. ${badge}@${r.username} — ${PLATFORMS[r.platform]?.emoji || '🎬'} ${r.url.substring(0, 30)}...\n`;
            });
            bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
            break;
        }

        case 'clearqueue': {
            const cleared = requestQueue.length;
            requestQueue.length = 0;
            bot.sendMessage(chatId, `🗑️ Đã xóa ${cleared} request khỏi hàng đợi.`);
            break;
        }
    }
});

// ============================================================
// 🎵 MP3 CALLBACK HANDLER
// ============================================================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data.startsWith('mp3_')) {
        const mp3Id = data.replace('mp3_', '');
        const info = mp3Cache.get(mp3Id);
        if (!info) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Link đã hết hạn!', show_alert: true });
            return;
        }
        bot.answerCallbackQuery(query.id, { text: '🎵 Đang trích xuất MP3...' });
        const proc = await bot.sendMessage(chatId, '⏳ Đang chuyển đổi MP3...');
        try {
            let mp3Url = null;
            if (info.platform === 'tiktok') {
                const res = await axios.post('https://www.tikwm.com/api/', { url: info.url }, { timeout: 10000 });
                if (res.data?.data?.music) mp3Url = res.data.data.music;
            }
            if (mp3Url) {
                await bot.sendAudio(chatId, mp3Url, { reply_to_message_id: messageId });
            } else {
                bot.sendMessage(chatId, '❌ Không tìm thấy audio cho video này.');
            }
        } catch (e) {
            bot.sendMessage(chatId, '❌ Lỗi trích xuất audio: ' + e.message);
        } finally {
            bot.deleteMessage(chatId, proc.message_id).catch(() => { });
        }
    }
});

// ============================================================
// 📨 MAIN MESSAGE HANDLER
// ============================================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from?.id;
    const username = msg.from?.username || msg.from?.first_name || 'unknown';

    if (!text) return;

    const detected = detectPlatform(text);

    if (detected) {
        const { platform, match: videoUrl } = detected;

        // Maintenance check
        if (maintenanceMode && !isVip(userId) && !isAdmin(userId)) {
            bot.sendMessage(chatId, '🔧 *Bot đang bảo trì!* Vui lòng quay lại sau.', { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }).catch(() => { });
            return;
        }

        // Ban check
        if (bannedUsers.has(userId)) {
            bot.sendMessage(chatId, '🚫 Bạn đã bị cấm sử dụng bot.').catch(() => { });
            return;
        }

        // Rate limit
        if (!isAdmin(userId) && !checkRateLimit(userId)) {
            const isSlowed = slowModeUsers.has(userId);
            bot.sendMessage(chatId,
                isSlowed
                    ? `⏱️ Bạn đang trong chế độ chậm. Vui lòng đợi giữa mỗi lần tải.`
                    : `⚠️ Gửi quá nhanh! Đợi ${botSettings.rateLimitWindow / 1000}s.\n💡 Nâng cấp VIP để không giới hạn!`,
                { reply_to_message_id: msg.message_id }
            ).catch(() => { });
            handleSuspiciousUser(userId, username);
            return;
        }

        stats.totalRequests++;
        updateUserStats(userId, username);

        const p = PLATFORMS[platform];
        console.log(`[${new Date().toISOString()}] ${p.emoji} ${platform.toUpperCase()} from @${username} (${userId}): ${videoUrl}`);
        
        // Log the new request to dashboard
        addActivityLog('ok', `📥 Yêu cầu tải ${p.name} từ @${username} (ID: ${userId})`);

        const item = {
            chatId, userId, username, url: videoUrl, platform,
            messageId: msg.message_id, timestamp: Date.now(),
            isVip: isVip(userId), isAdmin: isAdmin(userId), isPremium: isPremium(userId)
        };

        // Priority insertion: Admin > VIP > Premium > Regular
        if (item.isAdmin) {
            requestQueue.unshift(item);
        } else if (item.isVip) {
            const firstNonAdmin = requestQueue.findIndex(r => !r.isAdmin);
            requestQueue.splice(firstNonAdmin === -1 ? 0 : firstNonAdmin, 0, item);
        } else if (item.isPremium) {
            const firstRegular = requestQueue.findIndex(r => !r.isAdmin && !r.isVip);
            requestQueue.splice(firstRegular === -1 ? requestQueue.length : firstRegular, 0, item);
        } else {
            requestQueue.push(item);
        }

        const position = requestQueue.indexOf(item) + 1;
        if (requestQueue.length > 1 || processingCount >= MAX_CONCURRENT) {
            const badge = item.isAdmin ? '👑 Admin' : item.isVip ? '⭐ VIP' : item.isPremium ? '💎 Premium' : '';
            bot.sendMessage(chatId,
                `📋 Đã thêm hàng đợi (vị trí: #${position})${badge ? ` — ${badge}` : ''}`,
                { reply_to_message_id: msg.message_id }
            ).catch(() => { });
        }

        processQueue();

    } else if (!text.startsWith('/')) {
        // 2-way chat
        if (isAdmin(userId) && msg.reply_to_message) {
            let targetId = null;
            if (msg.reply_to_message.forward_from) {
                targetId = msg.reply_to_message.forward_from.id;
            } else {
                const idMatch = msg.reply_to_message.text?.match(/ID:\s*`?(\d+)`?/);
                if (idMatch) targetId = parseInt(idMatch[1]);
            }
            if (targetId) {
                bot.sendMessage(targetId, `👨‍💻 *Admin:*\n${text}`, { parse_mode: 'Markdown' })
                    .then(() => bot.sendMessage(chatId, '✅ Đã gửi!'))
                    .catch(e => bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`));
            } else {
                bot.sendMessage(chatId, '❌ Không nhận diện được User ID.');
            }
        } else if (!isAdmin(userId)) {
            if (mutedUsers.has(userId)) {
                bot.sendMessage(chatId, '🔇 Bạn đã bị khóa nhắn tin admin.').catch(() => { });
            } else if (ADMIN_USER_ID) {
                const who = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'user';
                bot.sendMessage(ADMIN_USER_ID,
                    `📩 *Tin nhắn từ ${who}* (ID: \`${userId}\`):\n\n${text}`,
                    { parse_mode: 'Markdown' }
                ).catch(() => { });
            }
        }
    }
});

// ============================================================
// ⚙️ QUEUE PROCESSOR
// ============================================================
async function processQueue() {
    if (processingCount >= MAX_CONCURRENT || requestQueue.length === 0) return;
    const request = requestQueue.shift();
    if (!request) return;
    processingCount++;

    let processingMsg;
    try {
        const p = PLATFORMS[request.platform];
        processingMsg = await bot.sendMessage(request.chatId,
            `⏳ Đang tải ${p ? p.emoji + ' ' + p.name : 'video'}...`,
            { reply_to_message_id: request.messageId }
        );

        let videoData;
        switch (request.platform) {
            case 'facebook': videoData = await downloadFacebookVideo(request.url); break;
            case 'youtube': videoData = await downloadYouTubeVideo(request.url); break;
            case 'instagram': videoData = await downloadInstagramVideo(request.url); break;
            case 'twitter': videoData = await downloadTwitterVideo(request.url); break;
            case 'reddit': videoData = await downloadRedditVideo(request.url); break;
            case 'bilibili': videoData = await downloadBilibiliVideo(request.url); break;
            default: videoData = await getVideoNoWatermark(request.url); break;
        }

        if (!videoData || (!videoData.url && !videoData.isTooLarge)) throw new Error('Could not retrieve video URL');

        if (videoData.isTooLarge) {
            await bot.sendMessage(request.chatId,
                `⚠️ *Video quá lớn (${videoData.sizeMB.toFixed(1)} MB)!*\n\nTelegram giới hạn ${botSettings.maxFileSizeMB}MB. Bấm nút bên dưới để tải trực tiếp 👇`,
                {
                    parse_mode: 'Markdown',
                    reply_to_message_id: request.messageId,
                    reply_markup: { inline_keyboard: [[{ text: '🔗 TẢI TRỰC TIẾP', url: videoData.url }]] }
                }
            );
        } else {
            const tempFile = path.join(__dirname, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
            const writer = fs.createWriteStream(tempFile);
            const res = await axios.get(videoData.url, {
                responseType: 'stream', timeout: 120000,
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' }
            });
            res.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

            const mp3Id = Math.random().toString(36).slice(2, 10);
            mp3Cache.set(mp3Id, { url: request.url, platform: request.platform });
            if (mp3Cache.size > 500) {
                const firstKey = mp3Cache.keys().next().value;
                mp3Cache.delete(firstKey);
            }

            await bot.sendVideo(request.chatId, tempFile, {
                caption: botSettings.captionText,
                reply_to_message_id: request.messageId,
                supports_streaming: true,
                reply_markup: { inline_keyboard: [[{ text: '🎵 Tải MP3', callback_data: `mp3_${mp3Id}` }]] }
            });

            fs.unlink(tempFile, () => { });
        }

        if (processingMsg && botSettings.autoDeleteProcessing) bot.deleteMessage(request.chatId, processingMsg.message_id).catch(() => { });
        stats.successfulDownloads++;
        dailyStats.downloads++;
        recordHistory(request.userId, request.url, request.platform);
        saveData();
        console.log(`[✅] ${request.platform} video sent to @${request.username}`);
        
        const platformInfo = PLATFORMS[request.platform];
        addActivityLog('ok', `✅ Tải xong ${platformInfo ? platformInfo.name : 'video'} cho @${request.username} (ID: ${request.userId})`);

    } catch (err) {
        console.error(`[❌] Error:`, err.message);
        stats.failedDownloads++;
        saveData();

        // Log the failure to dashboard
        addActivityLog('err', `❌ Lỗi tải video của @${request.username}: ${err.message.substring(0, 50)}`);

        let errMsg = '❌ ';
        if (err.message.includes('Could not retrieve')) errMsg += 'Link không hợp lệ hoặc video đã bị xóa.';
        else if (err.message.includes('timeout')) errMsg += 'Timeout. Vui lòng thử lại.';
        else if (err.message.includes('quá lớn')) errMsg += err.message;
        else errMsg += 'Lỗi không xác định. Hãy thử link khác.';

        if (processingMsg) {
            bot.editMessageText(errMsg + '\n\n💡 Đảm bảo link hợp lệ và không bị private.', {
                chat_id: request.chatId, message_id: processingMsg.message_id
            }).catch(() => { });
        }

        if (botSettings.notifyAdmin && ADMIN_USER_ID) {
            bot.sendMessage(ADMIN_USER_ID,
                `⚠️ *Download failed:*\n📱 ${request.platform}\n👤 @${request.username}\n🔗 ${request.url.substring(0, 60)}\n❌ ${err.message}`,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
        }
    } finally {
        processingCount--;
        setImmediate(() => processQueue());
    }
}

// ============================================================
// 📥 DOWNLOAD FUNCTIONS
// ============================================================

async function retryWithBackoff(fn, maxRetries = 2, baseDelay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try { return await fn(); }
        catch (e) {
            if (i === maxRetries - 1) throw e;
            await sleep(baseDelay * Math.pow(2, i));
        }
    }
}

async function checkVideoSize(url) {
    try {
        const r = await axios.head(url, { timeout: 10000, maxRedirects: 5 });
        const bytes = parseInt(r.headers['content-length'] || '0');
        return { sizeMB: bytes / 1024 / 1024, isTooLarge: bytes > botSettings.maxFileSizeMB * 1024 * 1024 };
    } catch { return { sizeMB: 0, isTooLarge: false }; }
}

async function normalizeUrl(url) {
    if (/vm\.|vt\.|v\./.test(url)) {
        try {
            const r = await axios.get(url, { maxRedirects: 5, timeout: 10000, validateStatus: () => true });
            return r.request?.res?.responseUrl || url;
        } catch { return url; }
    }
    return url;
}

// 🎵 TikTok / Douyin
async function getVideoNoWatermark(url) {
    const normalizedUrl = await normalizeUrl(url);

    const apis = [
        async () => {
            const res = await axios.post('https://www.tikwm.com/api/', { url: normalizedUrl, hd: 1 }, {
                timeout: 15000, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            });
            if (res.data?.code === 0 && (res.data?.data?.play || res.data?.data?.hdplay))
                return { url: res.data.data.hdplay || res.data.data.play, title: res.data.data.title };
            throw new Error('TikWM failed');
        },
        async () => {
            const res = await axios.post('https://ssstik.io/abc?url=dl',
                `id=${encodeURIComponent(normalizedUrl)}&locale=en&tt=d1N4eUs5`,
                { timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' } }
            );
            const m = res.data.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?no watermark/i);
            if (m) return { url: m[1], title: 'TikTok Video' };
            throw new Error('SSSTik failed');
        },
        async () => {
            const res = await axios.get('https://snaptikvideo.com/tikwm.php', {
                params: { url: normalizedUrl, hd: 1 }, timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (res.data?.url) return { url: res.data.url, title: 'TikTok Video' };
            throw new Error('SnapTik failed');
        },
        async () => {
            const res = await axios.post('https://api.tikmate.app/api/lookup',
                new URLSearchParams({ url: normalizedUrl }),
                { timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' } }
            );
            if (res.data?.token && res.data?.id)
                return { url: `https://tikmate.app/download/${res.data.token}/${res.data.id}.mp4`, title: 'TikTok Video' };
            throw new Error('TikMate failed');
        }
    ];

    for (const api of apis) {
        try {
            const result = await retryWithBackoff(api);
            if (result?.url) {
                const sizeInfo = await checkVideoSize(result.url);
                return { ...result, ...sizeInfo };
            }
        } catch (e) { console.log('TikTok API failed:', e.message); }
    }
    return null;
}

// 🐙 Facebook
async function normalizeFbUrl(fbUrl) {
    if (fbUrl.includes('/share/') || fbUrl.includes('fb.watch')) {
        try {
            const r = await axios.get(fbUrl, { maxRedirects: 10, timeout: 10000, validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const final = r.request?.res?.responseUrl || fbUrl;
            if (final.includes('facebook.com') || final.includes('fb.com')) return final;
        } catch { }
    }
    return fbUrl;
}

async function downloadFacebookVideo(fbUrl) {
    const realUrl = await normalizeFbUrl(fbUrl);

    const apis = [
        async () => {
            const youtubedl = require('youtube-dl-exec');
            const info = await youtubedl(realUrl, { dumpSingleJson: true, noWarnings: true, noCheckCertificates: true });
            let format = info.formats?.slice().reverse().find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4')
                || info.formats?.slice().reverse().find(f => f.vcodec !== 'none' && f.acodec !== 'none');
            const finalUrl = format ? format.url : info.url;
            if (finalUrl) return { url: finalUrl, title: info.title || 'Facebook Video' };
            throw new Error('yt-dlp failed for FB');
        },
        async () => {
            const res = await axios.post('https://snapsave.app/action.php', new URLSearchParams({ url: realUrl }), {
                timeout: 20000,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://snapsave.app/' }
            });
            let html = res.data;
            if (typeof html === 'string' && html.includes('eval(function')) {
                const fn = new Function(html.replace('eval(function', 'return (function'));
                html = fn();
            }
            const m = html.match(/href="(https:\/\/d\.rapidcdn\.app\/v2\?token=[^"]+)"/i)
                || html.match(/href="(https:\/\/[^"]+rapidcdn\.app[^"]+)"/i);
            if (m) return { url: m[1], title: 'Facebook Video' };
            throw new Error('SnapSave failed');
        },
        async () => {
            const res = await axios.post('https://api.cobalt.tools/', { url: realUrl }, {
                timeout: 15000,
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            });
            if (res.data?.url) return { url: res.data.url, title: 'Facebook Video' };
            throw new Error('Cobalt failed');
        },
        async () => {
            const res = await axios.post('https://getmyfb.com/api/ajaxSearch', new URLSearchParams({ q: realUrl, t: 'media', lang: 'en' }), {
                timeout: 15000,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'XMLHttpRequest' }
            });
            const m = (res.data?.data || '').match(/href="([^"]+)"[^>]*>\s*Download HD/i) || (res.data?.data || '').match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Facebook Video' };
            throw new Error('GetMyFB failed');
        },
        async () => {
            const res = await axios.post('https://www.getfvid.com/downloader', new URLSearchParams({ URLz: realUrl }), {
                timeout: 20000,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.getfvid.com/' }
            });
            const m = res.data.match(/href="(https:\/\/[^"]+)\.mp4[^"]*"[^>]*>.*?HD/is)
                || res.data.match(/href="(https:\/\/video\.f?b[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1].includes('.mp4') ? m[1] : m[1] + '.mp4', title: 'Facebook Video' };
            throw new Error('GetFVid failed');
        },
        async () => {
            const res = await axios.get('https://fdown.net/download.php', {
                params: { URLz: realUrl }, timeout: 20000,
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fdown.net/' }
            });
            const m = res.data.match(/id="sdlink"\s+href="([^"]+)"/i) || res.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Facebook Video' };
            throw new Error('FDown failed');
        },
        async () => {
            const res = await axios.post('https://fbdownloader.net/api/ajaxSearch', new URLSearchParams({ q: realUrl, t: 'home' }), {
                timeout: 20000,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'XMLHttpRequest' }
            });
            const m = res.data?.data?.match(/href="([^"]+)"[^>]*>\s*Download HD/i) || res.data?.data?.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Facebook Video' };
            throw new Error('FBDownloader failed');
        }
    ];

    for (const api of apis) {
        try {
            const result = await retryWithBackoff(api);
            if (result?.url) {
                const sizeInfo = await checkVideoSize(result.url);
                return { ...result, ...sizeInfo };
            }
        } catch (e) { console.log('FB API failed:', e.message); }
    }
    return null;
}

// ▶️ YouTube
const youtubedl = require('youtube-dl-exec');
async function downloadYouTubeVideo(url) {
    try {
        const info = await youtubedl(url, {
            dumpSingleJson: true, noWarnings: true, noCheckCertificates: true,
            preferFreeFormats: true, youtubeSkipDashManifest: true
        });
        if (info.duration > 600) throw new Error('Video quá lớn (chỉ hỗ trợ dưới 10 phút)');
        let format = info.formats?.slice().reverse().find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4')
            || info.formats?.slice().reverse().find(f => f.vcodec !== 'none' && f.acodec !== 'none');
        const finalUrl = format ? format.url : info.url;
        if (!finalUrl) throw new Error('No format found');
        return { url: finalUrl, title: info.title, sizeMB: 0, isTooLarge: false };
    } catch (e) { console.error('YT failed:', e.message); return null; }
}

// 📸 Instagram
async function downloadInstagramVideo(url) {
    const apis = [
        async () => {
            const res = await axios.post('https://snapinsta.app/action.php', new URLSearchParams({ url }), {
                timeout: 15000,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://snapinsta.app/' }
            });
            const m = res.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Instagram Video' };
            throw new Error('SnapInsta failed');
        },
        async () => {
            const res = await axios.post('https://sssinsta.com/action.php', new URLSearchParams({ url }), {
                timeout: 15000,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://sssinsta.com/' }
            });
            const m = res.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Instagram Video' };
            throw new Error('SSSInsta failed');
        },
        async () => {
            const res = await axios.get(`https://igram.world/api/convert?url=${encodeURIComponent(url)}`, {
                timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (res.data?.url) return { url: res.data.url, title: 'Instagram Video' };
            throw new Error('IGram failed');
        }
    ];

    for (const api of apis) {
        try {
            const result = await retryWithBackoff(api);
            if (result?.url) {
                const sizeInfo = await checkVideoSize(result.url);
                return { ...result, ...sizeInfo };
            }
        } catch (e) { console.log('IG API failed:', e.message); }
    }
    return null;
}

// 🐦 Twitter/X
async function downloadTwitterVideo(url) {
    const apis = [
        async () => {
            const res = await axios.get(`https://twitsave.com/info?url=${encodeURIComponent(url)}`, {
                timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const m = res.data.match(/href="(https:\/\/video\.twimg\.com[^"]+)"/i);
            if (m) return { url: m[1], title: 'Twitter Video' };
            throw new Error('TwitSave failed');
        },
        async () => {
            const res = await axios.get(`https://ssstwitter.com/${url.replace(/https?:\/\/(www\.)?(twitter|x)\.com\//, '')}`, {
                timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://ssstwitter.com/' }
            });
            const m = res.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Twitter Video' };
            throw new Error('SSSTwitter failed');
        },
        async () => {
            const res = await axios.post('https://www.savetweetvid.com/downloader',
                new URLSearchParams({ url }),
                { timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' } }
            );
            const m = res.data.match(/href="(https:\/\/video\.twimg\.com[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Twitter Video' };
            throw new Error('SaveTweetVid failed');
        }
    ];

    for (const api of apis) {
        try {
            const result = await retryWithBackoff(api);
            if (result?.url) {
                const sizeInfo = await checkVideoSize(result.url);
                return { ...result, ...sizeInfo };
            }
        } catch (e) { console.log('Twitter API failed:', e.message); }
    }
    return null;
}

// 🤖 Reddit
async function downloadRedditVideo(url) {
    try {
        const apiUrl = url.replace(/\/$/, '') + '.json';
        const res = await axios.get(apiUrl, {
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NobitaBot/3.0)' }
        });
        const post = res.data?.[0]?.data?.children?.[0]?.data;
        const videoUrl = post?.secure_media?.reddit_video?.fallback_url
            || post?.media?.reddit_video?.fallback_url;
        if (videoUrl) return { url: videoUrl, title: post.title || 'Reddit Video', sizeMB: 0, isTooLarge: false };
        throw new Error('No video found in Reddit post');
    } catch (e) { console.error('Reddit failed:', e.message); return null; }
}

// 📺 Bilibili
async function downloadBilibiliVideo(url) {
    try {
        const res = await axios.get(`https://api.injahow.cn/bparse/?url=${encodeURIComponent(url)}&type=json`, {
            timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.data?.url) {
            const sizeInfo = await checkVideoSize(res.data.url);
            return { url: res.data.url, title: res.data.title || 'Bilibili Video', ...sizeInfo };
        }
        throw new Error('Bilibili API failed');
    } catch (e) { console.error('Bilibili failed:', e.message); return null; }
}

// ============================================================
// 🔧 BOT ERROR HANDLERS
// ============================================================
bot.on('polling_error', (err) => console.error('Polling error:', err.message));
bot.on('webhook_error', (err) => console.error('Webhook error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// ============================================================
// 🗑️ AUTO CLEANUP (every 6 hours)
// ============================================================
function cleanupTempFiles() {
    let deleted = 0;
    try {
        fs.readdirSync(__dirname).forEach(file => {
            if (file.startsWith('temp_') && file.endsWith('.mp4')) {
                const fp = path.join(__dirname, file);
                if ((Date.now() - fs.statSync(fp).mtimeMs) > 600000) {
                    fs.unlinkSync(fp); deleted++;
                }
            }
        });
    } catch (e) { }
    if (deleted > 0) {
        console.log(`[Cleanup] Deleted ${deleted} temp files`);
        if (ADMIN_USER_ID) bot.sendMessage(ADMIN_USER_ID, `🗑️ Auto-cleanup: Xóa ${deleted} file tạm`).catch(() => { });
    }
}
cleanupTempFiles();
setInterval(cleanupTempFiles, 6 * 60 * 60 * 1000);

// ============================================================
// 📊 DAILY REPORT (midnight)
// ============================================================
function scheduleMidnightReset() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);

    setTimeout(function tick() {
        const rate = stats.totalRequests > 0 ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
        const top = Array.from(stats.activeUsers.entries()).sort((a, b) => {
            if (Number(a[0]) === ADMIN_USER_ID) return -1;
            return b[1].count - a[1].count;
        })[0];

        if (ADMIN_USER_ID) {
            bot.sendMessage(ADMIN_USER_ID,
                `📊 *Báo cáo ngày ${new Date().toLocaleDateString('vi-VN')}*\n\n` +
                `📥 Tổng: ${stats.totalRequests} | ✅ ${stats.successfulDownloads} (${rate}%)\n` +
                `📅 Hôm nay: ${dailyStats.requests} requests / ${dailyStats.downloads} tải\n` +
                `👥 Users: ${stats.activeUsers.size} | ⭐ VIP: ${vipUsers.size} | 💎 Premium: ${premiumUsers.size}\n` +
                `🚫 Banned: ${bannedUsers.size}\n` +
                `🏆 Top: @${top?.[1]?.username || 'N/A'} (${top?.[1]?.count || 0} lần)\n` +
                (maintenanceMode ? '\n⚠️ *Đang bảo trì!*' : ''),
                { parse_mode: 'Markdown' }
            ).catch(() => { });
        }

        hourlyStats = new Array(24).fill(0);
        dailyStats = { date: new Date().toDateString(), requests: 0, downloads: 0 };
        saveData();
        setTimeout(tick, 24 * 60 * 60 * 1000);
    }, midnight - now);
}
scheduleMidnightReset();

console.log(`🚀 Nobita Bot v${BOT_VERSION} is running!`);
console.log(`👑 Admin ID: ${ADMIN_USER_ID}`);
console.log(`🌐 Platforms: ${Object.keys(PLATFORMS).join(', ')}`);
