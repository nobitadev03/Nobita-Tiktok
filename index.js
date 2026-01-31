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

// --- Server for Render/Heroku (Keep Alive) ---
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
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

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from?.id;

    if (!text) return;

    const match = text.match(tiktokRegex);

    if (match) {
        // Check rate limit
        if (!checkRateLimit(userId)) {
            bot.sendMessage(chatId, '⚠️ Bạn đang gửi quá nhanh! Vui lòng đợi 10 giây.', {
                reply_to_message_id: msg.message_id
            }).catch(console.error);
            return;
        }

        const tiktokUrl = match[0];
        console.log(`[${new Date().toISOString()}] Received TikTok URL: ${tiktokUrl} from ${msg.from?.username || msg.from?.first_name || 'unknown'} (ID: ${userId})`);

        let processingMsg;

        try {
            // Notify user that we are processing
            processingMsg = await bot.sendMessage(chatId, '⏳ Đang tải video không logo...', {
                reply_to_message_id: msg.message_id
            });

            const videoData = await getVideoNoWatermark(tiktokUrl);

            if (!videoData || !videoData.url) {
                throw new Error('Could not retrieve video URL');
            }

            console.log(`[${new Date().toISOString()}] Downloading video...`);

            // Download video to temporary file
            // Telegram can't access TikTok CDN URLs directly, so we must download first
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

            // Wait for download to complete
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log(`[${new Date().toISOString()}] Video downloaded. Uploading to Telegram...`);

            // Send the video file
            await bot.sendVideo(chatId, tempFilePath, {
                caption: '👑 Admin: @phamtheson',
                reply_to_message_id: msg.message_id,
                supports_streaming: true
            });

            // Delete temp file after sending
            fs.unlink(tempFilePath, (err) => {
                if (err) console.error('Error deleting temp file:', err);
                else console.log(`[${new Date().toISOString()}] Temp file deleted: ${tempFileName}`);
            });

            // Delete the processing message
            if (processingMsg) {
                bot.deleteMessage(chatId, processingMsg.message_id).catch(() => { });
            }

            console.log(`[${new Date().toISOString()}] ✅ Video sent successfully!`);

        } catch (error) {
            console.error('Error processing TikTok:', error.message);
            console.error('Full error:', error);

            // Determine specific error message
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

            // Only try to edit message if we successfully sent the processing message
            if (processingMsg) {
                bot.editMessageText(errorMessage, {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                }).catch(() => { });
            }
        }
    }
});

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
    // If it's a shortened URL (vm.tiktok.com or vt.tiktok.com), expand it
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
    // Normalize URL first
    const normalizedUrl = await normalizeUrl(url);
    console.log(`Processing URL: ${normalizedUrl}`);

    // Try multiple APIs for better reliability
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

            // Parse HTML response to extract video URL
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

    // Try each API in sequence with retry logic
    for (let i = 0; i < apis.length; i++) {
        try {
            const result = await retryWithBackoff(apis[i], 2, 1000);

            if (result && result.url) {
                // Verify the URL is accessible and check file size
                try {
                    console.log('Verifying video URL...');
                    const headResponse = await axios.head(result.url, {
                        timeout: 10000,
                        maxRedirects: 5
                    });
                    const contentLength = parseInt(headResponse.headers['content-length'] || '0');
                    const fileSizeMB = contentLength / (1024 * 1024);

                    console.log(`✅ Video verified! Size: ${fileSizeMB > 0 ? fileSizeMB.toFixed(2) + ' MB' : 'Unknown'}`);

                    // Telegram bot API has a 50MB limit for videos
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
                    // If just verification fails but we have URL, still try it
                    if (result.url) {
                        console.log('⚠️ Proceeding with unverified URL...');
                        return result;
                    }
                }
            }
        } catch (error) {
            console.error(`❌ API ${i + 1} failed:`, error.message);
            // Continue to next API
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
    // Don't crash on polling errors, just log them
});

// Global error handler for webhook errors
bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error.message);
});

