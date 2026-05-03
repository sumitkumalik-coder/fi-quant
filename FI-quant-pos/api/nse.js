/**
 * api/nse.js — Real NSE India data: VIX, FII/DII, PCR, Option Chain
 *
 * GET /api/nse?type=vix    — India VIX + Nifty 50 live value
 * GET /api/nse?type=fii    — FII/DII net buy/sell (latest day)
 * GET /api/nse?type=pcr    — Nifty Put/Call ratio from option chain
 * GET /api/nse?type=market — All three in one call
 *
 * All data from nseindia.com official endpoints — permanently free.
 * KV cache: VIX/PCR = 60s, FII = 5min (updates once daily anyway).
 * NO synthetic fallback — if NSE is down, returns error with last-cached ts.
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type':                 'application/json',
};

const NSE   = 'https://www.nseindia.com';
const HDRS  = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         'https://www.nseindia.com/',
  'Connection':      'keep-alive',
};
const KV    = { url: process.env.KV_REST_API_URL, tok: process.env.KV_REST_API_TOKEN };

/* ── KV helpers (inline — no lib import needed in edge runtime) ── */
async function kvGet(key) {
  if (!KV.url) return null;
  try {
    const r = await fetch(`${KV.url}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${KV.tok}` } });
    const j = await r.json();
    return j.result != null ? JSON.parse(j.result) : null;
  } catch { return null; }
}
async function kvSet(key, val, ttl) {
  if (!KV.url) return;
  try {
    await fetch(`${KV.url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(val))}${ttl ? `/ex/${ttl}` : ''}`,
      { method: 'POST', headers: { Authorization: `Bearer ${KV.tok}` } });
  } catch { /* non-fatal */ }
}

/* ── NSE session cookie (required for all API calls) ── */
async function getNSECookie() {
  const r = await fetch(NSE + '/', { headers: HDRS, signal: AbortSignal.timeout(8000) });
  const raw = r.headers.get('set-cookie') || '';
  // Extract nsit + nseappid cookies — both required
  const cookies = raw.split(',')
    .map(c => c.split(';')[0].trim())
    .filter(c => c.startsWith('nsit=') || c.startsWith('nseappid='))
    .join('; ');
  return cookies || raw.split(';')[0];
}

