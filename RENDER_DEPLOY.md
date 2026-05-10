# 🚀 HƯỚNG DẪN DEPLOY NOBITA BOT LÊN RENDER

## ✅ BƯỚC 1: CHUẨN BỊ

### 1.1 Tạo tài khoản Render
- Vào https://render.com
- Đăng ký bằng GitHub hoặc Email

### 1.2 Push code lên GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/Nobita-Tiktok.git
git push -u origin main
```

---

## 📝 BƯỚC 2: CẤU HÌNH RENDER

### 2.1 Tạo Web Service mới
1. Vào Render Dashboard: https://dashboard.render.com
2. Click **"New +"** → **"Web Service"**
3. Chọn **"Connect a GitHub repository"**
4. Tìm & chọn repository `Nobita-Tiktok`
5. Nhập thông tin:
   - **Name**: `nobita-tiktok-bot` (hoặc tên khác)
   - **Region**: `Singapore` hoặc gần nhất
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free` (hoặc nâng cấp nếu cần)

### 2.2 Thêm Environment Variables
Sau khi tạo service, vào **"Environment"** và thêm:

| Key | Value | Ví dụ |
|-----|-------|--------|
| `TELEGRAM_BOT_TOKEN` | Token từ @BotFather | `7xxx:AAH...` |
| `ADMIN_USER_ID` | Your Telegram ID | `123456789` |
| `DASHBOARD_TOKEN` | Mật khẩu dashboard | `my_super_secret_123` |
| `MAX_CONCURRENT_REQUESTS` | Số requests cùng lúc | `3` |
| `NODE_ENV` | Environment | `production` |

**Cách lấy Telegram ID:**
- Gửi `/start` tới bot của bạn
- Bot sẽ hiển thị ID trong welcome message

---

## 🔑 BƯỚC 3: LẤY CÁC CREDENTIALS

### 3.1 Lấy TELEGRAM_BOT_TOKEN
1. Mở Telegram, tìm **@BotFather**
2. Gửi `/newbot`
3. Đặt tên bot (vd: `Nobita Tiktok Bot`)
4. Đặt username (vd: `nobita_tiktok_bot`) 
5. Copy token nhận được → dán vào Environment Variable

### 3.2 Lấy ADMIN_USER_ID
1. Gửi `/start` tới bot của bạn
2. Bot sẽ hiển thị Telegram ID trong message
3. Lưu lại số này

### 3.3 Tạo DASHBOARD_TOKEN
- Nhập random string mạnh: `Admin@2026_Nobita_xyz123` (ít nhất 16 ký tự)

---

## ⚙️ BƯỚC 4: DEPLOY

1. Sau khi thêm Environment Variables, click **"Deploy"**
2. Render sẽ tự động build & start service
3. Xem logs: Vào **"Events"** hoặc **"Logs"**
4. Đợi khoảng 2-3 phút cho bot bắt đầu

**Status checks:**
- ✅ Build successful
- ✅ Deploy successful  
- ✅ Service running
- ✅ Health check passing

---

## 🔍 BƯỚC 5: KIỂM TRA

### 5.1 Kiểm tra Bot hoạt động
1. Mở Telegram, tìm bot username của bạn
2. Gửi `/start`
3. Nên nhận được welcome message

### 5.2 Kiểm tra Dashboard
1. Render URL: `https://YOUR_SERVICE_NAME.onrender.com`
2. Dashboard: `https://YOUR_SERVICE_NAME.onrender.com/dashboard?token=YOUR_DASHBOARD_TOKEN`
3. Nhập password (DASHBOARD_TOKEN)

### 5.3 Kiểm tra Health
```
https://YOUR_SERVICE_NAME.onrender.com/health
```
Phải trả về JSON: `{"status":"ok","uptime":...}`

---

## 🛠️ BƯỚC 6: CẬP NHẬT LIVE

### Cập nhật code từ GitHub
```bash
git add .
git commit -m "Update features"
git push origin main
```
Render sẽ **tự động rebuild** từ GitHub. Xem logs để kiểm tra.

### Deploy lại thủ công
- Vào Render Dashboard
- Click service
- Click **"Manual Deploy"** → **"Deploy Latest Commit"**

---

## 📊 BƯỚC 7: GIÁM SÁT

### 7.1 Xem Logs Real-time
Render Dashboard → **"Logs"** tab

### 7.2 Xem CPU/Memory
Dashboard → **"Metrics"** tab

### 7.3 Nhận Alerts
Setting → **"Email Notifications"** → Enable

---

## ⚠️ TROUBLESHOOTING

### ❌ Service crashed
**Dấu hiệu**: Status = "Crashed"
**Giải pháp**:
1. Xem Logs: thường do missing package
2. Kiểm tra `.env` variables đúng chưa
3. Thử Manual Restart: Click **"Restart"** button

### ❌ Health check failed
**Dấu hiệu**: Yellow status, `/health` returns error
**Giải pháp**:
1. Kiểm tra PORT: phải là `process.env.PORT`
2. Đợi 30-60s (ban đầu bị timeout là bình thường)
3. Xem Logs chi tiết

### ❌ Bot không phản hồi
**Dấu hiệu**: Service running nhưng /start không trả lời
**Giải pháp**:
1. Kiểm tra TELEGRAM_BOT_TOKEN đúng
2. Kiểm tra @BotFather bot chưa disabled
3. Xem Logs: có error gì không?

---

## 📱 BƯỚC 8: DASHBOARD ADMIN

**URL**: `https://your-service.onrender.com/dashboard?token=YOUR_DASHBOARD_TOKEN`

### Chức năng:
- 📊 Xem stats real-time (24h chart)
- 👥 Quản lý users (ban/unban)
- 📢 Gửi broadcast message
- 🔧 Xem system status
- 📜 Activity logs

---

## 🎯 TIPS & TRICKS

### 💡 Tối ưu hiệu suất
- Dùng **Render Cron** để auto-cleanup files
- Thêm Redis cache (plan nâng cấp)
- Monitor memory usage regularly

### 💰 Giảm chi phí
- Render Free tier: OK cho ~100 users/day
- Vượt quá: nâng lên Paid plan (~$7/month)
- Hoặc dùng các hosting khác: Railway, Fly.io, Vercel

### 🔐 Bảo mật
- **Không** commit `.env` file!
- Dùng strong `DASHBOARD_TOKEN`
- Thay đổi token định kỳ
- Kiểm tra activity logs regularly

---

## 🆘 LIÊN HỆ SUPPORT

- Render Docs: https://render.com/docs
- Telegram Bot API: https://core.telegram.org/bots/api
- Bot issues: Check Logs → GitHub Issues

---

## ✨ CHÚC MỪNG! 

Bot của bạn đã chạy trên Render! 🎉

Tiếp theo:
- [ ] Cấu hình custom domain (nếu cần)
- [ ] Setup database MySQL/PostgreSQL (nâng cấp)
- [ ] Thêm webhook mode (thay vì polling)
- [ ] Implement queue system cho performance
