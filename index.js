require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Initialize Bot
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN is not defined in .env');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// Admin Configuration
const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '0');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_REQUESTS || '3');
// URL công khai (Render tự cung cấp RENDER_EXTERNAL_URL)
const BOT_URL = process.env.RENDER_EXTERNAL_URL || process.env.BOT_URL || 'http://localhost:3000';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'nobita_admin';
const DASHBOARD_URL = `${BOT_URL}/dashboard?token=${DASHBOARD_TOKEN}`;

// Queue System
const requestQueue = [];
let processingCount = 0;

// Data Persistence
const DATA_FILE = path.join(__dirname, 'data.json');

let stats = {
    totalRequests: 0,
    successfulDownloads: 0,
    failedDownloads: 0,
    activeUsers: new Map(), // userId -> {username, count, lastUsed}
};

// Banned Users
let bannedUsers = new Set();

// Muted Users
let mutedUsers = new Set();

// VIP Users
let vipUsers = new Set();

// Cache for MP3 downloads
const mp3Cache = new Map();


// Per-user rate limit overrides: userId -> maxRequests
let userLimitOverrides = new Map();

// Hourly stats for dashboard (24 slots)
let hourlyStats = new Array(24).fill(0);

// Maintenance mode
let maintenanceMode = false;

// Load data on startup
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (data.stats) {
                stats.totalRequests = data.stats.totalRequests || 0;
                stats.successfulDownloads = data.stats.successfulDownloads || 0;
                stats.failedDownloads = data.stats.failedDownloads || 0;
                if (data.stats.activeUsers) {
                    stats.activeUsers = new Map(data.stats.activeUsers);
                }
            }
            if (data.bannedUsers) {
                bannedUsers = new Set(data.bannedUsers);
            }
            if (data.mutedUsers) {
                mutedUsers = new Set(data.mutedUsers);
            }
            if (data.vipUsers) {
                vipUsers = new Set(data.vipUsers);
            }
            if (data.userLimitOverrides) {
                userLimitOverrides = new Map(data.userLimitOverrides);
            }
            if (data.hourlyStats) {
                hourlyStats = data.hourlyStats;
            }
            console.log('✅ Loaded saved data.');
        }
    } catch (e) {
        console.error('Error loading data:', e.message);
    }
}

