require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ============================================================
// 🤖 NOBITA BOT v4.0 - Ultra Edition
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
const BOT_VERSION = '4.3';
const BOT_EDITION = 'Ultra Edition';
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
    referralBonus: 5, // extra daily limit per referral
};

// ============================================================
// 🎛️ USER PREFERENCES / FAVORITES / ACHIEVEMENTS (v4.0)
// ============================================================
// Per-user personal settings: { lang, defaultQuality, silentMode, showMP3Btn, autoFav }
let userPreferences = new Map();
// Per-user saved favorite media: userId -> [{ url, platform, title, savedAt }]
let userFavorites = new Map();
// Per-user daily check-in streaks: userId -> { streak, lastClaim, points }
let dailyStreaks = new Map();
// Referral tree: userId -> { referrer?, invitedCount, invitees[] }
let referralData = new Map();
// Per-platform request counter for analytics: { [platform]: count }
let platformStats = {};
// Rolling 7-day stat bucket: [{ date: YYYY-MM-DD, requests, downloads }]
let daily7Stats = [];
// Cache of pending "smart reply" actions keyed by short id (HD/SD/MP3/retry/fav)
let actionCache = new Map();

// v4.1: scheduled broadcasts: [{ id, at (ms epoch), text, createdBy, createdAt, sent? }]
let scheduledBroadcasts = [];
// v4.1: weekly leaderboard: userId -> { weekStart (ms), count, username }
let weeklyTopStats = new Map();
// v4.1: downloads-per-hour heatmap: 7 weekdays × 24 hours (Sun..Sat)
let heatmapStats = Array.from({ length: 7 }, () => new Array(24).fill(0));
// v4.1: SSE clients listening to live log stream
const sseClients = new Set();

const DEFAULT_USER_PREFS = {
    lang: 'vi',
    defaultQuality: 'hd',    // hd | sd | mp3
    silentMode: false,       // suppress non-essential notifications
    showMP3Btn: true,
    autoFav: false,          // auto-save every successful download to favorites
};

function getUserPrefs(userId) {
    const cur = userPreferences.get(userId) || {};
    return { ...DEFAULT_USER_PREFS, ...cur };
}
function setUserPref(userId, key, value) {
    const cur = userPreferences.get(userId) || {};
    cur[key] = value;
    userPreferences.set(userId, cur);
    saveData();
}

// ============================================================
// 📋 ACTIVITY LOGS (In-memory, latest 50 events)
// ============================================================
const activityLogs = [];

function addActivityLog(type, text) {
    const time = new Date().toLocaleTimeString('vi-VN');
    const entry = { type, text, time, ts: Date.now() };
    activityLogs.unshift(entry);
    if (activityLogs.length > 50) activityLogs.pop();
    // v4.1: push to SSE clients
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of sseClients) { try { res.write(payload); } catch (_) {} }
}

// v4.1: bump heatmap bucket (called on each download)
function bumpHeatmap() {
    const d = new Date();
    heatmapStats[d.getDay()][d.getHours()]++;
}

// v4.1: bump weekly top (bucket resets every Monday 00:00)
function bumpWeeklyTop(userId, username) {
    const now = new Date();
    const day = now.getDay() || 7;
    const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - (day - 1));
    const weekStart = monday.getTime();
    let cur = weeklyTopStats.get(userId);
    if (!cur || cur.weekStart !== weekStart) cur = { weekStart, count: 0, username };
    cur.count++;
    cur.username = username || cur.username;
    weeklyTopStats.set(userId, cur);
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
            if (data.userPreferences) userPreferences = new Map(data.userPreferences);
            if (data.userFavorites) userFavorites = new Map(data.userFavorites);
            if (data.dailyStreaks) dailyStreaks = new Map(data.dailyStreaks);
            if (data.referralData) referralData = new Map(data.referralData);
            if (data.platformStats) platformStats = data.platformStats;
            if (data.daily7Stats) daily7Stats = data.daily7Stats;
            if (data.scheduledBroadcasts) scheduledBroadcasts = data.scheduledBroadcasts;
            if (data.weeklyTopStats) weeklyTopStats = new Map(data.weeklyTopStats);
            if (Array.isArray(data.heatmapStats) && data.heatmapStats.length === 7) heatmapStats = data.heatmapStats;
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
            maintenanceMode,
            userPreferences: Array.from(userPreferences.entries()),
            userFavorites: Array.from(userFavorites.entries()),
            dailyStreaks: Array.from(dailyStreaks.entries()),
            referralData: Array.from(referralData.entries()),
            platformStats,
            daily7Stats,
            scheduledBroadcasts,
            weeklyTopStats: Array.from(weeklyTopStats.entries()),
            heatmapStats,
        }, null, 2));
    } catch (e) {
        console.error('❌ Error saving data:', e.message);
    }
}

loadData();

// ============================================================
// 🌍 I18N (vi / en) — gọn nhẹ, fallback vi
// ============================================================
const I18N = {
    vi: {
        welcome: (name) => `👋 Chào *${name}*! Mình là *Nobita Bot v${BOT_VERSION} — ${BOT_EDITION}*`,
        maintenance: '⚠️ *Bot đang bảo trì!* Vui lòng quay lại sau.',
        supportedPlatforms: '📹 *Hỗ trợ tải video từ:*',
        typeHelp: '💡 Gõ /help để xem đầy đủ lệnh.',
        menu_download: '📥 Tải video',
        menu_help: '📖 Trợ giúp',
        menu_settings: '⚙️ Cài đặt',
        menu_favorites: '⭐ Yêu thích',
        menu_achievements: '🏅 Thành tích',
        menu_status: '📊 Trạng thái',
        menu_invite: '🎁 Mời bạn',
        menu_dashboard: '🖥️ Dashboard',
        rate_limit: (w) => `⚠️ Gửi quá nhanh! Đợi ${w}s.\n💡 Nâng cấp VIP để không giới hạn!`,
        slow_mode: '⏱️ Bạn đang trong chế độ chậm. Vui lòng đợi giữa mỗi lần tải.',
        banned: '🚫 Bạn đã bị cấm sử dụng bot.',
        queue_added: (pos, badge) => `📋 Đã thêm hàng đợi (vị trí: #${pos})${badge ? ` — ${badge}` : ''}`,
        download_error: '❌ Lỗi tải video.',
        sent_from_admin: '👨‍💻 *Admin:*',
        saved_fav: '⭐ Đã lưu vào danh sách yêu thích!',
        removed_fav: '🗑️ Đã xóa khỏi yêu thích.',
        no_favs: '📭 Bạn chưa có video yêu thích nào.',
        choose_quality: '🎚️ Chọn chất lượng:',
    },
    en: {
        welcome: (name) => `👋 Hi *${name}*! I am *Nobita Bot v${BOT_VERSION} — ${BOT_EDITION}*`,
        maintenance: '⚠️ *Bot is under maintenance!* Please come back later.',
        supportedPlatforms: '📹 *Supported platforms:*',
        typeHelp: '💡 Type /help to see all commands.',
        menu_download: '📥 Download',
        menu_help: '📖 Help',
        menu_settings: '⚙️ Settings',
        menu_favorites: '⭐ Favorites',
        menu_achievements: '🏅 Achievements',
        menu_status: '📊 Status',
        menu_invite: '🎁 Invite',
        menu_dashboard: '🖥️ Dashboard',
        rate_limit: (w) => `⚠️ Too fast! Wait ${w}s.\n💡 Upgrade to VIP for no limits!`,
        slow_mode: '⏱️ You are in slow mode. Please wait between downloads.',
        banned: '🚫 You are banned from using this bot.',
        queue_added: (pos, badge) => `📋 Added to queue (position: #${pos})${badge ? ` — ${badge}` : ''}`,
        download_error: '❌ Failed to download video.',
        sent_from_admin: '👨‍💻 *Admin:*',
        saved_fav: '⭐ Saved to favorites!',
        removed_fav: '🗑️ Removed from favorites.',
        no_favs: '📭 You have no favorites yet.',
        choose_quality: '🎚️ Choose quality:',
    }
};
function t(userId, key, ...args) {
    const lang = getUserPrefs(userId).lang || 'vi';
    const pool = I18N[lang] || I18N.vi;
    const v = pool[key] || I18N.vi[key];
    if (typeof v === 'function') return v(...args);
    return v;
}

// ============================================================
// 🏅 ACHIEVEMENTS & LEVELS (v4.0)
// ============================================================
const LEVEL_THRESHOLDS = [0, 5, 15, 40, 80, 150, 300, 600, 1200, 2500, 5000];
function getUserLevel(count) {
    let lv = 0;
    for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
        if (count >= LEVEL_THRESHOLDS[i]) lv = i;
    }
    return lv;
}
function getNextLevelTarget(count) {
    const lv = getUserLevel(count);
    return LEVEL_THRESHOLDS[Math.min(lv + 1, LEVEL_THRESHOLDS.length - 1)];
}
function getLevelBadge(lv) {
    if (lv >= 9) return '👑 Legend';
    if (lv >= 7) return '💎 Diamond';
    if (lv >= 5) return '🥇 Gold';
    if (lv >= 3) return '🥈 Silver';
    if (lv >= 1) return '🥉 Bronze';
    return '🌱 Rookie';
}
const ACHIEVEMENTS = [
    { id: 'first', name: '🎬 Người mới', desc: 'Tải 1 video đầu tiên', check: (u) => u.count >= 1 },
    { id: 'ten', name: '🔟 Nhà sưu tập', desc: 'Tải 10 video', check: (u) => u.count >= 10 },
    { id: 'fifty', name: '🎯 Chuyên gia', desc: 'Tải 50 video', check: (u) => u.count >= 50 },
    { id: 'hundred', name: '🏆 Cao thủ', desc: 'Tải 100 video', check: (u) => u.count >= 100 },
    { id: 'fav10', name: '⭐ Người hâm mộ', desc: 'Lưu 10 video yêu thích', check: (u, fs) => (fs?.length || 0) >= 10 },
    { id: 'streak7', name: '🔥 Kiên định', desc: 'Check-in 7 ngày liên tục', check: (u, fs, ds) => (ds?.streak || 0) >= 7 },
    { id: 'referrer', name: '🎁 Người mời', desc: 'Mời 5 bạn bè', check: (u, fs, ds, rd) => (rd?.invitedCount || 0) >= 5 },
    { id: 'allplatforms', name: '🌐 Đa nền tảng', desc: 'Tải từ 5 nền tảng khác nhau', check: (u) => (u.platformsUsed?.length || 0) >= 5 },
];
function getUserAchievements(userId) {
    const u = stats.activeUsers.get(userId);
    if (!u) return [];
    const fs = userFavorites.get(userId) || [];
    const ds = dailyStreaks.get(userId);
    const rd = referralData.get(userId);
    return ACHIEVEMENTS.filter(a => {
        try { return a.check(u, fs, ds, rd); } catch { return false; }
    });
}

