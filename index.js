require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const fs          = require('fs');
const path        = require('path');
const express     = require('express');
const EventEmitter= require('events');
const os          = require('os');

const activityEmitter = new EventEmitter();
activityEmitter.setMaxListeners(50);

// ============================================================
// 🤖 AI SETUP (Google Gemini)
// ============================================================
let geminiModel = null;
try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (geminiApiKey) {
        const gemini = new GoogleGenerativeAI(geminiApiKey);
        geminiModel  = gemini.getGenerativeModel({
            model: 'gemini-1.5-flash',
            systemInstruction:
                'Bạn là Nobita Bot, một trợ lý ảo thông minh, thân thiện và đa tài. ' +
                'Nhiệm vụ chính là hỗ trợ người dùng tải video/ảnh từ TikTok, Facebook, Instagram, YouTube... ' +
                'Nhưng bạn cũng là người bạn có thể trò chuyện về bất kỳ chủ đề nào. ' +
                'Trả lời bằng tiếng Việt, phong cách tự nhiên, hài hước và dùng emoji phù hợp. ' +
                'Luôn sẵn lòng giải đáp mọi câu hỏi một cách thông minh.',
        });
        console.log('✅ Google Gemini AI (1.5-Flash) initialized');
    } else {
        console.warn('⚠️  GEMINI_API_KEY not found, AI chat will use fallback responses');
    }
} catch (e) {
    console.error('⚠️  Gemini AI initialization error:', e.message);
}

// ============================================================
// ✈️ TELEGRAM USER CLIENT (MTProto)
// ============================================================
let tgClient = null;

(async () => {
    try {
        const apiId   = parseInt(process.env.TELEGRAM_API_ID   || '0');
        const apiHash = process.env.TELEGRAM_API_HASH || '';
        const session = process.env.TELEGRAM_SESSION  || '';
        if (!apiId || !apiHash || !session) {
            console.warn('⚠️  Telegram UserClient: thiếu TELEGRAM_API_ID/HASH/SESSION — tính năng tải Telegram media bị tắt');
            return;
        }
        const { TelegramClient } = require('telegram');
        const { StringSession }  = require('telegram/sessions');
        tgClient = new TelegramClient(new StringSession(session), apiId, apiHash, {
            connectionRetries: 5, autoReconnect: true, useWSS: false,
        });
        await tgClient.connect();
        if (!await tgClient.isUserAuthorized()) {
            console.warn('⚠️  Telegram UserClient: session không hợp lệ hoặc hết hạn.');
            tgClient = null; return;
        }
        console.log('✅ Telegram UserClient (MTProto) connected');
    } catch (e) {
        console.error('⚠️  Telegram UserClient init error:', e.message);
        tgClient = null;
    }
})();

// ============================================================
// ⚙️ FFMPEG SETUP
// ============================================================
try {
    const ffmpeg = require('@ffmpeg-installer/ffmpeg');
    process.env.FFMPEG_PATH = ffmpeg.path;
} catch (_) {
    console.warn('⚠️  FFmpeg installer not found, using system PATH');
}

// ============================================================
// 🚀 BOT INIT
// ============================================================
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('❌ TELEGRAM_BOT_TOKEN is not defined'); process.exit(1); }

const bot = new TelegramBot(token, { polling: true });

// ============================================================
// 📋 CONFIGURATION
// ============================================================
const ADMIN_USER_ID   = parseInt(process.env.ADMIN_USER_ID || '0');
const MAX_CONCURRENT  = parseInt(process.env.MAX_CONCURRENT_REQUESTS || '5');
const BOT_URL         = process.env.RENDER_EXTERNAL_URL || process.env.BOT_URL || 'http://localhost:3000';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'nobita_admin';
const DASHBOARD_URL   = `${BOT_URL}/dashboard?token=${DASHBOARD_TOKEN}`;
const BOT_VERSION     = '4.2';
const BOT_START_TIME  = Date.now();

// Giới hạn upload Bot API (~19MB an toàn)
const BOT_UPLOAD_LIMIT_MB = 19;

// ============================================================
// 💾 PERSISTENT DATA
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');

let stats = { totalRequests: 0, successfulDownloads: 0, failedDownloads: 0, activeUsers: new Map() };
let bannedUsers        = new Set();
let mutedUsers         = new Set();
let vipUsers           = new Set();
let premiumUsers       = new Set();
let userLimitOverrides = new Map();
let userWarnings       = new Map();
let slowModeUsers      = new Map();
let hourlyStats        = new Array(24).fill(0);
let dailyStats         = { date: new Date().toDateString(), requests: 0, downloads: 0 };
let platformStats      = {};
let maintenanceMode    = false;
let mp3Cache           = new Map();
let slideshowCache     = new Map();
let quizCache          = new Map();
let userCombos         = new Map();
let scheduledBroadcasts= new Map();
let conversationHistory= new Map();

const MP3_CACHE_TTL       = 30 * 60 * 1000;
const SLIDESHOW_CACHE_TTL = 30 * 60 * 1000;
const QUIZ_CACHE_TTL      = 10 * 60 * 1000;
const COMBO_WINDOW        = 3  * 60 * 1000;
const SCHEDULE_POLL       = 5000;
const MAX_AI_HISTORY      = 10;

let botSettings = {
    maxFileSizeMB:        49,
    rateLimitWindow:      10000,
    defaultRateLimit:     3,
    captionText:          '┏━━━━━━━━━━━━━━━━━━┓\n┃  🎬 NOBITA DOWNLOADER \n┗━━━━━━━━━━━━━━━━━━┛\n\n👤 Admin: @phamtheson\n⭐ Powered by Nobita Bot v4.2',
    autoDeleteProcessing: true,
    notifyAdmin:          true,
    autoBanSpam:          true,
    supportTikTokHD:      true,
    mp3Button:            true,
    funMode:              true,
    funChance:            0.3,
};

// ============================================================
// 📋 ACTIVITY LOGS
// ============================================================
const activityLogs = [];

function addActivityLog(type, text) {
    const time = new Date().toLocaleTimeString('vi-VN');
    const log  = { type, text, time };
    activityLogs.unshift(log);
    if (activityLogs.length > 100) activityLogs.pop();
    activityEmitter.emit('log', log);
}

// ============================================================
// 💾 LOAD / SAVE
// ============================================================
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (data.stats) {
                stats.totalRequests       = data.stats.totalRequests       || 0;
                stats.successfulDownloads = data.stats.successfulDownloads || 0;
                stats.failedDownloads     = data.stats.failedDownloads     || 0;
                if (data.stats.activeUsers) stats.activeUsers = new Map(data.stats.activeUsers);
            }
            if (data.bannedUsers)        bannedUsers         = new Set(data.bannedUsers);
            if (data.mutedUsers)         mutedUsers          = new Set(data.mutedUsers);
            if (data.vipUsers)           vipUsers            = new Set(data.vipUsers);
            if (data.premiumUsers)       premiumUsers        = new Set(data.premiumUsers);
            if (data.userLimitOverrides) userLimitOverrides  = new Map(data.userLimitOverrides);
            if (data.userWarnings)       userWarnings        = new Map(data.userWarnings);
            if (data.slowModeUsers)      slowModeUsers       = new Map(data.slowModeUsers);
            if (data.hourlyStats)        hourlyStats         = data.hourlyStats;
            if (data.dailyStats)         dailyStats          = data.dailyStats;
            if (data.platformStats)      platformStats       = data.platformStats;
            if (data.botSettings)        botSettings         = { ...botSettings, ...data.botSettings };
            if (data.maintenanceMode !== undefined) maintenanceMode = data.maintenanceMode;
            console.log('✅ Data loaded successfully.');
        }
    } catch (e) { console.error('❌ Error loading data:', e.message); }
}

function saveData() {
    try {
        const payload = JSON.stringify({
            stats: {
                totalRequests:       stats.totalRequests,
                successfulDownloads: stats.successfulDownloads,
                failedDownloads:     stats.failedDownloads,
                activeUsers:         Array.from(stats.activeUsers.entries()),
            },
            bannedUsers:        Array.from(bannedUsers),
            mutedUsers:         Array.from(mutedUsers),
            vipUsers:           Array.from(vipUsers),
            premiumUsers:       Array.from(premiumUsers),
            userLimitOverrides: Array.from(userLimitOverrides.entries()),
            userWarnings:       Array.from(userWarnings.entries()),
            slowModeUsers:      Array.from(slowModeUsers.entries()),
            hourlyStats, dailyStats, platformStats, botSettings, maintenanceMode,
        }, null, 2);
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, payload);
        fs.copyFileSync(tmp, DATA_FILE);
        fs.unlinkSync(tmp);
    } catch (e) { console.error('❌ Error saving data:', e.message); }
}

loadData();

// ============================================================
// 🌐 PLATFORMS
// ============================================================
const PLATFORMS = {
    tiktok:        { regex: /(?:https?:\/\/)?(?:(?:www|vt|vm|m|t|v)\.)?(?:tiktok\.com|douyin\.com)\/(?:@[\w.-]+\/(?:video|photo)\/\d+|(?:video|photo)\/\d+|v\/\d+|[\w-]+(?:\/[\w-]+)*(?:\?[^\s]*modal_id=\d+[^\s]*)?|share\/(?:video|photo)\/\d+)|(?:https?:\/\/)?(?:vm|vt|v)\.(?:tiktok\.com|douyin\.com)\/[\w]+/i, emoji: '🎵', name: 'TikTok' },
    facebook:      { regex: /(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.com)\/(?:[\w.-]+\/videos\/[\d]+|watch[\/?].*v=[\d]+|video\.php\?v=[\d]+|reel\/[\w]+|share\/v\/[\w]+|share\/r\/[\w]+|share\/[\w]+|[\w.-]+\/posts\/[\w]+)|(?:https?:\/\/)?fb\.watch\/[\w]+/i, emoji: '🐙', name: 'Facebook' },
    youtube:       { regex: /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)[\w-]+/i, emoji: '▶️', name: 'YouTube' },
    instagram:     { regex: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p)\/[\w-]+/i, emoji: '📸', name: 'Instagram' },
    twitter:       { regex: /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[\w]+\/status\/[\d]+/i, emoji: '🐦', name: 'Twitter/X' },
    pinterest:     { regex: /(?:https?:\/\/)?(?:(?:www|in|co)\.)?pinterest\.[a-z.]{2,10}\/pin\/[\d]+|(?:https?:\/\/)?pin\.it\/[\w]+/i, emoji: '📌', name: 'Pinterest' },
    snapchat:      { regex: /(?:https?:\/\/)?(?:www\.)?snapchat\.com\/(?:spotlight|add|discover)\/[\w-]+/i, emoji: '👻', name: 'Snapchat' },
    reddit:        { regex: /(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/[\w]+\/comments\/[\w]+/i, emoji: '🤖', name: 'Reddit' },
    bilibili:      { regex: /(?:https?:\/\/)?(?:www\.)?bilibili\.com\/video\/(BV[\w]+|av[\d]+)/i, emoji: '📺', name: 'Bilibili' },
    soundcloud:    { regex: /(?:https?:\/\/)?(?:(?:www|on)\.)?soundcloud\.com\/(?:[\w-]+\/[\w-]+|[\w-]+)/i, emoji: '🎧', name: 'SoundCloud' },
    telegram_media:{ regex: /https?:\/\/t\.me\/(?:c\/\d+|[a-zA-Z0-9_]+)\/\d+/i, emoji: '✈️', name: 'Telegram' },
};

function initPlatformStats() {
    for (const key of Object.keys(PLATFORMS)) {
        if (!platformStats[key])
            platformStats[key] = { ok: 0, fail: 0, lastOk: 0, lastFail: 0, lastError: '' };
    }
}
initPlatformStats();

function detectPlatform(text) {
    for (const [key, p] of Object.entries(PLATFORMS)) {
        const m = text.match(p.regex);
        if (m) return { platform: key, match: m[0] };
    }
    return null;
}

function recordPlatformSuccess(key) {
    if (!platformStats[key]) platformStats[key] = { ok: 0, fail: 0, lastOk: 0, lastFail: 0, lastError: '' };
    platformStats[key].ok++;
    platformStats[key].lastOk    = Date.now();
    platformStats[key].lastError = '';
}

function recordPlatformFailure(key, err) {
    if (!platformStats[key]) platformStats[key] = { ok: 0, fail: 0, lastOk: 0, lastFail: 0, lastError: '' };
    platformStats[key].fail++;
    platformStats[key].lastFail  = Date.now();
    platformStats[key].lastError = String(err?.message || err || 'error').slice(0, 120);
}

// ============================================================
// 🛠️ HELPERS
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isAdmin(uid)   { return uid === ADMIN_USER_ID; }
function isVip(uid)     { return vipUsers.has(uid); }
function isPremium(uid) { return premiumUsers.has(uid); }

function getUserBadge(uid) {
    if (isAdmin(uid))   return '👑';
    if (isVip(uid))     return '⭐';
    if (isPremium(uid)) return '💎';
    return '';
}

function escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/([_*`[\]()])/g, '\\$1');
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m ${s % 60}s`;
}

function formatFileSize(mb) {
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(1)} MB`;
}

function pickRandom(arr) {
    if (!arr || !arr.length) return '';
    return arr[Math.floor(Math.random() * arr.length)];
}

function setCacheWithTtl(cache, key, value, ttl) {
    cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function getCacheWithTtl(cache, key) {
    const e = cache.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) { cache.delete(key); return null; }
    return e.value;
}

function cleanupCache(cache) {
    const now = Date.now();
    for (const [k, v] of cache) if (!v || v.expiresAt <= now) cache.delete(k);
}

function isTransientError(err) {
    const msg  = String(err?.message || err || '').toLowerCase();
    const code = String(err?.code    || '').toUpperCase();
    return msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnreset')
        || msg.includes('socket hang up') || msg.includes('network')
        || ['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(code);
}

function updateUserStats(userId, username) {
    if (!stats.activeUsers.has(userId)) {
        stats.activeUsers.set(userId, {
            username: username || 'Unknown', count: 0, lastUsed: Date.now(),
            history: [], joinedAt: Date.now(),
        });
        addActivityLog('warn', `🆕 User mới: @${username || 'unknown'} (ID: ${userId})`);
    }
    const u    = stats.activeUsers.get(userId);
    u.count++;
    u.lastUsed = Date.now();
    u.username = username || u.username;
    hourlyStats[new Date().getHours()]++;
    dailyStats.requests++;
    saveData();
}

function recordHistory(userId, url, platform) {
    const u = stats.activeUsers.get(userId);
    if (!u) return;
    if (!u.history) u.history = [];
    u.history.unshift({ url, platform, time: Date.now() });
    if (u.history.length > 20) u.history = u.history.slice(0, 20);
    saveData();
}

function updateCombo(userId) {
    const now  = Date.now();
    const e    = userCombos.get(userId) || { count: 0, lastAt: 0 };
    const next = { count: now - e.lastAt <= COMBO_WINDOW ? e.count + 1 : 1, lastAt: now };
    userCombos.set(userId, next);
    return next;
}

function handleComboMessage(chatId, userId) {
    if (!botSettings.funMode) return;
    const combo = updateCombo(userId);
    if (combo.count < 2 || (combo.count > 6 && combo.count % 3 !== 0)) return;
    bot.sendMessage(chatId, `🔥 Combo ${combo.count}! Đỉnh quá đi thôi!`).catch(() => {});
}

function maybeSendFun(chatId, text) {
    if (!botSettings.funMode || Math.random() > (botSettings.funChance || 0)) return;
    bot.sendMessage(chatId, text).catch(() => {});
}

async function handleSuspiciousUser(userId, username) {
    const count = (userWarnings.get(userId) || 0) + 1;
    userWarnings.set(userId, count);
    saveData();
    if (ADMIN_USER_ID) {
        bot.sendMessage(ADMIN_USER_ID,
            `⚠️ *Spam cảnh báo:* @${username} (ID: \`${userId}\`)\n🔢 Vi phạm: ${count}`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
    if (count >= 5 && botSettings.autoBanSpam) {
        bannedUsers.add(userId); saveData();
        bot.sendMessage(userId, '🚫 Bạn đã bị auto-ban do spam.').catch(() => {});
    }
}

// ============================================================
// 🚦 RATE LIMITING
// ============================================================
const userRateLimits  = new Map();
const userLastRequest = new Map();

function checkRateLimit(userId) {
    if (isAdmin(userId)) return true;
    const now = Date.now();
    if (slowModeUsers.has(userId)) {
        const delay = slowModeUsers.get(userId);
        const last  = userLastRequest.get(userId) || 0;
        if (now - last < delay) return false;
        userLastRequest.set(userId, now);
    }
    const maxReqs = userLimitOverrides.has(userId)
        ? userLimitOverrides.get(userId)
        : isVip(userId) ? 999 : isPremium(userId) ? 6 : botSettings.defaultRateLimit;
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
// 🎭 FUN CONTENT
// ============================================================
const FUN = {
    waitLines: [
        'Đang nấu video... đừng rời mắt nhé 🍳',
        'Bot đang luyện công, chờ xíu ⏳',
        'Đang gọi Đôrêmon mở cánh cửa thần kỳ 🚪',
        'Tải nhanh như tia chớp (hứa luôn) ⚡',
    ],
    successLines: [
        'Xong rồi nè! Nhớ thả tim nhé ❤️',
        'Tải xong! Được chưa? Được nha 😎',
        'Video đã về bến an toàn 🛟',
        'Thêm một cú tải chuẩn bài 👌',
    ],
    failLines: [
        'Ôi no, bot vấp dây sạc 😵‍💫',
        'Lỗi nhẹ thôi, thử lại phát nè 🧯',
        'Cửa thần kỳ kẹt rồi, chờ chút nha 🚪',
    ],
    startTips: [
        'Meme mode: ON 🤖✨',
        'Đã nạp năng lượng bằng 3 chiếc bánh rán 🍩',
        'Hôm nay bạn muốn tải gì nào? 🎬',
    ],
    jokes: [
        'Vì sao lập trình viên thích đi biển? Vì ở đó có nhiều "bug" 😂',
        'Bot không mập, chỉ là dữ liệu nặng tình thôi 🤖💾',
        'Tải xong mà buồn? Tải thêm một video là hết buồn ngay 😆',
    ],
    memes: [
        'Khi tải xong mà mạng vẫn xanh: *Chef\'s kiss* 👌',
        'Ai cần phép thuật khi có bot? ✨',
        'Hôm nay bạn đã tải video chưa? — Chưa? — *Giờ thì rồi* 😎',
    ],
    riddles: [
        { q: 'Vừa đi vừa đếm, càng đếm càng dài là gì?', a: 'Con đường' },
        { q: 'Cái gì càng ăn càng to?', a: 'Lửa' },
        { q: 'Càng sạch càng bẩn là gì?', a: 'Nước' },
    ],
    quizzes: [
        { q: 'Mèo kêu thế nào?', opts: ['Gâu gâu','Meo meo','Chip chip'], answer: 1 },
        { q: 'Một tuần có mấy ngày?', opts: ['5','7','8'], answer: 1 },
        { q: 'Trái đất quay quanh gì?', opts: ['Mặt trăng','Mặt trời','Sao hỏa'], answer: 1 },
    ],
};

// ============================================================
// 🤖 AI CHATBOT
// ============================================================
const FALLBACK_RESPONSES = [
    '😄 Bạn nói thế à? Mình thích nói chuyện với bạn!',
    '👍 Hay đấy! Bạn có video nào cần tải không?',
    '🤔 Thú vị đấy! Gửi link cho mình tải nhé!',
    '😊 Mình rất vui khi được trò chuyện với bạn!',
    '🎉 Bạn tuyệt vời! Còn gì khác mình có thể giúp không?',
];

async function getAIResponse(userMessage, userId) {
    try {
        if (!geminiModel) return pickRandom(FALLBACK_RESPONSES);
        if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
        const history = conversationHistory.get(userId);
        const chat    = geminiModel.startChat({
            history,
            generationConfig: { maxOutputTokens: 2048, temperature: 0.8 },
        });
        const now    = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const result = await chat.sendMessage(`[Thời gian: ${now}]\n\n${userMessage}`);
        const aiMsg  = result.response.text() || pickRandom(FALLBACK_RESPONSES);
        history.push({ role: 'user',  parts: [{ text: userMessage }] });
        history.push({ role: 'model', parts: [{ text: aiMsg }] });
        if (history.length > MAX_AI_HISTORY * 2) history.splice(0, 2);
        return aiMsg;
    } catch (err) {
        console.error('❌ AI Error:', err.message);
        if (err.message.includes('SAFETY') || err.message.includes('blocked'))
            return '😊 Xin lỗi, mình không thể trả lời câu hỏi này. Bạn thử câu khác nhé!';
        return pickRandom(FALLBACK_RESPONSES);
    }
}

setInterval(() => {
    if (conversationHistory.size > 200) {
        const keys = Array.from(conversationHistory.keys());
        keys.slice(0, keys.length - 200).forEach(k => conversationHistory.delete(k));
    }
}, 60 * 60 * 1000);

// ============================================================
// 🚀 QUEUE SYSTEM
// ============================================================
const requestQueue = [];
let processingCount = 0;

// ============================================================
// 📥 DOWNLOAD HELPERS
// ============================================================
async function retryWithBackoff(fn, maxRetries = 2, baseDelay = 800) {
    for (let i = 0; i < maxRetries; i++) {
        try { return await fn(); }
        catch (e) {
            if (i === maxRetries - 1) throw e;
            await sleep(baseDelay * Math.pow(2, i));
        }
    }
}

async function getYtDlExec() {
    for (const pkg of ['yt-dlp-exec', 'youtube-dl-exec']) {
        try { return require(pkg); } catch (_) {}
    }
    const { execFile }  = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    return async (url, flags = {}) => {
        const args = [];
        for (const [k, v] of Object.entries(flags)) {
            const flag   = k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
            const prefix = flag.length === 1 ? '-' : '--';
            if (v === true)       args.push(`${prefix}${flag}`);
            else if (v !== false) { args.push(`${prefix}${flag}`); args.push(String(v)); }
        }
        args.push(url);
        const { stdout } = await execFileAsync('yt-dlp', args);
        if (flags.dumpSingleJson) return JSON.parse(stdout);
        return stdout;
    };
}

async function checkVideoSize(url) {
    try {
        const res = await axios.head(url, {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
            validateStatus: () => true,
        });
        const size   = parseInt(res.headers['content-length'] || '0') || 0;
        const sizeMB = size / 1024 / 1024;
        return { sizeMB, isTooLarge: sizeMB > botSettings.maxFileSizeMB && sizeMB > 0 };
    } catch (_) {
        return { sizeMB: 0, isTooLarge: false };
    }
}

async function normalizeUrl(url) {
    try {
        if (!/vm\.|vt\.|v\.tiktok|douyin/.test(url)) return url;
        const r = await axios.get(url, {
            maxRedirects: 10, timeout: 8000, validateStatus: () => true,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        return r.request?.res?.responseUrl || r.request?.responseURL || url;
    } catch (_) { return url; }
}

function normalizeDouyinUrl(url) {
    const m = url.match(/modal_id=(\d+)/);
    if (m) return `https://www.douyin.com/video/${m[1]}`;
    return url;
}

// ============================================================
// 🐙 FACEBOOK DOWNLOADER
// ============================================================
async function normalizeFbUrl(fbUrl) {
    if (/facebook\.com\/(watch|video\.php|\d+\/videos\/)/.test(fbUrl)) return fbUrl;
    try {
        const r = await axios.get(fbUrl, {
            maxRedirects: 10, timeout: 12000, validateStatus: () => true,
            headers: {
                'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
        });
        const finalUrl = r.request?.res?.responseUrl || r.request?.responseURL || fbUrl;
        if (finalUrl && finalUrl !== fbUrl) return finalUrl;
    } catch (e) { console.log('[FB] normalizeFbUrl error:', e.message); }
    return fbUrl;
}

async function downloadFacebookVideo(fbUrl) {
    const realUrl = await normalizeFbUrl(fbUrl);
    const HB = {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    };

    const apis = [
        async () => {
            const res = await axios.post('https://snapsave.app/action.php',
                new URLSearchParams({ url: realUrl }),
                { timeout: 20000, headers: { ...HB, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://snapsave.app/', 'Origin': 'https://snapsave.app' } }
            );
            let html = res.data;
            if (typeof html === 'string' && html.includes('eval(function(p,a,c,k,e,d)')) {
                try {
                    const packed = html.match(/eval\((function\(p,a,c,k,e,d\)[\s\S]+?)\)\s*[;<]/)?.[1];
                    if (packed) { html = eval(`(${packed})`); } // eslint-disable-line no-eval
                } catch (_) {}
            }
            const hdUrl  = html.match(/href="([^"]+)"[^>]*>\s*Download HD/i)?.[1];
            const anyUrl = html.match(/href="(https:\/\/[^"]+(?:\.mp4|rapidcdn|fbcdn|video)[^"]{0,200})"/i)?.[1];
            const url    = hdUrl || anyUrl;
            if (url) return { url, title: 'Facebook Video' };
            throw new Error('SnapSave: no URL found');
        },
        async () => {
            const res = await axios.post('https://api.cobalt.tools/',
                { url: realUrl, videoQuality: '1080', isAudioOnly: false },
                { timeout: 20000, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': HB['User-Agent'] } }
            );
            const d = res.data;
            if (d?.url) return { url: d.url, title: d.filename || 'Facebook Video' };
            if (d?.status === 'redirect' || d?.status === 'stream') return { url: d.url, title: 'Facebook Video' };
            throw new Error(`Cobalt: ${d?.text || d?.status || 'empty'}`);
        },
        async () => {
            const res = await axios.post('https://getmyfb.com/api/ajaxSearch',
                new URLSearchParams({ q: realUrl, t: 'media', lang: 'en' }),
                { timeout: 15000, headers: { ...HB, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://getmyfb.com/' } }
            );
            const html   = res.data?.data || res.data || '';
            const hdUrl  = html.match(/href="([^"]+)"[^>]*>\s*Download HD/i)?.[1];
            const sdUrl  = html.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/)?.[1];
            const url    = hdUrl || sdUrl;
            if (url) return { url, title: 'Facebook Video' };
            throw new Error('GetMyFB: no URL found');
        },
        async () => {
            const ytdl = await getYtDlExec();
            const info = await ytdl(realUrl, {
                dumpSingleJson: true, noWarnings: true, noCheckCertificates: true,
                addHeader: ['User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language:en-US,en;q=0.9'],
            });
            const fmts = info.formats || [];
            const best = fmts
                .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && (f.ext === 'mp4' || !f.ext))
                .sort((a, b) => (b.width || 0) - (a.width || 0))[0]
                || fmts.filter(f => f.vcodec !== 'none').sort((a, b) => (b.width || 0) - (a.width || 0))[0];
            const url = best?.url || info.url;
            if (url) return { url, title: info.title || 'Facebook Video' };
            throw new Error('yt-dlp: no usable format');
        },
    ];

    for (let i = 0; i < apis.length; i++) {
        try {
            const result = await retryWithBackoff(apis[i], 2, 800);
            if (result?.url) {
                const sizeInfo = await checkVideoSize(result.url);
                return { ...result, ...sizeInfo };
            }
        } catch (e) { console.log(`[FB] ❌ API #${i + 1} failed: ${e.message}`); }
    }
    return null;
}

// ============================================================
// 🎵 TIKTOK DOWNLOADER
// ============================================================
function isTikTokPhotoUrl(url) {
    return /\/(?:photo|image|note)\/\d+|modal_id=\d+|item_id=\d+/.test(url);
}

async function downloadTikTokPhoto(url) {
    const normalizedUrl = await normalizeUrl(url);
    for (const strategy of [
        async () => {
            const res = await axios.post('https://www.tikwm.com/api/', { url: normalizedUrl, hd: 1 }, {
                timeout: 15000, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            });
            if (res.data?.code === 0 && res.data.data?.images?.length > 0) {
                const d = res.data.data;
                return { isSlideshow: true, images: d.images, music: d.music, title: d.title || 'TikTok Photo', imageCount: d.images.length };
            }
            throw new Error('TikWM no photos');
        },
        async () => {
            const result = await getVideoNoWatermark(url);
            if (result?.isSlideshow) return result;
            throw new Error('Fallback no photos');
        },
    ]) {
        try { const r = await strategy(); if (r) return r; } catch (_) {}
    }
    return null;
}

async function getVideoNoWatermark(url) {
    url = normalizeDouyinUrl(url);
    const normalizedUrl = await normalizeUrl(url);

    const apis = [
        async () => {
            const res = await axios.post('https://www.tikwm.com/api/', { url: normalizedUrl, hd: 1 }, {
                timeout: 15000, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            });
            if (res.data?.code === 0) {
                const d = res.data.data;
                if (d.images?.length) return { isSlideshow: true, images: d.images, music: d.music, title: d.title };
                if (d.play || d.hdplay) return { url: d.hdplay || d.play, title: d.title };
            }
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
                params: { url: normalizedUrl, hd: 1 }, timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' },
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
        },
    ];

    for (const api of apis) {
        try {
            const result = await retryWithBackoff(api);
            if (result?.url)         { const sz = await checkVideoSize(result.url); return { ...result, ...sz }; }
            if (result?.isSlideshow) return result;
        } catch (_) {}
    }
    return null;
}

// ============================================================
// ▶️ YOUTUBE DOWNLOADER
// ============================================================
async function downloadYouTubeVideo(url) {
    try {
        const ytdl    = await getYtDlExec();
        const tempPath= path.join(__dirname, `yt_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
        const info    = await ytdl(url, {
            dumpSingleJson: true, noWarnings: true, noCheckCertificates: true, addHeader: ['User-Agent:Mozilla/5.0'],
        });
        if (info.duration > 600) throw new Error('Video quá dài (chỉ hỗ trợ dưới 10 phút)');
        await ytdl(url, {
            output: tempPath, format: 'bestvideo+bestaudio/best',
            noWarnings: true, noCheckCertificates: true, addHeader: ['User-Agent:Mozilla/5.0'],
        });
        if (fs.existsSync(tempPath)) {
            const sizeMB = fs.statSync(tempPath).size / 1024 / 1024;
            return { isLocal: true, localPath: tempPath, url, title: info.title || 'YouTube Video', sizeMB, isTooLarge: sizeMB > botSettings.maxFileSizeMB };
        }
        throw new Error('yt-dlp download failed');
    } catch (e) {
        console.error('[YT] yt-dlp failed:', e.message);
        try {
            const res = await axios.post('https://api.cobalt.tools/', { url, videoQuality: '720', vCodec: 'h264' }, {
                timeout: 20000, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            });
            if (res.data?.url) return { url: res.data.url, title: res.data.filename || 'YouTube Video', sizeMB: 0, isTooLarge: false };
        } catch (_) {}
    }
    return null;
}

// ============================================================
// 📸 INSTAGRAM DOWNLOADER
// ============================================================
async function downloadInstagramVideo(url) {
    const apis = [
        async () => {
            const res = await axios.post('https://snapinsta.app/action.php', new URLSearchParams({ url }), {
                timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://snapinsta.app/' },
            });
            const m = res.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Instagram Video' };
            throw new Error('SnapInsta failed');
        },
        async () => {
            const res = await axios.post('https://sssinsta.com/action.php', new URLSearchParams({ url }), {
                timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://sssinsta.com/' },
            });
            const m = res.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Instagram Video' };
            throw new Error('SSSInsta failed');
        },
        async () => {
            const res = await axios.get(`https://igram.world/api/convert?url=${encodeURIComponent(url)}`, {
                timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            if (res.data?.url) return { url: res.data.url, title: 'Instagram Video' };
            throw new Error('IGram failed');
        },
    ];
    for (const api of apis) {
        try {
            const result = await retryWithBackoff(api);
            if (result?.url) { const sz = await checkVideoSize(result.url); return { ...result, ...sz }; }
        } catch (_) {}
    }
    return null;
}

// ============================================================
// 🐦 TWITTER/X DOWNLOADER
// ============================================================
async function downloadTwitterVideo(url) {
    const apis = [
        async () => {
            const res = await axios.get(`https://twitsave.com/info?url=${encodeURIComponent(url)}`, {
                timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            const m = res.data.match(/href="(https:\/\/video\.twimg\.com[^"]+)"/i);
            if (m) return { url: m[1], title: 'Twitter Video' };
            throw new Error('TwitSave failed');
        },
        async () => {
            const res = await axios.post('https://www.savetweetvid.com/downloader',
                new URLSearchParams({ url }),
                { timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' } }
            );
            const m = res.data.match(/href="(https:\/\/video\.twimg\.com[^"]+\.mp4[^"]*)"/i);
            if (m) return { url: m[1], title: 'Twitter Video' };
            throw new Error('SaveTweetVid failed');
        },
        async () => {
            const res = await axios.post('https://api.cobalt.tools/', { url }, {
                timeout: 15000, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            });
            if (res.data?.url) return { url: res.data.url, title: 'Twitter Video' };
            throw new Error('Cobalt Twitter failed');
        },
    ];
    for (const api of apis) {
        try {
            const result = await retryWithBackoff(api);
            if (result?.url) { const sz = await checkVideoSize(result.url); return { ...result, ...sz }; }
        } catch (_) {}
    }
    return null;
}

// ============================================================
// 🤖 REDDIT DOWNLOADER
// ============================================================
async function downloadRedditVideo(url) {
    try {
        const apiUrl  = url.replace(/\/$/, '') + '.json';
        const res     = await axios.get(apiUrl, {
            timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NobitaBot/4.2)' },
        });
        const post    = res.data?.[0]?.data?.children?.[0]?.data;
        const videoUrl= post?.secure_media?.reddit_video?.fallback_url || post?.media?.reddit_video?.fallback_url;
        if (videoUrl) return { url: videoUrl, title: post.title || 'Reddit Video', sizeMB: 0, isTooLarge: false };
        throw new Error('No video in Reddit post');
    } catch (e) { console.error('[Reddit]', e.message); return null; }
}

// ============================================================
// 📺 BILIBILI DOWNLOADER
// ============================================================
async function downloadBilibiliVideo(url) {
    try {
        const res = await axios.get(`https://api.injahow.cn/bparse/?url=${encodeURIComponent(url)}&type=json`, {
            timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (res.data?.url) { const sz = await checkVideoSize(res.data.url); return { url: res.data.url, title: res.data.title || 'Bilibili Video', ...sz }; }
        throw new Error('Bilibili API failed');
    } catch (e) { console.error('[Bilibili]', e.message); return null; }
}

// ============================================================
// 📌 PINTEREST DOWNLOADER
// ============================================================
async function downloadPinterestMedia(url) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
    const H  = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };

    if (/pin\.it\//.test(url)) {
        try {
            const r = await axios.get(url, { maxRedirects: 10, timeout: 8000, headers: H, validateStatus: () => true });
            url = r.request?.res?.responseUrl || r.request?.responseURL || url;
        } catch (_) {}
    }

    const strategies = [
        async () => {
            const pinId = url.match(/\/pin\/(\d+)/)?.[1];
            if (!pinId) throw new Error('No pin ID');
            const r = await axios.get(
                `https://www.pinterest.com/resource/PinResource/get/?source_url=/pin/${pinId}/&data={"options":{"id":"${pinId}","field_set_key":"detailed"},"context":{}}`,
                { timeout: 12000, headers: { ...H, 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://www.pinterest.com/' } }
            );
            const pin  = r.data?.resource_response?.data;
            if (!pin) throw new Error('No pin data');
            const vurl = pin?.videos?.video_list?.V_720P?.url || pin?.videos?.video_list?.V_480P?.url;
            if (vurl) return { url: vurl, title: pin.title || 'Pinterest Video', isImage: false };
            const iurl = pin?.images?.orig?.url || pin?.images?.['736x']?.url;
            if (iurl) return { url: iurl, title: pin.title || 'Pinterest Image', isImage: true };
            throw new Error('No media in pin data');
        },
        async () => {
            const r    = await axios.get(url, { timeout: 15000, headers: { ...H, Accept: 'text/html' }, maxRedirects: 10 });
            const html = r.data || '';
            const vm   = html.match(/"url"\s*:\s*"(https:\/\/v\.pinimg\.com\/[^"]+\.mp4[^"]*)"/);
            if (vm) return { url: vm[1].replace(/\\u002F/g, '/'), title: 'Pinterest Video', isImage: false };
            for (const p of [
                /"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/,
                /property="og:image"\s+content="([^"]+)"/,
                /content="([^"]+)"\s+property="og:image"/,
            ]) {
                const m = html.match(p);
                if (m && m[1].startsWith('http')) {
                    const imgUrl = m[1].replace(/\\u002F/g, '/').replace(/\/\d+x[\d/]*\//, '/originals/');
                    return { url: imgUrl, title: 'Pinterest Image', isImage: true };
                }
            }
            throw new Error('No media in HTML');
        },
        async () => {
            const r = await axios.get(`https://www.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`, { timeout: 10000, headers: H });
            if (!r.data?.thumbnail_url) throw new Error('No thumbnail');
            const imgUrl = r.data.thumbnail_url.replace(/\/\d+x[\d/]*\//, '/originals/');
            return { url: imgUrl, title: r.data.title || 'Pinterest Image', isImage: true };
        },
        async () => {
            const r = await axios.post('https://api.cobalt.tools/',
                { url, videoQuality: '1080' },
                { timeout: 15000, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA } }
            );
            if (r.data?.url) return { url: r.data.url, title: 'Pinterest Video', isImage: false };
            throw new Error('Cobalt no result');
        },
    ];

    for (const [i, s] of strategies.entries()) {
        try {
            const result = await retryWithBackoff(s, 2, 600);
            if (result?.url) {
                const sz = await checkVideoSize(result.url);
                return { ...result, ...sz };
            }
        } catch (e) { console.log(`[Pinterest] strategy ${i + 1} failed: ${e.message}`); }
    }
    return null;
}

// ============================================================
// 👻 SNAPCHAT DOWNLOADER
// ============================================================
async function downloadSnapchatVideo(url) {
    try {
        const res = await axios.post('https://api.cobalt.tools/', { url }, {
            timeout: 15000, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        });
        if (res.data?.url) return { url: res.data.url, title: 'Snapchat Video', sizeMB: 0, isTooLarge: false };
    } catch (e) { console.error('[Snapchat]', e.message); }
    return null;
}

// ============================================================
// 🎧 SOUNDCLOUD DOWNLOADER
// ============================================================
async function downloadSoundCloudAudio(url) {
    try {
        const ytdl    = await getYtDlExec();
        const tempPath= path.join(__dirname, `sc_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
        const info    = await ytdl(url, { dumpSingleJson: true, noWarnings: true, noCheckCertificates: true, addHeader: ['User-Agent:Mozilla/5.0'] });
        await ytdl(url, { extractAudio: true, audioFormat: 'mp3', audioQuality: '0', output: tempPath, noWarnings: true, noCheckCertificates: true, addHeader: ['User-Agent:Mozilla/5.0'] });
        if (!fs.existsSync(tempPath)) throw new Error('SoundCloud: download failed');
        const sizeMB = fs.statSync(tempPath).size / 1024 / 1024;
        return { isAudio: true, isLocal: true, localPath: tempPath, title: info.title || 'SoundCloud Audio', sizeMB, isTooLarge: sizeMB > botSettings.maxFileSizeMB };
    } catch (e) { throw new Error(e.message || 'SoundCloud download failed'); }
}

// ============================================================
// ✈️ TELEGRAM PROTECTED MEDIA DOWNLOADER (FIX 413)
// ============================================================
function parseTelegramLink(url) {
    const m = url.match(/https?:\/\/t\.me\/(?:c\/(\d+)|([a-zA-Z0-9_]+))\/(\d+)/);
    if (!m) return null;
    return {
        isPrivate: !!m[1],
        channelId: m[1] ? parseInt(m[1]) : null,
        username:  m[2] || null,
        msgId:     parseInt(m[3]),
    };
}

async function downloadTelegramMedia(url, progressCb) {
    if (!tgClient) {
        throw new Error(
            'Tính năng tải Telegram chưa được cấu hình.\n\n' +
            'Admin cần thêm vào Render Environment:\n' +
            '• TELEGRAM_API_ID\n• TELEGRAM_API_HASH\n• TELEGRAM_SESSION\n\n' +
            'Xem hướng dẫn tại generateSession.js'
        );
    }

    const { Api } = require('telegram');
    const info    = parseTelegramLink(url);
    if (!info) throw new Error('Link Telegram không hợp lệ. Dùng định dạng: https://t.me/channel/123');

    // Resolve entity
    let entity;
    try {
        if (info.isPrivate) {
            entity = await tgClient.getEntity(new Api.PeerChannel({ channelId: info.channelId }));
        } else {
            entity = await tgClient.getEntity(info.username);
        }
    } catch (e) {
        throw new Error(`Không thể truy cập kênh "${info.username || info.channelId}".\nĐảm bảo tài khoản đã tham gia kênh này. (${e.message})`);
    }

    // Lấy tin nhắn
    const messages = await tgClient.getMessages(entity, { ids: [info.msgId] });
    const msg      = messages?.[0];
    if (!msg)       throw new Error('Không tìm thấy tin nhắn. Kiểm tra lại link.');
    if (!msg.media) throw new Error('Tin nhắn này không có media (nhạc/video/ảnh).');

    // ── Phân tích metadata đầy đủ ──────────────────────────
    let filename  = `tg_media_${Date.now()}`;
    let isAudio   = false;
    let isPhoto   = false;
    let fileSize  = 0;
    let duration  = 0;
    let performer = '';
    let trackTitle= '';
    let mimeType  = '';
    let waveform  = null; // dữ liệu sóng âm

    const doc = msg.media?.document;
    if (doc) {
        fileSize = Number(doc.size || 0);
        mimeType = doc.mimeType || '';
        for (const a of (doc.attributes || [])) {
            if (a.className === 'DocumentAttributeFilename' && a.fileName) {
                filename = a.fileName;
            }
            if (a.className === 'DocumentAttributeAudio') {
                isAudio    = true;
                duration   = a.duration  || 0;
                trackTitle = a.title     || '';
                performer  = a.performer || '';
                waveform   = a.waveform  || null; // Buffer sóng âm gốc
                if (trackTitle) filename = (performer ? `${performer} - ${trackTitle}` : trackTitle) + '.mp3';
            }
        }
    }
    if (msg.media?.className === 'MessageMediaPhoto') isPhoto = true;
    if (!filename.includes('.')) filename += isAudio ? '.mp3' : isPhoto ? '.jpg' : '.mp4';

    const sizeMB       = fileSize / 1024 / 1024;
    const safeFilename = filename.replace(/[^\w.\- ]/g, '_').slice(0, 100);

    console.log(`[TG] File: ${safeFilename} | Size: ${formatFileSize(sizeMB)} | Audio: ${isAudio} | Mime: ${mimeType}`);

    // ── Nếu file > BOT_UPLOAD_LIMIT_MB: trả về flag isForward ─
    // Bot sẽ dùng MTProto để forward trực tiếp, không re-upload
    if (sizeMB > BOT_UPLOAD_LIMIT_MB && sizeMB > 0) {
        console.log(`[TG] File lớn ${formatFileSize(sizeMB)} > ${BOT_UPLOAD_LIMIT_MB}MB → dùng forward MTProto`);
        return {
            isForward:  true,        // flag quan trọng: xử lý riêng trong processQueue
            isLocal:    false,
            tgMsg:      msg,
            tgEntity:   entity,
            tgMsgId:    info.msgId,
            isAudio,
            isPhoto,
            isVideo:    !isAudio && !isPhoto,
            title:      trackTitle || filename.replace(/\.[^.]+$/, ''),
            performer,
            duration,
            mimeType,
            waveform,
            filename:   safeFilename,
            sizeMB,
            isTooLarge: false,      // không phải "quá lớn" — sẽ được xử lý bằng forward
        };
    }

    // ── File nhỏ ≤ BOT_UPLOAD_LIMIT_MB: tải về local rồi upload ──
    const tempPath = path.join(__dirname, `tg_${Date.now()}_${Math.random().toString(36).slice(2)}_${safeFilename}`);
    let lastPct = -1;

    await tgClient.downloadMedia(msg, {
        outputFile: tempPath,
        progressCallback: (received, total) => {
            if (!progressCb || !total) return;
            const pct = Math.round((Number(received) / Number(total)) * 100);
            if (pct !== lastPct && pct % 20 === 0) { lastPct = pct; progressCb(pct); }
        },
    });

    if (!fs.existsSync(tempPath)) throw new Error('Tải file thất bại, thử lại sau.');

    const realSizeMB = fs.statSync(tempPath).size / 1024 / 1024;
    return {
        isLocal:    true,
        isForward:  false,
        localPath:  tempPath,
        isAudio,
        isPhoto,
        isVideo:    !isAudio && !isPhoto,
        title:      trackTitle || filename.replace(/\.[^.]+$/, ''),
        performer,
        duration,
        mimeType,
        waveform,
        filename:   safeFilename,
        sizeMB:     realSizeMB,
        isTooLarge: realSizeMB > BOT_UPLOAD_LIMIT_MB,
    };
}

// ── Forward file lớn qua MTProto (giữ nguyên chất lượng) ────
async function forwardTelegramMedia(videoData, targetChatId, replyToMsgId, caption) {
    if (!tgClient) throw new Error('MTProto client chưa kết nối');
    const { Api } = require('telegram');

    // Lấy peer của chat đích (bot chat với user)
    // Dùng sendFile để gửi lại file gốc với full quality qua MTProto
    try {
        await tgClient.sendFile(targetChatId, {
            file:       videoData.tgMsg.media.document || videoData.tgMsg.media,
            caption:    caption || '',
            replyTo:    replyToMsgId,
            // Giữ nguyên attributes (bao gồm waveform) → sóng nhạc đầy đủ
            attributes: videoData.tgMsg.media.document?.attributes || [],
            mimeType:   videoData.mimeType || undefined,
            forceDocument: false, // gửi dạng audio/video native, không phải document
        });
        return true;
    } catch (e) {
        console.error('[TG Forward] sendFile failed:', e.message);
        // Fallback: forward tin nhắn gốc
        try {
            await tgClient.forwardMessages(targetChatId, {
                messages:   [videoData.tgMsgId],
                fromPeer:   videoData.tgEntity,
            });
            return true;
        } catch (e2) {
            console.error('[TG Forward] forwardMessages failed:', e2.message);
            throw new Error(`Forward thất bại: ${e2.message}`);
        }
    }
}

// ============================================================
// ⚙️ QUEUE PROCESSOR
// ============================================================
async function processQueue() {
    if (processingCount >= MAX_CONCURRENT || requestQueue.length === 0) return;
    const req = requestQueue.shift();
    if (!req) return;
    processingCount++;

    let procMsg;
    try {
        const p        = PLATFORMS[req.platform];
        const waitLine = botSettings.funMode ? `\n${pickRandom(FUN.waitLines)}` : '';
        procMsg = await bot.sendMessage(req.chatId,
            `✨ *Đang xử lý:* ${p ? p.emoji + ' ' + p.name : 'Media'}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `⏳ Vui lòng chờ...${waitLine}`,
            { reply_to_message_id: req.messageId, parse_mode: 'Markdown' }
        );

        let videoData;
        switch (req.platform) {
            case 'tiktok':
                videoData = isTikTokPhotoUrl(req.url)
                    ? await downloadTikTokPhoto(req.url)
                    : await getVideoNoWatermark(req.url);
                break;
            case 'facebook':       videoData = await downloadFacebookVideo(req.url);    break;
            case 'youtube':        videoData = await downloadYouTubeVideo(req.url);     break;
            case 'instagram':      videoData = await downloadInstagramVideo(req.url);   break;
            case 'twitter':        videoData = await downloadTwitterVideo(req.url);     break;
            case 'pinterest':      videoData = await downloadPinterestMedia(req.url);   break;
            case 'reddit':         videoData = await downloadRedditVideo(req.url);      break;
            case 'bilibili':       videoData = await downloadBilibiliVideo(req.url);    break;
            case 'snapchat':       videoData = await downloadSnapchatVideo(req.url);    break;
            case 'soundcloud':     videoData = await downloadSoundCloudAudio(req.url);  break;
            case 'telegram_media':
                if (procMsg) {
                    bot.editMessageText(
                        `✈️ *Đang kết nối Telegram...*\n━━━━━━━━━━━━━━━━━━━━\n⏳ Đang lấy thông tin file...`,
                        { chat_id: req.chatId, message_id: procMsg.message_id, parse_mode: 'Markdown' }
                    ).catch(() => {});
                }
                videoData = await downloadTelegramMedia(req.url, (pct) => {
                    if (!procMsg) return;
                    const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
                    bot.editMessageText(
                        `✈️ *Đang tải từ Telegram...*\n━━━━━━━━━━━━━━━━━━━━\n[${bar}] ${pct}%`,
                        { chat_id: req.chatId, message_id: procMsg.message_id, parse_mode: 'Markdown' }
                    ).catch(() => {});
                });
                break;
            default:               videoData = await getVideoNoWatermark(req.url);      break;
        }

        if (!videoData || (!videoData.url && !videoData.localPath && !videoData.isSlideshow && !videoData.isForward)) {
            throw new Error('Could not retrieve media');
        }

        // ── Slideshow / Photo Album ────────────────────────────
        if (videoData.isSlideshow) {
            const sid = Math.random().toString(36).slice(2, 10);
            setCacheWithTtl(slideshowCache, sid, { images: videoData.images, music: videoData.music, title: videoData.title }, SLIDESHOW_CACHE_TTL);
            await bot.editMessageText(
                `📸 *Đây là bộ ảnh (${videoData.images?.length || 0} ảnh)*\n\nBạn muốn tải gì?`,
                {
                    chat_id: req.chatId, message_id: procMsg.message_id, parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: `🖼️ Tải ${videoData.images?.length || 0} ảnh`, callback_data: `slides_photos_${sid}` }],
                            [{ text: '🎵 Tải nhạc nền (MP3)', callback_data: `slides_music_${sid}` }],
                        ],
                    },
                }
            );
            stats.successfulDownloads++;
            dailyStats.downloads++;
            recordPlatformSuccess(req.platform);
            maybeSendFun(req.chatId, pickRandom(FUN.successLines));
            saveData();
            return;
        }

        // ── TELEGRAM FORWARD (file lớn > 19MB, giữ nguyên chất lượng) ──
        if (videoData.isForward) {
            if (procMsg) {
                const typeLabel = videoData.isAudio ? '🎵 Audio' : videoData.isVideo ? '🎬 Video' : '📄 File';
                bot.editMessageText(
                    `✈️ *Đang gửi ${typeLabel} chất lượng gốc...*\n━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 Kích thước: ${formatFileSize(videoData.sizeMB)}\n` +
                    `⚡ Dùng MTProto để giữ nguyên sóng nhạc & chất lượng`,
                    { chat_id: req.chatId, message_id: procMsg.message_id, parse_mode: 'Markdown' }
                ).catch(() => {});
            }

            try {
                await forwardTelegramMedia(videoData, req.chatId, req.messageId, botSettings.captionText);
                stats.successfulDownloads++;
                dailyStats.downloads++;
                recordPlatformSuccess(req.platform);
                maybeSendFun(req.chatId, pickRandom(FUN.successLines));
                handleComboMessage(req.chatId, req.userId);
                recordHistory(req.userId, req.url, req.platform);
                addActivityLog('ok', `✅ TG Forward (${formatFileSize(videoData.sizeMB)}) → @${req.username}`);
            } catch (fwdErr) {
                console.error('[TG Forward] failed:', fwdErr.message);
                // Fallback cuối: thông báo kích thước và link gốc
                await bot.sendMessage(req.chatId,
                    `⚠️ *Không thể tự động gửi file ${formatFileSize(videoData.sizeMB)}*\n\n` +
                    `Bot API Telegram giới hạn upload ~${BOT_UPLOAD_LIMIT_MB}MB.\n\n` +
                    `💡 *Cách tải thủ công:*\n` +
                    `1. Mở link gốc bên dưới\n` +
                    `2. Nhấn giữ file audio → Lưu về máy`,
                    {
                        parse_mode: 'Markdown', reply_to_message_id: req.messageId,
                        reply_markup: { inline_keyboard: [[{ text: '🔗 Mở link gốc', url: req.url }]] },
                    }
                );
            }
            if (procMsg && botSettings.autoDeleteProcessing) bot.deleteMessage(req.chatId, procMsg.message_id).catch(() => {});
            saveData();
            return;
        }

        // ── Ảnh đơn ────────────────────────────────────────────
        if (videoData.isImage) {
            const imgSrc = videoData.isLocal && videoData.localPath ? videoData.localPath : videoData.url;
            try {
                await bot.sendPhoto(req.chatId, imgSrc, {
                    caption: botSettings.captionText, reply_to_message_id: req.messageId,
                });
            } catch (_) {
                if (!videoData.isLocal) {
                    const tmpImg = path.join(__dirname, `img_${Date.now()}.jpg`);
                    const writer = fs.createWriteStream(tmpImg);
                    const dlr    = await axios.get(videoData.url, {
                        responseType: 'stream', timeout: 30000,
                        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.pinterest.com/' },
                    });
                    dlr.data.pipe(writer);
                    await new Promise((ok, fail) => { writer.on('finish', ok); writer.on('error', fail); });
                    try {
                        await bot.sendPhoto(req.chatId, tmpImg, { caption: botSettings.captionText, reply_to_message_id: req.messageId });
                    } finally { fs.unlink(tmpImg, () => {}); }
                } else {
                    throw new Error('Gửi ảnh thất bại');
                }
            } finally {
                if (videoData.isLocal && videoData.localPath) fs.unlink(videoData.localPath, () => {});
            }
            stats.successfulDownloads++;
            dailyStats.downloads++;
            recordPlatformSuccess(req.platform);
            maybeSendFun(req.chatId, pickRandom(FUN.successLines));
            handleComboMessage(req.chatId, req.userId);
            recordHistory(req.userId, req.url, req.platform);
            addActivityLog('ok', `✅ ${p?.name || 'image'} → @${req.username}`);
            if (procMsg && botSettings.autoDeleteProcessing) bot.deleteMessage(req.chatId, procMsg.message_id).catch(() => {});
            saveData();
            return;
        }

        // ── Audio ──────────────────────────────────────────────
        if (videoData.isAudio) {
            if (videoData.isTooLarge) {
                if (videoData.isLocal && videoData.localPath) fs.unlink(videoData.localPath, () => {});
                await bot.sendMessage(req.chatId,
                    `⚠️ *Audio quá lớn (${formatFileSize(videoData.sizeMB)})!*\nGiới hạn Bot API: ${BOT_UPLOAD_LIMIT_MB}MB.`,
                    { parse_mode: 'Markdown', reply_to_message_id: req.messageId }
                );
            } else {
                const audioSrc = videoData.isLocal && videoData.localPath ? videoData.localPath : videoData.url;
                try {
                    await bot.sendAudio(req.chatId, audioSrc, {
                        caption:             botSettings.captionText,
                        reply_to_message_id: req.messageId,
                        title:               videoData.title,
                        performer:           videoData.performer || undefined,
                        duration:            videoData.duration  || undefined,
                    });
                } finally {
                    if (videoData.isLocal && videoData.localPath) fs.unlink(videoData.localPath, () => {});
                }
                stats.successfulDownloads++;
                dailyStats.downloads++;
                recordPlatformSuccess(req.platform);
                maybeSendFun(req.chatId, pickRandom(FUN.successLines));
                handleComboMessage(req.chatId, req.userId);
                recordHistory(req.userId, req.url, req.platform);
                addActivityLog('ok', `✅ ${p?.name || 'audio'} → @${req.username}`);
            }
            if (procMsg && botSettings.autoDeleteProcessing) bot.deleteMessage(req.chatId, procMsg.message_id).catch(() => {});
            saveData();
            return;
        }

        // ── Video quá lớn: gửi link tải trực tiếp ─────────────
        if (videoData.isTooLarge) {
            if (videoData.isLocal && videoData.localPath) fs.unlink(videoData.localPath, () => {});
            await bot.sendMessage(req.chatId,
                `⚠️ *File quá lớn (${formatFileSize(videoData.sizeMB)})!*\nGiới hạn ${botSettings.maxFileSizeMB}MB. Bấm bên dưới để tải trực tiếp 👇`,
                {
                    parse_mode: 'Markdown', reply_to_message_id: req.messageId,
                    reply_markup: { inline_keyboard: [[{ text: '🔗 TẢI TRỰC TIẾP', url: videoData.url }]] },
                }
            );
        } else {
            // ── Tải và gửi video ───────────────────────────────
            const tempFile = path.join(__dirname, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
            try {
                if (videoData.isLocal && videoData.localPath) {
                    fs.renameSync(videoData.localPath, tempFile);
                } else {
                    const writer = fs.createWriteStream(tempFile);
                    const dlRes  = await axios.get(videoData.url, {
                        responseType: 'stream', timeout: 120000,
                        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' },
                    });
                    dlRes.data.pipe(writer);
                    await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
                }

                const mp3Id = Math.random().toString(36).slice(2, 10);
                setCacheWithTtl(mp3Cache, mp3Id, { url: req.url, platform: req.platform }, MP3_CACHE_TTL);
                if (mp3Cache.size > 500) mp3Cache.delete(mp3Cache.keys().next().value);

                await bot.sendVideo(req.chatId, tempFile, {
                    caption: botSettings.captionText, reply_to_message_id: req.messageId, supports_streaming: true,
                    reply_markup: botSettings.mp3Button
                        ? { inline_keyboard: [[{ text: '🎵 Tải MP3', callback_data: `mp3_${mp3Id}` }]] }
                        : undefined,
                });
            } finally {
                fs.unlink(tempFile, () => {});
            }

            stats.successfulDownloads++;
            dailyStats.downloads++;
            recordPlatformSuccess(req.platform);
            maybeSendFun(req.chatId, pickRandom(FUN.successLines));
            handleComboMessage(req.chatId, req.userId);
            recordHistory(req.userId, req.url, req.platform);
            addActivityLog('ok', `✅ ${p?.name || 'video'} → @${req.username}`);
        }

        if (procMsg && botSettings.autoDeleteProcessing) bot.deleteMessage(req.chatId, procMsg.message_id).catch(() => {});
        saveData();

    } catch (err) {
        console.error(`[❌] Error:`, err.message);

        const shouldRetry = isTransientError(err) && req.retries < 2;
        if (shouldRetry) {
            req.retries++;
            addActivityLog('warn', `🔁 Retry ${req.retries}/2: ${req.platform} @${req.username}`);
            if (procMsg) bot.editMessageText(`⏳ *Lỗi tạm thời, đang thử lại...* (${req.retries}/2)`,
                { chat_id: req.chatId, message_id: procMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});
            setTimeout(() => requestQueue.push(req), 1500 * req.retries);
            return;
        }

        stats.failedDownloads++;
        recordPlatformFailure(req.platform, err);
        addActivityLog('err', `❌ ${req.platform} @${req.username}: ${err.message.substring(0, 60)}`);
        saveData();

        let errMsg = `❌ *THẤT BẠI*\n━━━━━━━━━━━━━━━━━━━━\n`;
        if (err.message.includes('Could not retrieve'))   errMsg += `🚫 Không thể lấy media. Link có thể đã bị xóa hoặc private.`;
        else if (err.message.includes('timeout'))         errMsg += `⏰ Kết nối quá hạn. Vui lòng thử lại.`;
        else if (err.message.includes('quá lớn'))         errMsg += `⚠️ ${err.message}`;
        else if (err.message.includes('quá dài'))         errMsg += `⏱️ ${err.message}`;
        else if (err.message.includes('chưa được cấu hình')) errMsg += `⚙️ ${err.message}`;
        else errMsg += `👾 Lỗi: \`${err.message.substring(0, 80)}\``;
        errMsg += `\n\n💡 Đảm bảo link công khai và có thể xem được.`;
        if (botSettings.funMode) errMsg += `\n\n${pickRandom(FUN.failLines)}`;

        if (procMsg) bot.editMessageText(errMsg, { chat_id: req.chatId, message_id: procMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});
        else         bot.sendMessage(req.chatId, errMsg, { parse_mode: 'Markdown', reply_to_message_id: req.messageId }).catch(() => {});

        if (botSettings.notifyAdmin && ADMIN_USER_ID) {
            bot.sendMessage(ADMIN_USER_ID,
                `⚠️ *Download failed:*\n📱 ${req.platform}\n👤 @${req.username}\n🔗 ${req.url.substring(0, 80)}\n❌ ${err.message}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
    } finally {
        processingCount--;
        setImmediate(() => processQueue());
    }
}

// ============================================================
// 💬 BOT COMMANDS
// ============================================================

bot.onText(/^\/start(@\w+)?$/, async (msg) => {
    const chatId   = msg.chat.id;
    const userId   = msg.from?.id;
    const fname    = escapeMarkdown(msg.from?.first_name || 'bạn');
    const badge    = getUserBadge(userId);
    const platforms= Object.values(PLATFORMS).map(p => `${p.emoji} ${p.name}`).join('  |  ');
    const funLine  = botSettings.funMode ? `\n${pickRandom(FUN.startTips)}` : '';

    const text =
        `┏━━━━━━━━━━━━━━━━━━┓\n` +
        `┃   🚀  NOBITA BOT v${BOT_VERSION}  ┃\n` +
        `┗━━━━━━━━━━━━━━━━━━┛\n\n` +
        `👋 Chào *${fname}*! ${badge}\n` +
        `Mình là công cụ tải media *Không Logo* chất lượng cao.\n\n` +
        (maintenanceMode ? `⚠️ *BẢO TRÌ:* Bot đang nâng cấp, vui lòng quay lại sau.\n\n` : '') +
        `💎 *Tính năng:*\n` +
        `├ ⚡️ Tốc độ tải cực nhanh\n` +
        `├ 🎬 Chất lượng gốc, không watermark\n` +
        `├ 🎵 Trích xuất MP3\n` +
        `├ 🖼️ Tải ảnh Pinterest / TikTok album\n` +
        `└ ✈️ Tải audio/video Telegram giữ nguyên chất lượng\n\n` +
        `🌐 *Hỗ trợ:*\n${platforms}\n\n` +
        `${funLine}\n\n` +
        `💡 Chỉ cần dán link vào đây!\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 Gõ /help để xem lệnh.`;

    try {
        await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📑 Hướng dẫn sử dụng', callback_data: 'help_main' }],
                    ...(isAdmin(userId) ? [[{ text: '🖥️ Admin Dashboard', url: DASHBOARD_URL }]] : []),
                ],
            },
        });
    } catch (_) {
        bot.sendMessage(chatId, text.replace(/[*_`]/g, '')).catch(() => {});
    }
});

async function sendHelpMessage(chatId, userId) {
    const adm = isAdmin(userId);
    let text  = `📖 *HƯỚNG DẪN SỬ DỤNG*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `👤 *Người dùng:*\n` +
            `├ /start — Khởi động Bot\n` +
            `├ /help — Bảng lệnh này\n` +
            `├ /ping — Kiểm tra độ trễ\n` +
            `├ /status — Trạng thái hệ thống\n` +
            `├ /platforms — Nền tảng hỗ trợ + tỷ lệ\n` +
            `├ /myinfo — Thông tin tài khoản\n` +
            `├ /mystats — Thống kê cá nhân chi tiết\n` +
            `├ /history — Lịch sử tải\n` +
            `├ /top — BXH người dùng\n` +
            `├ /clear — Xóa lịch sử AI chat\n` +
            `├ /feedback <nội dung> — Gửi phản hồi\n` +
            `├ /about — Thông tin bot\n` +
            `├ /report <link> — Báo lỗi\n` +
            `├ /joke /meme /riddle /quiz — Vui vẻ\n` +
            `└ /dice /coin — Mini game\n\n` +
            `💡 Dán link video/ảnh/nhạc là bot tự xử lý!\n` +
            `✈️ Link Telegram: https://t.me/kênh/số_tin_nhắn\n`;

    if (adm) {
        text += `\n━━━━━━━━━━━━━━━━━━━━\n👑 *Quản trị viên:*\n` +
                `├ /stats /panel — Thống kê\n` +
                `├ /users — Danh sách user\n` +
                `├ /broadcast <msg> — Gửi tất cả\n` +
                `├ /ban /unban /warn — Quản lý user\n` +
                `├ /addvip /premium — Cấp quyền\n` +
                `└ /maintenance on|off — Bảo trì\n`;
    }

    try {
        await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    adm
                        ? { text: '🖥️ Mở Dashboard', url: DASHBOARD_URL }
                        : { text: '👨‍💻 Liên hệ Admin', url: 'https://t.me/phamtheson' },
                ]],
            },
        });
    } catch (_) {
        bot.sendMessage(chatId, text.replace(/[*_`]/g, '')).catch(() => {});
    }
}

bot.onText(/^\/help(@\w+)?$/, msg => sendHelpMessage(msg.chat.id, msg.from?.id));

bot.onText(/^\/ping$/, async (msg) => {
    const t = Date.now();
    const m = await bot.sendMessage(msg.chat.id, '🏓 Pinging...');
    bot.editMessageText(`🏓 Pong! \`${Date.now() - t}ms\`\n⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}`,
        { chat_id: msg.chat.id, message_id: m.message_id, parse_mode: 'Markdown' });
});

bot.onText(/^\/status$/, (msg) => {
    const rate = stats.totalRequests > 0 ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
    const tgStatus = tgClient ? '✅ Đã kết nối' : '❌ Chưa cấu hình';
    bot.sendMessage(msg.chat.id,
        `📊 *Trạng thái Bot v${BOT_VERSION}*\n\n` +
        `${maintenanceMode ? '🔧 Chế độ: BẢO TRÌ' : '✅ Chế độ: HOẠT ĐỘNG'}\n` +
        `⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
        `📥 Tổng tải: ${stats.successfulDownloads.toLocaleString()}\n` +
        `📈 Tỷ lệ: ${rate}%\n` +
        `👥 Users: ${stats.activeUsers.size}\n` +
        `📋 Hàng đợi: ${requestQueue.length}/${MAX_CONCURRENT}\n` +
        `✈️ Telegram MTProto: ${tgStatus}`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/^\/platforms$/, (msg) => {
    const lines = Object.entries(PLATFORMS).map(([key, p]) => {
        const s     = platformStats[key] || { ok: 0, fail: 0 };
        const total = s.ok + s.fail;
        const rate  = total > 0 ? Math.round((s.ok / total) * 100) : null;
        const icon  = total === 0 ? '⚪' : rate >= 80 ? '🟢' : rate >= 50 ? '🟡' : '🔴';
        return `${icon} ${p.emoji} *${p.name}*${rate !== null ? ` — ${rate}% (${s.ok}✅/${s.fail}❌)` : ' — chưa sử dụng'}`;
    }).join('\n');
    bot.sendMessage(msg.chat.id, `🌐 *Nền tảng hỗ trợ:*\n━━━━━━━━━━━━━━━━━━━━\n\n${lines}\n\n🟢 Tốt | 🟡 Trung bình | 🔴 Kém`, { parse_mode: 'Markdown' });
});

bot.onText(/^\/about$/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `🤖 *Nobita Bot v${BOT_VERSION}*\n\n` +
        `Bot tải media đa nền tảng, không watermark, chất lượng cao.\n\n` +
        `👨‍💻 *Phát triển bởi:* @phamtheson\n` +
        `📱 *Hỗ trợ:* ${Object.keys(PLATFORMS).length} nền tảng\n` +
        `⚡ *Powered by:* Node.js + Telegram Bot API\n` +
        `🧠 *AI:* Google Gemini 1.5 Flash\n` +
        `✈️ *Telegram MTProto:* ${tgClient ? '✅ Đã kết nối (hỗ trợ file lớn)' : '❌ Chưa cấu hình'}\n\n` +
        `📌 Dán link bất kỳ để bắt đầu tải!`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/^\/clear$/, (msg) => {
    conversationHistory.delete(msg.from?.id);
    bot.sendMessage(msg.chat.id, '🗑️ Đã xóa lịch sử trò chuyện AI! Bắt đầu lại từ đầu nhé 🤖');
});

bot.onText(/^\/mystats$/, (msg) => {
    const userId   = msg.from?.id;
    const userData = stats.activeUsers.get(userId);
    if (!userData) { bot.sendMessage(msg.chat.id, '📭 Bạn chưa tải media nào.'); return; }

    const cnt      = userData.count || 0;
    const level    = Math.floor(Math.sqrt(cnt)) || 1;
    const nextLvl  = (level + 1) * (level + 1);
    const progress = Math.round(((cnt - level * level) / Math.max(nextLvl - level * level, 1)) * 10);
    const bar      = '█'.repeat(Math.max(0, progress)) + '░'.repeat(Math.max(0, 10 - progress));

    const platforms = {};
    (userData.history || []).forEach(h => { platforms[h.platform] = (platforms[h.platform] || 0) + 1; });
    const topPlatform = Object.entries(platforms).sort((a, b) => b[1] - a[1])[0];

    bot.sendMessage(msg.chat.id,
        `📊 *Thống kê của bạn*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🎖️ Cấp độ: *${level}* ${getUserBadge(userId) || '🌱'}\n` +
        `📈 Tiến độ: \`[${bar}]\` ${cnt - level * level}/${nextLvl - level * level}\n\n` +
        `📥 Tổng tải: *${cnt.toLocaleString('vi-VN')}* lần\n` +
        `⭐ Cấp bậc: ${isAdmin(userId) ? 'Admin 👑' : isVip(userId) ? 'VIP ⭐' : isPremium(userId) ? 'Premium 💎' : 'Thành viên'}\n` +
        `${topPlatform ? `🌐 Nền tảng yêu thích: *${PLATFORMS[topPlatform[0]]?.name}* (${topPlatform[1]} lần)\n` : ''}` +
        `📅 Tham gia: ${userData.joinedAt ? new Date(userData.joinedAt).toLocaleDateString('vi-VN') : 'N/A'}\n` +
        `🕐 Lần cuối: ${userData.lastUsed ? new Date(userData.lastUsed).toLocaleString('vi-VN') : 'N/A'}`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/^\/feedback (.+)/, (msg, match) => {
    const who = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'user';
    if (ADMIN_USER_ID) {
        bot.sendMessage(ADMIN_USER_ID,
            `💬 *Phản hồi từ ${who}* (ID: \`${msg.from?.id}\`):\n\n${match[1]}`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
    bot.sendMessage(msg.chat.id, '✅ Phản hồi đã được gửi! Cảm ơn bạn đã đóng góp ý kiến 🙏');
});

bot.onText(/^\/joke$/,    (msg) => bot.sendMessage(msg.chat.id, `😂 ${pickRandom(FUN.jokes) || 'Hôm nay bot chưa nghĩ ra câu nào 😅'}`));
bot.onText(/^\/meme$/,    (msg) => bot.sendMessage(msg.chat.id, `🖼️ ${pickRandom(FUN.memes) || 'Meme đã bỏ đi chơi 😅'}`, { parse_mode: 'Markdown' }));
bot.onText(/^\/dice$/,    (msg) => bot.sendDice(msg.chat.id));
bot.onText(/^\/coin$/,    (msg) => bot.sendMessage(msg.chat.id, `Kết quả: ${Math.random() < 0.5 ? '🪙 Sấp' : '🪙 Ngửa'}!`));

bot.onText(/^\/riddle$/, (msg) => {
    const r = pickRandom(FUN.riddles);
    if (!r) return bot.sendMessage(msg.chat.id, '🤔 Chưa có câu đố!');
    bot.sendMessage(msg.chat.id, `🧩 *Đố vui:* ${r.q}\n\nĐáp án: *${r.a}*`, { parse_mode: 'Markdown' });
});

bot.onText(/^\/quiz$/, (msg) => {
    const q = pickRandom(FUN.quizzes);
    if (!q) return bot.sendMessage(msg.chat.id, '📚 Chưa có câu hỏi!');
    const id = Math.random().toString(36).slice(2, 10);
    setCacheWithTtl(quizCache, id, { answer: q.answer }, QUIZ_CACHE_TTL);
    bot.sendMessage(msg.chat.id, `🧠 *Quiz:* ${q.q}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: q.opts.map((o, i) => [{ text: o, callback_data: `quiz_${id}_${i}` }]) },
    });
});

bot.onText(/^\/myinfo$/, (msg) => {
    const userId   = msg.from?.id;
    const userData = stats.activeUsers.get(userId);
    const badge    = getUserBadge(userId);
    const warns    = userWarnings.get(userId) || 0;
    bot.sendMessage(msg.chat.id,
        `👤 *Thông tin tài khoản*\n\n` +
        `🆔 ID: \`${userId}\`\n` +
        `👤 Username: @${msg.from?.username || 'N/A'}\n` +
        `${badge ? `🏷️ Cấp bậc: ${badge} ${isAdmin(userId) ? 'Admin' : isVip(userId) ? 'VIP' : isPremium(userId) ? 'Premium' : 'User'}\n` : ''}` +
        `📥 Đã tải: ${userData?.count || 0} lần\n` +
        `${warns > 0 ? `⚠️ Cảnh cáo: ${warns}/3\n` : ''}` +
        `📅 Tham gia: ${userData?.joinedAt ? new Date(userData.joinedAt).toLocaleDateString('vi-VN') : 'N/A'}`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/^\/history$/, (msg) => {
    const userData = stats.activeUsers.get(msg.from?.id);
    if (!userData?.history?.length) { bot.sendMessage(msg.chat.id, '📭 Bạn chưa tải media nào.'); return; }
    let text = '📖 *Lịch sử tải (20 gần nhất):*\n\n';
    userData.history.forEach((item, i) => {
        const p     = PLATFORMS[item.platform];
        const short = item.url.length > 45 ? item.url.substring(0, 45) + '...' : item.url;
        text += `${i + 1}. ${p?.emoji || '🎬'} \`${short}\`\n   🕐 ${new Date(item.time).toLocaleString('vi-VN')}\n\n`;
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/^\/top$/, (msg) => {
    if (!stats.activeUsers.size) { bot.sendMessage(msg.chat.id, '📭 Chưa có dữ liệu.'); return; }
    const medals = ['👑','🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    const top    = Array.from(stats.activeUsers.entries())
        .sort((a, b) => Number(a[0]) === ADMIN_USER_ID ? -1 : Number(b[0]) === ADMIN_USER_ID ? 1 : b[1].count - a[1].count)
        .slice(0, 10);
    let text = '🏆 *Top 10 người dùng:*\n\n';
    top.forEach(([id, d], i) => {
        text += `${medals[i]} ${getUserBadge(Number(id))}@${d.username} — *${d.count}* lần\n`;
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/^\/report (.+)/, (msg, match) => {
    if (ADMIN_USER_ID) {
        bot.sendMessage(ADMIN_USER_ID,
            `📩 *Report từ @${msg.from?.username || msg.from?.first_name}* (ID: \`${msg.from?.id}\`):\n\n${match[1]}`,
            { parse_mode: 'Markdown' }
        );
        bot.sendMessage(msg.chat.id, '✅ Report đã được gửi tới Admin!');
    }
});

// ============================================================
// 👑 ADMIN COMMANDS
// ============================================================
const ADMIN_CMDS = [
    'stats','users','broadcast','ban','unban','warn','clearwarn','addvip','removevip',
    'vips','panel','setlimit','resetlimit','limits','maintenance','slowmode','clearslowmode',
    'premium','removepremium','premiums','caption','setmaxsize','botinfo','clearqueue','queue','announce'
];

bot.onText(/^\/(\w+)(?:\s(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const cmd    = match[1];
    const args   = match[2]?.trim() || '';

    if (!ADMIN_CMDS.includes(cmd)) return;
    if (!isAdmin(userId)) { bot.sendMessage(chatId, '❌ Bạn không có quyền dùng lệnh này.'); return; }

    switch (cmd) {
        case 'stats': case 'panel': {
            const rate = stats.totalRequests > 0 ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
            bot.sendMessage(chatId,
                `📊 *Stats Bot v${BOT_VERSION}*\n\n` +
                `📥 Requests: ${stats.totalRequests} | ✅ ${stats.successfulDownloads} (${rate}%)\n` +
                `👥 ${stats.activeUsers.size} users | ⭐ ${vipUsers.size} VIP | 💎 ${premiumUsers.size} Premium\n` +
                `🚫 ${bannedUsers.size} banned | 🔇 ${mutedUsers.size} muted\n` +
                `📋 Queue: ${requestQueue.length} | ⚙️ ${processingCount}/${MAX_CONCURRENT}\n` +
                `📅 Hôm nay: ${dailyStats.requests} req / ${dailyStats.downloads} tải\n` +
                `🔧 Bảo trì: ${maintenanceMode ? 'BẬT' : 'TẮT'}\n` +
                `✈️ Telegram MTProto: ${tgClient ? '✅' : '❌'}\n` +
                `⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🌐 Web Dashboard', url: DASHBOARD_URL }]] } }
            );
            break;
        }
        case 'botinfo': {
            bot.sendMessage(chatId,
                `🤖 *Nobita Bot v${BOT_VERSION}*\n\n` +
                `⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
                `💾 Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB\n` +
                `🎯 Platforms: ${Object.keys(PLATFORMS).length}\n` +
                `⚙️ Max concurrent: ${MAX_CONCURRENT}\n` +
                `📏 Max file (Bot API): ${BOT_UPLOAD_LIMIT_MB} MB\n` +
                `📏 Max file (MTProto): Không giới hạn\n` +
                `🚦 Rate limit: ${botSettings.defaultRateLimit}/10s\n` +
                `✈️ Telegram MTProto: ${tgClient ? '✅ Connected' : '❌ Not configured'}`,
                { parse_mode: 'Markdown' }
            );
            break;
        }
        case 'users': {
            if (!stats.activeUsers.size) { bot.sendMessage(chatId, '📭 Chưa có user.'); break; }
            let list = '👥 *Users (top 20):*\n\n';
            Array.from(stats.activeUsers.entries())
                .sort((a, b) => Number(a[0]) === ADMIN_USER_ID ? -1 : Number(b[0]) === ADMIN_USER_ID ? 1 : b[1].count - a[1].count)
                .slice(0, 20)
                .forEach(([id, d], i) => {
                    const fl = [getUserBadge(Number(id)), bannedUsers.has(Number(id)) ? '🚫' : '', mutedUsers.has(Number(id)) ? '🔇' : ''].join('');
                    list += `${i + 1}. ${fl}@${d.username} (\`${id}\`) — ${d.count}\n`;
                });
            bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
            break;
        }
        case 'broadcast': {
            if (!args) { bot.sendMessage(chatId, '❌ /broadcast <message>\nThêm "-vip" hoặc "-premium" để lọc'); break; }
            let target = 'all', msg2 = args;
            if (args.startsWith('-vip '))     { target = 'vip';     msg2 = args.slice(5); }
            if (args.startsWith('-premium ')) { target = 'premium'; msg2 = args.slice(9); }
            let targets = Array.from(stats.activeUsers.keys());
            if (target === 'vip')     targets = targets.filter(id => vipUsers.has(Number(id)));
            if (target === 'premium') targets = targets.filter(id => premiumUsers.has(Number(id)));
            let sent = 0, failed = 0;
            for (const uid of targets) {
                try { await bot.sendMessage(uid, `📢 *Thông báo Admin:*\n\n${msg2}`, { parse_mode: 'Markdown' }); sent++; }
                catch (_) { failed++; }
                await sleep(50);
            }
            bot.sendMessage(chatId, `✅ Broadcast (${target}): ${sent} OK, ${failed} lỗi`);
            break;
        }
        case 'announce': {
            if (!args) { bot.sendMessage(chatId, '❌ /announce <message>'); break; }
            let sent = 0;
            for (const [uid] of stats.activeUsers) {
                try { await bot.sendMessage(uid, `📌 *THÔNG BÁO QUAN TRỌNG*\n\n${args}`, { parse_mode: 'Markdown' }); sent++; }
                catch (_) {}
                await sleep(50);
            }
            bot.sendMessage(chatId, `📌 Đã gửi tới ${sent} users`);
            break;
        }
        case 'ban': {
            if (!args) { bot.sendMessage(chatId, '❌ /ban <user_id> [lý do]'); break; }
            const [idStr, ...rp] = args.split(' ');
            const uid    = parseInt(idStr);
            const reason = rp.join(' ') || 'Vi phạm quy định';
            if (uid === ADMIN_USER_ID) { bot.sendMessage(chatId, '❌ Không thể ban admin!'); break; }
            bannedUsers.add(uid); saveData();
            bot.sendMessage(uid, `🚫 Bạn đã bị ban.\n📝 Lý do: ${reason}`).catch(() => {});
            bot.sendMessage(chatId, `🚫 Đã ban ID: ${uid} — ${reason}`);
            addActivityLog('err', `🚫 Admin ban @${stats.activeUsers.get(uid)?.username || uid}`);
            break;
        }
        case 'unban': {
            if (!args) { bot.sendMessage(chatId, '❌ /unban <user_id>'); break; }
            const uid = parseInt(args);
            bannedUsers.delete(uid); userWarnings.delete(uid); saveData();
            bot.sendMessage(uid, '✅ Bạn đã được gỡ ban.').catch(() => {});
            bot.sendMessage(chatId, `✅ Đã unban ID: ${uid}`);
            break;
        }
        case 'warn': {
            const [idStr, ...rp] = args.split(' ');
            const uid    = parseInt(idStr);
            const reason = rp.join(' ') || 'Vi phạm quy định';
            if (!uid) { bot.sendMessage(chatId, '❌ /warn <user_id> [lý do]'); break; }
            const count  = (userWarnings.get(uid) || 0) + 1;
            userWarnings.set(uid, count); saveData();
            bot.sendMessage(uid, `⚠️ *Cảnh cáo #${count}/3:* ${reason}${count >= 3 ? '\n\n🚫 Bạn đã bị ban!' : ''}`, { parse_mode: 'Markdown' }).catch(() => {});
            if (count >= 3) { bannedUsers.add(uid); saveData(); }
            bot.sendMessage(chatId, `⚠️ Cảnh cáo ID: ${uid} (${count}/3)${count >= 3 ? ' → Auto-banned' : ''}`);
            break;
        }
        case 'clearwarn': {
            if (!args) { bot.sendMessage(chatId, '❌ /clearwarn <user_id>'); break; }
            userWarnings.delete(parseInt(args)); saveData();
            bot.sendMessage(chatId, `✅ Xóa cảnh cáo ID: ${args}`);
            break;
        }
        case 'addvip': {
            if (!args) { bot.sendMessage(chatId, '❌ /addvip <user_id>'); break; }
            const uid = parseInt(args);
            vipUsers.add(uid); premiumUsers.delete(uid); saveData();
            bot.sendMessage(uid, '🎉 *Chúc mừng!* Bạn đã được nâng cấp *VIP* ⭐', { parse_mode: 'Markdown' }).catch(() => {});
            bot.sendMessage(chatId, `⭐ Cấp VIP cho ID: ${uid}`);
            break;
        }
        case 'removevip': {
            if (!args) { bot.sendMessage(chatId, '❌ /removevip <user_id>'); break; }
            vipUsers.delete(parseInt(args)); saveData();
            bot.sendMessage(chatId, `✅ Xóa VIP ID: ${args}`);
            break;
        }
        case 'vips': {
            if (!vipUsers.size) { bot.sendMessage(chatId, '📭 Chưa có VIP.'); break; }
            let list = '⭐ *Danh sách VIP:*\n\n';
            Array.from(vipUsers).forEach((id, i) => {
                list += `${i + 1}. @${stats.activeUsers.get(id)?.username || 'Unknown'} (\`${id}\`)\n`;
            });
            bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
            break;
        }
        case 'premium': {
            if (!args) { bot.sendMessage(chatId, '❌ /premium <user_id>'); break; }
            const uid = parseInt(args);
            premiumUsers.add(uid); saveData();
            bot.sendMessage(uid, '💎 *Chúc mừng!* Bạn đã được nâng cấp *Premium* 💎', { parse_mode: 'Markdown' }).catch(() => {});
            bot.sendMessage(chatId, `💎 Cấp Premium cho ID: ${uid}`);
            break;
        }
        case 'removepremium': {
            if (!args) { bot.sendMessage(chatId, '❌ /removepremium <user_id>'); break; }
            premiumUsers.delete(parseInt(args)); saveData();
            bot.sendMessage(chatId, `✅ Xóa Premium ID: ${args}`);
            break;
        }
        case 'premiums': {
            if (!premiumUsers.size) { bot.sendMessage(chatId, '📭 Chưa có Premium.'); break; }
            let list = '💎 *Danh sách Premium:*\n\n';
            Array.from(premiumUsers).forEach((id, i) => {
                list += `${i + 1}. @${stats.activeUsers.get(id)?.username || 'Unknown'} (\`${id}\`)\n`;
            });
            bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
            break;
        }
        case 'setlimit': {
            const [idStr, limitStr] = args.split(' ');
            if (!idStr || !limitStr) { bot.sendMessage(chatId, '❌ /setlimit <user_id> <số>\n0 = block'); break; }
            userLimitOverrides.set(parseInt(idStr), parseInt(limitStr)); saveData();
            bot.sendMessage(chatId, parseInt(limitStr) === 0 ? `🚫 Chặn tải ID: ${idStr}` : `⚠️ Giới hạn ${limitStr}/10s cho ID: ${idStr}`);
            break;
        }
        case 'resetlimit': {
            if (!args) { bot.sendMessage(chatId, '❌ /resetlimit <user_id>'); break; }
            userLimitOverrides.delete(parseInt(args)); saveData();
            bot.sendMessage(chatId, `✅ Reset giới hạn ID: ${args}`);
            break;
        }
        case 'limits': {
            if (!userLimitOverrides.size) { bot.sendMessage(chatId, '📭 Không có giới hạn tùy chỉnh.'); break; }
            let list = '⚠️ *Giới hạn tùy chỉnh:*\n\n';
            userLimitOverrides.forEach((limit, id) => {
                list += `• @${stats.activeUsers.get(id)?.username || '?'} (\`${id}\`) → ${limit === 0 ? '🚫 CHẶN' : `${limit}/10s`}\n`;
            });
            bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
            break;
        }
        case 'slowmode': {
            const [idStr, secStr] = args.split(' ');
            if (!idStr || !secStr) { bot.sendMessage(chatId, '❌ /slowmode <user_id> <giây>'); break; }
            slowModeUsers.set(parseInt(idStr), parseInt(secStr) * 1000); saveData();
            bot.sendMessage(parseInt(idStr), `⏱️ Chế độ chậm: ${secStr}s/request.`).catch(() => {});
            bot.sendMessage(chatId, `⏱️ Slowmode ${secStr}s cho ID: ${idStr}`);
            break;
        }
        case 'clearslowmode': {
            if (!args) { bot.sendMessage(chatId, '❌ /clearslowmode <user_id>'); break; }
            slowModeUsers.delete(parseInt(args)); saveData();
            bot.sendMessage(chatId, `✅ Xóa slowmode ID: ${args}`);
            break;
        }
        case 'maintenance': {
            if (args === 'on' || args === 'off') {
                maintenanceMode = args === 'on'; saveData();
                bot.sendMessage(chatId, maintenanceMode ? '🔧 Bật bảo trì.' : '✅ Tắt bảo trì.');
                addActivityLog('warn', `🔧 Admin ${maintenanceMode ? 'bật' : 'tắt'} bảo trì`);
            } else {
                bot.sendMessage(chatId, `🔧 Bảo trì: *${maintenanceMode ? 'BẬT' : 'TẮT'}*\n\nDùng /maintenance on|off`, { parse_mode: 'Markdown' });
            }
            break;
        }
        case 'caption': {
            if (!args) { bot.sendMessage(chatId, `📝 Caption:\n${botSettings.captionText}`); break; }
            botSettings.captionText = args; saveData();
            bot.sendMessage(chatId, `✅ Caption mới:\n${args}`);
            break;
        }
        case 'setmaxsize': {
            const size = parseInt(args);
            if (!size || size < 1 || size > 2000) { bot.sendMessage(chatId, '❌ /setmaxsize <MB>'); break; }
            botSettings.maxFileSizeMB = size; saveData();
            bot.sendMessage(chatId, `✅ Max file: ${size} MB`);
            break;
        }
        case 'queue': {
            if (!requestQueue.length && !processingCount) { bot.sendMessage(chatId, '📭 Hàng đợi trống.'); break; }
            let info = `📋 *Hàng đợi:*\n\n⚙️ ${processingCount}/${MAX_CONCURRENT} xử lý\n📊 ${requestQueue.length} chờ\n\n`;
            requestQueue.slice(0, 8).forEach((r, i) => {
                info += `${i + 1}. ${getUserBadge(r.userId)}@${r.username} — ${PLATFORMS[r.platform]?.emoji || '🎬'} ${r.url.substring(0, 30)}...\n`;
            });
            bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
            break;
        }
        case 'clearqueue': {
            const n = requestQueue.length; requestQueue.length = 0;
            bot.sendMessage(chatId, `🗑️ Xóa ${n} request khỏi hàng đợi.`);
            break;
        }
    }
});

// ============================================================
// 🎵 CALLBACK QUERIES
// ============================================================
bot.on('callback_query', async (query) => {
    const data      = query.data;
    const chatId    = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data === 'help_main') {
        bot.answerCallbackQuery(query.id);
        await sendHelpMessage(chatId, query.from?.id);
        return;
    }

    if (data === 'show_status') {
        bot.answerCallbackQuery(query.id, { text: `✅ Bot v${BOT_VERSION} đang hoạt động` });
        return;
    }

    if (data.startsWith('mp3_')) {
        const info = getCacheWithTtl(mp3Cache, data.replace('mp3_', ''));
        if (!info) { bot.answerCallbackQuery(query.id, { text: '⚠️ Link đã hết hạn!', show_alert: true }); return; }
        bot.answerCallbackQuery(query.id, { text: '🎵 Đang trích xuất MP3...' });
        const proc = await bot.sendMessage(chatId, '⏳ Đang chuyển đổi MP3...');
        try {
            let mp3Url = null;
            if (info.platform === 'tiktok') {
                const res = await axios.post('https://www.tikwm.com/api/', { url: info.url }, { timeout: 10000 });
                if (res.data?.data?.music) mp3Url = res.data.data.music;
            }
            if (mp3Url) await bot.sendAudio(chatId, mp3Url, { reply_to_message_id: messageId });
            else bot.sendMessage(chatId, '❌ Không tìm thấy audio cho video này.');
        } catch (e) {
            bot.sendMessage(chatId, '❌ Lỗi trích xuất audio: ' + e.message);
        } finally {
            bot.deleteMessage(chatId, proc.message_id).catch(() => {});
        }
        return;
    }

    if (data.startsWith('slides_photos_')) {
        const info = getCacheWithTtl(slideshowCache, data.replace('slides_photos_', ''));
        if (!info) { bot.answerCallbackQuery(query.id, { text: '⚠️ Phiên đã hết hạn!', show_alert: true }); return; }
        bot.answerCallbackQuery(query.id, { text: '🖼️ Đang gửi ảnh...' });
        try {
            for (let i = 0; i < info.images.length; i += 10) {
                const batch = info.images.slice(i, i + 10).map(img => ({ type: 'photo', media: img }));
                await bot.sendMediaGroup(chatId, batch, { reply_to_message_id: messageId });
            }
        } catch (e) { bot.sendMessage(chatId, '❌ Lỗi gửi ảnh: ' + e.message); }
        return;
    }

    if (data.startsWith('slides_music_')) {
        const info = getCacheWithTtl(slideshowCache, data.replace('slides_music_', ''));
        if (!info) { bot.answerCallbackQuery(query.id, { text: '⚠️ Phiên đã hết hạn!', show_alert: true }); return; }
        bot.answerCallbackQuery(query.id, { text: '🎵 Đang gửi nhạc...' });
        try {
            if (info.music) await bot.sendAudio(chatId, info.music, { reply_to_message_id: messageId, caption: info.title });
            else bot.sendMessage(chatId, '❌ Không tìm thấy nhạc nền.');
        } catch (e) { bot.sendMessage(chatId, '❌ Lỗi gửi nhạc: ' + e.message); }
        return;
    }

    if (data.startsWith('quiz_')) {
        const parts   = data.split('_');
        const info    = getCacheWithTtl(quizCache, parts[1]);
        if (!info)    { bot.answerCallbackQuery(query.id, { text: '⏳ Quiz đã hết hạn!', show_alert: true }); return; }
        const correct = parseInt(parts[2]) === info.answer;
        bot.answerCallbackQuery(query.id, { text: correct ? '✅ Chính xác!' : '❌ Sai rồi!', show_alert: true });
        if (correct) maybeSendFun(chatId, '🎉 Đúng rồi! Bot tặng bạn một tràng vỗ tay 👏');
        return;
    }
});

// ============================================================
// 📨 MAIN MESSAGE HANDLER
// ============================================================
bot.on('message', async (msg) => {
    const chatId   = msg.chat.id;
    const text     = msg.text;
    const userId   = msg.from?.id;
    const username = msg.from?.username || msg.from?.first_name || 'unknown';

    if (!text) return;

    const detected = detectPlatform(text);

    if (detected) {
        const { platform, match: videoUrl } = detected;

        if (maintenanceMode && !isVip(userId) && !isAdmin(userId)) {
            bot.sendMessage(chatId, '🔧 *Bot đang bảo trì!* Vui lòng quay lại sau.', { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }).catch(() => {});
            return;
        }
        if (bannedUsers.has(userId)) { bot.sendMessage(chatId, '🚫 Bạn đã bị cấm sử dụng bot.').catch(() => {}); return; }
        if (!isAdmin(userId) && !checkRateLimit(userId)) {
            bot.sendMessage(chatId,
                slowModeUsers.has(userId)
                    ? `⏱️ Chế độ chậm đang bật. Vui lòng đợi giữa mỗi lần tải.`
                    : `⚠️ Gửi quá nhanh! Đợi ${botSettings.rateLimitWindow / 1000}s.\n💡 Nâng cấp VIP để không giới hạn!`,
                { reply_to_message_id: msg.message_id }
            ).catch(() => {});
            handleSuspiciousUser(userId, username);
            return;
        }

        stats.totalRequests++;
        updateUserStats(userId, username);

        const p = PLATFORMS[platform];
        console.log(`[${new Date().toISOString()}] ${p.emoji} ${platform.toUpperCase()} @${username}: ${videoUrl.substring(0, 60)}`);
        addActivityLog('ok', `📥 ${p.name} từ @${username}`);

        const item = {
            chatId, userId, username, url: videoUrl, platform,
            messageId: msg.message_id, timestamp: Date.now(),
            isVip: isVip(userId), isAdmin: isAdmin(userId), isPremium: isPremium(userId),
            retries: 0,
        };

        if (item.isAdmin) {
            requestQueue.unshift(item);
        } else if (item.isVip) {
            const i = requestQueue.findIndex(r => !r.isAdmin);
            requestQueue.splice(i === -1 ? requestQueue.length : i, 0, item);
        } else if (item.isPremium) {
            const i = requestQueue.findIndex(r => !r.isAdmin && !r.isVip);
            requestQueue.splice(i === -1 ? requestQueue.length : i, 0, item);
        } else {
            requestQueue.push(item);
        }

        const pos = requestQueue.indexOf(item) + 1;
        if (requestQueue.length > 1 || processingCount >= MAX_CONCURRENT) {
            const badge = item.isAdmin ? '👑 Admin' : item.isVip ? '⭐ VIP' : item.isPremium ? '💎 Premium' : '';
            bot.sendMessage(chatId, `📋 Hàng đợi #${pos}${badge ? ` — ${badge}` : ''}`, { reply_to_message_id: msg.message_id }).catch(() => {});
        }

        processQueue();
        return;
    }

    if (text.startsWith('/')) return;

    if (mutedUsers.has(userId) && !isAdmin(userId)) {
        bot.sendMessage(chatId, '🔇 Bạn đã bị khóa nhắn tin.').catch(() => {});
        return;
    }

    if (isAdmin(userId) && msg.reply_to_message) {
        const idMatch  = msg.reply_to_message.text?.match(/ID:\s*`?(\d+)`?/);
        const targetId = msg.reply_to_message.forward_from?.id || (idMatch ? parseInt(idMatch[1]) : null);
        if (targetId) {
            bot.sendMessage(targetId, `👨‍💻 *Admin:*\n${text}`, { parse_mode: 'Markdown' })
                .then(() => bot.sendMessage(chatId, '✅ Đã gửi!'))
                .catch(e => bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`));
            return;
        }
    }

    const lower = text.toLowerCase().trim();
    if (['help','hướng dẫn','trợ giúp','h','menu'].includes(lower)) {
        await sendHelpMessage(chatId, userId);
        return;
    }

    if (!isAdmin(userId) && ADMIN_USER_ID) {
        const who = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'user';
        bot.sendMessage(ADMIN_USER_ID,
            `📩 *Tin nhắn từ ${who}* (ID: \`${userId}\`):\n\n${text}`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }

    bot.sendChatAction(chatId, 'typing').catch(() => {});
    try {
        const aiResp = await getAIResponse(text, userId);
        const html   = aiResp
            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.*?)\*/g,     '<i>$1</i>')
            .replace(/`(.*?)`/g,       '<code>$1</code>');
        bot.sendMessage(chatId, html, { parse_mode: 'HTML', reply_to_message_id: msg.message_id })
            .catch(() => bot.sendMessage(chatId, aiResp, { reply_to_message_id: msg.message_id }));
    } catch (e) {
        console.error('[AI chat error]', e.message);
    }
});

// ============================================================
// 🌐 EXPRESS SERVER + DASHBOARD API
// ============================================================
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => res.json({
    status: 'ok', uptime: process.uptime(), version: BOT_VERSION,
    queue: requestQueue.length, processing: processingCount,
    telegramClient: !!tgClient,
}));

function getDashboardToken(req) {
    const auth = req.headers['authorization'] || '';
    return req.query.token || req.body?.token || req.headers['x-dashboard-token'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
}
function requireAdmin(req, res, next) {
    if (getDashboardToken(req) !== DASHBOARD_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
}
function parseId(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

app.get('/api/stats', requireAdmin, (req, res) => {
    const successRate = stats.totalRequests > 0 ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
    res.json({
        totalRequests: stats.totalRequests, successfulDownloads: stats.successfulDownloads,
        failedDownloads: stats.failedDownloads, successRate, totalUsers: stats.activeUsers.size,
        vipUsers: vipUsers.size, premiumUsers: premiumUsers.size, bannedUsers: bannedUsers.size,
        mutedUsers: mutedUsers.size, queueLength: requestQueue.length, processing: processingCount,
        maxConcurrent: MAX_CONCURRENT, hourlyStats, dailyStats, maintenanceMode,
        uptime: process.uptime(), version: BOT_VERSION, activityLogs,
        telegramClient: !!tgClient,
    });
});

app.get('/api/users', requireAdmin, (req, res) => {
    const users = Array.from(stats.activeUsers.entries()).map(([id, d]) => ({
        id, ...d,
        isVip: vipUsers.has(Number(id)), isPremium: premiumUsers.has(Number(id)),
        isBanned: bannedUsers.has(Number(id)), isMuted: mutedUsers.has(Number(id)),
        warnings: userWarnings.get(Number(id)) || 0,
        rateLimit: userLimitOverrides.has(Number(id)) ? userLimitOverrides.get(Number(id)) : null,
    }));
    res.json(users.sort((a, b) => b.count - a.count));
});

async function broadcastMessage(message, target, title) {
    let sent = 0, failed = 0;
    let targets = Array.from(stats.activeUsers.keys());
    if (target === 'vip')     targets = targets.filter(id => vipUsers.has(Number(id)));
    if (target === 'premium') targets = targets.filter(id => premiumUsers.has(Number(id)));
    const prefix = title ? `${title}\n\n` : '';
    for (const uid of targets) {
        try { await bot.sendMessage(uid, `${prefix}${message}`, { parse_mode: 'Markdown' }); sent++; }
        catch (_) { failed++; }
        await sleep(50);
    }
    return { sent, failed };
}

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
    const { message, target } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'No message' });
    res.json({ success: true });
    const r = await broadcastMessage(message, target, '📢 *Thông báo từ Admin:*');
    if (ADMIN_USER_ID) bot.sendMessage(ADMIN_USER_ID, `✅ Broadcast: ${r.sent} OK, ${r.failed} lỗi`).catch(() => {});
});

app.post('/api/admin/announce', requireAdmin, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'No message' });
    res.json({ success: true });
    const r = await broadcastMessage(message, 'all', '📌 *THÔNG BÁO QUAN TRỌNG*');
    if (ADMIN_USER_ID) bot.sendMessage(ADMIN_USER_ID, `📌 Announce: ${r.sent} OK, ${r.failed} lỗi`).catch(() => {});
});

app.post('/api/admin/dm', requireAdmin, async (req, res) => {
    try { await bot.sendMessage(parseInt(req.body.userId), `👨‍💻 *Admin:*\n${req.body.message}`, { parse_mode: 'Markdown' }); res.json({ success: true }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/admin/ban', requireAdmin, (req, res) => {
    const uid = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    if (uid === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'Cannot ban admin' });
    bannedUsers.add(uid); saveData();
    bot.sendMessage(uid, '🚫 Bạn đã bị cấm sử dụng bot.').catch(() => {});
    addActivityLog('err', `🚫 Admin ban ID: ${uid}`);
    res.json({ success: true });
});

app.post('/api/admin/unban', requireAdmin, (req, res) => {
    const uid = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    bannedUsers.delete(uid); saveData(); res.json({ success: true });
});

app.post('/api/admin/mute', requireAdmin, (req, res) => {
    const uid = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    mutedUsers.add(uid); saveData();
    bot.sendMessage(uid, '🔇 Bạn đã bị cấm nhắn tin.').catch(() => {});
    res.json({ success: true });
});

app.post('/api/admin/unmute', requireAdmin, (req, res) => {
    const uid = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    mutedUsers.delete(uid); saveData();
    bot.sendMessage(uid, '🔊 Bạn đã được mở khóa nhắn tin.').catch(() => {});
    res.json({ success: true });
});

app.post('/api/admin/vip', requireAdmin, (req, res) => {
    const uid  = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    const user = stats.activeUsers.get(uid)?.username || uid;
    if (req.body.action === 'add') {
        vipUsers.add(uid);
        bot.sendMessage(uid, '🎉 *Chúc mừng!* Bạn đã được nâng cấp *VIP*!', { parse_mode: 'Markdown' }).catch(() => {});
        addActivityLog('ok', `⭐ Admin cấp VIP @${user}`);
    } else {
        vipUsers.delete(uid);
        addActivityLog('warn', `⭐ Admin xóa VIP @${user}`);
    }
    saveData(); res.json({ success: true });
});

app.post('/api/admin/premium', requireAdmin, (req, res) => {
    const uid  = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    const user = stats.activeUsers.get(uid)?.username || uid;
    if (!req.body.action || req.body.action === 'add') {
        premiumUsers.add(uid);
        bot.sendMessage(uid, '💎 *Chúc mừng!* Bạn đã được nâng cấp *Premium*!', { parse_mode: 'Markdown' }).catch(() => {});
        addActivityLog('ok', `💎 Admin cấp Premium @${user}`);
    } else {
        premiumUsers.delete(uid);
        addActivityLog('warn', `💎 Admin xóa Premium @${user}`);
    }
    saveData(); res.json({ success: true });
});

app.post('/api/admin/setlimit', requireAdmin, (req, res) => {
    const uid = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    userLimitOverrides.set(uid, parseInt(req.body.limit) || 0); saveData(); res.json({ success: true });
});

app.post('/api/admin/resetlimit', requireAdmin, (req, res) => {
    const uid = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    userLimitOverrides.delete(uid); saveData(); res.json({ success: true });
});

app.post('/api/admin/maintenance', requireAdmin, async (req, res) => {
    maintenanceMode = req.body.status === 'on'; saveData();
    res.json({ success: true, maintenanceMode });
    const msgText = maintenanceMode ? '🔧 *Bot đang bảo trì.*' : '✅ *Bot đã hoạt động trở lại!*';
    for (const [uid] of stats.activeUsers) {
        try { await bot.sendMessage(uid, msgText, { parse_mode: 'Markdown' }); await sleep(50); } catch (_) {}
    }
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
    if (req.body.maintenanceMode !== undefined) { maintenanceMode = req.body.maintenanceMode === true; delete req.body.maintenanceMode; }
    botSettings = { ...botSettings, ...req.body }; saveData();
    res.json({ success: true, botSettings });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(botSettings));

app.post('/api/admin/resetstats', requireAdmin, (req, res) => {
    stats.totalRequests = 0; stats.successfulDownloads = 0; stats.failedDownloads = 0;
    hourlyStats = new Array(24).fill(0); dailyStats = { date: new Date().toDateString(), requests: 0, downloads: 0 };
    addActivityLog('warn', '🗑️ Admin reset thống kê'); saveData(); res.json({ success: true });
});

app.post('/api/admin/clearmp3', requireAdmin, (req, res) => {
    mp3Cache.clear(); addActivityLog('warn', '🗑️ Admin xóa MP3 cache'); res.json({ success: true });
});

app.post('/api/admin/clearqueue', requireAdmin, (req, res) => {
    const n = requestQueue.length; requestQueue.length = 0;
    addActivityLog('warn', `🗑️ Admin xóa queue (${n} items)`); res.json({ success: true, cleared: n });
});

app.post('/api/admin/warn', requireAdmin, async (req, res) => {
    const uid = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    const count = (userWarnings.get(uid) || 0) + 1;
    userWarnings.set(uid, count); saveData();
    await bot.sendMessage(uid,
        `⚠️ *Cảnh cáo #${count}:* ${req.body.reason || 'Vi phạm'}\n\n${count >= 3 ? '🚫 Bạn đã bị ban!' : `(${count}/3)`}`,
        { parse_mode: 'Markdown' }
    ).catch(() => {});
    if (count >= 3) { bannedUsers.add(uid); saveData(); }
    res.json({ success: true, warnings: count, autoBanned: count >= 3 });
});

app.post('/api/admin/clearwarnings', requireAdmin, (req, res) => {
    const uid = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    userWarnings.delete(uid); saveData(); res.json({ success: true });
});

app.post('/api/admin/slowmode', requireAdmin, (req, res) => {
    const uid = parseId(req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    slowModeUsers.set(uid, parseInt(req.body.delay) || 30000); saveData();
    bot.sendMessage(uid, `⏱️ Chế độ chậm đang bật.`).catch(() => {});
    res.json({ success: true });
});

app.delete('/api/admin/slowmode/:userId', requireAdmin, (req, res) => {
    const uid = parseId(req.params.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid userId' });
    slowModeUsers.delete(uid); saveData(); res.json({ success: true });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=nobita_export.json');
    res.json({
        exportTime: new Date().toISOString(),
        stats: { totalRequests: stats.totalRequests, successfulDownloads: stats.successfulDownloads, failedDownloads: stats.failedDownloads },
        users: Array.from(stats.activeUsers.entries()).map(([id, d]) => ({ id, ...d, isVip: vipUsers.has(Number(id)), isPremium: premiumUsers.has(Number(id)) })),
    });
});

app.post('/api/admin/import', requireAdmin, (req, res) => {
    try {
        const payload = req.body.data;
        if (!payload?.stats) return res.status(400).json({ success: false, error: 'Sai định dạng' });
        fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
        loadData(); addActivityLog('warn', '📥 Admin import backup'); res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/stats/activity', requireAdmin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    res.json({ success: true, data: activityLogs.slice(0, limit) });
});

app.get('/api/stats/platforms', requireAdmin, (req, res) => {
    const platforms = Object.keys(PLATFORMS).map(key => {
        const s     = platformStats[key] || { ok: 0, fail: 0 };
        const total = s.ok + s.fail;
        return {
            key, name: PLATFORMS[key].name, emoji: PLATFORMS[key].emoji,
            ok: s.ok, fail: s.fail, total,
            successRate: total > 0 ? Math.round((s.ok / total) * 100) : 0,
        };
    }).sort((a, b) => b.total - a.total);
    res.json({ success: true, platforms });
});

app.get('/api/stats/leaderboard', requireAdmin, (req, res) => {
    const all = Array.from(stats.activeUsers.entries()).map(([id, d]) => ({
        id: Number(id), username: d.username, count: d.count,
        badge: getUserBadge(Number(id)), level: Math.floor(Math.sqrt(d.count)) || 1,
    })).sort((a, b) => b.count - a.count);
    res.json({ success: true, global: all.slice(0, 20) });
});

app.get('/api/system/health', requireAdmin, (req, res) => {
    const mem   = process.memoryUsage();
    const total = os.totalmem(), free = os.freemem(), used = total - free;
    res.json({
        usedMemoryPct: total > 0 ? Math.round((used / total) * 100) : 0,
        heapUsedMB:    Math.round(mem.heapUsed  / 1024 / 1024),
        heapTotalMB:   Math.round(mem.heapTotal / 1024 / 1024),
        rssMB:         Math.round(mem.rss       / 1024 / 1024),
        totalMemoryMB: Math.round(total / 1024 / 1024),
        freeMemoryMB:  Math.round(free  / 1024 / 1024),
        loadAvg1m:     os.loadavg()[0],
        cpuCount:      os.cpus().length,
        cpuModel:      os.cpus()[0]?.model || 'Unknown',
        hostname:      os.hostname(), platform: os.platform(), arch: os.arch(),
        nodeVersion:   process.version, uptime: process.uptime(), version: BOT_VERSION,
        telegramClient: !!tgClient,
    });
});

app.get('/api/user/:userId/details', requireAdmin, (req, res) => {
    const uid = Number(req.params.userId);
    const u   = stats.activeUsers.get(uid);
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({
        id: uid, username: u.username, count: u.count, joinedAt: u.joinedAt, lastUsed: u.lastUsed,
        isVip: vipUsers.has(uid), isPremium: premiumUsers.has(uid),
        isBanned: bannedUsers.has(uid), isMuted: mutedUsers.has(uid),
        warnings: userWarnings.get(uid) || 0, badge: getUserBadge(uid),
        level: Math.floor(Math.sqrt(u.count)) || 1, history: u.history || [],
    });
});

app.get('/api/broadcast/scheduled', requireAdmin, (req, res) => {
    res.json(Array.from(scheduledBroadcasts.values()).sort((a, b) => a.at - b.at));
});

app.post('/api/broadcast/schedule', requireAdmin, (req, res) => {
    const at   = Number(req.body.at), text = String(req.body.text || '').trim();
    if (!at || !text) return res.status(400).json({ success: false, error: 'Invalid payload' });
    const id   = Math.random().toString(36).slice(2, 10);
    scheduledBroadcasts.set(id, { id, at, text, sent: false });
    addActivityLog('warn', `🗓️ Scheduled broadcast (${new Date(at).toLocaleString('vi-VN')})`);
    res.json({ success: true, id });
});

app.delete('/api/broadcast/schedule/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    if (!scheduledBroadcasts.has(id)) return res.status(404).json({ success: false });
    scheduledBroadcasts.delete(id); res.json({ success: true });
});

app.get('/api/logs/stream', requireAdmin, (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();
    const sendLog = (log) => res.write(`data: ${JSON.stringify(log)}\n\n`);
    activityLogs.slice().reverse().forEach(sendLog);
    activityEmitter.on('log', sendLog);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30000);
    req.on('close', () => { activityEmitter.off('log', sendLog); clearInterval(keepalive); });
});

app.get('/dashboard', (req, res) => {
    if (req.query.token !== DASHBOARD_TOKEN) return res.status(401).send('<h1>401 Unauthorized</h1>');
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ============================================================
// 🔄 SCHEDULED TASKS
// ============================================================

setInterval(async () => {
    const now = Date.now();
    for (const item of scheduledBroadcasts.values()) {
        if (item.sent || item.at > now) continue;
        item.sent = true;
        addActivityLog('warn', `📢 Sending scheduled broadcast #${item.id}`);
        const r = await broadcastMessage(item.text, 'all', '📢 *THÔNG BÁO TỰ ĐỘNG*');
        if (ADMIN_USER_ID) bot.sendMessage(ADMIN_USER_ID, `📅 Broadcast hẹn giờ: ${r.sent} OK, ${r.failed} lỗi`).catch(() => {});
    }
}, SCHEDULE_POLL);

setInterval(() => {
    cleanupCache(mp3Cache);
    cleanupCache(slideshowCache);
    cleanupCache(quizCache);
    if (conversationHistory.size > 200) {
        const keys = Array.from(conversationHistory.keys());
        keys.slice(0, keys.length - 200).forEach(k => conversationHistory.delete(k));
    }
}, 10 * 60 * 1000);

function cleanupTempFiles() {
    let deleted = 0;
    try {
        fs.readdirSync(__dirname).forEach(file => {
            if ((file.startsWith('temp_') || file.startsWith('yt_') || file.startsWith('sc_') || file.startsWith('tg_') || file.startsWith('img_') || file.startsWith('pin_'))
                && (file.endsWith('.mp4') || file.endsWith('.mp3') || file.endsWith('.jpg') || file.endsWith('.webp'))) {
                const fp = path.join(__dirname, file);
                try {
                    if ((Date.now() - fs.statSync(fp).mtimeMs) > 600000) { fs.unlinkSync(fp); deleted++; }
                } catch (_) {}
            }
        });
    } catch (_) {}
    if (deleted > 0) {
        console.log(`[Cleanup] Deleted ${deleted} temp files`);
        if (ADMIN_USER_ID) bot.sendMessage(ADMIN_USER_ID, `🗑️ Auto-cleanup: ${deleted} file tạm`).catch(() => {});
    }
}
cleanupTempFiles();
setInterval(cleanupTempFiles, 6 * 60 * 60 * 1000);

function scheduleMidnightReport() {
    const now      = new Date();
    const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
    setTimeout(function tick() {
        const rate = stats.totalRequests > 0 ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
        const top  = Array.from(stats.activeUsers.entries()).sort((a, b) => Number(a[0]) === ADMIN_USER_ID ? -1 : b[1].count - a[1].count)[0];
        if (ADMIN_USER_ID) {
            bot.sendMessage(ADMIN_USER_ID,
                `📊 *Báo cáo ${new Date().toLocaleDateString('vi-VN')}*\n\n` +
                `📥 Tổng: ${stats.totalRequests} | ✅ ${stats.successfulDownloads} (${rate}%)\n` +
                `📅 Hôm nay: ${dailyStats.requests} req / ${dailyStats.downloads} tải\n` +
                `👥 Users: ${stats.activeUsers.size} | ⭐ VIP: ${vipUsers.size} | 💎 Premium: ${premiumUsers.size}\n` +
                `🏆 Top: @${top?.[1]?.username || 'N/A'} (${top?.[1]?.count || 0} lần)`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
        hourlyStats = new Array(24).fill(0);
        dailyStats  = { date: new Date().toDateString(), requests: 0, downloads: 0 };
        saveData();
        setTimeout(tick, 24 * 60 * 60 * 1000);
    }, midnight - now);
}
scheduleMidnightReport();

// ============================================================
// ⚡ AUTO-CONVERSATION
// ============================================================
// ===============================
// CHAT BOT MODE - KHÔNG AUTO CHAT
// ===============================

const CHATBOT_ENABLED = process.env.CHATBOT_ENABLED !== 'false';

const BOT_REPLY_MESSAGES = [
    '👋 Chào bạn! Gửi link video bạn muốn tải nhé.',
    '🎬 Mình hỗ trợ tải video TikTok, Facebook, Instagram, YouTube...',
    '😊 Bạn gửi link vào đây, mình sẽ xử lý giúp bạn.',
    '✨ Mình có thể hỗ trợ tải video không watermark nếu link được hỗ trợ.',
];

if (CHATBOT_ENABLED) {
    bot.on('message', async (msg) => {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from?.id;
            const text = msg.text || '';

            // Bỏ qua user bị ban / mute
            if (bannedUsers.has(Number(userId)) || mutedUsers.has(Number(userId))) {
                return;
            }

            // Bỏ qua tin nhắn không có text
            if (!text) return;

            // Nếu người dùng gửi command thì không trả lời linh tinh
            if (text.startsWith('/')) return;

            // Nếu người dùng gửi link
            if (/https?:\/\//i.test(text)) {
                await bot.sendMessage(chatId, '✅ Mình đã nhận được link, đang kiểm tra và xử lý cho bạn...');
                return;
            }

            // Tin nhắn thường
            await bot.sendMessage(chatId, pickRandom(BOT_REPLY_MESSAGES));

        } catch (err) {
            console.error('Chatbot reply error:', err.message);
        }
    });

    console.log('✅ Chatbot mode enabled - bot chỉ trả lời khi user nhắn');
}
// ============================================================
// 🛑 ERROR HANDLERS
// ============================================================
bot.on('polling_error', err => console.error('[Polling]', err.message));
bot.on('webhook_error', err => console.error('[Webhook]', err.message));
process.on('unhandledRejection', err => console.error('[Unhandled]', err?.message || err));
process.on('uncaughtException',  err => { console.error('[Uncaught]', err?.message || err); });

console.log(`🚀 Nobita Bot v${BOT_VERSION} is running!`);
console.log(`👑 Admin ID:    ${ADMIN_USER_ID}`);
console.log(`🌐 Platforms:   ${Object.keys(PLATFORMS).join(', ')}`);
console.log(`✈️  Telegram:    ${tgClient ? 'Client ready (hỗ trợ file lớn qua MTProto)' : 'Not configured'}`);
console.log(`🔗 Dashboard:   ${DASHBOARD_URL}`);
