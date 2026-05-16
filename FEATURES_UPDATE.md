# Nobita Bot - New Features Update

## 📋 Changelog

### ✨ New Feature 1: TikTok Photo Download Support
**Date**: May 2026  
**Status**: ✅ Implemented

#### What's New:
- Bot now supports downloading TikTok photos and photo albums
- Detect TikTok photo URLs (e.g., `https://www.tiktok.com/@username/photo/ID`)

#### Technical Details:
1. **Updated TikTok Regex Pattern** (Line 739)
   - Old pattern: Only supported `/video/` URLs
   - New pattern: Now supports both `/video/` and `/photo/` URLs
   - Pattern: `(?:tiktok\.com|douyin\.com)\/(?:@[\w.-]+\/(?:video|photo)\/\d+|...)`

2. **Photo Detection Function** (Line 2179-2183)
   ```javascript
   function isTikTokPhotoUrl(url)
   - Detects if a URL is a photo URL
   - Checks for `/photo/` pattern or `modal_id` parameter
   ```

3. **Photo Download Function** (Line 2185-2210)
   ```javascript
   async function downloadTikTokPhoto(url)
   - Uses TikWM API to fetch photo/album data
   - Returns images array for slideshow posts
   - Returns imageCount for display
   ```

4. **Message Handler Update** (Line 1857-1867)
   - Added TikTok-specific case in switch statement
   - Checks if URL is photo or video
   - Routes to appropriate download function

#### Usage:
```
User sends: https://www.tiktok.com/@khanh_0209_pqk/photo/7610823829916519687
Bot response: ✅ Downloads photo and presents options to:
  - 🖼️ Download all photos
  - 🎵 Download background music (MP3)
```

---

### 💬 New Feature 2: Auto-Conversation System
**Date**: May 2026  
**Status**: ✅ Implemented

#### What's New:
- Bot now sends periodic messages to active users
- Makes interaction feel like natural conversation
- Helps re-engage inactive users
- Reminds users about new features (like photo download)

#### Technical Details:

1. **Conversation Message Templates** (Line 1649-1663)
   - 15+ pre-written Vietnamese messages
   - Includes feature highlights and casual greetings
   - Randomly selected for each message

2. **Send Conversation Function** (Line 1666-1681)
   ```javascript
   async function sendConversationMessage(userId)
   - Checks if user is active and not banned/muted
   - Sends random message from CONVERSATION_MESSAGES
   - Silently handles errors if user blocked bot
   ```

3. **Scheduled Auto-Chat** (Line 1684-1707)
   - Sends messages every 2 hours (configurable)
   - Randomly selects 1-5 active users
   - 1-second delay between messages to avoid rate limiting
   - Can be disabled via `AUTO_CHAT_ENABLED` env variable

#### Configuration:
```
Environment Variables:
- AUTO_CHAT_ENABLED: Enable/disable auto-chat (default: true)
- AUTO_CHAT_INTERVAL: Interval in milliseconds (default: 120 * 60 * 1000 = 2 hours)

Example:
AUTO_CHAT_ENABLED=false      # Disable feature
AUTO_CHAT_INTERVAL=3600000   # Send every 1 hour
```

#### Features:
- ✅ Respects ban/mute status
- ✅ Only messages active users
- ✅ Handles users who blocked bot gracefully
- ✅ Logs activities
- ✅ Configurable via environment variables

#### Sample Messages:
- "👋 Chào bạn! Bạn khỏe không? Mình vừa cập nhật tính năng tải ảnh TikTok rồi đó!"
- "👉 Psst... bạn có thể tải ảnh từ TikTok bây giờ! Thử xem nào!"
- "🚀 Nobita Bot vừa được nâng cấp với tính năng tải ảnh TikTok cực hay!"

---

## 🔧 Implementation Summary

### Files Modified:
- **index.js** - Main file with all changes

### Changes Made:

1. **Line 739**: Updated TikTok regex
   - Added `/photo/` pattern support

2. **Lines 1857-1867**: Updated message processor
   - Added TikTok platform case
   - Photo/video detection logic

3. **Lines 1649-1707**: Added auto-conversation system
   - 15+ conversation templates
   - Message sending function
   - Scheduled timer

4. **Lines 2175-2210**: Added TikTok photo utilities
   - Photo URL detection
   - Photo download handler

### Lines of Code Added:
- ~120 lines for auto-conversation feature
- ~35 lines for TikTok photo support
- **Total**: ~155 new lines of code

---

## 🧪 Testing Checklist

- [x] Syntax validation passed
- [x] No compilation errors
- [x] TikTok photo regex works
- [x] Photo download function created
- [x] Message handler updated
- [x] Auto-conversation feature implemented
- [ ] Runtime testing (needs bot to be running)
- [ ] TikTok photo download test
- [ ] Auto-conversation message delivery test

---

## 📝 Notes

### TikTok Photo Support:
- Uses existing TikWM API for consistency
- Handles photo albums as slideshow posts
- User can choose to download photos or music
- Falls back to video download if no photos detected

### Auto-Conversation:
- Messages sent to random 1-5 users every 2 hours
- Does not message banned or muted users
- Graceful error handling if user blocked bot
- Configurable intervals via environment variables

---

## 🚀 Deployment Steps

1. Deploy updated `index.js`
2. Optional: Set environment variables
   ```bash
   AUTO_CHAT_ENABLED=true
   AUTO_CHAT_INTERVAL=120000  # 2 hours
   ```
3. Restart bot
4. Check logs for confirmation:
   - "✅ Auto-conversation feature enabled..."
   - "📬 Sending auto-conversation to X users..."

---

## 🐛 Troubleshooting

### Auto-conversation not working:
- Check if `AUTO_CHAT_ENABLED` is set to `true`
- Check bot logs for errors
- Ensure users are in `stats.activeUsers` map
- Verify bot hasn't been blocked by users

### TikTok photo not downloading:
- Check if URL matches `/photo/` pattern
- Verify TikWM API is accessible
- Check if photo album has images
- Try alternative TikTok video download if photo fails

---

## 📚 References

- TikTok API: https://www.tikwm.com/api/
- Telegram Bot API: https://core.telegram.org/bots/api
- Node Telegram Bot: https://github.com/yagop/node-telegram-bot-api