function saveData() {
    try {
        const dataToSave = {
            stats: {
                totalRequests: stats.totalRequests,
                successfulDownloads: stats.successfulDownloads,
                failedDownloads: stats.failedDownloads,
                activeUsers: Array.from(stats.activeUsers.entries())
            },
            bannedUsers: Array.from(bannedUsers),
            mutedUsers: Array.from(mutedUsers),
            vipUsers: Array.from(vipUsers),
            userLimitOverrides: Array.from(userLimitOverrides.entries()),
            hourlyStats
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (e) {
        console.error('Error saving data:', e.message);
    }
}

loadData();

// --- Server for Render/Heroku (Keep Alive + Dashboard) ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Enable JSON parsing for API requests
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

// API endpoint for stats (secured by token)
app.get('/api/stats', (req, res) => {
    const token = req.query.token;
    if (!process.env.DASHBOARD_TOKEN || token !== process.env.DASHBOARD_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const successRate = stats.totalRequests > 0
        ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1)
        : 0;
    res.json({
        totalRequests: stats.totalRequests,
        successfulDownloads: stats.successfulDownloads,
        failedDownloads: stats.failedDownloads,
        successRate,
        totalUsers: stats.activeUsers.size,
        vipUsers: vipUsers.size,
        bannedUsers: bannedUsers.size,
        mutedUsers: mutedUsers.size,
        queueLength: requestQueue.length,
        processing: processingCount,
        maxConcurrent: MAX_CONCURRENT,
        hourlyStats,
        maintenanceMode
    });
});

// Middleware to check admin token
function requireAdminToken(req, res, next) {
    const token = req.query.token || req.body.token;
    if (!process.env.DASHBOARD_TOKEN || token !== process.env.DASHBOARD_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized', success: false });
    }
    next();
}

// Management APIs
app.post('/api/admin/broadcast', requireAdminToken, async (req, res) => {
    const message = req.body.message;
    if (!message) return res.status(400).json({ success: false, error: 'No message provided' });
    let sent = 0;
    res.json({ success: true, message: 'Đang tiến hành gửi broadcast...' });
    
    // Process asynchronously with a small delay to avoid hitting Telegram rate limits (429)
    for (const [uid] of stats.activeUsers) {
        try {
            await bot.sendMessage(uid, `📢 *Thông báo từ Admin:*\n\n${message}`, { parse_mode: 'Markdown' });
            sent++;
            await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay
        } catch (e) {
            console.error(`Failed to broadcast to ${uid}:`, e.message);
        }
    }
    console.log(`Broadcast completed. Sent to ${sent} users.`);
});

app.post('/api/admin/dm', requireAdminToken, async (req, res) => {
    const { userId, message } = req.body;
    if (!userId || !message) return res.status(400).json({ success: false, error: 'Missing parameters' });
    try {
        await bot.sendMessage(parseInt(userId), `👨‍💻 *Admin:*\n${message}`, { parse_mode: 'Markdown' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/ban', requireAdminToken, async (req, res) => {
    const { userId } = req.body;
    const uid = parseInt(userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid user id' });
    if (uid === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'Cannot ban admin' });
    bannedUsers.add(uid);
    saveData();
    res.json({ success: true });
});

app.post('/api/admin/unban', requireAdminToken, async (req, res) => {
    const { userId } = req.body;
    bannedUsers.delete(parseInt(userId));
    saveData();
    res.json({ success: true });
});

app.post('/api/admin/mute', requireAdminToken, async (req, res) => {
    const { userId } = req.body;
    const uid = parseInt(userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid user id' });
    if (uid === ADMIN_USER_ID) return res.status(400).json({ success: false, error: 'Cannot mute admin' });
    mutedUsers.add(uid);
    saveData();
    bot.sendMessage(uid, '🔇 Bạn đã bị cấm nhắn tin với Admin.').catch(()=>{});
    res.json({ success: true, message: `Thành công cấm chat ID: ${uid}` });
});

app.post('/api/admin/unmute', requireAdminToken, async (req, res) => {
    const { userId } = req.body;
    const uid = parseInt(userId);
    mutedUsers.delete(uid);
    saveData();
    bot.sendMessage(uid, '🔊 Bạn đã được mở khoá nhắn tin với Admin.').catch(()=>{});
    res.json({ success: true, message: `Thành công mở khoá chat ID: ${uid}` });
});

app.post('/api/admin/vip', requireAdminToken, async (req, res) => {
    const { userId, action } = req.body;
    const uid = parseInt(userId);
    if (!uid) return res.status(400).json({ success: false, error: 'Invalid user id' });
    if (action === 'add') {
        vipUsers.add(uid);
        bot.sendMessage(uid, '🎉 *Chúc mừng!* Bạn đã được nâng cấp lên *VIP*!\n\n⭐ Quyền lợi VIP:\n• Không giới hạn tốc độ.\n• Ưu tiên tải nhanh nhất.', { parse_mode: 'Markdown' }).catch(()=>{});
    } else {
        vipUsers.delete(uid);
        bot.sendMessage(uid, '⚠️ *Thông báo:* Quyền VIP của bạn đã bị thu hồi.', { parse_mode: 'Markdown' }).catch(()=>{});
    }
    saveData();
    res.json({ success: true });
});

app.post('/api/admin/maintenance', requireAdminToken, async (req, res) => {
    const { status } = req.body;
    maintenanceMode = status === 'on';
    res.json({ success: true, maintenanceMode });

    // Asynchronously notify all users about the maintenance status
    const message = maintenanceMode 
        ? "🔧 *Thông báo hệ thống:*\n\nBot hiện đang bảo trì hoặc tiến hành nâng cấp. Các tính năng tải video tạm thời bị ngưng. Vui lòng quay lại sau nhé! Xin lỗi bạn vì sự bất tiện."
        : "✅ *Thông báo hệ thống:*\n\nQuá trình bảo trì đã hoàn tất! Bot đã hoạt động ổn định và trơn tru trở lại, mời bạn tiếp tục sử dụng.";
        
    // Send to all active users with a 50ms delay buffer
    for (const [uid] of stats.activeUsers) {
        try {
            await bot.sendMessage(uid, message, { parse_mode: 'Markdown' });
            await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay protect
        } catch (e) {
            console.error(`Failed to notify maintenance update to ${uid}:`, e.message);
        }
    }
});

// Serve dashboard HTML
app.get('/dashboard', (req, res) => {
    const token = req.query.token;
    if (!process.env.DASHBOARD_TOKEN || token !== process.env.DASHBOARD_TOKEN) {
        return res.status(401).send('<h1>401 Unauthorized</h1><p>Thêm ?token=YOUR_TOKEN vào URL</p>');
    }
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Admin User ID: ${ADMIN_USER_ID}`);
});
// ---------------------------------------------

console.log('Bot is running...');

// Rate limiting to prevent spam
const userRateLimits = new Map();
const RATE_LIMIT_WINDOW = 10000; // 10 seconds
const MAX_REQUESTS_PER_WINDOW = 3;

function checkRateLimit(userId) {
    const now = Date.now();
    // Get this user's custom limit (or global default)
    const maxReqs = userLimitOverrides.has(userId)
        ? userLimitOverrides.get(userId)
        : MAX_REQUESTS_PER_WINDOW;

    // Limit 0 = soft-block: user cannot download anything
    if (maxReqs === 0) return false;

    const userLimits = userRateLimits.get(userId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

    if (now > userLimits.resetTime) {
        userRateLimits.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return true;
    }

    if (userLimits.count >= maxReqs) {
        return false;
    }

    userLimits.count++;
    userRateLimits.set(userId, userLimits);
    return true;
}

// Expanded regex to detect TikTok and Douyin links - covers more formats
const tiktokRegex = /(?:https?:\/\/)?(?:(?:www|vt|vm|m|t|v)\.)?(?:tiktok\.com|douyin\.com)\/(?:@[\w.-]+\/video\/\d+|v\/\d+|[\w-]+|share\/video\/\d+)|(?:https?:\/\/)?(?:vm|vt|v)\.(?:tiktok\.com|douyin\.com)\/[\w]+/i;

// Regex to detect Facebook video links (including share/v/ format)
const facebookRegex = /(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.com)\/(?:[\w.-]+\/videos\/[\d]+|watch[\/?].*v=[\d]+|video\.php\?v=[\d]+|reel\/[\w]+|share\/v\/[\w]+|share\/r\/[\w]+|[\w.-]+\/posts\/[\w]+)|(?:https?:\/\/)?fb\.watch\/[\w]+/i;

// Regex to detect YouTube links (Shorts & regular)
const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)[\w-]+/i;

// Regex to detect Instagram links (Reels/Post)
const instagramRegex = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p)\/[\w-]+/i;

// Helper: Check if user is admin
function isAdmin(userId) {
    return userId === ADMIN_USER_ID;
}

// Helper: Check if user is VIP
function isVip(userId) {
    return vipUsers.has(userId);
}

// Helper: Update user stats
function updateUserStats(userId, username) {
    if (!stats.activeUsers.has(userId)) {
        stats.activeUsers.set(userId, {
            username: username || 'Unknown',
            count: 0,
            lastUsed: Date.now(),
            history: []
        });
    }
    const user = stats.activeUsers.get(userId);
    user.count++;
    user.lastUsed = Date.now();
    user.username = username || user.username;
    // Track hourly stats
    const hour = new Date().getHours();
    hourlyStats[hour] = (hourlyStats[hour] || 0) + 1;
    saveData();
}

// Helper: Record a download in user history
function recordHistory(userId, videoUrl, platform) {
    const user = stats.activeUsers.get(userId);
    if (!user) return;
    if (!user.history) user.history = [];
    user.history.unshift({ url: videoUrl, platform, time: Date.now() });
    if (user.history.length > 10) user.history = user.history.slice(0, 10);
    saveData();
}

// Admin Commands Handler
bot.onText(/^\/(\w+)(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const command = match[1];
    const args = match[2]?.trim();

    // Check if command is admin-only
    const adminCommands = ['stats', 'users', 'broadcast', 'ban', 'unban', 'queue', 'addvip', 'removevip', 'vips', 'panel', 'setlimit', 'resetlimit', 'limits', 'top', 'maintenance'];
    if (adminCommands.includes(command) && !isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Bạn không có quyền sử dụng lệnh này.');
        return;
    }

    switch (command) {
        case 'start':
            bot.sendMessage(chatId,
                '👋 Chào mừng đến với Nobita Bot!\n\n' +
                (maintenanceMode ? '⚠️ *Bot đang bảo trì!* Chức năng tải video tạm thời ngưng.\n\n' : '') +
                '📹 Gửi link để tải video (Không logo/Watermark):\n' +
                '  🎵 TikTok / Douyin\n' +
                '  🐙 Facebook (Reels, Watch, Post...)\n' +
                '  ▶️ YouTube Shorts\n' +
                '  📸 Instagram Reels\n\n' +
                '💡 Gõ /help để xem danh sách lệnh đầy đủ.\n' +
                (isVip(userId) ? '⭐ Bạn là thành viên VIP - ưu tiên cao nhất!\n' : ''),
                isAdmin(userId) ? {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🖥️ MỞ ADMIN DASHBOARD', url: DASHBOARD_URL }
                        ]]
                    }
                } : {}
            );
            break;

        case 'help':
            bot.sendMessage(chatId,
                '📖 *Danh sách lệnh:*\n\n' +
                '• /start - Khởi động bot\n' +
                '• /help - Xem hướng dẫn này\n' +
                '• /ping - Xem tốc độ phản hồi\n' +
                '• /report <lỗi> - Gửi lỗi/góp ý cho Admin\n' +
                '• /history - Xem lịch sử tải của bạn\n' +
                '• /top - Xem TOP người dùng\n\n' +
                '💡 Mẹo: Ở mỗi video tải xong, sẽ có nút [🎵 Tải MP3] để lấy audio.',
                { parse_mode: 'Markdown' }
            );
            break;

        case 'ping':
            const start = Date.now();
            bot.sendMessage(chatId, '🏓 Pinging...').then((msgPing) => {
                const diff = Date.now() - start;
                bot.editMessageText(`🏓 Pong! \`${diff}ms\``, {
                    chat_id: chatId,
                    message_id: msgPing.message_id,
                    parse_mode: 'Markdown'
                });
            });
            break;

        case 'report':
            if (!args) {
                bot.sendMessage(chatId, '❌ Sử dụng: /report <nội dung lỗi/góp ý>');
                return;
            }
            if (ADMIN_USER_ID) {
                bot.sendMessage(ADMIN_USER_ID, `📩 *Report từ @${msg.from.username || msg.from.first_name}* (ID: \`${userId}\`):\n${args}`, { parse_mode: 'Markdown' });
                bot.sendMessage(chatId, '✅ Cảm ơn bạn. Report của bạn đã được gửi tới Admin!');
            } else {
                bot.sendMessage(chatId, '⚠️ Tính năng này chưa được cấu hình.');
            }
            break;

        case 'stats': {
            const successRate = stats.totalRequests > 0
                ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1)
                : 0;
            bot.sendMessage(chatId,
                `📊 *Thống kê Bot*\n\n` +
                `📥 Tổng requests: ${stats.totalRequests}\n` +
                `✅ Thành công: ${stats.successfulDownloads}\n` +
                `❌ Thất bại: ${stats.failedDownloads}\n` +
                `📈 Tỷ lệ thành công: ${successRate}%\n` +
                `👥 Người dùng hoạt động: ${stats.activeUsers.size}\n` +
                `⭐ VIP users: ${vipUsers.size}\n` +
                `📋 Hàng đợi: ${requestQueue.length}\n` +
                `⚙️ Đang xử lý: ${processingCount}/${MAX_CONCURRENT}\n` +
                `🚫 Banned users: ${bannedUsers.size}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🖥️ Xem Dashboard đầy đủ', url: DASHBOARD_URL }
                        ]]
                    }
                }
            );
            break;
        }

        case 'panel': {
            const successRateP = stats.totalRequests > 0
                ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
            bot.sendMessage(chatId,
                `🖥️ *Admin Dashboard*\n\n` +
                `📥 Tổng: ${stats.totalRequests} requests\n` +
                `✅ Thành công: ${stats.successfulDownloads} (${successRateP}%)\n` +
                `👥 Users: ${stats.activeUsers.size} | ⭐ VIP: ${vipUsers.size} | 🚫 Banned: ${bannedUsers.size} | 🔇 Muted: ${mutedUsers.size}\n` +
                `📋 Hàng đợi: ${requestQueue.length} | ⚙️ Xử lý: ${processingCount}/${MAX_CONCURRENT}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🌐 Mở Web Dashboard', url: DASHBOARD_URL }]
                        ]
                    }
                }
            );
            break;
        }

        case 'users':
            if (stats.activeUsers.size === 0) {
                bot.sendMessage(chatId, '📭 Chưa có người dùng nào.');
                break;
            }
            let userList = '👥 *Danh sách người dùng:*\n\n';
            const sortedUsers = Array.from(stats.activeUsers.entries())
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 20);

            sortedUsers.forEach(([id, data], index) => {
                const lastUsed = new Date(data.lastUsed).toLocaleString('vi-VN');
                const vipBadge = vipUsers.has(Number(id)) ? ' ⭐VIP' : '';
                userList += `${index + 1}. @${data.username}${vipBadge} (ID: \`${id}\`)\n`;
                userList += `   📥 ${data.count} downloads | 🕐 ${lastUsed}\n\n`;
            });
            bot.sendMessage(chatId, userList, { parse_mode: 'Markdown' });
            break;

        case 'broadcast':
            if (!args) {
                bot.sendMessage(chatId, '❌ Sử dụng: /broadcast <message>');
                break;
            }
            let sent = 0;
            for (const [userId] of stats.activeUsers) {
                try {
                    await bot.sendMessage(userId, `📢 *Thông báo từ Admin:*\n\n${args}`, { parse_mode: 'Markdown' });
                    sent++;
                } catch (e) {
                    console.error(`Failed to send to ${userId}:`, e.message);
                }
            }
            bot.sendMessage(chatId, `✅ Đã gửi thông báo tới ${sent}/${stats.activeUsers.size} người dùng.`);
            break;

        case 'ban':
            if (!args) {
                bot.sendMessage(chatId, '❌ Sử dụng: /ban <user_id>');
                break;
            }
            const banUserId = parseInt(args);
            if (banUserId === ADMIN_USER_ID) {
                bot.sendMessage(chatId, '❌ Không thể ban admin!');
                break;
            }
            bannedUsers.add(banUserId);
            saveData();
            bot.sendMessage(chatId, `🚫 Đã ban user ID: ${banUserId}`);
            break;

        case 'unban':
            if (!args) {
                bot.sendMessage(chatId, '❌ Sử dụng: /unban <user_id>');
                break;
            }
            const unbanUserId = parseInt(args);
            bannedUsers.delete(unbanUserId);
            saveData();
            bot.sendMessage(chatId, `✅ Đã unban user ID: ${unbanUserId}`);
            break;

        case 'setlimit': {
            const parts = args ? args.split(/\s+/) : [];
            if (parts.length < 2) {
                bot.sendMessage(chatId, '❌ Sử dụng: /setlimit <user_id> <số>\n\n💡 Số = 0 → chặn tải hoàn toàn\nSố = 1 → chỉ cho 1 request/10 giây\nSố = 3 → mặc định');
                break;
            }
            const limitUserId = parseInt(parts[0]);
            const limitCount = parseInt(parts[1]);
            if (isNaN(limitUserId) || isNaN(limitCount) || limitCount < 0) {
                bot.sendMessage(chatId, '❌ Giá trị không hợp lệ.');
                break;
            }
            if (limitUserId === ADMIN_USER_ID) {
                bot.sendMessage(chatId, '❌ Không thể giới hạn admin!');
                break;
            }
            userLimitOverrides.set(limitUserId, limitCount);
            saveData();
            const uInfo = stats.activeUsers.get(limitUserId);
            const uName = uInfo ? `@${uInfo.username}` : `ID ${limitUserId}`;
            if (limitCount === 0) {
                bot.sendMessage(chatId, `🚫 ${uName} - đã chặn tải video (soft-ban).`);
            } else {
                bot.sendMessage(chatId, `⚠️ ${uName} - giới hạn còn ${limitCount} request / 10 giây.`);
            }
            break;
        }

        case 'resetlimit': {
            if (!args) {
                bot.sendMessage(chatId, '❌ Sử dụng: /resetlimit <user_id>');
                break;
            }
            const resetId = parseInt(args);
            userLimitOverrides.delete(resetId);
            saveData();
            bot.sendMessage(chatId, `✅ Đã reset giới hạn cho user ID: ${resetId} về mặc định (${MAX_REQUESTS_PER_WINDOW}/10s).`);
            break;
        }

        case 'limits': {
            if (userLimitOverrides.size === 0) {
                bot.sendMessage(chatId, '📭 Không có giới hạn tùy chỉnh nào.');
                break;
            }
            let limitList = '⚠️ *Giới hạn tùy chỉnh:*\n\n';
            Array.from(userLimitOverrides.entries()).forEach(([id, limit], index) => {
                const uData = stats.activeUsers.get(id);
                const name = uData ? `@${uData.username}` : `ID: ${id}`;
                const status = limit === 0 ? '🚫 CHẸN TẢI' : `${limit}/10s`;
                limitList += `${index + 1}. ${name} (\`${id}\`) → ${status}\n`;
            });
            limitList += `\n🔹 Mặc định: ${MAX_REQUESTS_PER_WINDOW}/10s`;
            bot.sendMessage(chatId, limitList, { parse_mode: 'Markdown' });
            break;
        }

        case 'addvip': {
            if (!args) {
                bot.sendMessage(chatId, '❌ Sử dụng: /addvip <user_id>');
                break;
            }
            const addVipId = parseInt(args);
            vipUsers.add(addVipId);
            saveData();
            bot.sendMessage(chatId, `⭐ Đã thêm VIP cho user ID: ${addVipId}`);
            // Notify the VIP user
            bot.sendMessage(addVipId,
                '🎉 *Chúc mừng!* Bạn đã được nâng cấp lên *VIP*!\n\n' +
                '⭐ Quyền lợi VIP:\n' +
                '• Không giới hạn tốc độ gửi link\n' +
                '• Ưu tiên đầu hàng đợi - không phải đợi lâu\n\n' +
                'Cảm ơn bạn đã ủng hộ bot! 💙',
                { parse_mode: 'Markdown' }
            ).catch((err) => {
                console.error(`[VIP] Cannot notify user ${addVipId}:`, err.message);
                // Admin: inform delivery failed
                bot.sendMessage(chatId,
                    `⚠️ Không thể gửi thông báo cho user \`${addVipId}\`.\n` +
                    `💡 Lý do: User chưa từng nhắn tin với bot (Telegram hạn chế).\n` +
                    `→ Hãy nhắn thủ công cho họ biết đã được cấp VIP nhé!`,
                    { parse_mode: 'Markdown' }
                ).catch(() => { });
            });
            break;
        }

        case 'removevip': {
            if (!args) {
                bot.sendMessage(chatId, '❌ Sử dụng: /removevip <user_id>');
                break;
            }
            const removeVipId = parseInt(args);
            vipUsers.delete(removeVipId);
            saveData();
            bot.sendMessage(chatId, `✅ Đã xóa VIP user ID: ${removeVipId}`);
            // Notify the user
            bot.sendMessage(removeVipId,
                '⚠️ *Thông báo:* Quyền VIP của bạn đã bị thu hồi.\n' +
                'Liên hệ admin nếu có thắc mắc.',
                { parse_mode: 'Markdown' }
            ).catch((err) => {
                console.error(`[VIP] Cannot notify user ${removeVipId}:`, err.message);
                bot.sendMessage(chatId,
                    `⚠️ Không thể gửi thông báo cho user \`${removeVipId}\`.\n` +
                    `💡 Hãy nhắn thủ công cho họ biết đã bị thu hồi VIP nhé!`,
                    { parse_mode: 'Markdown' }
                ).catch(() => { });
            });
            break;
        }

        case 'vips':
            if (vipUsers.size === 0) {
                bot.sendMessage(chatId, '📭 Chưa có VIP user nào.');
                break;
            }
            let vipList = '⭐ *Danh sách VIP:*\n\n';
            Array.from(vipUsers).forEach((id, index) => {
                const uData = stats.activeUsers.get(id);
                const name = uData ? `@${uData.username}` : `ID: ${id}`;
                vipList += `${index + 1}. ${name} (\`${id}\`)\n`;
            });
            bot.sendMessage(chatId, vipList, { parse_mode: 'Markdown' });
            break;

        case 'top': {
            if (stats.activeUsers.size === 0) {
                bot.sendMessage(chatId, '📭 Chưa có dữ liệu người dùng.');
                break;
            }
            const topUsers = Array.from(stats.activeUsers.entries())
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 5);
            let topMsg = '🏆 *Top 5 người dùng tích cực:*\n\n';
            const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
            topUsers.forEach(([id, data], i) => {
                const vipBadge = vipUsers.has(Number(id)) ? '⭐' : '';
                topMsg += `${medals[i]} ${vipBadge}@${data.username} - *${data.count}* lượt tải\n`;
            });
            bot.sendMessage(chatId, topMsg, { parse_mode: 'Markdown' });
            break;
        }

        case 'maintenance': {
            const action = args?.toLowerCase();
            if (action === 'on') {
                maintenanceMode = true;
                bot.sendMessage(chatId, '🔧 Đã bật chế độ bảo trì. User sẽ không tải được video.');
            } else if (action === 'off') {
                maintenanceMode = false;
                bot.sendMessage(chatId, '✅ Đã tắt bảo trì. Bot hoạt động bình thường.');
            } else {
                bot.sendMessage(chatId, `⚠️ Chế độ bảo trì: *${maintenanceMode ? 'ĐANG BẬT' : 'ĐÃ TẮFT'}*\n\nDùng /maintenance on hoặc /maintenance off`, { parse_mode: 'Markdown' });
            }
            break;
        }

        case 'queue':
            if (requestQueue.length === 0 && processingCount === 0) {
                bot.sendMessage(chatId, '📭 Hàng đợi trống.');
                break;
            }
            let queueInfo = `📋 *Trạng thái hàng đợi:*\n\n`;
            queueInfo += `⚙️ Đang xử lý: ${processingCount}/${MAX_CONCURRENT}\n`;
            queueInfo += `📊 Chờ xử lý: ${requestQueue.length}\n\n`;

            if (requestQueue.length > 0) {
                queueInfo += '*Danh sách chờ:*\n';
                requestQueue.slice(0, 5).forEach((req, idx) => {
                    queueInfo += `${idx + 1}. @${req.username} - ${req.url.substring(0, 30)}...\n`;
                });
                if (requestQueue.length > 5) {
                    queueInfo += `\n...và ${requestQueue.length - 5} requests khác`;
                }
            }
            bot.sendMessage(chatId, queueInfo, { parse_mode: 'Markdown' });
            break;
    }
});