// ============================================================
// ⭐ FAVORITES helpers
// ============================================================
function addFavorite(userId, url, platform, title) {
    const list = userFavorites.get(userId) || [];
    if (list.some(it => it.url === url)) return false;
    list.unshift({ url, platform, title: title || url, savedAt: Date.now() });
    if (list.length > 100) list.pop();
    userFavorites.set(userId, list);
    saveData();
    return true;
}
function removeFavorite(userId, url) {
    const list = userFavorites.get(userId) || [];
    const idx = list.findIndex(it => it.url === url);
    if (idx === -1) return false;
    list.splice(idx, 1);
    userFavorites.set(userId, list);
    saveData();
    return true;
}

// ============================================================
// 📊 Platform stats & 7-day rotation
// ============================================================
function incPlatformStat(platform) {
    if (!platform) return;
    platformStats[platform] = (platformStats[platform] || 0) + 1;
    // maintain rolling daily bucket
    const today = new Date().toISOString().slice(0, 10);
    let bucket = daily7Stats.find(d => d.date === today);
    if (!bucket) {
        bucket = { date: today, requests: 0, downloads: 0 };
        daily7Stats.push(bucket);
        while (daily7Stats.length > 7) daily7Stats.shift();
    }
    bucket.requests++;
}
function bumpDailyDownloads() {
    const today = new Date().toISOString().slice(0, 10);
    let bucket = daily7Stats.find(d => d.date === today);
    if (!bucket) {
        bucket = { date: today, requests: 0, downloads: 0 };
        daily7Stats.push(bucket);
        while (daily7Stats.length > 7) daily7Stats.shift();
    }
    bucket.downloads++;
}

// ============================================================
// 🗄️ Short ID helpers (for inline callback payloads)
// ============================================================
function cacheAction(payload) {
    const id = Math.random().toString(36).slice(2, 10);
    actionCache.set(id, { ...payload, createdAt: Date.now() });
    if (actionCache.size > 1000) {
        const firstKey = actionCache.keys().next().value;
        actionCache.delete(firstKey);
    }
    return id;
}

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
        edition: BOT_EDITION,
        activityLogs // Add activity logs to stats response
    });
});

// v4.0: System health metrics (CPU / memory / platform)
app.get('/api/system/health', requireAdminToken, (req, res) => {
    const os = require('os');
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const load = os.loadavg();
    const cpus = os.cpus();
    res.json({
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        cpuModel: cpus[0]?.model || 'unknown',
        cpuCount: cpus.length,
        loadAvg1m: load[0],
        loadAvg5m: load[1],
        loadAvg15m: load[2],
        totalMemoryMB: Math.round(totalMem / 1024 / 1024),
        freeMemoryMB: Math.round(freeMem / 1024 / 1024),
        usedMemoryPct: Number(((totalMem - freeMem) / totalMem * 100).toFixed(1)),
        heapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
        heapTotalMB: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
        rssMB: Number((mem.rss / 1024 / 1024).toFixed(1)),
        uptime: process.uptime(),
        hostname: os.hostname(),
        version: BOT_VERSION,
        edition: BOT_EDITION,
    });
});

// v4.0: Platform breakdown stats
app.get('/api/stats/platforms', requireAdminToken, (req, res) => {
    const total = Object.values(platformStats).reduce((a, b) => a + b, 0) || 0;
    const list = Object.entries(platformStats).map(([platform, count]) => {
        const meta = PLATFORMS[platform];
        return {
            platform,
            name: meta?.name || platform,
            emoji: meta?.emoji || '🎬',
            count,
            percent: total > 0 ? Number((count / total * 100).toFixed(1)) : 0
        };
    }).sort((a, b) => b.count - a.count);
    res.json({ total, platforms: list });
});

// v4.0: Rolling 7-day stats
app.get('/api/stats/daily7', requireAdminToken, (req, res) => {
    // Fill missing days with zero entries
    const out = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const iso = d.toISOString().slice(0, 10);
        const bucket = daily7Stats.find(b => b.date === iso);
        out.push({
            date: iso,
            label: d.toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' }),
            requests: bucket?.requests || 0,
            downloads: bucket?.downloads || 0
        });
    }
    res.json({ days: out });
});

// v4.0: User detail endpoint (for modal in dashboard)
app.get('/api/user/:id/details', requireAdminToken, (req, res) => {
    const uid = parseInt(req.params.id);
    const u = stats.activeUsers.get(uid);
    if (!u) return res.status(404).json({ error: 'not found' });
    const prefs = getUserPrefs(uid);
    const achievements = getUserAchievements(uid).map(a => ({ id: a.id, name: a.name, desc: a.desc }));
    const favs = userFavorites.get(uid) || [];
    const streak = dailyStreaks.get(uid) || null;
    const ref = referralData.get(uid) || null;
    res.json({
        id: uid,
        username: u.username,
        count: u.count,
        history: (u.history || []).slice(0, 20),
        lastUsed: u.lastUsed,
        joinedAt: u.joinedAt,
        level: getUserLevel(u.count),
        nextLevelTarget: getNextLevelTarget(u.count),
        badge: getLevelBadge(getUserLevel(u.count)),
        isAdmin: isAdmin(uid),
        isVip: vipUsers.has(uid),
        isPremium: premiumUsers.has(uid),
        isBanned: bannedUsers.has(uid),
        isMuted: mutedUsers.has(uid),
        warnings: userWarnings.get(uid) || 0,
        rateLimit: userLimitOverrides.get(uid) ?? null,
        slowMode: slowModeUsers.get(uid) || 0,
        preferences: prefs,
        achievements,
        favoritesCount: favs.length,
        streak: streak,
        referral: ref,
    });
});

