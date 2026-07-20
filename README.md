# EBP Tracker

Multi-signal alert platform for Engulfing Bar Print (EBP) detection
across forex, commodities, indices, and Indian market assets.

## Stack
- Frontend: React + Vite + MUI → Cloudflare Pages
- Backend: Cloudflare Worker (zero dependencies)
- Database: Cloudflare D1 (SQLite)
- Auth: Clerk (Google OAuth)
- Data: Twelve Data API + Yahoo Finance fallback
- Alerts: Telegram Bot API (shared bot)
- Payments: UPI (manual verification)

## Prerequisites
- Node.js 18+
- Cloudflare account
- Clerk account (clerk.com)
- Twelve Data account (twelvedata.com)
- Telegram bot (via @BotFather)

## Setup

### 1. Clone
```
git clone https://github.com/YOUR_USERNAME/ebp-tracker
cd ebp-tracker
```

### 2. Frontend
```
cd frontend
npm install
cp .env.example .env.local
# Fill in VITE_CLERK_PUBLISHABLE_KEY and VITE_WORKER_URL
```

### 3. D1 Database
Create database in Cloudflare dashboard → D1 → Create
Run each statement in schema.sql via D1 Console

### 4. Worker Secrets (Cloudflare dashboard)
```
CLERK_SECRET_KEY
TWELVE_DATA_API_KEY
SHARED_BOT_TOKEN
DEVELOPER_TELEGRAM_CHAT_ID
UPI_ID
APP_URL
```

### 5. Worker Deployment
Deploy worker-bundle-v4.js via Cloudflare dashboard editor
Add D1 binding: variable name DB → ebp-tracker-db
Add 5 cron triggers (Settings → Trigger events):
```
*/15 * * * *   M15
0 * * * *      1H
0 */4 * * *    4H
0 21 * * 1-5   Daily NY close
0 21 * * 5     Weekly NY close
```

### 6. Frontend Deploy
Connect GitHub repo to Cloudflare Pages
- Build command: `npm run build`
- Build output: `dist`
- Root directory: `frontend`
- Environment variables:
  - `VITE_CLERK_PUBLISHABLE_KEY`
  - `VITE_WORKER_URL`

### 7. First admin
Sign in to live site → copy your Clerk user ID from D1:
```sql
SELECT id FROM users;
UPDATE users SET is_admin = 1 WHERE id = 'your_id';
```

### 8. Telegram bot webhook
```
https://api.telegram.org/botYOUR_TOKEN/setWebhook?url=YOUR_WORKER_URL/telegram/webhook
```

## Alert Types
- **EBP**: Engulfing Bar Print (wick sweep + close beyond body)
- **Sweep**: Liquidity sweep (wick beyond + close back inside) [Phase 7]
- **Combined**: HTF EBP + LTF Sweep confluence [Phase 7]

## Timeframes
- EBP Worker: W, D, 4H, 1H, M15
- Sweep Worker (Phase 7): 4H, 1H, M30, M15, M5
