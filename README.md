# EBP Tracker

Multi-asset Engulfing Bar Print alert web app for traders. Sends Telegram alerts when EBP patterns are detected on Forex, Commodities, Indices, Indian Markets, and Crypto.

## Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)
- Cloudflare account (free tier works)
- [Clerk](https://clerk.com) account — for Google OAuth
- [Twelve Data](https://twelvedata.com) API key — for market data
- A Telegram bot token from [@BotFather](https://t.me/botfather)

---

## 1. Clone & Install

```bash
git clone https://github.com/aicubeapps/ebp_tracker.git
cd ebp_tracker

# Install frontend deps
cd frontend && npm install

# Install worker deps
cd ../worker && npm install
```

---

## 2. Create D1 Database & Run Schema

```bash
# Create the database (copy the database_id from output)
wrangler d1 create ebp-tracker-db

# Update worker/wrangler.toml: replace PLACEHOLDER_REPLACE_AFTER_D1_CREATE with your database_id

# Apply schema
wrangler d1 execute ebp-tracker-db --file=../schema.sql
```

---

## 3. Set Worker Secrets

```bash
cd worker

wrangler secret put CLERK_SECRET_KEY        # sk_live_... from Clerk dashboard
wrangler secret put TWELVE_DATA_API_KEY     # from twelvedata.com
wrangler secret put SHARED_BOT_TOKEN        # Telegram bot token from @BotFather
wrangler secret put DEVELOPER_TELEGRAM_CHAT_ID  # Your personal Telegram chat ID
wrangler secret put UPI_ID                  # Your UPI ID for payments
wrangler secret put ADMIN_USER_ID           # Your Clerk user ID
```

For local dev, create `worker/.dev.vars`:
```
CLERK_SECRET_KEY=sk_test_...
TWELVE_DATA_API_KEY=...
SHARED_BOT_TOKEN=...
DEVELOPER_TELEGRAM_CHAT_ID=...
UPI_ID=yourname@bank
ADMIN_USER_ID=user_...
```

---

## 4. Frontend Environment Variables

Create `frontend/.env.local`:
```
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
VITE_WORKER_URL=https://ebp-tracker-worker.your-subdomain.workers.dev
```

For local dev:
```
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_WORKER_URL=http://localhost:8787
```

---

## 5. Connect Cloudflare Pages to GitHub

1. Go to [Cloudflare Pages](https://pages.cloudflare.com) → Create application → Connect to Git
2. Select this repository
3. Build settings:
   - **Root directory**: `frontend`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. Add environment variables (`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_WORKER_URL`)

---

## 6. Deploy Worker

```bash
cd worker
wrangler deploy
```

---

## 7. Set Telegram Webhook

After deploying the Worker, set the Telegram webhook:
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://ebp-tracker-worker.your-subdomain.workers.dev/telegram/webhook"
```

---

## 8. First Run Checklist

- [ ] D1 database created and schema applied
- [ ] Worker secrets set
- [ ] Worker deployed and `/health` returns `{ "status": "ok" }`
- [ ] Frontend deployed to Cloudflare Pages
- [ ] Clerk Google OAuth configured (redirect URLs set)
- [ ] Telegram webhook set
- [ ] Sign in via invite link and verify Telegram connection
- [ ] Add a test asset and confirm cron fires (check Worker logs)

---

## Local Development

```bash
# Terminal 1 — Frontend
cd frontend
npm run dev
# → http://localhost:5173

# Terminal 2 — Worker
cd worker
wrangler dev
# → http://localhost:8787
```

---

## Architecture

```
Cloudflare Pages (React + Vite)
        ↓ API calls
Cloudflare Worker (Hono)
        ↓ D1 queries
Cloudflare D1 (SQLite)

Worker cron jobs (*/15min, hourly, 4H, daily, weekly):
  → Twelve Data / Yahoo Finance → EBP detection → Telegram alerts
```

## Subscription Tiers

| Plan   | Price | Assets | Days | Custom TF |
|--------|-------|--------|------|-----------|
| FREE   | —     | 3      | —    | No        |
| ☕ Coffee | ₹99  | 5    | 30   | No        |
| 🍺 Beer | ₹249 | 8     | 30   | No        |
| 🍷 Wine | ₹499 | 13    | 30   | Yes       |