// v4.1: Leaderboard (global + weekly)
app.get('/api/stats/leaderboard', requireAdminToken, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const global = Array.from(stats.activeUsers.entries())
        .map(([id, u]) => ({
            id: Number(id),
            username: u.username,
            count: u.count || 0,
            level: getUserLevel(u.count || 0),
            badge: getLevelBadge(getUserLevel(u.count || 0)),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    const now = new Date();
    const day = now.getDay() || 7;
    const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - (day - 1));
    const weekStart = monday.getTime();
    const weekly = Array.from(weeklyTopStats.entries())
        .filter(([, v]) => v.weekStart === weekStart)
        .map(([id, v]) => ({ id: Number(id), username: v.username, count: v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    res.json({ weekStart, global, weekly });
});

// v4.1: Downloads heatmap (7 days × 24 hours)
app.get('/api/stats/heatmap', requireAdminToken, (req, res) => {
    const days = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    const rows = heatmapStats.map((hours, d) => ({
        day: days[d],
        hours,
        total: hours.reduce((s, n) => s + n, 0),
    }));
    let peak = { day: '—', hour: 0, count: 0 };
    heatmapStats.forEach((hours, d) => {
        hours.forEach((n, h) => { if (n > peak.count) peak = { day: days[d], hour: h, count: n }; });
    });
    res.json({ rows, peak });
});

// v4.1: SSE live log stream
app.get('/api/logs/stream', (req, res) => {
    if (!process.env.DASHBOARD_TOKEN || req.query.token !== process.env.DASHBOARD_TOKEN) return res.status(401).end();
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    // Send recent logs on connect (newest first then reverse for chronological UI)
    for (const entry of [...activityLogs].reverse().slice(-20)) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    const ka = setInterval(() => { try { res.write(':\n\n'); } catch (_) {} }, 20000);
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); clearInterval(ka); });
});

// v4.1: Scheduled broadcasts CRUD
app.get('/api/broadcast/scheduled', requireAdminToken, (req, res) => {
    res.json(scheduledBroadcasts.slice(-50).sort((a, b) => a.at - b.at));
});
app.post('/api/broadcast/schedule', requireAdminToken, (req, res) => {
    const { at, text } = req.body || {};
    const atMs = typeof at === 'number' ? at : Date.parse(at);
    if (!atMs || isNaN(atMs)) return res.status(400).json({ error: 'invalid at' });
    if (!text || String(text).trim().length === 0) return res.status(400).json({ error: 'empty text' });
    if (atMs < Date.now()) return res.status(400).json({ error: 'in past' });
    const job = { id: String(Date.now()), at: atMs, text, createdBy: 'dashboard', createdAt: Date.now(), sent: false };
    scheduledBroadcasts.push(job); saveData();
    res.json({ success: true, job });
});
app.delete('/api/broadcast/schedule/:id', requireAdminToken, (req, res) => {
    const idx = scheduledBroadcasts.findIndex(j => j.id === req.params.id && !j.sent);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    scheduledBroadcasts.splice(idx, 1); saveData();
    res.json({ success: true });
});

// v4.1: Public emit endpoint so bot internal events push to dashboard bell
app.post('/api/events/broadcast', requireAdminToken, (req, res) => {
    const { type = 'info', text = '' } = req.body || {};
    addActivityLog(type, text);
    res.json({ success: true });
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

app.post('/api/admin/premium', requireAdminToken, (req, res) => {
    const uid = parseInt(req.body.userId);
    const action = req.body.action;
    const user = stats.activeUsers.get(uid)?.username || 'user';
    
    if (action === 'add' || !action) {
        premiumUsers.add(uid);
        bot.sendMessage(uid, '💎 *Chúc mừng!* Bạn đã được nâng cấp lên *Premium*!', { parse_mode: 'Markdown' }).catch(() => { });
        addActivityLog('ok', `💎 Admin đã cấp Premium cho @${user} (ID: ${uid})`);
    } else {
        premiumUsers.delete(uid);
        bot.sendMessage(uid, '⚠️ Quyền Premium của bạn đã bị thu hồi.').catch(() => { });
        addActivityLog('warn', `⚠️ Admin thu hồi Premium của @${user} (ID: ${uid})`);
    }
    saveData(); res.json({ success: true });
});

app.post('/api/admin/setlimit', requireAdminToken, (req, res) => {
    const uid = parseInt(req.body.userId);
    const limit = parseInt(req.body.limit) || 0;
    const user = stats.activeUsers.get(uid)?.username || 'user';
    
    userLimitOverrides.set(uid, limit);
    addActivityLog('warn', `🚦 Admin đặt giới hạn ${limit}/10s cho @${user} (ID: ${uid})`);
    saveData(); res.json({ success: true });
});

app.post('/api/admin/resetlimit', requireAdminToken, (req, res) => {
    const uid = parseInt(req.body.userId);
    const user = stats.activeUsers.get(uid)?.username || 'user';
    
    userLimitOverrides.delete(uid);
    addActivityLog('ok', `🚦 Admin reset giới hạn cho @${user} (ID: ${uid})`);
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
    tiktok: { regex: /(?:https?:\/\/)?(?:(?:www|vt|vm|m|t|v)\.)?tiktok\.com\/(?:@[\w.-]+\/video\/\d+|video\/\d+|v\/\d+|share\/video\/\d+|[\w-]+(?:\/[\w-]+)*(?:\?[^\s]*modal_id=\d+[^\s]*)?)|(?:https?:\/\/)?(?:vm|vt|v)\.tiktok\.com\/[\w]+/i, emoji: '🎵', name: 'TikTok' },
    douyin: { regex: /(?:https?:\/\/)?(?:www\.)?douyin\.com\/(?:video\/\d+|share\/video\/\d+|@[\w.-]+\/video\/\d+|[\w-]+(?:\?[^\s]*modal_id=\d+[^\s]*)?|jingxuan\?[^\s]*modal_id=\d+[^\s]*)|(?:https?:\/\/)?v\.douyin\.com\/[\w-]+\/?|(?:https?:\/\/)?(?:www\.)?iesdouyin\.com\/share\/video\/\d+/i, emoji: '🎶', name: 'Douyin' },
    facebook: { regex: /(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.com)\/(?:[\w.-]+\/videos\/[\d]+|watch[\/?].*v=[\d]+|video\.php\?v=[\d]+|reel\/[\w]+|share\/v\/[\w]+|share\/r\/[\w]+|[\w.-]+\/posts\/[\w]+)|(?:https?:\/\/)?fb\.watch\/[\w]+/i, emoji: '🐙', name: 'Facebook' },
    youtube: { regex: /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)[\w-]+/i, emoji: '▶️', name: 'YouTube' },
    instagram: { regex: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p)\/[\w-]+/i, emoji: '📸', name: 'Instagram' },
    twitter: { regex: /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[\w]+\/status\/[\d]+/i, emoji: '🐦', name: 'Twitter/X' },
    pinterest: { regex: /(?:https?:\/\/)?(?:www\.)?pinterest\.(?:com|ph|co\.uk|fr|de)\/pin\/[\d]+/i, emoji: '📌', name: 'Pinterest' },
    snapchat: { regex: /(?:https?:\/\/)?(?:www\.)?snapchat\.com\/(?:spotlight|add|discover)\/[\w-]+/i, emoji: '👻', name: 'Snapchat' },
    reddit: { regex: /(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/[\w]+\/comments\/[\w]+/i, emoji: '🤖', name: 'Reddit' },
    bilibili: { regex: /(?:https?:\/\/)?(?:www\.)?bilibili\.com\/video\/(BV[\w]+|av[\d]+)/i, emoji: '📺', name: 'Bilibili' },
    threads: { regex: /(?:https?:\/\/)?(?:www\.)?threads\.(?:net|com)\/@[\w.-]+\/post\/[\w-]+/i, emoji: '🧵', name: 'Threads' },
    vimeo: { regex: /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(?:channels\/[\w-]+\/\d+|groups\/[\w-]+\/videos\/\d+|\d+(?:\/\w+)?)|(?:https?:\/\/)?player\.vimeo\.com\/video\/\d+/i, emoji: '🎬', name: 'Vimeo' },
    dailymotion: { regex: /(?:https?:\/\/)?(?:www\.)?dailymotion\.com\/(?:video|embed\/video)\/[\w]+|(?:https?:\/\/)?dai\.ly\/[\w]+/i, emoji: '📹', name: 'Dailymotion' },
    likee: { regex: /(?:https?:\/\/)?(?:www\.|l\.|m\.)?likee\.(?:video|com)\/(?:v\/[\w-]+|@[\w.-]+\/video\/\d+|video\/\d+|[\w.-]+\/video\/\d+)/i, emoji: '🎯', name: 'Likee' },
};

function detectPlatform(text) {
    for (const [key, p] of Object.entries(PLATFORMS)) {
        const m = text.match(p.regex);
        if (m) return { platform: key, match: m[0] };
    }
    return null;
}

// v4.0: find ALL supported URLs in a message (batch mode). De-duped and capped at 10.
function detectAllPlatforms(text) {
    const results = [];
    const seen = new Set();
    for (const [key, p] of Object.entries(PLATFORMS)) {
        const global = new RegExp(p.regex.source, p.regex.flags.includes('g') ? p.regex.flags : p.regex.flags + 'g');
        let m;
        while ((m = global.exec(text)) !== null) {
            if (!m[0]) break;
            if (!seen.has(m[0])) {
                seen.add(m[0]);
                results.push({ platform: key, match: m[0] });
                if (results.length >= 10) return results;
            }
            if (global.lastIndex === m.index) global.lastIndex++;
        }
    }
    return results;
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

function updateUserStats(userId, username, platform) {
    if (!stats.activeUsers.has(userId)) {
        stats.activeUsers.set(userId, { username: username || 'Unknown', count: 0, lastUsed: Date.now(), history: [], joinedAt: Date.now(), platformsUsed: [] });
        addActivityLog('warn', `🆕 User mới tham gia: @${username || 'unknown'} (ID: ${userId})`);
    }
    const user = stats.activeUsers.get(userId);
    user.count++;
    user.lastUsed = Date.now();
    user.username = username || user.username;
    if (!user.platformsUsed) user.platformsUsed = [];
    if (platform && !user.platformsUsed.includes(platform)) user.platformsUsed.push(platform);
    const hour = new Date().getHours();
    hourlyStats[hour] = (hourlyStats[hour] || 0) + 1;
    dailyStats.requests++;
    if (platform) incPlatformStat(platform);
    saveData();
}

function recordHistory(userId, videoUrl, platform, title) {
    const user = stats.activeUsers.get(userId);
    if (!user) return;
    if (!user.history) user.history = [];
    user.history.unshift({ url: videoUrl, platform, title: title || null, time: Date.now() });
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
// /start — v4.0: rich inline menu + referral support
bot.onText(/^\/start(?:\s+(\S+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const username = msg.from?.first_name || 'bạn';
    const badge = getUserBadge(userId);
    const refArg = match?.[1];
    const supportedPlatforms = Object.values(PLATFORMS).map(p => ` ${p.emoji} ${p.name}`).join('\n');

    // Handle referral only for brand-new users
    if (refArg && !stats.activeUsers.has(userId)) {
        const refId = parseInt(refArg.replace(/^ref_/, ''));
        if (refId && refId !== userId) {
            const rd = referralData.get(refId) || { invitedCount: 0, invitees: [] };
            if (!rd.invitees.includes(userId)) {
                rd.invitees.push(userId);
                rd.invitedCount = rd.invitees.length;
                referralData.set(refId, rd);
                const selfRd = referralData.get(userId) || { invitedCount: 0, invitees: [] };
                selfRd.referrer = refId;
                referralData.set(userId, selfRd);
                saveData();
                // notify inviter
                bot.sendMessage(refId,
                    `🎁 *Có người vừa dùng link mời của bạn!*\n` +
                    `👤 @${msg.from?.username || msg.from?.first_name}\n` +
                    `📊 Tổng đã mời: *${rd.invitedCount}* người`,
                    { parse_mode: 'Markdown' }
                ).catch(() => { });
            }
        }
    }

    const levelCount = stats.activeUsers.get(userId)?.count || 0;
    const lvl = getUserLevel(levelCount);
    const badgeStr = getLevelBadge(lvl);

    await bot.sendMessage(chatId,
        `${badge ? badge + ' ' : ''}${t(userId, 'welcome', username)}\n\n` +
        (maintenanceMode ? `${t(userId, 'maintenance')}\n\n` : '') +
        `🎖️ Cấp bậc: ${badgeStr} (Lv.${lvl})\n\n` +
        `${t(userId, 'supportedPlatforms')}\n${supportedPlatforms}\n\n` +
        `${t(userId, 'typeHelp')}`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buildMainMenuKeyboard(userId)
            }
        }
    );
});

// Reusable main menu keyboard generator
function buildMainMenuKeyboard(userId) {
    const rows = [
        [
            { text: t(userId, 'menu_favorites'), callback_data: 'nav_favorites' },
            { text: t(userId, 'menu_achievements'), callback_data: 'nav_achievements' },
        ],
        [
            { text: t(userId, 'menu_settings'), callback_data: 'nav_settings' },
            { text: t(userId, 'menu_status'), callback_data: 'nav_status' },
        ],
        [
            { text: t(userId, 'menu_invite'), callback_data: 'nav_invite' },
            { text: t(userId, 'menu_help'), callback_data: 'nav_help' },
        ]
    ];
    if (isAdmin(userId)) {
        rows.push([{ text: t(userId, 'menu_dashboard'), url: DASHBOARD_URL }]);
    }
    return rows;
}

// /help - Tùy theo quyền Admin hay User thường
bot.onText(/^\/help$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const isAdminUser = userId === ADMIN_USER_ID;

    let text = `📖 *Hướng dẫn Nobita Bot v${BOT_VERSION} — ${BOT_EDITION}*\n\n`;

    // Lệnh cho tất cả người dùng
    text += `🔸 *Lệnh cơ bản:*\n`;
    text += `• /start — Khởi động bot\n`;
    text += `• /help — Xem hướng dẫn\n`;
    text += `• /ping — Kiểm tra tốc độ (đo theo API)\n`;
    text += `• /status — Trạng thái bot\n`;
    text += `• /platforms — Nền tảng hỗ trợ\n`;
    text += `• /myinfo — Thông tin tài khoản\n`;
    text += `• /history — Lịch sử tải của bạn\n`;
    text += `• /top — BXH người dùng tích cực\n`;
    text += `• /report <nội dung> — Báo lỗi cho admin\n\n`;

    text += `🆕 *Tính năng v4.0:*\n`;
    text += `• /settings — Cài đặt cá nhân (ngôn ngữ, chất lượng...)\n`;
    text += `• /lang vi|en — Đổi ngôn ngữ\n`;
    text += `• /fav <url> — Lưu video yêu thích\n`;
    text += `• /favorites — Danh sách yêu thích\n`;
    text += `• /info <url> — Xem thông tin video (không tải)\n`;
    text += `• /qr <text> — Tạo mã QR\n`;
    text += `• /daily — Điểm danh nhận thưởng streak\n`;
    text += `• /achievements — Huy hiệu & thành tích\n`;
    text += `• /level — Cấp bậc & kinh nghiệm\n`;
    text += `• /invite — Lấy link mời bạn bè\n\n`;

    text += `✨ *Tính năng v4.1 (mới):*\n`;
    text += `• /topweek — BXH tuần\n`;
    text += `• /translate <mã> <text> — Dịch văn bản (vi/en/ja/ko...)\n`;
    text += `• /weather <thành phố> — Thời tiết trực tiếp\n`;
    text += `• /short <url> — Rút gọn link\n`;
    text += `• /expand <url> — Mở full link rút gọn\n`;
    text += `• /thumb <url> — Lấy ảnh thumbnail video\n`;
    text += `• /export — Xuất dữ liệu cá nhân (JSON)\n`;
    text += `• /joke — Chuyện cười ngẫu nhiên\n`;
    text += `• /quote — Câu nói truyền cảm hứng\n\n`;

    text += `💡 Gửi link video bất kỳ để tải (không watermark). Bot cũng tự động xử lý khi bạn gửi nhiều link trong một tin nhắn (batch mode).\n`;
    text += `⚡ Inline mode: gõ \`@${(await bot.getMe().catch(() => ({}))).username || 'bot'} <url>\` trong mọi cuộc chat.\n\n`;

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
        text += `• /schedule YYYY-MM-DD HH:MM <text> — Hẹn giờ broadcast\n`;
        text += `• /scheduled — Xem broadcast đang chờ\n`;
        text += `• /unschedule <id> — Hủy broadcast đã hẹn\n`;
        text += `• /search <từ khóa> — Tìm user/history nhanh\n`;
        text += `• /cleanup — Dọn user 60 ngày không hoạt động\n`;
        text += `• /sysinfo — Thông tin hệ thống chi tiết\n`;
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
// /ping — v4.0: đo theo API (Telegram + TikWM + SnapSave)
bot.onText(/^\/ping$/, async (msg) => {
    const chatId = msg.chat.id;
    const start = Date.now();
    const m = await bot.sendMessage(chatId, '🏓 Pinging...');
    const tgPing = Date.now() - start;

    const timed = async (label, fn) => {
        const t0 = Date.now();
        try { await fn(); return { label, ok: true, ms: Date.now() - t0 }; }
        catch (e) { return { label, ok: false, ms: Date.now() - t0, err: e.code || e.message }; }
    };

    const probes = await Promise.all([
        timed('TikWM', () => axios.get('https://www.tikwm.com/', { timeout: 5000 })),
        timed('SnapSave', () => axios.get('https://snapsave.app/', { timeout: 5000 })),
        timed('Cobalt', () => axios.get('https://api.cobalt.tools/', { timeout: 5000, validateStatus: () => true })),
    ]);

    const mem = process.memoryUsage();
    const memMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    let text = `🏓 *Pong!*\n`;
    text += `📡 Telegram API: \`${tgPing}ms\`\n`;
    probes.forEach(p => {
        text += `${p.ok ? '✅' : '❌'} ${p.label}: \`${p.ms}ms\`${p.ok ? '' : ` (${p.err})`}\n`;
    });
    text += `⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}\n`;
    text += `💾 RAM: ${memMB} MB\n`;
    text += `📋 Queue: ${requestQueue.length} / ${MAX_CONCURRENT}`;

    bot.editMessageText(text, {
        chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown'
    }).catch(() => { });
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
// 🆕 v4.0 USER COMMANDS: /settings /lang /fav /favorites /info /qr /daily /achievements /level /invite
// ============================================================

// /settings
bot.onText(/^\/settings$/, (msg) => {
    sendSettingsPanel(msg.chat.id, msg.from?.id);
});

function sendSettingsPanel(chatId, userId, editMessageId) {
    const prefs = getUserPrefs(userId);
    const onoff = v => v ? '🟢 BẬT' : '⚪ TẮT';
    const qLabel = q => ({ hd: '🎥 HD', sd: '📼 SD', mp3: '🎵 MP3' }[q] || q);
    const text =
        `⚙️ *Cài đặt cá nhân*\n\n` +
        `🌍 Ngôn ngữ: *${prefs.lang.toUpperCase()}*\n` +
        `🎚️ Chất lượng mặc định: *${qLabel(prefs.defaultQuality)}*\n` +
        `🎵 Nút tải MP3: ${onoff(prefs.showMP3Btn)}\n` +
        `🔇 Silent mode: ${onoff(prefs.silentMode)}\n` +
        `⭐ Tự lưu yêu thích: ${onoff(prefs.autoFav)}\n\n` +
        `💡 Bấm nút bên dưới để thay đổi nhanh.`;
    const keyboard = [
        [
            { text: `🌍 Lang: ${prefs.lang === 'vi' ? 'VI→EN' : 'EN→VI'}`, callback_data: 'set_lang' },
            { text: `🎚️ Quality: ${prefs.defaultQuality.toUpperCase()}`, callback_data: 'set_quality' },
        ],
        [
            { text: `🎵 MP3 btn: ${prefs.showMP3Btn ? 'OFF' : 'ON'}`, callback_data: 'set_mp3btn' },
            { text: `🔇 Silent: ${prefs.silentMode ? 'OFF' : 'ON'}`, callback_data: 'set_silent' },
        ],
        [
            { text: `⭐ AutoFav: ${prefs.autoFav ? 'OFF' : 'ON'}`, callback_data: 'set_autofav' },
            { text: '🔄 Reset về mặc định', callback_data: 'set_reset' },
        ],
        [{ text: '✖️ Đóng', callback_data: 'set_close' }]
    ];
    if (editMessageId) {
        bot.editMessageText(text, {
            chat_id: chatId, message_id: editMessageId,
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });
    } else {
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    }
}

// /lang vi|en
bot.onText(/^\/lang(?:\s+(\w+))?$/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const lang = (match?.[1] || '').toLowerCase();
    if (lang !== 'vi' && lang !== 'en') {
        bot.sendMessage(chatId, 'Cú pháp: `/lang vi` hoặc `/lang en`', { parse_mode: 'Markdown' });
        return;
    }
    setUserPref(userId, 'lang', lang);
    bot.sendMessage(chatId, lang === 'vi' ? '🇻🇳 Đã đổi ngôn ngữ sang Tiếng Việt.' : '🇺🇸 Language set to English.');
});

// /fav [url] — thêm vào yêu thích (nếu không có url, dùng history[0])
bot.onText(/^\/fav(?:\s+(.+))?$/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    let url = match?.[1]?.trim();
    let platform;
    if (!url) {
        const hist = stats.activeUsers.get(userId)?.history || [];
        if (!hist.length) return bot.sendMessage(chatId, '💡 Gửi kèm link: `/fav <url>` hoặc tải một video trước đã.', { parse_mode: 'Markdown' });
        url = hist[0].url;
        platform = hist[0].platform;
    } else {
        const det = detectPlatform(url);
        if (!det) return bot.sendMessage(chatId, '❌ Link không được hỗ trợ.');
        url = det.match;
        platform = det.platform;
    }
    const ok = addFavorite(userId, url, platform);
    bot.sendMessage(chatId, ok ? t(userId, 'saved_fav') : '⚠️ Link này đã có trong yêu thích.');
});

// /favorites
bot.onText(/^\/favorites$/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const list = userFavorites.get(userId) || [];
    if (!list.length) return bot.sendMessage(chatId, t(userId, 'no_favs'));
    let text = `⭐ *Yêu thích (${list.length}/100)*\n\n`;
    list.slice(0, 15).forEach((it, i) => {
        const pMeta = PLATFORMS[it.platform];
        const emoji = pMeta ? pMeta.emoji : '🎬';
        const short = it.url.length > 50 ? it.url.substring(0, 50) + '...' : it.url;
        text += `${i + 1}. ${emoji} \`${short}\`\n   🗓️ ${new Date(it.savedAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}\n\n`;
    });
    if (list.length > 15) text += `\n_...và ${list.length - 15} mục nữa._`;
    bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
            { text: '🗑️ Xóa tất cả', callback_data: 'fav_clear' }
        ]]}
    });
});

