// POST /api/score: replay a finished Single Player game and add its points to the team.

import { getRedis } from './_lib/redis.js';
import { submitScore, clientIp } from './_lib/leaderboard.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'bad-json' });
    }
  }
  try {
    const redis = await getRedis();
    if (!redis) return res.status(503).json({ ok: false, error: 'not-configured' });
    const out = await submitScore(redis, body, clientIp(req));
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('score failed', err);
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