/* ── Fetch with NSE cookie and timeout ── */
async function nseGet(path, timeoutMs = 10000) {
  const cookie = await getNSECookie();
  const r = await fetch(NSE + path, {
    headers: { ...HDRS, Cookie: cookie },
    signal:  AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`NSE returned ${r.status} for ${path}`);
  return r.json();
}

/* ── Data fetchers ── */
async function fetchVIX() {
  const cached = await kvGet('nse:vix');
  if (cached && Date.now() - cached.ts < 60000) return { ...cached, fromCache: true };

  const d     = await nseGet('/api/allIndices');
  const vix   = d?.data?.find(x => x.index === 'INDIA VIX');
  const nifty = d?.data?.find(x => x.index === 'NIFTY 50');
  const bank  = d?.data?.find(x => x.index === 'NIFTY BANK');
  const fin   = d?.data?.find(x => x.index === 'NIFTY FIN SERVICE');

  const result = {
    vix:         vix   ? +parseFloat(vix.last).toFixed(2)         : null,
    vixChange:   vix   ? +parseFloat(vix.percentChange).toFixed(2) : null,
    vixPrev:     vix   ? +parseFloat(vix.previousClose).toFixed(2) : null,
    nifty:       nifty ? +parseFloat(nifty.last).toFixed(2)        : null,
    niftyChange: nifty ? +parseFloat(nifty.percentChange).toFixed(2): null,
    bankNifty:   bank  ? +parseFloat(bank.last).toFixed(2)         : null,
    finNifty:    fin   ? +parseFloat(fin.last).toFixed(2)          : null,
    // VIX regime: <12 = calm, 12-20 = normal, >20 = fear, >25 = panic
    vixRegime:   !vix ? 'unknown'
                 : vix.last < 12 ? 'calm'
                 : vix.last < 20 ? 'normal'
                 : vix.last < 25 ? 'fear' : 'panic',
    ts: Date.now(),
    source: 'nseindia.com/api/allIndices',
  };

  await kvSet('nse:vix', result, 60);
  return result;
}

async function fetchFII() {
  const cached = await kvGet('nse:fii');
  if (cached && Date.now() - cached.ts < 300000) return { ...cached, fromCache: true };

  const d      = await nseGet('/api/fiidiiTradeReact');
  const rows   = Array.isArray(d) ? d.slice(0, 5) : [];
  const latest = rows[0] || {};

  // NSE reports in Crores — convert to rupees for consistency
  const crToRs = v => v ? Math.round(parseFloat(v) * 1e7) : null;

  const result = {
    date:          latest.date || null,
    fiiNetBuy:     crToRs(latest.netVal),     // +ve = buying, -ve = selling
    fiiBuy:        crToRs(latest.grossPurchase),
    fiiSell:       crToRs(latest.grossSales),
    // Last 5 days for trend context
    history: rows.map(r => ({
      date:     r.date,
      netBuy:   crToRs(r.netVal),
      category: r.category || 'FII',
    })),
    // Simple trend: are FIIs net buyers over last 3 days?
    fiiTrend: rows.slice(0, 3).reduce((s, r) => s + (parseFloat(r.netVal) || 0), 0) > 0
              ? 'buying' : 'selling',
    ts: Date.now(),
    source: 'nseindia.com/api/fiidiiTradeReact',
  };

  await kvSet('nse:fii', result, 300);
  return result;
}

async function fetchPCR() {
  const cached = await kvGet('nse:pcr');
  if (cached && Date.now() - cached.ts < 60000) return { ...cached, fromCache: true };

  const d = await nseGet('/api/option-chain-indices?symbol=NIFTY', 12000);

  let totalPE = 0, totalCE = 0;
  let maxPE_OI = 0, maxCE_OI = 0;
  let maxPE_strike = 0, maxCE_strike = 0;
  const expirySet = new Set();

  (d?.records?.data || []).forEach(rec => {
    if (rec.expiryDate) expirySet.add(rec.expiryDate);
    if (rec.PE) {
      totalPE += rec.PE.openInterest || 0;
      if (rec.PE.openInterest > maxPE_OI) {
        maxPE_OI = rec.PE.openInterest;
        maxPE_strike = rec.strikePrice;
      }
    }
    if (rec.CE) {
      totalCE += rec.CE.openInterest || 0;
      if (rec.CE.openInterest > maxCE_OI) {
        maxCE_OI = rec.CE.openInterest;
        maxCE_strike = rec.strikePrice;
      }
    }
  });

  const pcr = totalCE > 0 ? +(totalPE / totalCE).toFixed(3) : null;

  const result = {
    pcr,
    totalPE_OI:    totalPE,
    totalCE_OI:    totalCE,
    // Key support/resistance levels from OI concentration
    maxPainPE:     maxPE_strike,   // PUT max OI = strong support level
    maxPainCE:     maxCE_strike,   // CALL max OI = strong resistance level
    // PCR interpretation: >1.2 = bullish sentiment, <0.8 = bearish
    pcrSignal:     !pcr    ? 'neutral'
                 : pcr > 1.3 ? 'very_bullish'
                 : pcr > 1.1 ? 'bullish'
                 : pcr < 0.7 ? 'very_bearish'
                 : pcr < 0.9 ? 'bearish' : 'neutral',
    expiryDates:   [...expirySet].slice(0, 4),
    ts: Date.now(),
    source: 'nseindia.com/api/option-chain-indices',
  };

  await kvSet('nse:pcr', result, 60);
  return result;
}

/* ── Main handler ── */
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });

  const type = new URL(req.url).searchParams.get('type') || 'vix';

  try {
    if (type === 'vix')    return json(await fetchVIX(), 60);
    if (type === 'fii')    return json(await fetchFII(), 300);
    if (type === 'pcr')    return json(await fetchPCR(), 60);
    if (type === 'market') {
      // Fetch all 3 in parallel — one round-trip for the frontend
      const [vix, fii, pcr] = await Promise.allSettled([fetchVIX(), fetchFII(), fetchPCR()]);
      return json({
        vix:  vix.status  === 'fulfilled' ? vix.value  : { error: vix.reason?.message  },
        fii:  fii.status  === 'fulfilled' ? fii.value  : { error: fii.reason?.message  },
        pcr:  pcr.status  === 'fulfilled' ? pcr.value  : { error: pcr.reason?.message  },
        ts:   Date.now(),
      }, 60);
    }
    return json({ error: 'Unknown type. Use: vix | fii | pcr | market' }, 0, 400);

  } catch (err) {
    // Return last cached value if live fetch fails — never return nothing
    const cached = await kvGet(`nse:${type}`);
    if (cached) return json({ ...cached, stale: true, liveError: err.message }, 30);
    return json({ error: err.message, type, hint: 'NSE may be down or rate-limiting. Try again in 30s.' }, 0, 503);
  }
}

function json(data, ttl, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: ttl > 0
      ? { ...CORS, 'Cache-Control': `s-maxage=${ttl}, stale-while-revalidate=30` }
      : CORS,
  });
}
