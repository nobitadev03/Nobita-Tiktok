# 🔌 REST API Documentation

## Base URL
```
https://your-bot-domain.com/api
```

## Authentication
All endpoints require one of:
- Query: `?token=YOUR_TOKEN`
- Header: `X-Dashboard-Token: YOUR_TOKEN`
- Header: `Authorization: Bearer YOUR_TOKEN`

---

## 🏥 Health & Status

### Health Check
```http
GET /admin/health
```
**No authentication required**

**Response:**
```json
{
  "status": "ok",
  "version": "3.1.0",
  "uptime": 3600,
  "timestamp": "2026-05-10T10:00:00Z"
}
```

---

## 📊 Statistics

### Get Today's Stats
```http
GET /stats
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "date": "2026-05-10",
    "total_requests": 150,
    "successful_downloads": 140,
    "failed_downloads": 10,
    "successRate": "93.3",
    "totalUsers": 45,
    "bannedUsers": 2,
    "uptime": 3600,
    "timestamp": "2026-05-10T10:00:00Z"
  }
}
```

### Get Activity Logs
```http
GET /stats/activity?limit=50
```

**Query Parameters:**
- `limit` (optional): Max logs to return (default: 50, max: 200)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "type": "download",
      "message": "Successfully downloaded from TikTok",
      "user_id": 123456,
      "created_at": "2026-05-10T10:00:00Z"
    }
  ]
}
```

---

## 👥 User Management

### Get All Users
```http
GET /users
```

**Response:**
```json
{
  "success": true,
  "count": 45,
  "data": [
    {
      "id": 123456,
      "username": "johndoe",
      "first_name": "John",
      "last_name": "Doe",
      "download_count": 150,
      "created_at": "2026-01-15T08:30:00Z",
      "last_active": "2026-05-10T09:45:00Z",
      "is_banned": 0,
      "is_muted": 0,
      "is_vip": 1,
      "is_premium": 0,
      "warnings": 0
    }
  ]
}
```

### Get Specific User
```http
GET /users/:userId
```

**Parameters:**
- `userId`: User's Telegram ID

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 123456,
    "username": "johndoe",
    "first_name": "John",
    "download_count": 150,
    ...
  }
}
```

### Get Top Users
```http
GET /users/top/:limit
```

**Parameters:**
- `limit`: Number of top users (max: 100)

**Response:**
```json
{
  "success": true,
  "count": 10,
  "data": [
    {
      "id": 123456,
      "first_name": "John",
      "download_count": 500
    }
  ]
}
```

### Ban User
```http
POST /users/:userId/ban
```

**Parameters:**
- `userId`: User's Telegram ID

**Response:**
```json
{
  "success": true,
  "message": "User 123456 has been banned"
}
```

### Unban User
```http
POST /users/:userId/unban
```

**Parameters:**
- `userId`: User's Telegram ID

**Response:**
```json
{
  "success": true,
  "message": "User 123456 has been unbanned"
}
```

---

## 🔧 Admin Operations

### Get Bot Configuration
```http
GET /admin/config
```

**Response:**
```json
{
  "success": true,
  "config": {
    "bot": {
      "version": "3.1.0",
      "name": "Nobita Downloader",
      "features": {...}
    },
    "performance": {
      "maxConcurrentRequests": 5,
      "defaultRateLimit": 3
    }
  }
}
```

### Send Broadcast
```http
POST /admin/broadcast
```

**Request Body:**
```json
{
  "message": "📢 Announcement text here",
  "target": "all|vip|premium"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Broadcast queued for sending"
}
```

### Send Announcement
```http
POST /admin/announce
```

**Request Body:**
```json
{
  "message": "📌 Important announcement"
}
```

### Cleanup Old Logs
```http
POST /admin/cleanup
```

**Response:**
```json
{
  "success": true,
  "message": "Cleanup completed",
  "changes": 150
}
```

### Restart Bot
```http
POST /admin/restart
```

**Response:**
```json
{
  "success": true,
  "message": "Restart request received"
}
```

---

## ❌ Error Responses

### 401 Unauthorized
```json
{
  "success": false,
  "error": "Unauthorized - Invalid token"
}
```

### 400 Bad Request
```json
{
  "success": false,
  "error": "Invalid userId format"
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "User not found"
}
```

### 500 Server Error
```json
{
  "success": false,
  "error": "Internal server error"
}
```

---

## 📝 cURL Examples

### Get Stats
```bash
curl -H "X-Dashboard-Token: YOUR_TOKEN" \
  https://your-bot.com/api/stats
```

### Ban User
```bash
curl -X POST \
  -H "X-Dashboard-Token: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId": 123456789}' \
  https://your-bot.com/api/users/123456789/ban
```

### Get Top Users
```bash
curl -H "X-Dashboard-Token: YOUR_TOKEN" \
  https://your-bot.com/api/users/top/10
```

### Send Broadcast
```bash
curl -X POST \
  -H "X-Dashboard-Token: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello everyone!",
    "target": "all"
  }' \
  https://your-bot.com/api/admin/broadcast
```

---

## 🔑 Rate Limiting

Currently, no rate limiting on admin APIs. Consider adding in production.

Recommended: 100 requests/minute per token

---

## 📚 Swagger UI

Access interactive API docs at:
```
https://your-bot.com/api-docs
```

---

## 🆘 Troubleshooting

**401 Unauthorized:**
- Check token is correct
- Verify `DASHBOARD_TOKEN` in `.env`

**404 Not Found:**
- Endpoint may not exist
- Check base URL

**500 Server Error:**
- Check logs: `tail -f logs/error.log`
- Restart bot

---

Last Updated: May 10, 2026