// /info <url> — xem metadata không tải về
bot.onText(/^\/info\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1].trim();
    const det = detectPlatform(url);
    if (!det) return bot.sendMessage(chatId, '❌ Link không được hỗ trợ. Dùng /platforms để xem danh sách.');
    const p = PLATFORMS[det.platform];
    const processing = await bot.sendMessage(chatId, `🔍 Đang lấy thông tin ${p.emoji} ${p.name}...`);
    try {
        const info = await getVideoInfo(det.match, det.platform);
        let text = `ℹ️ *Thông tin video*\n\n`;
        text += `${p.emoji} *Nền tảng:* ${p.name}\n`;
        if (info?.title) text += `📝 *Tiêu đề:* ${info.title.substring(0, 200)}\n`;
        if (info?.author) text += `👤 *Tác giả:* ${info.author}\n`;
        if (info?.duration) text += `⏱️ *Thời lượng:* ${info.duration}s\n`;
        if (info?.sizeMB) text += `💾 *Kích thước:* ~${info.sizeMB.toFixed(1)} MB\n`;
        if (info?.url) text += `\n🔗 [Link trực tiếp](${info.url})`;
        bot.editMessageText(text, { chat_id: chatId, message_id: processing.message_id, parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => { });
    } catch (e) {
        bot.editMessageText('❌ Không lấy được thông tin video. ' + e.message, { chat_id: chatId, message_id: processing.message_id }).catch(() => { });
    }
});

// Simple metadata fetcher used by /info (best-effort)
async function getVideoInfo(url, platform) {
    try {
        if (platform === 'tiktok' || platform === 'douyin') {
            const res = await axios.post('https://www.tikwm.com/api/', { url, hd: 1 }, { timeout: 15000 });
            const d = res.data?.data;
            if (!d) return null;
            return {
                title: d.title,
                author: d.author?.nickname,
                duration: d.duration,
                sizeMB: d.size ? d.size / 1024 / 1024 : undefined,
                url: d.hdplay || d.play
            };
        }
        // Fallback: try yt-dlp for everything else (facebook, youtube, instagram, etc.)
        const ytdl = require('youtube-dl-exec');
        const info = await ytdl(url, { dumpSingleJson: true, noWarnings: true, noCheckCertificates: true });
        return {
            title: info.title,
            author: info.uploader || info.channel,
            duration: info.duration,
            sizeMB: info.filesize ? info.filesize / 1024 / 1024 : (info.filesize_approx ? info.filesize_approx / 1024 / 1024 : undefined),
            url: info.url
        };
    } catch (e) {
        return null;
    }
}

