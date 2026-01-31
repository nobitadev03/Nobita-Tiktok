require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

// Queue System
const requestQueue = [];
let processingCount = 0;

// Statistics
const stats = {
    totalRequests: 0,
    successfulDownloads: 0,
    failedDownloads: 0,
    activeUsers: new Map(), // userId -> {username, count, lastUsed}
};

// Banned Users
const bannedUsers = new Set();

// --- Server for Render/Heroku (Keep Alive) ---
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
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
    const userLimits = userRateLimits.get(userId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

    if (now > userLimits.resetTime) {
        userRateLimits.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return true;
    }

    if (userLimits.count >= MAX_REQUESTS_PER_WINDOW) {
        return false;
    }

    userLimits.count++;
    userRateLimits.set(userId, userLimits);
    return true;
}

// Expanded regex to detect TikTok links - covers more formats
const tiktokRegex = /(?:https?:\/\/)?(?:(?:www|vt|vm|m|t)\.)?tiktok\.com\/(?:@[\w.-]+\/video\/\d+|v\/\d+|[\w-]+|share\/video\/\d+)|(?:https?:\/\/)?(?:vm|vt)\.tiktok\.com\/[\w]+/i;

// Helper: Check if user is admin
function isAdmin(userId) {
    return userId === ADMIN_USER_ID;
}

// Helper: Update user stats
function updateUserStats(userId, username) {
    if (!stats.activeUsers.has(userId)) {
        stats.activeUsers.set(userId, {
            username: username || 'Unknown',
            count: 0,
            lastUsed: Date.now()
        });
    }
    const user = stats.activeUsers.get(userId);
    user.count++;
    user.lastUsed = Date.now();
    user.username = username || user.username;
}

// Admin Commands Handler
bot.onText(/^\/(\w+)(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const command = match[1];
    const args = match[2]?.trim();

    // Check if command is admin-only
    const adminCommands = ['stats', 'users', 'broadcast', 'ban', 'unban', 'queue'];
    if (adminCommands.includes(command) && !isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Bạn không có quyền sử dụng lệnh này.');
        return;
    }

    switch (command) {
        case 'start':
            bot.sendMessage(chatId,
                '👋 Chào mừng đến với Nobita TikTok Bot!\n\n' +
                '📹 Gửi link TikTok để tải video không logo\n' +
                '⚡ Hỗ trợ tất cả định dạng link TikTok\n\n' +
                (isAdmin(userId) ? '🔧 Admin commands:\n/stats - Thống kê\n/users - Người dùng\n/queue - Hàng đợi\n/broadcast <msg> - Thông báo\n/ban <id> - Chặn user\n/unban <id> - Bỏ chặn' : '')
            );
            break;

        case 'stats':
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
                `📋 Hàng đợi: ${requestQueue.length}\n` +
                `⚙️ Đang xử lý: ${processingCount}/${MAX_CONCURRENT}\n` +
                `🚫 Banned users: ${bannedUsers.size}`,
                { parse_mode: 'Markdown' }
            );
            break;

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
                userList += `${index + 1}. @${data.username} (ID: \`${id}\`)\n`;
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
            bot.sendMessage(chatId, `🚫 Đã ban user ID: ${banUserId}`);
            break;

        case 'unban':
            if (!args) {
                bot.sendMessage(chatId, '❌ Sử dụng: /unban <user_id>');
                break;
            }
            const unbanUserId = parseInt(args);
            bannedUsers.delete(unbanUserId);
            bot.sendMessage(chatId, `✅ Đã unban user ID: ${unbanUserId}`);
            break;

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

// TikTok Message Handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from?.id;

    if (!text) return;

    const match = text.match(tiktokRegex);

    if (match) {
        // Check if user is banned
        if (bannedUsers.has(userId)) {
            bot.sendMessage(chatId, '🚫 Bạn đã bị chặn sử dụng bot này.').catch(console.error);
            if (ADMIN_USER_ID) {
                bot.sendMessage(ADMIN_USER_ID, `⚠️ Banned user ${userId} (@${msg.from?.username}) tried to use bot`).catch(console.error);
            }
            return;
        }

        // Check rate limit
        if (!checkRateLimit(userId)) {
            bot.sendMessage(chatId, '⚠️ Bạn đang gửi quá nhanh! Vui lòng đợi 10 giây.', {
                reply_to_message_id: msg.message_id
            }).catch(console.error);
            return;
        }

        const tiktokUrl = match[0];
        const username = msg.from?.username || msg.from?.first_name || 'unknown';

        stats.totalRequests++;
        updateUserStats(userId, username);

        console.log(`[${new Date().toISOString()}] Received TikTok URL: ${tiktokUrl} from ${username} (ID: ${userId})`);

        // Add to queue
        const queueItem = {
            chatId,
            userId,
            username,
            url: tiktokUrl,
            messageId: msg.message_id,
            timestamp: Date.now()
        };

        requestQueue.push(queueItem);

        // Notify user of queue position
        const position = requestQueue.length;
        if (position > 1 || processingCount >= MAX_CONCURRENT) {
            bot.sendMessage(chatId, `📋 Đã thêm vào hàng đợi (vị trí: ${position})`, {
                reply_to_message_id: msg.message_id
            }).catch(console.error);
        }

        // Process queue
        processQueue();
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
        processingMsg = await bot.sendMessage(request.chatId, '⏳ Đang tải video không logo...', {
            reply_to_message_id: request.messageId
        });

        const videoData = await getVideoNoWatermark(request.url);

        if (!videoData || !videoData.url) {
            throw new Error('Could not retrieve video URL');
        }

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

        await bot.sendVideo(request.chatId, tempFilePath, {
            caption: '👑 Admin: @phamtheson',
            reply_to_message_id: request.messageId,
            supports_streaming: true
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

    } catch (error) {
        console.error('Error processing TikTok:', error.message);
        stats.failedDownloads++;

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

        errorMessage += '\n\n💡 Tips: Hãy chắc chắn link TikTok hợp lệ và video không quá lớn (max 50MB).';

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
                url: normalizedUrl
            }, {
                timeout: 20000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const data = response.data;
            if (data.code === 0 && data.data?.play) {
                console.log('✅ TikWM API success!');
                return {
                    url: data.data.play,
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

                    if (contentLength > 50 * 1024 * 1024) {
                        console.error(`❌ Video too large: ${fileSizeMB.toFixed(2)} MB (max 50MB)`);
                        throw new Error(`Video quá lớn (${fileSizeMB.toFixed(2)}MB). Telegram chỉ hỗ trợ tối đa 50MB.`);
                    }

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

// Global error handler for polling errors
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
});

// Global error handler for webhook errors
bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error.message);
});
