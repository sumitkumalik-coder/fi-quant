/**
 * api/ohlcv.js — Real NSE OHLCV from Yahoo Finance + KV cache
 *
 * GET /api/ohlcv?symbol=RELIANCE&days=365
 * GET /api/ohlcv?symbol=NIFTY50&days=252
 *
 * Flow:
 *   1. Check Vercel KV cache (TTL 25h) — instant, no hallucination
 *   2. On miss: fetch Yahoo Finance — real traded data, adj close
 *   3. Store in KV for next caller
 *   4. Return clean OHLCV array
 *
 * NO synthetic/generated data ever returned.
 * If Yahoo fails: returns { error, cached: null } — caller must handle.
 */

export const config = { runtime: 'edge' };

import { getOHLCV, saveOHLCV } from '../lib/db.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type':                 'application/json',
};

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept':     'application/json',
  'Referer':    'https://finance.yahoo.com',
};

/* Canonical NSE symbol mapping */
function normaliseSymbol(raw) {
  const s = raw.trim().toUpperCase();
  if (s === 'NIFTY50' || s === 'NIFTY') return '^NSEI';
  if (s === 'BANKNIFTY')                 return '^NSEBANK';
  if (s === 'SENSEX')                    return '^BSESN';
  if (s === 'FINNIFTY')                  return 'NIFTY_FIN_SERVICE.NS';
  if (s.includes('.') || s.startsWith('^')) return s;
  return s + '.NS';
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });

  const url    = new URL(req.url);
  const rawSym = url.searchParams.get('symbol') || 'RELIANCE';
  const days   = Math.min(Math.max(parseInt(url.searchParams.get('days') || '365'), 30), 1825);
  const force  = url.searchParams.get('force') === '1'; // bypass cache
  const symbol = normaliseSymbol(rawSym);

  /* ── 1. Check KV cache ── */
  if (!force) {
    try {
      const cached = await getOHLCV(symbol);
      if (cached?.bars?.length) {
        // Filter to requested days
        const cutoff = Date.now() / 1000 - days * 86400;
        const bars   = cached.bars.filter(b => b.t >= cutoff);
        return new Response(JSON.stringify({
          symbol, bars: bars.length, ohlcv: bars,
          source: 'cache', cachedAt: cached.cachedAt,
          exchange: 'NSE', currency: 'INR',
        }), { headers: { ...CORS, 'Cache-Control': 's-maxage=300' } });
      }
    } catch (_) { /* cache miss, continue */ }
  }

  /* ── 2. Fetch from Yahoo Finance (real traded data) ── */
  const now  = Math.floor(Date.now() / 1000);
  const from = now - days * 86400;
  // Use v8 chart API — most reliable for NSE
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?interval=1d&period1=${from}&period2=${now}&events=div,split&includePrePost=false`;

  let yahooData;
  try {
    const res = await fetch(yahooUrl, {
      headers: YAHOO_HEADERS,
      signal:  AbortSignal.timeout(12000),
    });

    if (res.status === 429) {
      return new Response(JSON.stringify({
        error:   'Yahoo rate-limited. Retry in 60s.',
        symbol,  retryAfter: 60,
      }), { status: 429, headers: CORS });
    }
    if (!res.ok) {
      return new Response(JSON.stringify({
        error: `Yahoo returned HTTP ${res.status}`, symbol,
      }), { status: 502, headers: CORS });
    }

    yahooData = await res.json();
  } catch (err) {
    return new Response(JSON.stringify({
      error: `Fetch failed: ${err.message}`, symbol,
    }), { status: 500, headers: CORS });
  }

  /* ── 3. Parse and validate ── */
  const result = yahooData?.chart?.result?.[0];
  if (!result) {
    return new Response(JSON.stringify({
      error: `No data returned for ${symbol}. Check symbol is correct (e.g. RELIANCE, TCS, NIFTY50).`,
      symbol,
    }), { status: 404, headers: CORS });
  }

  const timestamps = result.timestamp || [];
  const quote      = result.indicators?.quote?.[0] || {};
  const { open = [], high = [], low = [], close = [], volume = [] } = quote;
  const adjClose   = result.indicators?.adjclose?.[0]?.adjclose || close;

  // Build clean bars — ONLY real traded data, never synthetic
  const ohlcv = timestamps
    .map((t, i) => ({
      t: t,
      d: new Date(t * 1000).toISOString().slice(0, 10),
      o: open[i]     != null ? +open[i].toFixed(2)     : null,
      h: high[i]     != null ? +high[i].toFixed(2)     : null,
      l: low[i]      != null ? +low[i].toFixed(2)      : null,
      c: adjClose[i] != null ? +adjClose[i].toFixed(2) : close[i] != null ? +close[i].toFixed(2) : null,
      v: volume[i]   != null ? volume[i]               : 0,
    }))
    .filter(b => b.o != null && b.h != null && b.l != null && b.c != null && b.c > 0 && b.h >= b.l);

  if (ohlcv.length < 5) {
    return new Response(JSON.stringify({
      error: `Insufficient data for ${symbol}: only ${ohlcv.length} bars returned.`,
      symbol,
    }), { status: 404, headers: CORS });
  }

  /* ── 4. Cache in KV for next request ── */
  try {
    await saveOHLCV(symbol, ohlcv);
  } catch (_) { /* non-fatal cache write failure */ }

  const meta = result.meta || {};
  return new Response(JSON.stringify({
    symbol,
    displayName: meta.longName || meta.shortName || symbol,
    exchange:    meta.exchangeName || 'NSE',
    currency:    meta.currency || 'INR',
    bars:        ohlcv.length,
    ohlcv,
    source:      'yahoo',
    fetchedAt:   Date.now(),
  }), {
    status:  200,
    headers: { ...CORS, 'Cache-Control': 's-maxage=300, stale-while-revalidate=60' },
  });
}