// /qr <text>
bot.onText(/^\/qr\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const content = match[1].trim();
    if (content.length > 500) return bot.sendMessage(chatId, '❌ Nội dung quá dài (tối đa 500 ký tự).');
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=12&data=${encodeURIComponent(content)}`;
    try {
        await bot.sendPhoto(chatId, qrUrl, {
            caption: `🔳 *QR Code*\n\`\`\`\n${content.substring(0, 200)}${content.length > 200 ? '...' : ''}\n\`\`\``,
            parse_mode: 'Markdown'
        });
    } catch (e) {
        bot.sendMessage(chatId, '❌ Không tạo được QR: ' + e.message);
    }
});

// /daily — check-in streak
bot.onText(/^\/daily$/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let entry = dailyStreaks.get(userId) || { streak: 0, lastClaim: null, points: 0 };
    if (entry.lastClaim === today) {
        return bot.sendMessage(chatId,
            `✅ Bạn đã điểm danh hôm nay rồi!\n🔥 Streak hiện tại: *${entry.streak}* ngày\n⭐ Tổng điểm: *${entry.points}*`,
            { parse_mode: 'Markdown' }
        );
    }
    if (entry.lastClaim === yesterday) entry.streak += 1;
    else entry.streak = 1;
    entry.lastClaim = today;
    const bonus = 10 + Math.min(entry.streak * 2, 50); // tăng dần, cap 60
    entry.points = (entry.points || 0) + bonus;
    dailyStreaks.set(userId, entry);
    saveData();
    bot.sendMessage(chatId,
        `🎉 *Điểm danh thành công!*\n\n` +
        `🔥 Streak: *${entry.streak}* ngày liên tục\n` +
        `💰 +${bonus} điểm (Tổng: *${entry.points}*)\n` +
        `⏰ Quay lại vào ngày mai để duy trì streak!`,
        { parse_mode: 'Markdown' }
    );
});

// /achievements
bot.onText(/^\/achievements$/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const unlocked = getUserAchievements(userId);
    const unlockedIds = new Set(unlocked.map(a => a.id));
    let text = `🏅 *Thành tích của bạn (${unlocked.length}/${ACHIEVEMENTS.length})*\n\n`;
    ACHIEVEMENTS.forEach(a => {
        const got = unlockedIds.has(a.id);
        text += `${got ? '✅' : '🔒'} ${a.name} — ${a.desc}\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// /level
bot.onText(/^\/level$/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const u = stats.activeUsers.get(userId);
    const count = u?.count || 0;
    const lvl = getUserLevel(count);
    const badge = getLevelBadge(lvl);
    const next = getNextLevelTarget(count);
    const progress = Math.min(1, count / Math.max(next, 1));
    const bar = '█'.repeat(Math.round(progress * 10)) + '░'.repeat(10 - Math.round(progress * 10));
    bot.sendMessage(chatId,
        `🎖️ *Cấp bậc*\n\n` +
        `${badge} — *Lv.${lvl}*\n` +
        `📥 Đã tải: *${count}* video\n` +
        `📊 Tiến độ: \`${bar}\` ${Math.round(progress * 100)}%\n` +
        (lvl < LEVEL_THRESHOLDS.length - 1 ? `🎯 Mục tiêu kế: *${next}* video → Lv.${lvl + 1}` : `🏆 Bạn đã đạt cấp cao nhất!`),
        { parse_mode: 'Markdown' }
    );
});

// /invite
bot.onText(/^\/invite$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    let me;
    try { me = await bot.getMe(); } catch { me = { username: 'your_bot' }; }
    const link = `https://t.me/${me.username}?start=ref_${userId}`;
    const rd = referralData.get(userId) || { invitedCount: 0, invitees: [] };
    bot.sendMessage(chatId,
        `🎁 *Mời bạn — Nhận thưởng!*\n\n` +
        `🔗 Link cá nhân của bạn:\n\`${link}\`\n\n` +
        `👥 Đã mời: *${rd.invitedCount}* người\n` +
        `💡 Khi có người vào bot qua link của bạn, bạn sẽ nhận thông báo & điểm thưởng.`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '📤 Chia sẻ link', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Tải video không logo cực nhanh với Nobita Bot! 🤖')}` }
                ]]
            }
        }
    );
});

// ============================================================
// ✨ v4.1 EXTRA UTILITIES — translate / weather / short / thumb / etc.
// ============================================================

// /translate <target> <text>   (free LibreTranslate mirror)
bot.onText(/^\/translate(?:\s+(\w{2}))?\s+([\s\S]+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const targetArg = (match[1] || 'en').toLowerCase();
    const text = (match[2] || '').trim();
    if (!text) return bot.sendMessage(chatId, 'ℹ️ Cú pháp: `/translate <mã_ngôn_ngữ> <nội dung>`\nVí dụ: `/translate en Xin chào`', { parse_mode: 'Markdown' });
    const notify = await bot.sendMessage(chatId, '🌐 Đang dịch...');
    const endpoints = [
        'https://translate.astian.org/translate',
        'https://libretranslate.de/translate',
        'https://translate.terraprint.co/translate',
    ];
    let result = null;
    for (const ep of endpoints) {
        try {
            const res = await axios.post(ep, { q: text, source: 'auto', target: targetArg, format: 'text' }, { timeout: 10000 });
            if (res.data?.translatedText) { result = res.data.translatedText; break; }
        } catch (_) {}
    }
    if (!result) return bot.editMessageText('❌ Dịch vụ dịch tạm không phản hồi. Thử lại sau.', { chat_id: chatId, message_id: notify.message_id });
    bot.editMessageText(`🌐 *Dịch sang ${targetArg.toUpperCase()}*\n\n${result}`, {
        chat_id: chatId, message_id: notify.message_id, parse_mode: 'Markdown'
    });
});

// /weather <city>   (wttr.in, no API key)
bot.onText(/^\/weather\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const city = match[1].trim();
    const notify = await bot.sendMessage(chatId, `🌤️ Đang lấy thời tiết *${city}*...`, { parse_mode: 'Markdown' });
    try {
        const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}`, {
            params: { format: 'j1' }, timeout: 10000, headers: { 'User-Agent': 'curl/7.0' }
        });
        const cur = data?.current_condition?.[0];
        const area = data?.nearest_area?.[0]?.areaName?.[0]?.value || city;
        if (!cur) throw new Error('no data');
        const txt =
            `🌤️ *Thời tiết ${area}*\n\n` +
            `🌡️ Nhiệt độ: *${cur.temp_C}°C* (cảm giác ${cur.FeelsLikeC}°C)\n` +
            `💧 Độ ẩm: ${cur.humidity}%\n` +
            `💨 Gió: ${cur.windspeedKmph} km/h ${cur.winddir16Point}\n` +
            `☁️ Trạng thái: ${cur.lang_vi?.[0]?.value || cur.weatherDesc?.[0]?.value}\n` +
            `👁️ Tầm nhìn: ${cur.visibility} km\n` +
            `🕒 Cập nhật: ${cur.localObsDateTime || '—'}`;
        bot.editMessageText(txt, { chat_id: chatId, message_id: notify.message_id, parse_mode: 'Markdown' });
    } catch (e) {
        bot.editMessageText(`❌ Không lấy được thời tiết cho "${city}".`, { chat_id: chatId, message_id: notify.message_id });
    }
});

// /short <url>   (is.gd, no API key)
bot.onText(/^\/short\s+(\S+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1];
    try {
        const { data } = await axios.get('https://is.gd/create.php', {
            params: { format: 'simple', url }, timeout: 10000
        });
        if (typeof data === 'string' && data.startsWith('http')) {
            bot.sendMessage(chatId, `🔗 *Link rút gọn:*\n\`${data.trim()}\``, { parse_mode: 'Markdown' });
        } else throw new Error('bad');
    } catch { bot.sendMessage(chatId, '❌ Không rút gọn được. Kiểm tra lại URL.'); }
});

// /expand <short_url>   (follow redirects)
bot.onText(/^\/expand\s+(\S+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1];
    try {
        const res = await axios.get(url, { maxRedirects: 10, timeout: 10000, validateStatus: () => true });
        const final = res.request?.res?.responseUrl || res.config?.url || url;
        bot.sendMessage(chatId, `🔓 *Link đầy đủ:*\n\`${final}\``, { parse_mode: 'Markdown' });
    } catch { bot.sendMessage(chatId, '❌ Không expand được URL.'); }
});

// /thumb <url>   (extract thumbnail for tiktok via tikwm)
bot.onText(/^\/thumb\s+(\S+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1];
    const platform = detectPlatform(url);
    const notify = await bot.sendMessage(chatId, '🖼️ Đang lấy ảnh thumbnail...');
    try {
        if (platform?.platform === 'tiktok' || platform?.platform === 'douyin') {
            const { data } = await axios.post('https://www.tikwm.com/api/', { url, hd: 1 }, { timeout: 15000, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
            const cover = data?.data?.cover || data?.data?.origin_cover;
            if (!cover) throw new Error('no cover');
            await bot.deleteMessage(chatId, notify.message_id).catch(() => {});
            return bot.sendPhoto(chatId, cover, { caption: `🖼️ Thumbnail từ ${platform.platform}\n\n${data.data.title || ''}` });
        }
        // fallback: try to fetch og:image meta
        const html = (await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } })).data;
        const m = String(html).match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        if (!m) throw new Error('no og:image');
        await bot.deleteMessage(chatId, notify.message_id).catch(() => {});
        bot.sendPhoto(chatId, m[1], { caption: `🖼️ Thumbnail\n${url}` });
    } catch { bot.editMessageText('❌ Không lấy được thumbnail.', { chat_id: chatId, message_id: notify.message_id }); }
});

// /export  — gửi JSON data cá nhân
bot.onText(/^\/export$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const u = stats.activeUsers.get(userId);
    const profile = {
        id: userId,
        username: msg.from?.username,
        exportedAt: new Date().toISOString(),
        profile: u ? {
            count: u.count, joinedAt: u.joinedAt, lastUsed: u.lastUsed,
            history: u.history || [], platformsUsed: u.platformsUsed || [], warnings: u.warnings || 0,
        } : null,
        preferences: getUserPrefs(userId),
        favorites: userFavorites.get(userId) || [],
        dailyStreak: dailyStreaks.get(userId) || null,
        referral: referralData.get(userId) || null,
        achievements: getUserAchievements(userId).map(a => ({ id: a.id, name: a.name })),
        level: u ? { level: getUserLevel(u.count), next: getNextLevelTarget(u.count) } : null,
    };
    const buf = Buffer.from(JSON.stringify(profile, null, 2), 'utf8');
    const fname = `nobita-export-${userId}-${Date.now()}.json`;
    await bot.sendDocument(chatId, buf, { caption: '📦 Dữ liệu cá nhân của bạn trên Nobita Bot.' }, { filename: fname, contentType: 'application/json' });
});

