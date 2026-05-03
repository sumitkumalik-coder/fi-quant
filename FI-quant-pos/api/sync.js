/**
 * api/sync.js — Full state sync between browser localStorage and DB
 *
 * POST /api/sync  { strategies[], trades[], stats }
 *   → persists everything to KV + GitHub
 *   → returns merged state (DB wins on conflicts)
 *
 * GET  /api/sync
 *   → returns full current state from DB
 *   → browser uses this on load to restore state
 */

export const config = { runtime: 'edge' };

import {
  getAllStrategies, saveStrategy,
  getTrades, saveTrade,
  getStats, saveStats, getEquityCurve,
  getSDELeaderboard,
} from '../lib/db.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });

  /* ── GET: load full state from DB ── */
  if (req.method === 'GET') {
    const [strategies, trades, stats, equity, sdeTop] = await Promise.allSettled([
      getAllStrategies(),
      getTrades({ limit: 200 }),
      getStats(),
      getEquityCurve(90),
      getSDELeaderboard(50),
    ]);

    return resp({
      strategies:   strategies.status === 'fulfilled' ? strategies.value : [],
      trades:       trades.status     === 'fulfilled' ? trades.value     : [],
      stats:        stats.status      === 'fulfilled' ? stats.value      : null,
      equityCurve:  equity.status     === 'fulfilled' ? equity.value     : [],
      sdeTop:       sdeTop.status     === 'fulfilled' ? sdeTop.value     : [],
      syncedAt:     new Date().toISOString(),
      source:       'vercel-kv + github',
    });
  }

  /* ── POST: push browser state to DB ── */
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); }
    catch { return resp({ error: 'Invalid JSON' }, 400); }

    const results = { saved: { strategies: 0, trades: 0 }, errors: [] };

    // Save strategies
    if (Array.isArray(body.strategies)) {
      await Promise.allSettled(
        body.strategies.map(async s => {
          try {
            await saveStrategy(s);
            results.saved.strategies++;
          } catch (e) {
            results.errors.push(`Strategy ${s.id}: ${e.message}`);
          }
        })
      );
    }

    // Save only REAL closed trades (paper or live)
    if (Array.isArray(body.trades)) {
      const realTrades = body.trades.filter(t =>
        t.closeTs &&                              // must be closed
        ['paper','live'].includes(t.source) &&    // no synthetic source
        t.symbol &&                               // must have symbol
        typeof t.entry === 'number' &&
        typeof t.exit  === 'number'
      );
      await Promise.allSettled(
        realTrades.map(async t => {
          try {
            await saveTrade(t);
            results.saved.trades++;
          } catch (e) {
            results.errors.push(`Trade ${t.id}: ${e.message}`);
          }
        })
      );
    }

    // Save portfolio stats
    if (body.stats && typeof body.stats === 'object') {
      try { await saveStats(body.stats); }
      catch (e) { results.errors.push(`Stats: ${e.message}`); }
    }

    return resp({ success: true, results, syncedAt: new Date().toISOString() }, 200);
  }

  return resp({ error: 'Method not allowed' }, 405);
}

function resp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
