# 🤖 Nobita Video Downloader Bot v4.0 — Ultimate Edition

Nobita Bot là một Telegram Bot cực mạnh giúp bạn tải video/media từ **13 nền tảng** mạng xã hội **không watermark**, với dashboard admin hiện đại, hệ thống đa ngôn ngữ, batch download, favorites, và nhiều tính năng nâng cao.

---

## 🌟 Chức năng nổi bật

### 📱 Hỗ trợ 13 nền tảng
| # | Nền tảng | Loại link hỗ trợ |
|---|----------|------------------|
| 1 | 🎵 **TikTok / Douyin** | `/video/`, `vm.tiktok.com`, `vt.tiktok.com` |
| 2 | 📘 **Facebook** | Post, Reels, Watch, `share/v`, `fb.watch` |
| 3 | ▶️ **YouTube Shorts** | `youtube.com/shorts/` |
| 4 | 📸 **Instagram** | Reels & Posts |
| 5 | 🐦 **Twitter/X** | Tweet videos |
| 6 | 📌 **Pinterest** | Pin videos |
| 7 | 👻 **Snapchat** | Spotlight, Stories |
| 8 | 🤖 **Reddit** | Video posts |
| 9 | 📺 **Bilibili** | Video BV/av links |
| 10 | 🧵 **Threads** | Post videos |
| 11 | 🎬 **Vimeo** | Video links |
| 12 | 📹 **Dailymotion** | Video links |
| 13 | 🎯 **Likee** | Video/post links |

### ✨ Tính năng mới v4.0
- 📦 **Batch Download** — Gửi nhiều link cùng lúc để tải hàng loạt (tối đa 5 link/lần)
- ⭐ **Favorites/Bookmarks** — Lưu video yêu thích, xem lại bất cứ lúc nào
- 🌐 **Đa ngôn ngữ** — Hỗ trợ Tiếng Việt 🇻🇳 và English 🇬🇧
- 📊 **Thống kê nền tảng** — Xem chi tiết lượt tải theo từng nền tảng
- 🎵 **Tải MP3** — Trích xuất audio từ video
- 🔷 **TikTok HD** — Hỗ trợ tải video chất lượng cao
- 👑 **4 cấp bậc** — Admin > VIP > Premium > Regular (ưu tiên hàng đợi)
- 🛡️ **Anti-spam** — Auto-ban, rate limiting, slowmode, cảnh cáo
- 💬 **2-way chat** — Nhắn tin trực tiếp với Admin qua bot
- 📢 **Broadcast** — Gửi thông báo tới tất cả user

### 🖥️ Dashboard Admin
- 🎨 **Glassmorphism UI** với dark/light theme
- 📊 **Donut chart** phân phối nền tảng + biểu đồ hoạt động 24h & 7 ngày
- 👥 **Quản lý user** với tìm kiếm, lọc, ban/unban/VIP nhanh
- 📋 **Queue real-time** theo dõi hàng đợi xử lý
- 📢 **Broadcast & DM** gửi thông báo từ dashboard
- 🛡️ **Moderation** — ban, mute, warn, slowmode, rate limit
- ⚙️ **Settings** — cấu hình tất cả thông số bot
- 📝 **Live logs** — nhật ký hoạt động real-time
- ⌨️ **Keyboard shortcuts** — phím tắt 1-8 chuyển trang, T theme, R refresh
- 📱 **Responsive** — mobile hamburger menu

---

## 🚀 Hướng Dẫn Cài Đặt

### 1. Yêu cầu hệ thống
- Node.js (v18 trở lên)
- FFmpeg (tùy chọn, để xử lý media nâng cao)

### 2. Cài đặt
```bash
git clone https://github.com/nobitadev03/Nobita-Tiktok.git
cd Nobita-Tiktok
npm install
```

### 3. Cấu hình biến môi trường
Tạo file `.env` tại thư mục gốc:

```ini
TELEGRAM_BOT_TOKEN=7xxx:AAHxxxxxxxxxx
ADMIN_USER_ID=123456789
DASHBOARD_TOKEN=mat_khau_bao_mat_web
MAX_CONCURRENT_REQUESTS=5
```

### 4. Khởi động bot
```bash
npm start
```
- Bot sẽ hoạt động ngay. Nhắn `/start` với bot.
- Dashboard Admin: `http://localhost:3000/dashboard?token=mat_khau_bao_mat_web`

---

## ☁️ Triển khai lên Render

1. Đăng nhập [Render.com](https://render.com/)
2. Chọn **New Web Service**, kết nối repository này
3. Khai báo Environment Variables: `TELEGRAM_BOT_TOKEN`, `ADMIN_USER_ID`, `DASHBOARD_TOKEN`
4. Deploy — tự động build nhờ `render.yaml`

---

## ⚙️ Lệnh Bot (Telegram)

### 👤 User Commands
| Lệnh | Mô tả |
|-------|--------|
| `/start` | Khởi động bot |
| `/help` | Xem hướng dẫn & danh sách lệnh |
| `/ping` | Kiểm tra tốc độ phản hồi |
| `/status` | Trạng thái hệ thống |
| `/platforms` | Xem các nền tảng hỗ trợ |
| `/myinfo` | Thông tin tài khoản cá nhân |
| `/history` | Lịch sử tải 20 link gần nhất |
| `/top` | Top 10 user tích cực nhất |
| `/report <nội dung>` | Gửi báo lỗi cho Admin |
| `/lang` | Chuyển đổi ngôn ngữ VI/EN |
| `/favorites` | Xem danh sách yêu thích |
| `/platformstats` | Thống kê tải theo nền tảng |

### 👑 Admin Commands
| Lệnh | Mô tả |
|-------|--------|
| `/stats` | Thống kê tổng quan |
| `/panel` | Mở dashboard |
| `/botinfo` | Thông tin hệ thống |
| `/ban`, `/unban` | Quản lý ban user |
| `/warn` | Cảnh cáo user |
| `/vip`, `/premium` | Quản lý cấp bậc |
| `/slowmode` | Bật/tắt chế độ chậm |
| `/setlimit` | Giới hạn tải riêng user |
| `/broadcast`, `/announce` | Gửi thông báo |
| `/maintenance` | Bật/tắt bảo trì |

---

## 📊 Dashboard Keyboard Shortcuts

| Phím | Chức năng |
|------|-----------|
| `1-8` | Chuyển nhanh giữa các trang |
| `T` | Chuyển dark/light theme |
| `R` | Làm mới dữ liệu |
| `?` | Mở bảng phím tắt |

---

*Phát triển bởi NobitaDev — Nobita Bot v4.0 Ultimate Edition*