// /history command (open to all users)
bot.onText(/^\/history$/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const userData = stats.activeUsers.get(userId);
    if (!userData || !userData.history || userData.history.length === 0) {
        bot.sendMessage(chatId, '📭 Bạn chưa tải video nào.');
        return;
    }
    let histMsg = '📖 *Lịch sử tải gần đây của bạn:*\n\n';
    userData.history.forEach((item, i) => {
        const time = new Date(item.time).toLocaleString('vi-VN');
        const plat = item.platform === 'facebook' ? '🐙' : '🎵';
        const shortUrl = item.url.length > 45 ? item.url.substring(0, 45) + '...' : item.url;
        histMsg += `${i + 1}. ${plat} \`${shortUrl}\`\n   🕐 ${time}\n\n`;
    });
    bot.sendMessage(chatId, histMsg, { parse_mode: 'Markdown' });
});

// /top command (open to all users)
bot.onText(/^\/top$/, (msg) => {
    const chatId = msg.chat.id;
    if (stats.activeUsers.size === 0) {
        bot.sendMessage(chatId, '📭 Chưa có dữ liệu.');
        return;
    }
    const topUsers = Array.from(stats.activeUsers.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5);
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    let topMsg = '🏆 *Top 5 người dùng tích cực:*\n\n';
    topUsers.forEach(([id, data], i) => {
        const vipBadge = vipUsers.has(Number(id)) ? '⭐' : '';
        topMsg += `${medals[i]} ${vipBadge}@${data.username} — *${data.count}* lượt tải\n`;
    });
    bot.sendMessage(chatId, topMsg, { parse_mode: 'Markdown' });
});

