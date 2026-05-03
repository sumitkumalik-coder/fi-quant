/**
 * api/trades.js — Trade persistence API
 *
 * GET  /api/trades              — list trades (limit, stratId, from, to)
 * POST /api/trades              — save a new closed trade
 * GET  /api/trades?id=T123      — get single trade
 *
 * Every trade stored is REAL (paper or live) — never synthetic.
 * Dual write: Vercel KV (fast reads) + GitHub JSON (permanent history).
 */

export const config = { runtime: 'edge' };

import { saveTrade, getTrades } from '../lib/db.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

/* Trade schema validation — rejects hallucinated/synthetic data */
function validateTrade(t) {
  const errors = [];
  if (!t.stratId)          errors.push('stratId required');
  if (!t.symbol)           errors.push('symbol required');
  if (typeof t.entry !== 'number' || t.entry <= 0) errors.push('entry must be positive number');
  if (typeof t.exit  !== 'number' || t.exit  <= 0) errors.push('exit must be positive number');
  if (typeof t.isWin !== 'boolean')                errors.push('isWin must be boolean');
  if (!t.openTs)           errors.push('openTs (ISO string) required');
  if (!t.closeTs)          errors.push('closeTs (ISO string) required');
  if (!['paper','live'].includes(t.source)) errors.push('source must be paper or live');
  // Sanity check: P&L must be consistent with isWin
  if (t.pnlRs != null && t.isWin && t.pnlRs < 0)
    errors.push('isWin=true but pnlRs is negative — data inconsistency');
  if (t.pnlRs != null && !t.isWin && t.pnlRs > 0)
    errors.push('isWin=false but pnlRs is positive — data inconsistency');
  return errors;
}

/* Compute derived fields server-side (never trust client-computed P&L) */
function computeDerived(t) {
  const pnlPct = ((t.exit - t.entry) / t.entry * 100).toFixed(3);
  const rr     = t.sl && t.sl !== t.entry
    ? +Math.abs((t.exit - t.entry) / (t.entry - t.sl)).toFixed(2)
    : null;
  const holdMs = new Date(t.closeTs) - new Date(t.openTs);
  const holdMin = Math.round(holdMs / 60000);
  return {
    ...t,
    pnlPct:   +pnlPct,
    pnlRs:    t.qty ? +(t.qty * (t.exit - t.entry)).toFixed(2) : null,
    rr,
    holdMin,
    // Tag for display
    holdLabel: holdMin < 60   ? `${holdMin}m`
             : holdMin < 1440 ? `${Math.round(holdMin/60)}h`
             : `${Math.round(holdMin/1440)}d`,
  };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });

  const url = new URL(req.url);

  /* ── GET single trade ── */
  if (req.method === 'GET' && url.searchParams.get('id')) {
    const id = url.searchParams.get('id');
    const { kvGet } = await import('../lib/db.js');
    const trade = await kvGet(`trades:${id}`);
    if (!trade) return resp({ error: 'Trade not found', id }, 404);
    return resp(trade);
  }

  /* ── GET list of trades ── */
  if (req.method === 'GET') {
    const limit   = Math.min(parseInt(url.searchParams.get('limit')  || '100'), 500);
    const stratId = url.searchParams.get('stratId') || null;
    const from    = url.searchParams.get('from')    || null;
    const to      = url.searchParams.get('to')      || null;

    const trades = await getTrades({ limit, stratId, from, to });

    // Compute aggregate stats on the server — source of truth
    const wins      = trades.filter(t => t.isWin);
    const losses    = trades.filter(t => !t.isWin);
    const totalPnl  = trades.reduce((s, t) => s + (t.pnlRs || 0), 0);
    const avgRR     = trades.filter(t=>t.rr).length
      ? +(trades.reduce((s,t) => s+(t.rr||0), 0) / trades.filter(t=>t.rr).length).toFixed(2)
      : null;
    const expectancy = wins.length && losses.length
      ? +(wins.reduce((s,t)=>s+(t.pnlPct||0),0)/wins.length * (wins.length/trades.length)
          - Math.abs(losses.reduce((s,t)=>s+(t.pnlPct||0),0)/losses.length) * (losses.length/trades.length)).toFixed(3)
      : null;

    return resp({
      trades,
      stats: {
        total:        trades.length,
        wins:         wins.length,
        losses:       losses.length,
        winRate:      trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
        totalPnl:     +totalPnl.toFixed(2),
        avgRR,
        expectancy,
        // These are REAL computed stats — no hallucination
        dataSource:   'vercel-kv + github',
      },
    });
  }

  /* ── POST new trade ── */
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); }
    catch { return resp({ error: 'Invalid JSON body' }, 400); }

    // Validate schema
    const errors = validateTrade(body);
    if (errors.length) return resp({ error: 'Validation failed', errors }, 422);

    // Compute server-side derived fields (don't trust client)
    const trade = computeDerived(body);
    trade.id      = `T${Date.now()}${Math.random().toString(36).slice(2,5)}`;
    trade.savedAt = new Date().toISOString();

    const id = await saveTrade(trade);
    return resp({ success: true, id, trade }, 201);
  }

  return resp({ error: 'Method not allowed' }, 405);
}

function resp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
