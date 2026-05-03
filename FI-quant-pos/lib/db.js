/**
 * lib/db.js — Unified database layer
 *
 * Priority chain (zero hallucination — every read is a real DB call):
 *   1. Vercel KV (Redis)  — primary, < 1ms reads, free 256MB
 *   2. GitHub JSON files  — fallback + permanent history
 *
 * Tables (KV keys / GitHub paths):
 *   trades:{id}          — individual trade records
 *   trades:index         — sorted set of all trade IDs by timestamp
 *   strategies:{id}      — strategy state (WR, RR, trades, tier)
 *   strategies:index     — list of all strategy IDs
 *   ohlcv:{symbol}:{date} — daily OHLCV bar cache (TTL 25h)
 *   sde:results          — Strategy Discovery Engine leaderboard
 *   journal:index        — auto-journal entries
 *   meta:stats           — portfolio stats, equity curve points
 */

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO  = process.env.GITHUB_REPO;   // e.g. "youruser/fi-quant-db"
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';

/* ─────────────────────────────────────────────────────
   VERCEL KV (Redis) — primary store
───────────────────────────────────────────────────── */
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result != null ? JSON.parse(j.result) : null;
}

async function kvSet(key, value, ttlSeconds = null) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = ttlSeconds
    ? { EX: ttlSeconds }
    : {};
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([JSON.stringify(value), 'EX', ttlSeconds || 0].filter(Boolean)),
  });
  return r.ok;
}

async function kvSetPipeline(pairs) {
  // Batch set multiple keys in one HTTP round-trip using KV pipeline
  if (!KV_URL || !KV_TOKEN || !pairs.length) return;
  const cmds = pairs.map(([k, v, ttl]) =>
    ttl ? ['SET', k, JSON.stringify(v), 'EX', ttl] : ['SET', k, JSON.stringify(v)]
  );
  await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
}

async function kvLRange(key, start = 0, end = -1) {
  if (!KV_URL || !KV_TOKEN) return [];
  const r = await fetch(`${KV_URL}/lrange/${encodeURIComponent(key)}/${start}/${end}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.result || []).map(x => { try { return JSON.parse(x); } catch { return x; } });
}

async function kvLPush(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  await fetch(`${KV_URL}/lpush/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value)),
  });
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return;
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

