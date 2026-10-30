// GET /api/config: current point values (public).
// POST /api/config with "Authorization: Bearer <ADMIN_KEY>": change them (admin page).

import { getRedis } from './_lib/redis.js';
import { readRules, updateRules, clientIp } from './_lib/leaderboard.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }
  res.setHeader('Cache-Control', 'no-store');
  let body = req.body;
  if (req.method === 'POST' && typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'bad-json' });
    }
  }
  try {
    const redis = await getRedis();
    if (!redis) return res.status(503).json({ ok: false, error: 'not-configured' });
    if (req.method === 'GET') {
      const out = await readRules(redis);
      return res.status(out.status).json(out.body);
    }
    const auth = String(req.headers?.authorization ?? '');
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const out = await updateRules(redis, body, key, process.env.ADMIN_KEY, clientIp(req));
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('config failed', err);
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
