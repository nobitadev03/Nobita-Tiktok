# 🤖 Nobita Video Downloader Bot (v2)

Nobita Bot là một Telegram Bot mạnh mẽ giúp bạn tải đa phương tiện từ nhiều nền tảng mạng xã hội khác nhau (TikTok, Douyin, Facebook, YouTube Shorts, Instagram Reels) mà **không có logo / watermark**. Ngoài ra, bot còn hỗ trợ trích xuất riêng biệt âm thanh (tải nhạc MP3) trực tiếp từ video cực kỳ nhanh chóng.

---

## 🌟 Chức năng nổi bật

1. **📱 Đa Nền Tảng Hỗ Trợ:**
   - 🎵 **TikTok / Douyin**: Link dạng `/video/`, `vm.tiktok.com`, `vt.tiktok.com`...
   - 🐙 **Facebook**: Hỗ trợ video Post, Reels, Watch (`share/v`, `fb.watch`...)
   - ▶️ **YouTube**: Hỗ trợ tải YouTube Shorts (video < 10 phút)
   - 📸 **Instagram**: Hỗ trợ tải Instagram Reels & Post.
2. **🎵 Tải Nhạc MP3 Thông Minh**: Mọi video được bot phản hồi đều sẽ gắn kèm một tuỳ chọn `[🎵 Tải MP3]`, thuận tiện trong việc trích nhạc làm chuông điện thoại.
3. **🖥️ Bảng Điều Khiển (Dashboard) Admin:**
   - Theo dõi lượt tải, tỷ lệ thành công của Bot theo thời gian thực (Làm mới mỗi 30s).
   - Biểu đồ line-chart trực quan cho vòng 24H.
   - Giao diện UI Dark Mode hiện đại, bóng bẩy trên mọi thiết bị.
4. **🛠 Các Lệnh Tiện Tích Khác:** 
   - Hỗ trợ xếp hạng (Top Users), Lịch sử cá nhân.
   - Các lệnh Admin: `stats`, `panel`, `users`, `queue`, `ban`, `unban`, `vips`, `setlimit`...
   - Tự dọn rác (auto-cleanup file tạm) 24h/lần và reset chỉ số nửa đêm.

---

## 🚀 Hướng Dẫn Cài Đặt (Local / VPS)

### 1. Yêu cầu hệ thống
- Node.js (v18 trở lên khuyến nghị)
- FFmpeg (tuỳ chọn, phục vụ thêm cho YTDL nếu cần thiết)

### 2. Cài đặt các thư viện
```bash
git clone https://github.com/nobitadev03/Nobita-Tiktok.git
cd Nobita-Tiktok
npm install
```

### 3. Cấu hình biến môi trường
Tạo file `.env` tại thư mục gốc với các thông số sau:

```ini
TELEGRAM_BOT_TOKEN=7xxx:AAHxxxxxxxxxx
ADMIN_USER_ID=123456789
DASHBOARD_TOKEN=mat_khau_bao_mat_web
MAX_CONCURRENT_REQUESTS=3
```

### 4. Khởi động bot
```bash
npm start
```
- Bot Tele sẽ đi vào hoạt động: Nhắn `/start` với bot của bạn.
- Bảng Dashboard Admin sẽ có tại `http://localhost:3000/dashboard?token=mat_khau_bao_mat_web`.

---

## ☁️ Triển khai lên Render (Trực tiếp)

Repository này đã được cấu hình sẵn cho Render. 

1. Đăng nhập [Render.com](https://render.com/).
2. Chọn **New Web Service**, kết nối repository này.
3. Tại mục `Environment Variables`, khai báo các thông số đã nêu trên `TELEGRAM_BOT_TOKEN`, `ADMIN_USER_ID`, `DASHBOARD_TOKEN`.
4. Bấm **Deploy**. Nhờ cấu hình `render.yaml` và Web Router Express `/health`, ứng dụng sẽ tự động auto-build và không bị Render đưa vào giấc ngủ đông!

---

## ⚙️ Các Cú Pháp Lệnh (Telegram)

- `/start` : Khởi động bot
- `/help` : Xem danh sách lệnh & hướng dẫn
- `/ping` : Xem tốc độ phản hồi của Server
- `/history`: Xem lại 10 link tải gần nhất.
- `/report <nội dung>`: Gửi báo lỗi tới ADMIN.
- `/top` : Top 5 tải nhiều nhất.

*(Admin có các đặc quyền riêng, vui lòng xem mã nguồn tại `commands` switch/case)*

---

*Phát triển bởi NobitaDev. Bản quyền cấu trúc thuộc về mã nguồn công khai tích hợp API No-Watermark.*