// /joke  (free jokes API)
bot.onText(/^\/joke$/i, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const { data } = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 8000 });
        bot.sendMessage(chatId, `😂 *${data.setup}*\n\n_${data.punchline}_`, { parse_mode: 'Markdown' });
    } catch { bot.sendMessage(chatId, '😅 Hôm nay hết chuyện cười rồi, thử lại sau nhé!'); }
});

// /quote  (free quotes API — Zen Quotes)
bot.onText(/^\/quote$/i, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const { data } = await axios.get('https://zenquotes.io/api/random', { timeout: 8000 });
        const q = data?.[0];
        if (!q?.q) throw new Error('no');
        bot.sendMessage(chatId, `💭 _"${q.q}"_\n\n— *${q.a}*`, { parse_mode: 'Markdown' });
    } catch { bot.sendMessage(chatId, '💡 "Cố lên! Thử lại sau nhé." — Nobita Bot'); }
});

// /topweek  (top của tuần này)
bot.onText(/^\/topweek$/i, (msg) => {
    const chatId = msg.chat.id;
    if (weeklyTopStats.size === 0) return bot.sendMessage(chatId, '📭 Tuần này chưa có dữ liệu.');
    const now = new Date();
    const day = now.getDay() || 7;
    const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - (day - 1));
    const weekStart = monday.getTime();
    const rows = Array.from(weeklyTopStats.entries())
        .filter(([, v]) => v.weekStart === weekStart)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10);
    if (!rows.length) return bot.sendMessage(chatId, '📭 Tuần này chưa có dữ liệu.');
    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    let out = `🏆 *Top tuần này* (từ ${monday.toLocaleDateString('vi-VN')})\n\n`;
    rows.forEach(([id, v], i) => { out += `${medals[i]} @${v.username || id} — *${v.count}* video\n`; });
    bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
});

// ============================================================
// ⚡ v4.1 INLINE MODE — @botname <url>
// ============================================================
bot.on('inline_query', async (q) => {
    try {
        const query = (q.query || '').trim();
        if (!query) {
            return bot.answerInlineQuery(q.id, [{
                type: 'article', id: 'help',
                title: '📎 Dán link video vào đây...',
                description: 'Hỗ trợ TikTok, Facebook, YouTube, Instagram, X/Twitter, Pinterest, Reddit, Bilibili',
                input_message_content: { message_text: 'Nhập link video sau @' + (await bot.getMe()).username + ' để tải nhanh.' },
            }], { cache_time: 5 });
        }
        const det = detectAllPlatforms(query).slice(0, 5);
        if (!det.length) {
            return bot.answerInlineQuery(q.id, [{
                type: 'article', id: 'nourl',
                title: '❌ Không tìm thấy link hợp lệ',
                description: 'Vui lòng dán URL video được hỗ trợ',
                input_message_content: { message_text: '❌ Link không hợp lệ: ' + query },
            }], { cache_time: 5 });
        }
        const results = [];
        for (const d of det) {
            const pInfo = PLATFORMS[d.platform];
            results.push({
                type: 'article',
                id: 'r_' + d.platform + '_' + results.length,
                title: `${pInfo?.emoji || '🎬'} Tải ${pInfo?.name || d.platform}`,
                description: d.match.substring(0, 64),
                input_message_content: {
                    message_text: `🎬 *${pInfo?.name || d.platform}*\n\n${d.match}\n\n⬇️ Gửi link này trực tiếp cho @${(await bot.getMe()).username} để tải.`,
                    parse_mode: 'Markdown',
                },
                reply_markup: {
                    inline_keyboard: [[
                        { text: '⬇️ Mở bot để tải', url: `https://t.me/${(await bot.getMe()).username}?start=` },
                    ]],
                },
            });
        }
        bot.answerInlineQuery(q.id, results, { cache_time: 5 });
    } catch (e) { /* swallow */ }
});

// ============================================================
// 👑 ADMIN COMMANDS
// ============================================================
const ADMIN_CMDS = ['stats', 'users', 'broadcast', 'ban', 'unban', 'queue', 'addvip', 'removevip',
    'vips', 'panel', 'setlimit', 'resetlimit', 'limits', 'maintenance', 'warn', 'clearwarn',
    'slowmode', 'clearslowmode', 'premium', 'removepremium', 'premiums', 'caption',
    'setmaxsize', 'botinfo', 'clearqueue', 'kickqueue', 'announce',
    'schedule', 'scheduled', 'unschedule', 'search', 'cleanup', 'sysinfo'];

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

        // ===== v4.1 admin commands =====
        case 'schedule': {
            // /schedule <YYYY-MM-DD HH:MM> <text>
            const m = args.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s+([\s\S]+)/);
            if (!m) { bot.sendMessage(chatId, 'ℹ️ Cú pháp:\n`/schedule 2026-05-01 08:00 Nội dung`', { parse_mode: 'Markdown' }); break; }
            const [_, date, hh, mm, text] = m;
            const at = new Date(`${date}T${hh.padStart(2,'0')}:${mm}:00`).getTime();
            if (isNaN(at) || at < Date.now()) { bot.sendMessage(chatId, '❌ Thời điểm không hợp lệ hoặc đã qua.'); break; }
            const job = { id: String(Date.now()), at, text, createdBy: userId, createdAt: Date.now(), sent: false };
            scheduledBroadcasts.push(job); saveData();
            bot.sendMessage(chatId, `✅ Đã lên lịch broadcast *#${job.id}* vào ${new Date(at).toLocaleString('vi-VN')}.`, { parse_mode: 'Markdown' });
            break;
        }

        case 'scheduled': {
            const pending = scheduledBroadcasts.filter(j => !j.sent).sort((a, b) => a.at - b.at);
            if (!pending.length) { bot.sendMessage(chatId, '📭 Không có broadcast nào được lên lịch.'); break; }
            const text = pending.slice(0, 15).map(j =>
                `• *#${j.id}* — ${new Date(j.at).toLocaleString('vi-VN')}\n  _${j.text.substring(0, 80)}${j.text.length > 80 ? '…' : ''}_`
            ).join('\n\n');
            bot.sendMessage(chatId, `📅 *Broadcast đang chờ:*\n\n${text}`, { parse_mode: 'Markdown' });
            break;
        }

        case 'unschedule': {
            if (!args) { bot.sendMessage(chatId, 'ℹ️ Cú pháp: `/unschedule <id>`', { parse_mode: 'Markdown' }); break; }
            const idx = scheduledBroadcasts.findIndex(j => j.id === args && !j.sent);
            if (idx === -1) { bot.sendMessage(chatId, '❌ Không tìm thấy id này.'); break; }
            scheduledBroadcasts.splice(idx, 1); saveData();
            bot.sendMessage(chatId, `🗑️ Đã hủy broadcast #${args}.`);
            break;
        }

        case 'search': {
            if (!args) { bot.sendMessage(chatId, 'ℹ️ Cú pháp: `/search <từ khóa>` (tìm trong username/id/history)', { parse_mode: 'Markdown' }); break; }
            const q = args.toLowerCase();
            const matches = [];
            for (const [id, u] of stats.activeUsers.entries()) {
                const hay = `${id} ${u.username || ''}`.toLowerCase();
                const histMatch = (u.history || []).some(h => (h.url || '').toLowerCase().includes(q) || (h.platform || '').toLowerCase().includes(q));
                if (hay.includes(q) || histMatch) matches.push({ id, username: u.username, count: u.count });
                if (matches.length >= 25) break;
            }
            if (!matches.length) { bot.sendMessage(chatId, '📭 Không tìm thấy.'); break; }
            const text = matches.map(m => `• \`${m.id}\` @${m.username || '—'} — ${m.count}`).join('\n');
            bot.sendMessage(chatId, `🔎 *${matches.length} kết quả:*\n\n${text}`, { parse_mode: 'Markdown' });
            break;
        }

        case 'cleanup': {
            // Remove users inactive >60 days and count=0
            const cutoff = Date.now() - 60 * 86400 * 1000;
            let removed = 0;
            for (const [id, u] of Array.from(stats.activeUsers.entries())) {
                if ((u.count || 0) === 0 && (u.lastUsed || 0) < cutoff) {
                    stats.activeUsers.delete(id); removed++;
                }
            }
            saveData();
            bot.sendMessage(chatId, `🧹 Đã dọn ${removed} user không hoạt động >60 ngày.`);
            break;
        }

        case 'sysinfo': {
            const os = require('os');
            const mem = process.memoryUsage();
            const used = os.totalmem() - os.freemem();
            bot.sendMessage(chatId,
                `🖥️ *Hệ thống*\n\n` +
                `• Host: \`${os.hostname()}\` (${os.platform()}/${os.arch()})\n` +
                `• Node: ${process.version}\n` +
                `• CPU: ${os.cpus()[0].model} × ${os.cpus().length}\n` +
                `• Load: ${os.loadavg().map(n => n.toFixed(2)).join(' · ')}\n` +
                `• RAM: ${Math.round(used / 1048576)}MB / ${Math.round(os.totalmem() / 1048576)}MB\n` +
                `• Heap: ${Math.round(mem.heapUsed / 1048576)}MB / ${Math.round(mem.heapTotal / 1048576)}MB\n` +
                `• RSS: ${Math.round(mem.rss / 1048576)}MB\n` +
                `• Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
                `• Bot: v${BOT_VERSION} ${BOT_EDITION}`,
                { parse_mode: 'Markdown' });
            break;
        }
    }
});

// ============================================================
// 🕒 v4.1 SCHEDULED BROADCAST EXECUTOR — tick every 30s
// ============================================================
setInterval(async () => {
    const now = Date.now();
    for (const job of scheduledBroadcasts) {
        if (job.sent || job.at > now) continue;
        job.sent = true; job.sentAt = now;
        const targets = Array.from(stats.activeUsers.keys());
        let success = 0, failed = 0;
        for (const id of targets) {
            try { await bot.sendMessage(id, `📢 ${job.text}`, { parse_mode: 'Markdown' }); success++; }
            catch { failed++; }
            await new Promise(r => setTimeout(r, 50));
        }
        addActivityLog('broadcast', `📅 Scheduled #${job.id}: ${success}/${targets.length} delivered`);
        saveData();
    }
}, 30 * 1000);