// TikTok + Facebook Message Handler
// MP3 Callback handler
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data.startsWith('mp3_')) {
        const mp3Id = data.replace('mp3_', '');
        const info = mp3Cache.get(mp3Id);
        
        if (!info) {
            bot.answerCallbackQuery(query.id, { text: 'Link đã hết hạn, vui lòng gửi lại video!', show_alert: true });
            return;
        }

        bot.answerCallbackQuery(query.id, { text: 'Đang trích xuất MP3...' });
        const processingMsg = await bot.sendMessage(chatId, '⏳ Đang chuyển đổi MP3, vui lòng đợi...');

        try {
            // Simplified logic: TikTok/FB MP3 fetch (In real app, you would use an API like TikWM music or SSSTik)
            // For now we'll download video and extract audio or use API if possible
            // Let's use TikWM API directly for Tiktok MP3 if platform is tiktok
            let mp3Url = null;

            if (info.platform === 'tiktok') {
                const response = await axios.post('https://www.tikwm.com/api/', { url: info.url }, { timeout: 10000 });
                if (response.data && response.data.data && response.data.data.music) {
                    mp3Url = response.data.data.music;
                }
            }

            if (mp3Url) {
                await bot.sendAudio(chatId, mp3Url, { reply_to_message_id: messageId });
            } else {
                bot.sendMessage(chatId, '❌ Không thể tìm thấy âm thanh cho video này.');
            }
        } catch (e) {
            bot.sendMessage(chatId, '❌ Lỗi trích xuất âm thanh: ' + e.message);
        } finally {
            bot.deleteMessage(chatId, processingMsg.message_id).catch(()=>{});
        }
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from?.id;

    if (!text) return;

    const tiktokMatch = text.match(tiktokRegex);
    const fbMatch = text.match(facebookRegex);
    const ytMatch = text.match(youtubeRegex);
    const igMatch = text.match(instagramRegex);

    const match = tiktokMatch || fbMatch || ytMatch || igMatch;
    const platform = tiktokMatch ? 'tiktok' : fbMatch ? 'facebook' : ytMatch ? 'youtube' : igMatch ? 'instagram' : null;

    if (match) {
        // Check maintenance mode immediately
        if (maintenanceMode && !isVip(userId) && !isAdmin(userId)) {
            bot.sendMessage(chatId, '🔧 *Bot đang bảo trì!*\n\nCác tính năng tải video tạm thời bị ngưng. Vui lòng quay lại sau nhé!', { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }).catch(console.error);
            return;
        }

        // Check if user is banned
        if (bannedUsers.has(userId)) {
            bot.sendMessage(chatId, '🚫 Bạn đã bị chặn sử dụng bot này.').catch(console.error);
            if (ADMIN_USER_ID) {
                bot.sendMessage(ADMIN_USER_ID, `⚠️ Banned user ${userId} (@${msg.from?.username}) tried to use bot`).catch(console.error);
            }
            return;
        }

        // VIP users bypass rate limit
        if (!isVip(userId) && !checkRateLimit(userId)) {
            bot.sendMessage(chatId, '⚠️ Bạn đang gửi quá nhanh! Vui lòng đợi 10 giây.\n\n💡 Tip: Liên hệ admin để nâng cấp VIP không giới hạn!', {
                reply_to_message_id: msg.message_id
            }).catch(console.error);
            return;
        }

        const videoUrl = match[0];
        const username = msg.from?.username || msg.from?.first_name || 'unknown';

        stats.totalRequests++;
        updateUserStats(userId, username);

        console.log(`[${new Date().toISOString()}] Received ${platform.toUpperCase()} URL: ${videoUrl} from ${username} (ID: ${userId})`);

        // Add to queue
        const queueItem = {
            chatId,
            userId,
            username,
            url: videoUrl,
            platform,
            messageId: msg.message_id,
            timestamp: Date.now(),
            isVip: isVip(userId)
        };

        // VIP users go to front of queue, regular users go to back
        if (queueItem.isVip) {
            requestQueue.unshift(queueItem);
        } else {
            requestQueue.push(queueItem);
        }

        // Notify user of queue position
        const position = requestQueue.indexOf(queueItem) + 1;
        if (requestQueue.length > 1 || processingCount >= MAX_CONCURRENT) {
            const vipNote = queueItem.isVip ? ' ⭐ VIP - Ưu tiên cao nhất!' : '';
            bot.sendMessage(chatId, `📋 Đã thêm vào hàng đợi (vị trí: ${position})${vipNote}`, {
                reply_to_message_id: msg.message_id
            }).catch(console.error);
        }

        // Process queue
        processQueue();
    } else {
        // Handle 2-way chat if message is not a command
        if (!text.startsWith('/')) {
            if (isAdmin(userId) && msg.reply_to_message) {
                // Admin replies to a user message
                let targetId = null;
                if (msg.reply_to_message.forward_from) {
                    targetId = msg.reply_to_message.forward_from.id;
                } else if (msg.reply_to_message.text && msg.reply_to_message.text.includes('ID:')) {
                    // Fallback to parse ID from text
                    const idMatch = msg.reply_to_message.text.match(/ID:\s*`?(\d+)`?/);
                    if (idMatch) targetId = parseInt(idMatch[1]);
                }

                if (targetId) {
                    bot.sendMessage(targetId, `👨‍💻 *Admin:*\n${text}`, { parse_mode: 'Markdown' })
                        .then(() => bot.sendMessage(chatId, '✅ Đã gửi phản hồi!'))
                        .catch(e => bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`));
                } else {
                    bot.sendMessage(chatId, '❌ Không nhận diện được User ID để trả lời.');
                }
            } else if (!isAdmin(userId)) {
                // User sending regular message -> forward to Admin
                if (mutedUsers.has(userId)) {
                    bot.sendMessage(chatId, '🔇 Tính năng gửi tin nhắn cho Admin của bạn đã bị khóa.').catch(console.error);
                } else if (ADMIN_USER_ID) {
                    const usernameInfo = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'user';
                    bot.sendMessage(ADMIN_USER_ID, `📩 *Tin nhắn từ ${usernameInfo}* (ID: \`${userId}\`):\n\n${text}`, { parse_mode: 'Markdown' })
                        .catch(console.error);
                }
            }
        }
    }
});

