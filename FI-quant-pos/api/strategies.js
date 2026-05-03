/**
 * api/strategies.js — Strategy state persistence
 *
 * GET  /api/strategies          — all strategies with live stats
 * GET  /api/strategies?id=S001  — single strategy with full trade history
 * POST /api/strategies          — upsert strategy state
 * GET  /api/strategies?leaderboard=1 — ranked by composite score
 */

export const config = { runtime: 'edge' };

import { saveStrategy, getAllStrategies } from '../lib/db.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

/* Score a strategy for leaderboard ranking
   Uses REAL trade stats — never synthetic estimates */
function scoreStrategy(s) {
  if (!s.trades || s.trades < 5) return 0;
  const wr     = (s.winRate   || 0) / 100;
  const rr     = Math.min(s.avgRR || 0, 5) / 5;       // cap at 5x
  const sharpe = Math.min(s.sharpe || 0, 3) / 3;       // cap at 3
  const wf     = s.wfScore != null ? Math.min(s.wfScore, 1) : 0.5;
  // Reliability weight — penalise < 20 trades
  const reliability = Math.min(s.trades / 20, 1);
  return +((wr * 0.40 + rr * 0.25 + sharpe * 0.20 + wf * 0.15) * reliability * 100).toFixed(2);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });

  const url = new URL(req.url);

  /* ── GET leaderboard ── */
  if (req.method === 'GET' && url.searchParams.get('leaderboard')) {
    const all = await getAllStrategies();
    const scored = all
      .filter(s => s.tier !== 'retired' && s.trades >= 5)
      .map(s => ({ ...s, compositeScore: scoreStrategy(s) }))
      .sort((a, b) => b.compositeScore - a.compositeScore);

    const fiCandidates = scored.filter(s => s.winRate >= 75 && s.avgRR >= 2.5);
    const ninetyPlus   = scored.filter(s => s.winRate >= 90);

    return resp({
      leaderboard:    scored.slice(0, 50),
      fiCandidates,
      ninetyPlus,
      totalTested:    all.length,
      lastUpdated:    new Date().toISOString(),
    });
  }

  /* ── GET single strategy ── */
  if (req.method === 'GET' && url.searchParams.get('id')) {
    const { kvGet } = await import('../lib/db.js');
    const s = await kvGet(`strategies:${url.searchParams.get('id')}`);
    if (!s) return resp({ error: 'Strategy not found' }, 404);
    return resp({ ...s, compositeScore: scoreStrategy(s) });
  }

  /* ── GET all strategies ── */
  if (req.method === 'GET') {
    const all = await getAllStrategies();
    const withScores = all.map(s => ({ ...s, compositeScore: scoreStrategy(s) }));
    return resp({
      strategies:  withScores,
      summary: {
        total:     all.length,
        promoted:  all.filter(s => s.tier === 'promoted').length,
        testing:   all.filter(s => s.tier === 'testing').length,
        retired:   all.filter(s => s.tier === 'retired').length,
        fiCands:   all.filter(s => s.isFICandidate).length,
        best90:    all.filter(s => s.winRate >= 90).length,
      },
    });
  }

  /* ── POST upsert strategy ── */
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); }
    catch { return resp({ error: 'Invalid JSON' }, 400); }

    if (!body.id)   return resp({ error: 'id required' }, 422);
    if (!body.name) return resp({ error: 'name required' }, 422);

    // Compute composite score server-side
    body.compositeScore = scoreStrategy(body);
    body.updatedAt      = new Date().toISOString();

    // Auto-determine tier based on REAL stats
    if (body.trades >= 10) {
      if (body.winRate >= 75 && body.avgRR >= 2.5 && !body.isOverfit) {
        body.tier          = 'promoted';
        body.isFICandidate = true;
      } else if (body.consecutiveLosses >= 5 || body.winRate < 35) {
        body.tier = 'retired';
      }
    }

    await saveStrategy(body);
    return resp({ success: true, id: body.id, tier: body.tier, score: body.compositeScore }, 201);
  }

  return resp({ error: 'Method not allowed' }, 405);
}

function resp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
