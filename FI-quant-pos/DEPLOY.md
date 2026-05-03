# FI/QUANT — Complete Deployment Guide
## Zero hallucination · Real NSE data · Free stack · 10 minute setup

---

## Architecture (100% Free)

```
Browser (index.html)
    │
    ├─► Vercel Edge Functions (api/*.js)  ← your code runs here
    │       │
    │       ├─► Yahoo Finance        ← real OHLCV (free, no key)
    │       ├─► NSE India API        ← VIX, FII, PCR (free, no key)
    │       ├─► Vercel KV (Redis)    ← fast cache + session state (free 256MB)
    │       └─► GitHub JSON files    ← permanent trade history (free private repo)
    │
    └─► GitHub Actions               ← daily cache warm (free 2000 min/month)
```

**Cost: ₹0/month forever**
- Vercel Hobby: free (100GB bandwidth, 100k edge invocations/day)
- Vercel KV: free tier (256MB, 500k requests/day)
- GitHub: free private repos + Actions

---

## Step 1 — Create GitHub repositories (5 min)

### 1a. App repository (your code)
```bash
# On your computer:
git init fi-quant
cd fi-quant
# Copy all files from this zip into here
git add .
git commit -m "init: FI/QUANT v12"
# Create repo on github.com (name: fi-quant, can be public)
git remote add origin https://github.com/YOURNAME/fi-quant.git
git push -u origin main
```

### 1b. Database repository (private — your trade history)
1. Go to github.com → New repository
2. Name: `fi-quant-db`
3. Set to **Private** (your trade data)
4. Initialize with README
5. Copy the repo path: `YOURNAME/fi-quant-db`

### 1c. Create GitHub Personal Access Token (PAT)
1. GitHub → Settings → Developer Settings → Personal Access Tokens → Tokens (classic)
2. Click **Generate new token (classic)**
3. Name: `fi-quant-db-writer`
4. Scopes: check **repo** (full repo access)
5. Expiration: No expiration (or 1 year)
6. Click **Generate** — copy the token: `ghp_xxxxxxxxxxxx`
7. **Save it somewhere safe — you won't see it again**

---

## Step 2 — Deploy to Vercel (3 min)

### 2a. Install Vercel CLI
```bash
npm install -g vercel
vercel login
```

### 2b. Link and deploy
```bash
cd fi-quant
vercel           # follow prompts, deploy to preview
vercel --prod    # deploy to production
```

Note your production URL: `https://fi-quant-xxxx.vercel.app`

### 2c. Create Vercel KV database
1. Go to vercel.com → Your project → Storage tab
2. Click **Create Database** → choose **KV**
3. Name: `fi-quant-kv`
4. Click Create — Vercel auto-adds env vars to your project:
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`

---

## Step 3 — Set environment variables (2 min)

In Vercel dashboard → Your project → Settings → Environment Variables:

| Variable | Value | Where to get |
|---|---|---|
| `KV_REST_API_URL` | Auto-added by Vercel KV | Vercel Storage tab |
| `KV_REST_API_TOKEN` | Auto-added by Vercel KV | Vercel Storage tab |
| `GITHUB_TOKEN` | `ghp_xxxxxxxxxxxx` | Step 1c above |
| `GITHUB_REPO` | `YOURNAME/fi-quant-db` | Step 1b above |
| `GITHUB_BRANCH` | `main` | (literal string) |

After adding variables:
```bash
vercel --prod   # redeploy with new env vars
```

---

## Step 4 — Initialize the database (1 min)

```bash
# In your fi-quant directory:
GITHUB_TOKEN=ghp_xxx GITHUB_REPO=YOURNAME/fi-quant-db node scripts/seed-github-db.js
```

Expected output:
```
✅  Created: README.md
✅  Created: db/trades/2025-05.json
✅  Created: db/strategies/_index.json
✅  Created: db/sde/2025-W20.json
✅  Created: db/stats/2025-05.json
✅  Done! Your GitHub DB repo is ready.
```

---

## Step 5 — Add GitHub Actions secret (1 min)

1. Go to your **app repo** (fi-quant) on GitHub
2. Settings → Secrets and variables → Actions
3. Click **New repository secret**
4. Name: `VERCEL_URL`
5. Value: `https://fi-quant-xxxx.vercel.app` (your production URL)
6. Save

The daily OHLCV refresh will now run automatically every weekday at 8:30 AM IST.

---

## Step 6 — Copy index.html to public folder

```bash
mkdir public
cp FI_QUANT_v12.html public/index.html
git add .
git commit -m "deploy: v12 with real data APIs"
git push
```
Vercel auto-deploys on every push.

---

## Step 7 — Configure the app (in Settings tab)

Open your deployed app → Settings tab:

1. **API Base URL**: paste `https://fi-quant-xxxx.vercel.app`
2. Click **Test Connection** — should show ✅ green
3. The app will now use real Yahoo Finance OHLCV + real NSE data

---

## Verification checklist

```
✅ Today tab: VIX shows a real number (not 0.0 or —)
✅ Today tab: Nifty 50 price is current market price
✅ Discovery: clicking Start uses real OHLCV bars in backtest
✅ FII data: shows today's or yesterday's FII net buy/sell
✅ Trades saved: close a paper trade → check github.com/YOURNAME/fi-quant-db/db/trades/
```

---

## What's real vs what's simulated

| Data | Source | Real? |
|---|---|---|
| OHLCV price bars | Yahoo Finance via `/api/ohlcv` | ✅ Real NSE traded data |
| India VIX | NSE India via `/api/nse?type=vix` | ✅ Real live data |
| FII/DII flows | NSE India via `/api/nse?type=fii` | ✅ Real daily data |
| Put/Call ratio | NSE option chain via `/api/nse?type=pcr` | ✅ Real live data |
| Paper trade results | Simulated from real OHLCV | 📊 Based on real data |
| Auto-Lab cycle | Simulation engine | 📊 Paper trades, not live |
| Trade history | Vercel KV + GitHub | ✅ Persisted permanently |
| Discovery backtest | Walk-forward on real OHLCV | ✅ Real data, no hallucination |

---

## Troubleshooting

**VIX shows "—" or error:**
- NSE rate-limits scrapers. The app retries with cached data.
- If persistent: NSE may have changed their API. Open `api/nse.js` and check the endpoint.

**OHLCV fetch fails:**
- Yahoo Finance occasionally blocks. The 25h KV cache means only the first fetch per symbol per day hits Yahoo.
- Force refresh: `GET /api/ohlcv?symbol=RELIANCE&force=1`

**GitHub DB not updating:**
- Check your PAT hasn't expired (github.com → Settings → Tokens)
- Check `GITHUB_REPO` env var is exactly `YOURNAME/fi-quant-db` (no https://)

**Vercel KV quota:**
- Free tier: 500k requests/day. At 30 symbols × 24 refreshes = 720 requests/day. Well within limits.

---

## Daily workflow (once deployed)

```
8:30 AM IST → GitHub Actions refreshes OHLCV cache automatically
9:00 AM IST → Open your Vercel URL in browser
9:15 AM IST → Click "▶ Start Auto-Lab" — real paper trades begin
3:30 PM IST → Review promoted strategies in Lab → Strategies tab
Weekend     → Click "▶ Start Discovery" — runs all night on real data
Monday 9AM  → Check Discovery leaderboard — promote top 3 to Lab
```