// ============================================================
// 🎵 CALLBACK HANDLER (MP3 + v4.0 inline actions)
// ============================================================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const userId = query.from?.id;

    // --- MP3 extraction (existing) ---
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
            if (info.platform === 'tiktok' || info.platform === 'douyin') {
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
        return;
    }

    // --- Main menu navigation (from /start inline menu) ---
    if (data.startsWith('nav_')) {
        const page = data.replace('nav_', '');
        bot.answerCallbackQuery(query.id).catch(() => { });
        if (page === 'help') {
            return bot.sendMessage(chatId, '📖 Mở /help để xem hướng dẫn đầy đủ.');
        }
        if (page === 'settings') return sendSettingsPanel(chatId, userId);
        if (page === 'status') return bot.emit('text', { ...query.message, text: '/status', from: query.from });
        if (page === 'favorites') {
            const list = userFavorites.get(userId) || [];
            if (!list.length) return bot.sendMessage(chatId, t(userId, 'no_favs'));
            let text = `⭐ *Yêu thích (${list.length}/100)*\n\n`;
            list.slice(0, 10).forEach((it, i) => {
                const pMeta = PLATFORMS[it.platform];
                text += `${i + 1}. ${pMeta?.emoji || '🎬'} \`${it.url.substring(0, 55)}${it.url.length > 55 ? '...' : ''}\`\n`;
            });
            return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        }
        if (page === 'achievements') {
            const unlocked = getUserAchievements(userId);
            const ids = new Set(unlocked.map(a => a.id));
            let text = `🏅 *Thành tích (${unlocked.length}/${ACHIEVEMENTS.length})*\n\n`;
            ACHIEVEMENTS.forEach(a => { text += `${ids.has(a.id) ? '✅' : '🔒'} ${a.name}\n`; });
            return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        }
        if (page === 'invite') {
            const me = await bot.getMe().catch(() => ({ username: 'your_bot' }));
            const link = `https://t.me/${me.username}?start=ref_${userId}`;
            const rd = referralData.get(userId) || { invitedCount: 0 };
            return bot.sendMessage(chatId,
                `🎁 *Link mời của bạn:*\n\`${link}\`\n👥 Đã mời: *${rd.invitedCount || 0}* người`,
                { parse_mode: 'Markdown' }
            );
        }
        return;
    }

    // --- Settings toggles ---
    if (data.startsWith('set_')) {
        const action = data.replace('set_', '');
        const prefs = getUserPrefs(userId);
        if (action === 'lang') setUserPref(userId, 'lang', prefs.lang === 'vi' ? 'en' : 'vi');
        else if (action === 'quality') {
            const order = ['hd', 'sd', 'mp3'];
            const next = order[(order.indexOf(prefs.defaultQuality) + 1) % order.length];
            setUserPref(userId, 'defaultQuality', next);
        }
        else if (action === 'mp3btn') setUserPref(userId, 'showMP3Btn', !prefs.showMP3Btn);
        else if (action === 'silent') setUserPref(userId, 'silentMode', !prefs.silentMode);
        else if (action === 'autofav') setUserPref(userId, 'autoFav', !prefs.autoFav);
        else if (action === 'reset') {
            userPreferences.delete(userId);
            saveData();
        }
        else if (action === 'close') {
            bot.answerCallbackQuery(query.id, { text: '✖️ Đã đóng' }).catch(() => { });
            return bot.deleteMessage(chatId, messageId).catch(() => { });
        }
        bot.answerCallbackQuery(query.id, { text: '✔️ Đã cập nhật' }).catch(() => { });
        return sendSettingsPanel(chatId, userId, messageId);
    }

    // --- Favorite save button from download result ---
    if (data.startsWith('favsave_')) {
        const favId = data.replace('favsave_', '');
        const payload = actionCache.get(favId);
        if (!payload) return bot.answerCallbackQuery(query.id, { text: '⚠️ Đã hết hạn.', show_alert: true });
        const ok = addFavorite(userId, payload.url, payload.platform);
        bot.answerCallbackQuery(query.id, { text: ok ? '⭐ Đã lưu!' : '⚠️ Đã có trong yêu thích.' }).catch(() => { });
        return;
    }

    // --- Retry a failed download ---
    if (data.startsWith('retry_')) {
        const retryId = data.replace('retry_', '');
        const payload = actionCache.get(retryId);
        if (!payload) return bot.answerCallbackQuery(query.id, { text: '⚠️ Đã hết hạn.', show_alert: true });
        bot.answerCallbackQuery(query.id, { text: '🔁 Thử lại...' }).catch(() => { });
        const item = {
            chatId, userId, username: query.from?.username || 'unknown',
            url: payload.url, platform: payload.platform,
            messageId, timestamp: Date.now(),
            isVip: isVip(userId), isAdmin: isAdmin(userId), isPremium: isPremium(userId),
            quality: payload.quality || getUserPrefs(userId).defaultQuality,
        };
        requestQueue.push(item);
        processQueue();
        return;
    }

    // --- Clear favorites ---
    if (data === 'fav_clear') {
        userFavorites.set(userId, []);
        saveData();
        bot.answerCallbackQuery(query.id, { text: '🗑️ Đã xóa tất cả yêu thích' }).catch(() => { });
        return bot.editMessageText('📭 Danh sách yêu thích đã được xóa.', { chat_id: chatId, message_id: messageId }).catch(() => { });
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

    // v4.0: detect multiple URLs (batch mode)
    const allDetected = detectAllPlatforms(text);

    if (allDetected.length > 0) {
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

        // Rate limit (only check once per message, batch counts as 1 "message")
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

        const prefs = getUserPrefs(userId);
        const isBatch = allDetected.length > 1;

        if (isBatch) {
            bot.sendMessage(chatId,
                `🧺 *Chế độ batch:* phát hiện *${allDetected.length}* link\n` +
                `⏳ Các video sẽ được xử lý lần lượt...`,
                { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
            ).catch(() => { });
        }

        for (const det of allDetected) {
            const { platform, match: videoUrl } = det;
            stats.totalRequests++;
            updateUserStats(userId, username, platform);

            const p = PLATFORMS[platform];
            console.log(`[${new Date().toISOString()}] ${p.emoji} ${platform.toUpperCase()} from @${username} (${userId}): ${videoUrl}`);
            addActivityLog('ok', `📥 Yêu cầu tải ${p.name} từ @${username} (ID: ${userId})`);

            const item = {
                chatId, userId, username, url: videoUrl, platform,
                messageId: msg.message_id, timestamp: Date.now(),
                isVip: isVip(userId), isAdmin: isAdmin(userId), isPremium: isPremium(userId),
                quality: prefs.defaultQuality,
                batch: isBatch,
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
        }

        // Queue-status ping (for the first item only, to avoid spam on batch)
        const first = requestQueue[0] || { isAdmin: false, isVip: false, isPremium: false };
        const position = 1;
        if (!isBatch && (requestQueue.length > 1 || processingCount >= MAX_CONCURRENT)) {
            const badge = first.isAdmin ? '👑 Admin' : first.isVip ? '⭐ VIP' : first.isPremium ? '💎 Premium' : '';
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
            case 'douyin': videoData = await downloadDouyinVideo(request.url); break;
            case 'threads': videoData = await downloadThreadsVideo(request.url); break;
            case 'vimeo': videoData = await downloadVimeoVideo(request.url); break;
            case 'dailymotion': videoData = await downloadDailymotionVideo(request.url); break;
            case 'likee': videoData = await downloadLikeeVideo(request.url); break;
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
            // Platform-appropriate download headers. Douyin CDN will 403 without iOS UA + Douyin Referer;
            // likewise each platform may have its own anti-hotlink guard. Downloaders may also supply
            // their own explicit `downloadHeaders` to override the defaults.
            const DL_HEADERS_BY_PLATFORM = {
                douyin:     { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', 'Referer': 'https://www.douyin.com/' },
                tiktok:     { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.tiktok.com/' },
                facebook:   { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.facebook.com/' },
                youtube:    { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.youtube.com/' },
                instagram:  { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.instagram.com/' },
                twitter:    { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://twitter.com/' },
                pinterest:  { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.pinterest.com/' },
                snapchat:   { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.snapchat.com/' },
                reddit:     { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.reddit.com/' },
                bilibili:   { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.bilibili.com/' },
                threads:    { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.threads.net/' },
                vimeo:      { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://vimeo.com/' },
                dailymotion:{ 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://www.dailymotion.com/' },
                likee:      { 'User-Agent': 'Mozilla/5.0',                                                                                          'Referer': 'https://likee.video/' },
            };
            const dlHeaders = videoData.downloadHeaders
                || DL_HEADERS_BY_PLATFORM[request.platform]
                || { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' };
            const res = await axios.get(videoData.url, {
                responseType: 'stream', timeout: 120000, maxRedirects: 10, headers: dlHeaders
            });
            res.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

            const mp3Id = Math.random().toString(36).slice(2, 10);
            mp3Cache.set(mp3Id, { url: request.url, platform: request.platform });
            if (mp3Cache.size > 500) {
                const firstKey = mp3Cache.keys().next().value;
                mp3Cache.delete(firstKey);
            }

            // v4.0: enhanced caption with video title if available
            const prefs = getUserPrefs(request.userId);
            const pInfo = PLATFORMS[request.platform];
            let caption = botSettings.captionText || '';
            if (videoData.title) {
                const cleanTitle = String(videoData.title).replace(/[*_`~\[\]]/g, '').substring(0, 150);
                caption = `🎬 *${cleanTitle}*\n${pInfo?.emoji || ''} ${pInfo?.name || request.platform}\n\n${caption}`;
            }

            const favShortId = cacheAction({ url: request.url, platform: request.platform });
            const btnRows = [];
            if (prefs.showMP3Btn && botSettings.mp3Button) {
                btnRows.push([{ text: '🎵 Tải MP3', callback_data: `mp3_${mp3Id}` }, { text: '⭐ Lưu yêu thích', callback_data: `favsave_${favShortId}` }]);
            } else {
                btnRows.push([{ text: '⭐ Lưu yêu thích', callback_data: `favsave_${favShortId}` }]);
            }

            await bot.sendVideo(request.chatId, tempFile, {
                caption,
                parse_mode: 'Markdown',
                reply_to_message_id: request.messageId,
                supports_streaming: true,
                reply_markup: { inline_keyboard: btnRows }
            });

            fs.unlink(tempFile, () => { });

            // auto-save favorite if user opted-in
            if (prefs.autoFav) addFavorite(request.userId, request.url, request.platform, videoData.title);
        }

        if (processingMsg && botSettings.autoDeleteProcessing) bot.deleteMessage(request.chatId, processingMsg.message_id).catch(() => { });
        stats.successfulDownloads++;
        dailyStats.downloads++;
        bumpDailyDownloads();
        bumpHeatmap();
        bumpWeeklyTop(request.userId, stats.activeUsers.get(request.userId)?.username);
        recordHistory(request.userId, request.url, request.platform, videoData?.title);
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

        // v4.0: offer retry button
        const retryShortId = cacheAction({ url: request.url, platform: request.platform, quality: request.quality });
        const retryMarkup = { inline_keyboard: [[{ text: '🔁 Thử lại', callback_data: `retry_${retryShortId}` }]] };

        if (processingMsg) {
            bot.editMessageText(errMsg + '\n\n💡 Đảm bảo link hợp lệ và không bị private.', {
                chat_id: request.chatId, message_id: processingMsg.message_id,
                reply_markup: retryMarkup
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
function normalizeDouyinUrl(url) {
    // Chuyển douyin.com/jingxuan/...?modal_id=ID → douyin.com/video/ID
    try {
        const u = new URL(url);
        if (u.hostname.includes('douyin.com')) {
            const modalId = u.searchParams.get('modal_id');
            if (modalId) {
                return `https://www.douyin.com/video/${modalId}`;
            }
        }
    } catch (e) { }
    return url;
}

async function getVideoNoWatermark(url) {
    // Chuẩn hóa URL Douyin (jingxuan/modal_id → /video/ID)
    url = normalizeDouyinUrl(url);
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
// 🎶 DOUYIN — v4.3 dedicated downloader (iesdouyin HTML scrape primary)
// ============================================================
const DOUYIN_UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
const DOUYIN_UA_DESK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function _decodeDouyinUrl(s) {
    if (!s) return s;
    return s.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
}

// Extract aweme_id from any Douyin URL format
function extractDouyinAwemeId(url) {
    const m = url.match(/(?:\/video|\/share\/video|\/aweme)\/(\d{10,})/)
        || url.match(/modal_id=(\d{10,})/);
    return m ? m[1] : null;
}

// Resolve v.douyin.com short link → aweme_id + final canonical URL
async function resolveDouyinShort(url) {
    try {
        const r = await axios.get(url, {
            maxRedirects: 10, timeout: 12000, validateStatus: () => true,
            headers: { 'User-Agent': DOUYIN_UA_IOS }
        });
        const finalUrl = r.request?.res?.responseUrl || url;
        const id = extractDouyinAwemeId(finalUrl);
        return { finalUrl, awemeId: id };
    } catch (e) {
        console.log('[douyin] resolveShort failed:', e.message);
        return { finalUrl: url, awemeId: extractDouyinAwemeId(url) };
    }
}

// Primary: fetch iesdouyin share page and extract play_addr + video_id
// Returns { playUrl, title, video_id } or null
async function scrapeIesdouyinShare(awemeId) {
    const pageUrl = `https://www.iesdouyin.com/share/video/${awemeId}/`;
    try {
        const r = await axios.get(pageUrl, {
            timeout: 15000, validateStatus: () => true, maxRedirects: 5,
            headers: { 'User-Agent': DOUYIN_UA_IOS, 'Referer': 'https://www.douyin.com/' }
        });
        if (r.status !== 200 || !r.data || r.data.length < 1000) {
            console.log('[douyin] iesdouyin bad response:', r.status, r.data?.length);
            return null;
        }
        const html = r.data;

        // play_addr.url_list[0] — the primary video URL
        const playMatch = html.match(/"play_addr":\s*\{\s*"uri":"([^"]+)"\s*,\s*"url_list":\s*\["([^"]+)"/);
        // video_id from the play URL
        let videoId = null;
        if (playMatch) {
            const decoded = _decodeDouyinUrl(playMatch[2]);
            const vm = decoded.match(/[?&]video_id=([\w\d]+)/);
            if (vm) videoId = vm[1];
        }
        // title
        let title = 'Douyin Video';
        const titleMatch = html.match(/"desc":"([^"]{1,120})"/);
        if (titleMatch) {
            try { title = JSON.parse(`"${titleMatch[1]}"`).slice(0, 120) || title; } catch { title = titleMatch[1].slice(0, 120); }
        }

        // Prefer HD no-watermark URL via aweme.snssdk.com/aweme/v1/play
        if (videoId) {
            return {
                playUrl: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}&ratio=1080p&line=0`,
                playUrlWm: `https://aweme.snssdk.com/aweme/v1/playwm/?video_id=${videoId}&ratio=1080p&line=0`,
                title, videoId,
            };
        }
        // Fallback: whatever URL the page gave us (may have watermark)
        if (playMatch) {
            const decoded = _decodeDouyinUrl(playMatch[2]);
            return { playUrl: decoded.replace('/playwm/', '/play/'), playUrlWm: decoded, title };
        }
        return null;
    } catch (e) {
        console.log('[douyin] scrape iesdouyin failed:', e.message);
        return null;
    }
}

async function downloadDouyinVideo(url) {
    // 1. Get aweme_id (from modal_id, /video/, or by resolving short link)
    let normalized = normalizeDouyinUrl(url);
    let awemeId = extractDouyinAwemeId(normalized);
    let canonical = normalized;

    if (!awemeId && (/^https?:\/\/v\.douyin\.com\//i.test(normalized) || /iesdouyin\.com/i.test(normalized))) {
        const { finalUrl, awemeId: id } = await resolveDouyinShort(normalized);
        canonical = finalUrl;
        awemeId = id || extractDouyinAwemeId(finalUrl);
    }

    console.log('[douyin] input:', url, '→ aweme:', awemeId || '(none)');

    const apis = [
        // 1) Primary: iesdouyin share page → no-watermark HD URL
        async () => {
            if (!awemeId) throw new Error('no aweme_id');
            const scraped = await scrapeIesdouyinShare(awemeId);
            if (!scraped?.playUrl) throw new Error('iesdouyin scrape: no play URL');
            const sizeInfo = await checkVideoSize(scraped.playUrl);
            return {
                url: scraped.playUrl,
                title: scraped.title,
                downloadHeaders: { 'User-Agent': DOUYIN_UA_IOS, 'Referer': 'https://www.douyin.com/' },
                ...sizeInfo
            };
        },
        // 2) TikWM (sometimes supports Douyin URLs)
        async () => {
            const target = awemeId ? `https://www.douyin.com/video/${awemeId}` : canonical;
            const res = await axios.post('https://www.tikwm.com/api/', { url: target, hd: 1 }, {
                timeout: 15000, headers: { 'Content-Type': 'application/json', 'User-Agent': DOUYIN_UA_DESK }
            });
            if (res.data?.code === 0 && (res.data?.data?.play || res.data?.data?.hdplay)) {
                const u = res.data.data.hdplay || res.data.data.play;
                const sizeInfo = await checkVideoSize(u);
                return { url: u, title: res.data.data.title || 'Douyin Video', ...sizeInfo };
            }
            throw new Error('TikWM douyin: ' + (res.data?.msg || 'no play'));
        },
        // 3) yt-dlp with iOS UA + Douyin Referer
        async () => {
            const target = awemeId ? `https://www.douyin.com/video/${awemeId}` : canonical;
            const info = await youtubedl(target, {
                dumpSingleJson: true, noWarnings: true, noCheckCertificates: true,
                addHeader: [
                    'Referer:https://www.douyin.com/',
                    `User-Agent:${DOUYIN_UA_IOS}`,
                ],
            });
            const finalUrl = info.url
                || info.formats?.slice().reverse().find(f => f.vcodec !== 'none' && f.acodec !== 'none')?.url
                || info.formats?.slice().reverse().find(f => f.vcodec !== 'none')?.url;
            if (!finalUrl) throw new Error('yt-dlp douyin: no format');
            const sizeInfo = await checkVideoSize(finalUrl);
            return { url: finalUrl, title: info.title || 'Douyin Video', ...sizeInfo };
        },
    ];

    for (let i = 0; i < apis.length; i++) {
        try {
            const result = await retryWithBackoff(apis[i]);
            if (result?.url) {
                console.log(`[douyin] ✓ API ${i + 1} succeeded`);
                return result;
            }
        } catch (e) { console.log(`[douyin] ✗ API ${i + 1} failed:`, e.message); }
    }
    console.log('[douyin] all APIs exhausted for:', url);
    return null;
}

// ============================================================
// 🔁 GENERIC yt-dlp wrapper — v4.2 (Threads / Vimeo / Dailymotion / Likee)
// ============================================================
async function downloadViaYtdlp(url, fallbackTitle, extraOpts = {}) {
    try {
        const info = await youtubedl(url, {
            dumpSingleJson: true, noWarnings: true, noCheckCertificates: true,
            preferFreeFormats: true,
            ...extraOpts,
        });
        if (info.duration && info.duration > 1800) throw new Error('Video quá dài (>30 phút)');
        let format = info.formats?.slice().reverse().find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4')
            || info.formats?.slice().reverse().find(f => f.vcodec !== 'none' && f.acodec !== 'none')
            || info.formats?.slice().reverse().find(f => f.vcodec !== 'none');
        const finalUrl = format ? format.url : info.url;
        if (!finalUrl) throw new Error('No format found');
        const sizeInfo = await checkVideoSize(finalUrl);
        return { url: finalUrl, title: info.title || fallbackTitle, ...sizeInfo };
    } catch (e) { console.error(`yt-dlp ${fallbackTitle} failed:`, e.message); return null; }
}

async function downloadVimeoVideo(url) { return downloadViaYtdlp(url, 'Vimeo Video'); }
async function downloadDailymotionVideo(url) { return downloadViaYtdlp(url, 'Dailymotion Video'); }
async function downloadLikeeVideo(url) {
    const r = await downloadViaYtdlp(url, 'Likee Video');
    if (r) return r;
    // Fallback: scrape videoUrl from Likee HTML
    try {
        const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const m = res.data.match(/"videoUrl"\s*:\s*"([^"]+)"/)
            || res.data.match(/property="og:video(?::url)?"\s+content="([^"]+)"/i);
        if (m && m[1]) {
            const vu = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
            const sizeInfo = await checkVideoSize(vu);
            return { url: vu, title: 'Likee Video', ...sizeInfo };
        }
    } catch (e) { console.error('Likee fallback failed:', e.message); }
    return null;
}
async function downloadThreadsVideo(url) {
    const r = await downloadViaYtdlp(url, 'Threads Video');
    if (r) return r;
    // Fallback: scrape og:video from Threads public page
    try {
        const res = await axios.get(url, {
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NobitaBot/4.2)' }
        });
        const m = res.data.match(/property="og:video(?::url|:secure_url)?"\s+content="([^"]+)"/i)
            || res.data.match(/"video_url"\s*:\s*"([^"]+)"/);
        if (m && m[1]) {
            const vu = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
            const sizeInfo = await checkVideoSize(vu);
            return { url: vu, title: 'Threads Video', ...sizeInfo };
        }
    } catch (e) { console.error('Threads fallback failed:', e.message); }
    return null;
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