// Queue Processor
async function processQueue() {
    // Check if we can process more
    if (processingCount >= MAX_CONCURRENT || requestQueue.length === 0) {
        return;
    }

    // Get next request from queue
    const request = requestQueue.shift();
    if (!request) return;

    processingCount++;
    console.log(`[Queue] Processing: ${processingCount}/${MAX_CONCURRENT}, Queue: ${requestQueue.length}`);

    let processingMsg;

    try {
        // Notify user that we are processing
        let platformLabel = '🎵 TikTok';
        if (request.platform === 'facebook') platformLabel = '🐙 Facebook';
        else if (request.platform === 'youtube') platformLabel = '▶️ YouTube';
        else if (request.platform === 'instagram') platformLabel = '📸 Instagram';

        processingMsg = await bot.sendMessage(request.chatId, `⏳ Đang tải video ${platformLabel}...`, {
            reply_to_message_id: request.messageId
        });

        let videoData;
        if (request.platform === 'facebook') {
            videoData = await downloadFacebookVideo(request.url);
        } else if (request.platform === 'youtube') {
            videoData = await downloadYouTubeVideo(request.url);
        } else if (request.platform === 'instagram') {
            videoData = await downloadInstagramVideo(request.url);
        } else {
            videoData = await getVideoNoWatermark(request.url);
        }

        if (!videoData || (!videoData.url && !videoData.isTooLarge)) {
            throw new Error('Could not retrieve video URL');
        }

        if (videoData.isTooLarge) {
            console.log(`[${new Date().toISOString()}] Video is too large (${videoData.sizeMB.toFixed(2)} MB), sending direct link...`);

            await bot.sendMessage(request.chatId, `⚠️ **Video này quá lớn (${videoData.sizeMB.toFixed(2)} MB)!**\n\nTelegram chỉ cho phép bot tải file tối đa 50MB. Vui lòng bấm vào nút dưới đây để tải trực tiếp video chất lượng cao về điện thoại của bạn 👇`, {
                reply_to_message_id: request.messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔗 TẢI VIDEO TRỰC TIẾP', url: videoData.url }]]
                }
            });

            if (processingMsg) {
                bot.deleteMessage(request.chatId, processingMsg.message_id).catch(() => { });
            }

            console.log(`[${new Date().toISOString()}] ✅ Direct link sent successfully!`);
            stats.successfulDownloads++;
            saveData();
        } else {
            console.log(`[${new Date().toISOString()}] Downloading video...`);

            // Download video to temporary file
            const tempFileName = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.mp4`;
            const tempFilePath = path.join(__dirname, tempFileName);

            const writer = fs.createWriteStream(tempFilePath);
            const videoResponse = await axios.get(videoData.url, {
                responseType: 'stream',
                timeout: 60000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://www.tiktok.com/'
                }
            });

            videoResponse.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log(`[${new Date().toISOString()}] Video downloaded. Uploading to Telegram...`);

            // Add MP3 button functionality
            const mp3Id = Math.random().toString(36).substring(2, 10);
            mp3Cache.set(mp3Id, { url: request.url, platform: request.platform });

            await bot.sendVideo(request.chatId, tempFilePath, {
                caption: '👑 Admin: @phamtheson\n⭐ Bot tải video không logo',
                reply_to_message_id: request.messageId,
                supports_streaming: true,
                reply_markup: {
                    inline_keyboard: [[{ text: '🎵 Tải MP3', callback_data: `mp3_${mp3Id}` }]]
                }
            });

            fs.unlink(tempFilePath, (err) => {
                if (err) console.error('Error deleting temp file:', err);
                else console.log(`[${new Date().toISOString()}] Temp file deleted: ${tempFileName}`);
            });

            if (processingMsg) {
                bot.deleteMessage(request.chatId, processingMsg.message_id).catch(() => { });
            }

            console.log(`[${new Date().toISOString()}] ✅ Video sent successfully!`);
            stats.successfulDownloads++;
            recordHistory(request.userId, request.url, request.platform);
            saveData();
        }

    } catch (error) {
        console.error('Error processing TikTok:', error.message);
        stats.failedDownloads++;
        saveData();

        let errorMessage = '❌ Có lỗi xảy ra. ';

        if (error.message.includes('Video quá lớn')) {
            errorMessage += error.message;
        } else if (error.message.includes('Could not retrieve video URL')) {
            errorMessage += 'Link không hợp lệ hoặc video đã bị xóa. Vui lòng thử link khác.';
        } else if (error.message.includes('timeout')) {
            errorMessage += 'Timeout khi tải video. Vui lòng thử lại sau.';
        } else if (error.message.includes('Network')) {
            errorMessage += 'Lỗi kết nối mạng. Vui lòng thử lại.';
        } else {
            errorMessage += 'Link lỗi hoặc Bot không gửi được file (do quyền hạn/file quá nặng).';
        }

        errorMessage += '\n\n💡 Tips: Hãy chắc chắn link TikTok / Facebook hợp lệ và video không quá lớn (max 50MB).';

        if (processingMsg) {
            bot.editMessageText(errorMessage, {
                chat_id: request.chatId,
                message_id: processingMsg.message_id
            }).catch(() => { });
        }
    } finally {
        processingCount--;
        console.log(`[Queue] Finished processing. Active: ${processingCount}, Queue: ${requestQueue.length}`);

        // Process next item in queue
        setImmediate(() => processQueue());
    }
}

// -----------------------------------------------
// 🐙 Facebook Video Downloader
// -----------------------------------------------
async function normalizeFbUrl(fbUrl) {
    // Share links (share/v/ share/r/ fb.watch) need to be expanded to get the real URL
    if (fbUrl.includes('/share/') || fbUrl.includes('fb.watch')) {
        try {
            console.log('[FB] Expanding share URL...');
            const response = await axios.get(fbUrl, {
                maxRedirects: 10,
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                validateStatus: () => true
            });
            const finalUrl = response.request?.res?.responseUrl || response.config?.url || fbUrl;
            if (finalUrl !== fbUrl) {
                console.log('[FB] Expanded to:', finalUrl);
            }
            // Make sure it's fb URL (not login redirect)
            if (finalUrl.includes('facebook.com') || finalUrl.includes('fb.com')) {
                return finalUrl;
            }
        } catch (e) {
            console.log('[FB] URL expansion failed, using original:', fbUrl);
        }
    }
    return fbUrl;
}

async function downloadFacebookVideo(fbUrl) {
    // Expand share links to real video URLs first
    const realUrl = await normalizeFbUrl(fbUrl);
    console.log(`[FB] Processing URL: ${realUrl}`);

    const apis = [
        // API 1: snapsave.app (Primary)
        async () => {
            console.log('[FB API 1/3] Trying snapsave.app...');
            const response = await axios.post('https://snapsave.app/action.php',
                new URLSearchParams({ url: realUrl }),
                {
                    timeout: 20000,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://snapsave.app/',
                        'Origin': 'https://snapsave.app'
                    }
                }
            );

            let html = response.data;
            if (typeof html === 'string' && html.includes('eval(function')) {
                console.log('[FB] Detected packed script inside SnapSave response. Decoding...');
                const modifiedCode = html.replace('eval(function', 'return (function');
                const decodeFn = new Function(modifiedCode);
                html = decodeFn();
                if (html.includes('\\"')) {
                    html = html.replace(/\\"/g, '"').replace(/\\\//g, '/');
                }
            }

            const hdMatch = html.match(/href="(https:\/\/d\.rapidcdn\.app\/v2\?token=[^"]+)"/i)
                || html.match(/href="(https:\/\/[^"]+rapidcdn\.app[^"]+)"/i)
                || html.match(/<a[^>]+href="([^"]+)"[^>]*>.*?Download HD/is)
                || html.match(/href="([^"]+)"[^>]*>.*?Download/is);

            if (hdMatch) {
                console.log('✅ snapsave.app API success!');
                return { url: hdMatch[1], title: 'Facebook Video', author: 'Facebook' };
            }
            throw new Error('snapsave parsing failed');
        },

        // API 2: getfvid.com
        async () => {
            console.log('[FB API 2/3] Trying getfvid.com...');
            const response = await axios.post('https://www.getfvid.com/downloader',
                new URLSearchParams({ URLz: realUrl }),
                {
                    timeout: 20000,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.getfvid.com/',
                        'Origin': 'https://www.getfvid.com'
                    }
                }
            );
            // Parse HD link first, then SD
            const hdMatch = response.data.match(/href="(https:\/\/[^"]+)\.mp4[^"]*"[^>]*>.*?HD/is)
                || response.data.match(/href="(https:\/\/video\.f?b[^"]+\.mp4[^"]*)"/i);
            if (hdMatch) {
                console.log('✅ getfvid API success!');
                return { url: hdMatch[1].includes('.mp4') ? hdMatch[1] : hdMatch[1] + '.mp4', title: 'Facebook Video', author: 'Facebook' };
            }
            throw new Error('getfvid parsing failed');
        },

        // API 3: fdown.net
        async () => {
            console.log('[FB API 3/3] Trying fdown.net...');
            const response = await axios.get('https://fdown.net/download.php', {
                params: { URLz: realUrl },
                timeout: 20000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://fdown.net/'
                }
            });
            const sdMatch = response.data.match(/id="sdlink"\s+href="([^"]+)"/i)
                || response.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
            if (sdMatch) {
                console.log('✅ fdown.net API success!');
                return { url: sdMatch[1], title: 'Facebook Video', author: 'Facebook' };
            }
            throw new Error('fdown.net parsing failed');
        }
    ];

    for (let i = 0; i < apis.length; i++) {
        try {
            const result = await retryWithBackoff(apis[i], 2, 1000);
            if (result && result.url) {
                // Verify & check size
                try {
                    const headResponse = await axios.head(result.url, { timeout: 10000, maxRedirects: 5 });
                    const contentLength = parseInt(headResponse.headers['content-length'] || '0');
                    const fileSizeMB = contentLength / (1024 * 1024);
                    console.log(`✅ FB Video verified! Size: ${fileSizeMB > 0 ? fileSizeMB.toFixed(2) + ' MB' : 'Unknown'}`);
                    result.sizeMB = fileSizeMB;
                    result.isTooLarge = contentLength > 50 * 1024 * 1024;
                } catch (e) {
                    console.log('⚠️ FB size check failed, proceeding...');
                }
                return result;
            }
        } catch (err) {
            console.error(`❌ FB API ${i + 1} failed:`, err.message);
        }
    }

    console.error('❌ All Facebook APIs failed!');
    return null;
}

// Retry helper with exponential backoff
async function retryWithBackoff(fn, maxRetries = 2, baseDelay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            const delay = baseDelay * Math.pow(2, i);
            console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Normalize shortened URLs
async function normalizeUrl(url) {
    if (url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) {
        try {
            console.log('Expanding shortened URL...');
            const response = await axios.get(url, {
                maxRedirects: 5,
                timeout: 10000,
                validateStatus: () => true
            });
            const finalUrl = response.request?.res?.responseUrl || response.config?.url || url;
            if (finalUrl !== url) {
                console.log('Expanded URL:', finalUrl);
                return finalUrl;
            }
        } catch (error) {
            console.log('URL expansion failed, using original:', url);
        }
    }
    return url;
}

// Helper function to get video without watermark
async function getVideoNoWatermark(url) {
    const normalizedUrl = await normalizeUrl(url);
    console.log(`Processing URL: ${normalizedUrl}`);

    const apis = [
        // API 1: TikWM (Primary - Most Reliable)
        async () => {
            console.log('[API 1/5] Trying TikWM API...');
            const response = await axios.post('https://www.tikwm.com/api/', {
                url: normalizedUrl,
                hd: 1
            }, {
                timeout: 20000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const data = response.data;
            if (data.code === 0 && (data.data?.play || data.data?.hdplay)) {
                console.log('✅ TikWM API success!');
                return {
                    url: data.data.hdplay || data.data.play,
                    title: data.data.title || 'TikTok Video',
                    author: data.data.author?.nickname || 'Unknown'
                };
            }
            throw new Error('TikWM returned no data');
        },

        // API 2: SSSTik
        async () => {
            console.log('[API 2/5] Trying SSSTik API...');
            const response = await axios.post('https://ssstik.io/abc?url=dl',
                `id=${encodeURIComponent(normalizedUrl)}&locale=en&tt=d1N4eUs5`,
                {
                    timeout: 20000,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }
            );

            const urlMatch = response.data.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?no watermark/i);
            if (urlMatch && urlMatch[1]) {
                console.log('✅ SSSTik API success!');
                return {
                    url: urlMatch[1],
                    title: 'TikTok Video',
                    author: 'Unknown'
                };
            }
            throw new Error('SSSTik parsing failed');
        },

        // API 3: SnapTik
        async () => {
            console.log('[API 3/5] Trying SnapTik API...');
            const response = await axios.get('https://snaptikvideo.com/tikwm.php', {
                params: {
                    url: normalizedUrl,
                    hd: 1
                },
                timeout: 20000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.data?.url) {
                console.log('✅ SnapTik API success!');
                return {
                    url: response.data.url,
                    title: response.data.title || 'TikTok Video',
                    author: 'Unknown'
                };
            }
            throw new Error('SnapTik returned no data');
        },

        // API 4: TikCDN
        async () => {
            console.log('[API 4/5] Trying TikCDN API...');
            const response = await axios.post('https://tikcdn.io/api/v1/get-video', {
                url: normalizedUrl
            }, {
                timeout: 20000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.data?.video) {
                console.log('✅ TikCDN API success!');
                return {
                    url: response.data.video,
                    title: 'TikTok Video',
                    author: 'Unknown'
                };
            }
            throw new Error('TikCDN returned no data');
        },

        // API 5: Direct TikTok API (Fallback)
        async () => {
            const videoId = extractVideoId(normalizedUrl);
            if (!videoId) throw new Error('Could not extract video ID');

            console.log('[API 5/5] Trying direct TikTok API...');
            const response = await axios.get(`https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}`, {
                timeout: 20000,
                headers: {
                    'User-Agent': 'com.zhiliaoapp.musically/2022600040 (Linux; U; Android 7.1.2; es_ES; SM-G988N; Build/NRD90M;tt-ok/3.12.13.1)'
                }
            });

            if (response.data?.aweme_list?.[0]?.video?.play_addr?.url_list?.[0]) {
                const videoUrl = response.data.aweme_list[0].video.play_addr.url_list[0];
                console.log('✅ Direct TikTok API success!');
                return {
                    url: videoUrl,
                    title: response.data.aweme_list[0].desc || 'TikTok Video',
                    author: response.data.aweme_list[0].author?.nickname || 'Unknown'
                };
            }
            throw new Error('Direct API returned no data');
        }
    ];

    for (let i = 0; i < apis.length; i++) {
        try {
            const result = await retryWithBackoff(apis[i], 2, 1000);

            if (result && result.url) {
                try {
                    console.log('Verifying video URL...');
                    const headResponse = await axios.head(result.url, {
                        timeout: 10000,
                        maxRedirects: 5
                    });
                    const contentLength = parseInt(headResponse.headers['content-length'] || '0');
                    const fileSizeMB = contentLength / (1024 * 1024);

                    console.log(`✅ Video verified! Size: ${fileSizeMB > 0 ? fileSizeMB.toFixed(2) + ' MB' : 'Unknown'}`);

                    result.sizeMB = fileSizeMB;
                    result.isTooLarge = contentLength > 50 * 1024 * 1024;

                    return result;
                } catch (verifyError) {
                    console.error('Video verification failed:', verifyError.message);
                    if (verifyError.message.includes('Video quá lớn')) {
                        throw verifyError;
                    }
                    if (result.url) {
                        console.log('⚠️ Proceeding with unverified URL...');
                        return result;
                    }
                }
            }
        } catch (error) {
            console.error(`❌ API ${i + 1} failed:`, error.message);
        }
    }

    console.error('❌ All APIs failed!');
    return null;
}

// Helper to extract video ID from various TikTok URL formats
function extractVideoId(url) {
    const patterns = [
        /\/video\/(\d+)/,
        /\/v\/(\d+)/,
        /vt\.tiktok\.com\/(\w+)/,
        /vm\.tiktok\.com\/(\w+)/,
        /aweme_id=(\d+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// -----------------------------------------------
// ▶️ YouTube Video Downloader
// -----------------------------------------------
const youtubedl = require('youtube-dl-exec');
async function downloadYouTubeVideo(url) {
    console.log(`[YT] Processing URL: ${url}`);
    try {
        const info = await youtubedl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificates: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true
        });

        if (info.duration > 600) {
            throw new Error('Video quá lớn (chỉ hỗ trợ tải video dưới 10 phút)');
        }

        let format = null;
        if (info.formats) {
            format = info.formats.slice().reverse().find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4');
            if (!format) {
                format = info.formats.slice().reverse().find(f => f.vcodec !== 'none' && f.acodec !== 'none');
            }
        }
        
        const finalUrl = format ? format.url : info.url;

        if (finalUrl) {
            return {
                url: finalUrl,
                title: info.title || 'YouTube Video',
                author: info.uploader || 'YouTube',
                sizeMB: 0,
                isTooLarge: false
            };
        }
        throw new Error('Không tìm thấy định dạng phù hợp');
    } catch (e) {
        console.error('❌ YT API failed:', e.message);
        return null;
    }
}

// -----------------------------------------------
// 📸 Instagram Video Downloader
// -----------------------------------------------
async function downloadInstagramVideo(url) {
    console.log(`[IG] Processing URL: ${url}`);
    try {
        // Simple API for IG: SnapInsta API or similar. 
        // Notice: In real world, IG APIs change constantly, for now use a placeholder logic
        const response = await axios.get('https://api.snaptik.video/api/ig', { params: { url: url }, timeout: 10000 }).catch(() => null);
        
        if (response && response.data && response.data.url) {
            return {
                url: response.data.url,
                title: 'Instagram Video',
                author: 'Instagram'
            };
        }
        // Fallback or empty (since IG strictly blocks bots, using a 3rd party API is mandatory)
        throw new Error('IG API currently down');
    } catch (e) {
        console.error('❌ IG API failed:', e.message);
        return null;
    }
}

// Global error handler for polling errors
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
});

// Global error handler for webhook errors
bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error.message);
});

// -----------------------------------------------
// 🗑️ Auto-Cleanup: Delete leftover temp files every 24 hours
// -----------------------------------------------
function cleanupTempFiles() {
    console.log('[Cleanup] Starting auto-cleanup of temp files...');
    let deleted = 0;
    let errors = 0;
    try {
        const files = fs.readdirSync(__dirname);
        files.forEach(file => {
            if (file.startsWith('temp_') && file.endsWith('.mp4')) {
                const filePath = path.join(__dirname, file);
                try {
                    // Only delete if file is older than 10 minutes (safety check)
                    const stat = fs.statSync(filePath);
                    const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
                    if (ageMinutes > 10) {
                        fs.unlinkSync(filePath);
                        deleted++;
                        console.log(`[Cleanup] Deleted: ${file}`);
                    }
                } catch (e) {
                    errors++;
                    console.error(`[Cleanup] Failed to delete ${file}:`, e.message);
                }
            }
        });
    } catch (e) {
        console.error('[Cleanup] Error reading directory:', e.message);
    }
    console.log(`[Cleanup] Done. Deleted: ${deleted} file(s), Errors: ${errors}`);
    if (ADMIN_USER_ID && deleted > 0) {
        bot.sendMessage(ADMIN_USER_ID, `🗑️ *Auto-Cleanup xong!*\n✅ Đã xóa ${deleted} file tạm\n❌ Lỗi: ${errors}`, { parse_mode: 'Markdown' }).catch(() => { });
    }
}

// Run cleanup immediately on start, then every 24 hours
cleanupTempFiles();
setInterval(cleanupTempFiles, 24 * 60 * 60 * 1000);

// -----------------------------------------------
// 🕛 Reset hourly stats at midnight every day
// -----------------------------------------------
function scheduleMidnightReset() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0); // next midnight
    const msUntilMidnight = midnight - now;

    const doMidnightTasks = () => {
        console.log('[Scheduler] Running midnight tasks...');

        // 1. Send daily report to admin
        if (ADMIN_USER_ID) {
            const successRate = stats.totalRequests > 0
                ? ((stats.successfulDownloads / stats.totalRequests) * 100).toFixed(1) : 0;
            const topUser = Array.from(stats.activeUsers.entries())
                .sort((a, b) => b[1].count - a[1].count)[0];
            const topUserStr = topUser ? `@${topUser[1].username} (${topUser[1].count} lượt)` : 'N/A';
            const today = new Date().toLocaleDateString('vi-VN');

            bot.sendMessage(ADMIN_USER_ID,
                `📊 *Báo cáo ngày ${today}*\n\n` +
                `📥 Tổng requests: ${stats.totalRequests}\n` +
                `✅ Thành công: ${stats.successfulDownloads} (${successRate}%)\n` +
                `❌ Thất bại: ${stats.failedDownloads}\n` +
                `👥 Người dùng: ${stats.activeUsers.size}\n` +
                `⭐ VIP: ${vipUsers.size} | 🚫 Banned: ${bannedUsers.size}\n` +
                `🏆 Top user: ${topUserStr}\n` +
                (maintenanceMode ? '\n⚠️ *Bot đang ở chế độ bảo trì!*' : ''),
                { parse_mode: 'Markdown' }
            ).catch(console.error);
        }

        // 2. Reset hourly stats for new day
        hourlyStats = new Array(24).fill(0);
        saveData();
        console.log('[Scheduler] Daily reset complete.');
    };

    setTimeout(() => {
        doMidnightTasks();
        setInterval(doMidnightTasks, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
}

scheduleMidnightReset();

