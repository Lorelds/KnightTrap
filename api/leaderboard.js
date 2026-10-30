// GET /api/leaderboard: top teams as JSON.

import { getRedis } from './_lib/redis.js';
import { readLeaderboard } from './_lib/leaderboard.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method' });
  }
  try {
    const redis = await getRedis();
    if (!redis) return res.status(503).json({ ok: false, error: 'not-configured' });
    const out = await readLeaderboard(redis);
    // A short edge cache keeps many open screens polling every 15 s cheap.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3, stale-while-revalidate=10');
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('leaderboard failed', err);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
