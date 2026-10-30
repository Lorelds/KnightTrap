// Leaderboard storage and score submission. Each function returns { status, body }
// so the handlers stay thin and the tests can call this with a mock Redis.
//
// Keys:  kt:total  sorted set   team key -> cumulative points
//        kt:wins / kt:games / kt:name / kt:first   hashes keyed by team key
//        kt:rl:<ip>  rate limit,  kt:game:<id>  one submission per game
//        kt:rules  point values set by the admin (JSON),  kt:adm:<ip>  failed admin logins

import { createHash, timingSafeEqual } from 'node:crypto';
import { DIFFICULTY, LEADERBOARD, SIZE } from '../../js/config.js';
import { scoreGame, cleanName, validName, nameKey, normalizeRules, defaultRules } from '../../js/scoring.js';

const K = {
  total: 'kt:total',
  wins: 'kt:wins',
  games: 'kt:games',
  name: 'kt:name',
  first: 'kt:first',
  rate: (ip) => `kt:rl:${ip}`,
  game: (id) => `kt:game:${id}`,
  rules: 'kt:rules',
  admin: (ip) => `kt:adm:${ip}`,
};
const GAME_ID = /^[A-Za-z0-9-]{8,64}$/;
const DUPLICATE_TTL_SEC = 7 * 24 * 3600;

const fail = (status, error) => ({ status, body: { ok: false, error } });

function parseMoves(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SIZE) return null;
  const moves = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object' || !Number.isInteger(m.jump) || !Number.isInteger(m.trap)) return null;
    moves.push({ jump: m.jump, trap: m.trap });
  }
  return moves;
}

// body: { name, difficulty, side, id, moves: [{ jump, trap }] }. Any score field is ignored.
export async function submitScore(redis, body, ip, now = Date.now()) {
  if (!body || typeof body !== 'object') return fail(400, 'bad-request');
  const name = cleanName(body.name);
  if (!validName(name)) return fail(400, 'bad-name');
  const level = body.difficulty;
  if (typeof level !== 'string' || !Object.hasOwn(DIFFICULTY, level)) return fail(400, 'bad-difficulty');
  const side = body.side;
  if (side !== 0 && side !== 1) return fail(400, 'bad-side');
  if (typeof body.id !== 'string' || !GAME_ID.test(body.id)) return fail(400, 'bad-id');
  const moves = parseMoves(body.moves);
  if (!moves) return fail(400, 'bad-moves');

  const rules = await getRules(redis);
  const score = scoreGame(moves, { mode: 'ai', level, humanSide: side, rules });
  if (!score.valid) return fail(400, 'illegal-move');
  if (!score.finished) return fail(400, 'unfinished');

  const allowed = await redis.set(K.rate(ip), 1, { nx: true, ex: LEADERBOARD.rateLimitSec });
  if (!allowed) return fail(429, 'rate-limited');
  const fresh = await redis.set(K.game(body.id), 1, { nx: true, ex: DUPLICATE_TTL_SEC });
  if (!fresh) return fail(409, 'duplicate');

  const key = nameKey(name);
  const [total] = await redis
    .multi()
    .zincrby(K.total, score.total, key)
    .hincrby(K.wins, key, score.won ? 1 : 0)
    .hincrby(K.games, key, 1)
    .hsetnx(K.name, key, name)
    .hsetnx(K.first, key, now)
    .exec();
  const higher = await redis.zcount(K.total, `(${Number(total)}`, '+inf');
  return {
    status: 200,
    body: { ok: true, score, team: { name, total: Number(total) }, rank: Number(higher) + 1 },
  };
}

// Top teams by total, then wins, then earliest first submission.
export async function readLeaderboard(redis) {
  // Fetch a margin past the cut so ties on total are ordered by the full rule.
  const flat = await redis.zrange(K.total, 0, LEADERBOARD.top * 2 + 9, { rev: true, withScores: true });
  const keys = [];
  const totals = [];
  for (let i = 0; i < flat.length; i += 2) {
    keys.push(String(flat[i]));
    totals.push(Number(flat[i + 1]));
  }
  if (!keys.length) return { status: 200, body: { ok: true, teams: [] } };
  const [wins, games, names, first] = await redis
    .pipeline()
    .hmget(K.wins, ...keys)
    .hmget(K.games, ...keys)
    .hmget(K.name, ...keys)
    .hmget(K.first, ...keys)
    .exec();
  const teams = keys.map((key, i) => ({
    key,
    // Upstash auto-parses values, so a name like "123" can come back as a number.
    name: String(names?.[key] ?? key),
    total: totals[i],
    wins: Number(wins?.[key] ?? 0),
    games: Number(games?.[key] ?? 0),
    first: Number(first?.[key] ?? 0),
  }));
  teams.sort((a, b) => b.total - a.total || b.wins - a.wins || a.first - b.first);
  return {
    status: 200,
    body: { ok: true, teams: teams.slice(0, LEADERBOARD.top).map(({ first, ...t }, i) => ({ rank: i + 1, ...t })) },
  };
}

export function clientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() || req.headers?.['x-real-ip'] || req.socket?.remoteAddress;
  return String(ip || 'unknown').slice(0, 64);
}

// ---- Point values -------------------------------------------------------------

// The admin's saved values, or the defaults from config.js.
export async function getRules(redis) {
  return normalizeRules(await redis.get(K.rules)) ?? defaultRules();
}

export async function readRules(redis) {
  return { status: 200, body: { ok: true, rules: await getRules(redis) } };
}

function sameSecret(given, expected) {
  // Hash both so the comparison is constant-time whatever the lengths.
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

/**
 * body: { rules } to save new values, or { reset: true } to go back to the defaults.
 * key is the Bearer token; adminKey comes from the ADMIN_KEY environment variable.
 */
export async function updateRules(redis, body, key, adminKey, ip) {
  if (!adminKey) return fail(503, 'admin-disabled');
  const fails = Number((await redis.get(K.admin(ip))) ?? 0);
  if (fails >= LEADERBOARD.adminMaxFails) return fail(429, 'locked');
  if (!key || !sameSecret(key, adminKey)) {
    await redis.multi().incr(K.admin(ip)).expire(K.admin(ip), LEADERBOARD.adminLockSec).exec();
    return fail(401, 'unauthorized');
  }
  if (!body || typeof body !== 'object') return fail(400, 'bad-request');
  if (body.check === true) return readRules(redis);
  if (body.reset === true) {
    await redis.del(K.rules);
    return readRules(redis);
  }
  const rules = normalizeRules(body.rules);
  if (!rules) return fail(400, 'bad-rules');
  await redis.set(K.rules, JSON.stringify(rules));
  return { status: 200, body: { ok: true, rules } };
}
