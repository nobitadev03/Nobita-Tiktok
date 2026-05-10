// ============================================================
// 🤖 BOT SERVICE (Core Bot Logic)
// ============================================================

const config = require('../config');
const logger = require('../logger');
const UserService = require('./UserService');
const StatsService = require('./StatsService');

class BotService {
    constructor(bot) {
        this.bot = bot;
        this.requestQueue = [];
        this.processingCount = 0;
    }

    /**
     * Initialize bot
     */
    async init() {
        logger.info(`🤖 Initializing Nobita Bot v${config.bot.version}`);
        config.validate();
    }

    /**
     * Handle message start
     */
    async handleStart(userId, userData) {
        UserService.getOrCreate(userId, userData);
        UserService.updateLastActive(userId);
        
        const welcomeMsg = `
🎬 **Nobita Video Downloader Bot v${config.bot.version}**

Xin chào! Tôi là bot tải video không watermark từ các nền tảng:
• 🎵 TikTok/Douyin
• 📸 Instagram/Reels
• 🐙 Facebook
• ▶️ YouTube Shorts

**Cách sử dụng:**
1. Gửi link video (bất kỳ nền tảng nào)
2. Tôi sẽ tải và gửi cho bạn
3. Có option tải MP3 riêng

**Lệnh:**
/start - Bắt đầu
/help - Trợ giúp
/stats - Thống kê cá nhân
/top - Top 10 người dùng
/ping - Kiểm tra bot

${config.dashboard.enablePanel ? '📊 Dashboard: ' + config.server.url + '/dashboard' : ''}

Powered by @phamtheson ⭐
        `;

        this.bot.sendMessage(userId, welcomeMsg, { parse_mode: 'Markdown' });
    }

    /**
     * Handle help command
     */
    async handleHelp(userId) {
        const helpMsg = `
📖 **HƯỚNG DẪN SỬ DỤNG**

**Tải Video:**
Đơn giản gửi link video từ:
• TikTok (vm.tiktok.com, vt.tiktok.com...)
• Facebook (fb.watch, share/video...)
• Instagram (instagram.com/reel/...)
• YouTube Shorts (youtube.com/shorts/...)
• Douyin (douyin.com...)

**Tính năng:**
✨ Tải không watermark
🎵 Export MP3
⚡ Tải nhanh chóng
🔒 Riêng tư

**Lệnh:**
/start - Bắt đầu
/help - Trợ giúp này
/stats - Thống kê của bạn
/top - Top 10 người tải nhiều nhất
/ping - Kiểm tra tốc độ bot
/report <link> - Báo lỗi

**Gặp vấn đề?**
- Link không hoạt động? Thử link khác
- Bot không phản hồi? Gửi /ping
- Cần help? Liên hệ admin

Cảm ơn bạn sử dụng! ❤️
        `;

        this.bot.sendMessage(userId, helpMsg, { parse_mode: 'Markdown' });
    }

    /**
     * Handle stats command
     */
    async handleStats(userId) {
        const user = UserService.getById(userId);
        if (!user) {
            this.bot.sendMessage(userId, '❌ Người dùng không tìm thấy');
            return;
        }

        const statsMsg = `
📊 **THỐNG KÊ CÁ NHÂN**

👤 User: ${user.first_name || 'Unknown'}
🔢 ID: \`${userId}\`
📥 Số video đã tải: **${user.download_count}**
📅 Tham gia từ: ${new Date(user.created_at).toLocaleDateString('vi-VN')}
⏰ Hoạt động cuối: ${new Date(user.last_active).toLocaleString('vi-VN')}

${user.is_vip ? '⭐ **VIP User**' : ''}
${user.is_premium ? '💎 **Premium User**' : ''}
${user.is_banned ? '🚫 **Bị cấm**' : ''}
        `;

        this.bot.sendMessage(userId, statsMsg, { parse_mode: 'Markdown' });
    }

    /**
     * Handle top command
     */
    async handleTop(userId) {
        const topUsers = UserService.getTopUsers(10);
        let topMsg = '🏆 **TOP 10 NGƯỜI DÙNG NỔI TIẾNG**\n\n';

        topUsers.forEach((user, index) => {
            topMsg += `${index + 1}. ${user.first_name || user.username || 'Anonymous'} - ${user.download_count} downloads\n`;
        });

        this.bot.sendMessage(userId, topMsg, { parse_mode: 'Markdown' });
    }

    /**
     * Handle ping command
     */
    async handlePing(userId) {
        const startTime = Date.now();
        const msg = await this.bot.sendMessage(userId, '🏓 Pinging...');
        const latency = Date.now() - startTime;

        this.bot.editMessageText(
            `🏓 Pong!\nLatency: ${latency}ms`,
            { chat_id: userId, message_id: msg.message_id }
        );
    }

    /**
     * Queue request for processing
     */
    queueRequest(request) {
        this.requestQueue.push(request);
    }

    /**
     * Get queue length
     */
    getQueueLength() {
        return this.requestQueue.length;
    }

    /**
     * Get processing count
     */
    getProcessingCount() {
        return this.processingCount;
    }
}

module.exports = BotService;