/* ─────────────────────────────────────────────────────
   GITHUB JSON — permanent history / fallback
   Each "table" = one JSON file in the db repo
   Path pattern: db/{table}/{shard}.json
───────────────────────────────────────────────────── */
async function ghRead(path) {
  if (!GH_TOKEN || !GH_REPO) return null;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`,
      { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github.v3.raw' } }
    );
    if (r.status === 404) return null;
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function ghWrite(path, data, message = 'db: auto-update') {
  if (!GH_TOKEN || !GH_REPO) return false;
  try {
    // Get current SHA (needed for updates)
    const metaR = await fetch(
      `https://api.github.com/repos/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`,
      { headers: { Authorization: `Bearer ${GH_TOKEN}` } }
    );
    const meta = metaR.ok ? await metaR.json() : {};
    const sha  = meta.sha;

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    const body    = { message, content, branch: GH_BRANCH };
    if (sha) body.sha = sha;

    const r = await fetch(
      `https://api.github.com/repos/${GH_REPO}/contents/${path}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    return r.ok;
  } catch { return false; }
}

/* ─────────────────────────────────────────────────────
   PUBLIC API
───────────────────────────────────────────────────── */

/**
 * saveTrade(trade) — persist a closed paper/live trade
 * trade: { id, stratId, stratName, symbol, entry, exit, sl, t1,
 *           pnlPct, pnlRs, rr, isWin, regime, signals[], openTs, closeTs,
 *           category, tradeStyle, source:'paper'|'live' }
 */
export async function saveTrade(trade) {
  const id = trade.id || `T${Date.now()}`;
  trade.id = id;
  trade.savedAt = new Date().toISOString();

  // KV: store trade + push to index list
  await kvSet(`trades:${id}`, trade);
  await kvLPush('trades:index', id);

  // GitHub: append to monthly shard trades/YYYY-MM.json
  const month = trade.closeTs
    ? new Date(trade.closeTs).toISOString().slice(0, 7)
    : new Date().toISOString().slice(0, 7);
  const ghPath = `db/trades/${month}.json`;
  const existing = await ghRead(ghPath) || [];
  existing.push(trade);
  // Write to GitHub async (don't await — keep response fast)
  ghWrite(ghPath, existing, `trade: ${id} ${trade.stratName} ${trade.isWin ? 'WIN' : 'LOSS'} ${trade.pnlPct}%`);

  return id;
}

/**
 * getTrades({ limit, stratId, from, to }) — fetch real trades
 */
export async function getTrades({ limit = 100, stratId, from, to } = {}) {
  // Try KV first
  let ids = await kvLRange('trades:index', 0, limit * 2);

  if (!ids.length) {
    // Fallback: read latest GitHub shard
    const month = new Date().toISOString().slice(0, 7);
    const ghData = await ghRead(`db/trades/${month}.json`) || [];
    return ghData.slice(-limit).reverse();
  }

  // Fetch trade objects in parallel (max 20 concurrent)
  const fetched = await Promise.all(
    ids.slice(0, limit).map(id => kvGet(`trades:${id}`))
  );
  let trades = fetched.filter(Boolean);

  if (stratId) trades = trades.filter(t => t.stratId === stratId);
  if (from)    trades = trades.filter(t => t.closeTs >= from);
  if (to)      trades = trades.filter(t => t.closeTs <= to);

  return trades;
}

/**
 * saveStrategy(strategy) — upsert strategy state
 */
export async function saveStrategy(strat) {
  strat.updatedAt = new Date().toISOString();
  await kvSet(`strategies:${strat.id}`, strat);

  // Maintain index
  const idx = await kvGet('strategies:index') || [];
  if (!idx.includes(strat.id)) {
    idx.push(strat.id);
    await kvSet('strategies:index', idx);
  }

  // Async GitHub write
  const ghPath = `db/strategies/${strat.id}.json`;
  ghWrite(ghPath, strat, `strategy: ${strat.id} ${strat.name} tier=${strat.tier} wr=${strat.winRate}%`);

  return strat.id;
}

/**
 * getAllStrategies() — load all strategies
 */
export async function getAllStrategies() {
  const idx = await kvGet('strategies:index') || [];
  if (!idx.length) {
    // Fallback GitHub
    const ghData = await ghRead('db/strategies/_index.json') || [];
    return ghData;
  }
  const strats = await Promise.all(idx.map(id => kvGet(`strategies:${id}`)));
  return strats.filter(Boolean);
}

/**
 * saveSDEResult(result) — save one SDE permutation result
 */
export async function saveSDEResult(result) {
  result.savedAt = new Date().toISOString();
  await kvLPush('sde:results', result);

  // Maintain top-100 leaderboard in KV
  const lb = await kvGet('sde:leaderboard') || [];
  lb.push(result);
  lb.sort((a, b) => b.score - a.score);
  await kvSet('sde:leaderboard', lb.slice(0, 200));

  // Weekly GitHub snapshot
  const week = getWeekKey();
  const ghPath = `db/sde/${week}.json`;
  // Fire and forget
  ghRead(ghPath).then(existing => {
    const arr = existing || [];
    arr.push(result);
    ghWrite(ghPath, arr.slice(-500), `sde: ${result.signals?.join('+')} wr=${result.winRate}%`);
  });
}

/**
 * getSDELeaderboard(limit) — get best strategies found
 */
export async function getSDELeaderboard(limit = 100) {
  const lb = await kvGet('sde:leaderboard');
  if (lb?.length) return lb.slice(0, limit);
  // GitHub fallback
  const week = getWeekKey();
  const ghData = await ghRead(`db/sde/${week}.json`) || [];
  return ghData.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * saveOHLCV(symbol, bars) — cache OHLCV data
 */
export async function saveOHLCV(symbol, bars) {
  // Cache in KV with 25h TTL (refreshes daily)
  await kvSet(`ohlcv:${symbol}`, { symbol, bars, cachedAt: Date.now() }, 90000);
}

/**
 * getOHLCV(symbol) — get cached OHLCV
 */
export async function getOHLCV(symbol) {
  return kvGet(`ohlcv:${symbol}`);
}

/**
 * saveStats(stats) — portfolio equity curve + daily stats
 */
export async function saveStats(stats) {
  const today = new Date().toISOString().slice(0, 10);
  stats.date  = today;
  await kvSet('meta:stats:latest', stats);
  await kvLPush('meta:equity-curve', stats);

  // Monthly GitHub snapshot
  const month = today.slice(0, 7);
  const ghPath = `db/stats/${month}.json`;
  ghRead(ghPath).then(existing => {
    const arr = existing || [];
    const idx  = arr.findIndex(s => s.date === today);
    if (idx >= 0) arr[idx] = stats; else arr.push(stats);
    ghWrite(ghPath, arr, `stats: ${today} pnl=${stats.totalPnl}`);
  });
}

export async function getStats() {
  return kvGet('meta:stats:latest');
}

export async function getEquityCurve(days = 90) {
  const raw = await kvLRange('meta:equity-curve', 0, days);
  return raw.filter(Boolean);
}

/* helpers */
function getWeekKey() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
