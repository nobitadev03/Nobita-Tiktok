require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

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

// Regex to detect TikTok links
// Covers various formats: vm.tiktok.com, vt.tiktok.com, www.tiktok.com
const tiktokRegex = /(?:https?:\/\/)?(?:www\.|vt\.|vm\.|t\.)?tiktok\.com\/[^\s]+/;

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    const match = text.match(tiktokRegex);

    if (match) {
        const tiktokUrl = match[0];
        console.log(`Received TikTok URL: ${tiktokUrl} from ${msg.from?.username || msg.from?.first_name || 'unknown'}`);

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

            // Send the video
            await bot.sendVideo(chatId, videoData.url, {
                caption: '👑 Admin: @phamtheson',
                reply_to_message_id: msg.message_id
            });

            // Delete the processing message
            if (processingMsg) {
                bot.deleteMessage(chatId, processingMsg.message_id).catch(() => { });
            }

        } catch (error) {
            console.error('Error processing TikTok:', error.message);
            // Only try to edit message if we successfully sent the processing message
            if (processingMsg) {
                bot.editMessageText('❌ Có lỗi xảy ra. Link lỗi hoặc Bot không gửi được file (do quyền hạn/file quá nặng).', {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                }).catch(() => { });
            }
        }
    }
});

// Helper function to get video without watermark
async function getVideoNoWatermark(url) {
    try {
        // Using TikWM API which is reliable and free
        const response = await axios.post('https://www.tikwm.com/api/', {
            url: url
        });

        const data = response.data;

        if (data.code === 0) {
            return {
                url: data.data.play, // The URL of the video without watermark
                title: data.data.title,
                author: data.data.author.nickname
            };
        } else {
            console.error('TikWM API error:', data);
            return null;
        }
    } catch (error) {
        console.error('Axios error:', error);
        // Fallback or retry logic could go here
        return null;
    }
}
