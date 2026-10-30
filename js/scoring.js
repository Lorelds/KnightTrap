// Single Player points. No DOM access: the browser shows the live score with this
// module and /api/score replays the submitted move log through it, so the server
// never trusts a score sent by the client.

import { DIFFICULTY, SCORING, SCORING_LIMITS, LEADERBOARD } from './config.js';
import { createState, validateMove, applyJump, applyTrap, endTurn, winner } from './rules.js';

export const POINT_FIELDS = ['move', 'win'];
export const LEVELS = Object.keys(DIFFICULTY);

export function pointsEnabled(mode) {
  return mode === 'ai';
}

/**
 * Checks a rules object from the admin page or storage. Points are whole numbers
 * 0..pointsMax, multipliers 0..multiplierMax with up to two decimals.
 * Returns a clean copy, or null if anything is missing or out of range.
 */
export function normalizeRules(raw) {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || !raw.multiplier || typeof raw.multiplier !== 'object') return null;
  const out = { multiplier: {} };
  for (const f of POINT_FIELDS) {
    const v = raw[f];
    if (!Number.isInteger(v) || v < 0 || v > SCORING_LIMITS.pointsMax) return null;
    out[f] = v;
  }
  for (const lvl of LEVELS) {
    const v = raw.multiplier[lvl];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > SCORING_LIMITS.multiplierMax) return null;
    if (Math.round(v * 100) !== v * 100) return null;
    out.multiplier[lvl] = v;
  }
  return out;
}

export const defaultRules = () => normalizeRules(SCORING);

// What one level is worth, rounded to whole points: per move and for a win.
export function levelValues(rules, level) {
  const m = rules.multiplier[level] ?? 0;
  const pts = (v) => Math.round(v * m);
  return {
    mult: m,
    move: pts(rules.move),
    win: pts(rules.win),
  };
}

/**
 * Replays moves [{ jump, trap }, ...] from the start position.
 * opts.level 'easy' | 'medium' | 'hard' | 'expert', opts.humanSide 0 | 1,
 * opts.rules (defaults to SCORING).
 * Returns the breakdown; valid is false (and badMove set) if a move is illegal.
 * steps[i] is what move i earned (0 for AI moves), win bonus excluded.
 */
export function scoreGame(moves, { mode = 'ai', level, humanSide, rules = SCORING }) {
  const mult = rules.multiplier?.[level] ?? 0;
  const out = {
    valid: true, badMove: -1, finished: false, won: false, mult, steps: [],
    humanMoves: 0, movePoints: 0, winPoints: 0, total: 0,
  };
  if (!pointsEnabled(mode) || !Object.hasOwn(DIFFICULTY, level) || !Array.isArray(moves)) return out;

  const per = levelValues(rules, level);
  const s = createState();
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (!validateMove(s, m)) {
      out.valid = false;
      out.badMove = i;
      return out;
    }
    const side = s.turn;
    applyJump(s, m.jump);
    applyTrap(s, m.trap);
    if (side === humanSide) out.humanMoves++;
    out.steps.push(side === humanSide ? per.move : 0);
    endTurn(s);
  }

  const w = winner(s);
  out.finished = w !== null;
  out.won = w === humanSide;
  out.movePoints = out.humanMoves * per.move;
  if (out.won) out.winPoints = per.win;
  out.total = out.movePoints + out.winPoints;
  return out;
}

// Team names: strip markup characters and control codes, collapse spaces.
export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validName(name) {
  return name.length >= LEADERBOARD.nameMin && name.length <= LEADERBOARD.nameMax;
}

// Names that differ only in case belong to the same team.
export const nameKey = (name) => name.toLowerCase();
