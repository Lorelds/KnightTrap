// Knight Trap AI: Minimax with optional Alpha-Beta Pruning.
// Evaluation uses only BFS (territory) and DFS (flood fill split check),
// as the course limits the AI to these four algorithms.

import { SIZE, AI as CFG } from './config.js';
import { NEIGHBORS, EMPTY, BURNED, TRAP, cloneState, legalJumps, isOpen, hasOpenSquare, applyJump } from './rules.js';

export const WIN = 1_000_000;
// A split board is close to decided, so its score must outrank any territory score (max ~53).
export const SPLIT_WEIGHT = 100;

const ABORT = Symbol('abort');
const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Scratch buffers reused by every evaluation (the search is single-threaded and not re-entrant).
const distA = new Int8Array(SIZE);
const distB = new Int8Array(SIZE);
const queue = new Int8Array(SIZE);
const markA = new Uint8Array(SIZE);
const markB = new Uint8Array(SIZE);
const stack = new Int8Array(SIZE * 8);
const stamp = new Int32Array(SIZE);
let stampId = 0;

function open(cells, pos, sq) {
  return cells[sq] === EMPTY && sq !== pos[0] && sq !== pos[1];
}

function mobility(cells, pos, side) {
  let n = 0;
  for (const j of NEIGHBORS[pos[side]]) if (open(cells, pos, j)) n++;
  return n;
}

// BFS: fewest knight jumps from `start` to every square. -1 = unreachable.
export function bfs(cells, pos, side, dist) {
  dist.fill(-1);
  const start = pos[side];
  dist[start] = 0;
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    const d = dist[cur] + 1;
    for (const n of NEIGHBORS[cur]) {
      if (dist[n] < 0 && open(cells, pos, n)) {
        dist[n] = d;
        queue[tail++] = n;
      }
    }
  }
}

// DFS flood fill: marks every square reachable from the knight (1), start square = 2.
// Returns the region size, start excluded.
export function dfs(cells, pos, side, mark) {
  mark.fill(0);
  const start = pos[side];
  mark[start] = 2;
  let top = 0;
  let size = 0;
  stack[top++] = start;
  while (top > 0) {
    const cur = stack[--top];
    for (const n of NEIGHBORS[cur]) {
      if (mark[n] === 0 && open(cells, pos, n)) {
        mark[n] = 1;
        size++;
        stack[top++] = n;
      }
    }
  }
  return size;
}

// Static evaluation from `me`'s point of view. Positive = good for `me`.
export function evaluate(s, me) {
  const { cells, pos, turn } = s;
  const areaA = dfs(cells, pos, 0, markA);
  const areaB = dfs(cells, pos, 1, markB);
  let split = true;
  for (let i = 0; i < SIZE; i++) {
    if (markA[i] === 1 && markB[i] === 1) {
      split = false;
      break;
    }
  }
  let score;
  if (split) {
    score = (areaA - areaB) * SPLIT_WEIGHT;
  } else {
    bfs(cells, pos, 0, distA);
    bfs(cells, pos, 1, distB);
    let terr = 0;
    for (let i = 0; i < SIZE; i++) {
      if (!open(cells, pos, i)) continue;
      const a = distA[i];
      const b = distB[i];
      if (a < 0 && b < 0) continue;
      if (b < 0 || (a >= 0 && a < b)) terr++;
      else if (a < 0 || b < a) terr--;
      else terr += turn === 0 ? 1 : -1; // tie goes to the side to move
    }
    score = terr + 0.5 * (mobility(cells, pos, 0) - mobility(cells, pos, 1));
  }
  return me === 0 ? score : -score;
}

// Trap candidates after the mover has jumped: the opponent's jump targets first,
// then squares two jumps away, capped at maxTrapCandidates.
function trapCandidates(s, opp, out) {
  const { cells, pos } = s;
  const max = CFG.maxTrapCandidates;
  out.length = 0;
  stampId++;
  const ring1 = NEIGHBORS[pos[opp]];
  for (const n of ring1) {
    if (open(cells, pos, n)) {
      stamp[n] = stampId;
      out.push(n);
    }
  }
  for (const n of ring1) {
    if (out.length >= max) break;
    if (!open(cells, pos, n)) continue;
    for (const m of NEIGHBORS[n]) {
      if (out.length >= max) break;
      if (stamp[m] !== stampId && open(cells, pos, m)) {
        stamp[m] = stampId;
        out.push(m);
      }
    }
  }
  // The opponent is boxed in already: any open square is a legal trap.
  if (out.length === 0) {
    for (let i = 0; i < SIZE && out.length < max; i++) if (open(cells, pos, i)) out.push(i);
  }
  return out;
}

// A move is packed as jump | (trap + 1) << 6, so trap -1 (no square left) packs to 0.
export const pack = (jump, trap) => jump | ((trap + 1) << 6);
export const unpack = (m) => ({ jump: m & 63, trap: (m >> 6) - 1 });

const trapBuf = [];
export function generateMoves(s, side, out = []) {
  const { cells, pos } = s;
  const from = pos[side];
  const opp = side ^ 1;
  for (const j of NEIGHBORS[from]) {
    if (!open(cells, pos, j)) continue;
    cells[from] = BURNED;
    pos[side] = j;
    trapCandidates(s, opp, trapBuf);
    if (trapBuf.length === 0) out.push(pack(j, -1));
    else for (const t of trapBuf) out.push(pack(j, t));
    pos[side] = from;
    cells[from] = EMPTY;
  }
  return out;
}

function make(s, m) {
  const side = s.turn;
  const from = s.pos[side];
  const t = (m >> 6) - 1;
  s.cells[from] = BURNED;
  s.pos[side] = m & 63;
  if (t >= 0) s.cells[t] = TRAP;
  s.turn ^= 1;
  return from;
}

function unmake(s, m, from) {
  s.turn ^= 1;
  const t = (m >> 6) - 1;
  if (t >= 0) s.cells[t] = EMPTY;
  s.pos[s.turn] = from;
  s.cells[from] = EMPTY;
}

function hasJump(s, side) {
  for (const n of NEIGHBORS[s.pos[side]]) if (open(s.cells, s.pos, n)) return true;
  return false;
}

// Best static score first, from the point of view of the side choosing.
function orderMoves(s, moves, aiSide, maximizing) {
  const scored = moves.map((m) => {
    const from = make(s, m);
    const v = evaluate(s, aiSide);
    unmake(s, m, from);
    return { m, v };
  });
  scored.sort(maximizing ? (a, b) => b.v - a.v : (a, b) => a.v - b.v);
  for (let i = 0; i < moves.length; i++) moves[i] = scored[i].m;
}

/**
 * Pick a move for the side to move in `state` (that side is MAX).
 * opts: depth, prune (Alpha-Beta on/off), timeLimitMs, now.
 * Returns null when the side to move has no legal jump.
 */
export function search(state, opts = {}) {
  const depth = Math.max(1, opts.depth ?? 2);
  const prune = opts.prune ?? true;
  const timeLimitMs = opts.timeLimitMs ?? CFG.timeLimitMs;
  const now = opts.now ?? defaultNow;
  const s = cloneState(state);
  const aiSide = s.turn;
  const t0 = now();
  const deadline = t0 + timeLimitMs;
  let nodes = 1;
  let cutoffs = 0;

  function ab(d, alpha, beta, ply) {
    nodes++;
    if ((nodes & 255) === 0 && now() > deadline) throw ABORT;
    const side = s.turn;
    if (!hasJump(s, side)) return side === aiSide ? -(WIN - ply) : WIN - ply;
    if (d === 0) return evaluate(s, aiSide);
    const moves = generateMoves(s, side);
    const isMax = side === aiSide;
    if (d >= CFG.orderMinDepth) orderMoves(s, moves, aiSide, isMax);
    if (isMax) {
      let best = -Infinity;
      for (const m of moves) {
        const from = make(s, m);
        const v = ab(d - 1, alpha, beta, ply + 1);
        unmake(s, m, from);
        if (v > best) best = v;
        if (best > alpha) alpha = best;
        if (prune && beta <= alpha) {
          cutoffs++;
          break;
        }
      }
      return best;
    }
    let best = Infinity;
    for (const m of moves) {
      const from = make(s, m);
      const v = ab(d - 1, alpha, beta, ply + 1);
      unmake(s, m, from);
      if (v < best) best = v;
      if (best < beta) beta = best;
      if (prune && beta <= alpha) {
        cutoffs++;
        break;
      }
    }
    return best;
  }

  if (!hasJump(s, aiSide)) return null;
  const moves = generateMoves(s, aiSide);
  if (depth >= CFG.orderMinDepth) orderMoves(s, moves, aiSide, true);

  let best = -Infinity;
  let bestMove = moves[0];
  let alpha = -Infinity;
  let completed = 0;
  let timedOut = false;
  try {
    for (const m of moves) {
      const from = make(s, m);
      const v = ab(depth - 1, alpha, Infinity, 1);
      unmake(s, m, from);
      completed++;
      if (v > best) {
        best = v;
        bestMove = m;
      }
      if (prune && best > alpha) alpha = best;
    }
  } catch (e) {
    if (e !== ABORT) throw e;
    timedOut = true;
  }

  return {
    move: unpack(bestMove),
    score: completed > 0 ? best : null,
    depth,
    prune,
    nodes,
    cutoffs,
    timeMs: now() - t0,
    timedOut,
    rootMoves: moves.length,
    completedRootMoves: completed,
  };
}

// ---- Baseline players used by the tests -------------------------------------

function openSquares(s) {
  const out = [];
  for (let i = 0; i < SIZE; i++) if (isOpen(s, i)) out.push(i);
  return out;
}

function pickRandom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

export function randomMove(state, rng = Math.random) {
  const jumps = legalJumps(state);
  if (jumps.length === 0) return null;
  const jump = pickRandom(jumps, rng);
  const t = cloneState(state);
  applyJump(t, jump);
  const opens = openSquares(t);
  return { jump, trap: opens.length ? pickRandom(opens, rng) : -1 };
}

// Greedy: jump to the square with the most follow-up jumps; trap the opponent's
// best follow-up square the same way (random open square if the opponent has none).
export function greedyMove(state, rng = Math.random) {
  const side = state.turn;
  const jumps = legalJumps(state);
  if (jumps.length === 0) return null;
  const bestBy = (list, scoreFn) => {
    let best = -1;
    let picks = [];
    for (const x of list) {
      const v = scoreFn(x);
      if (v > best) {
        best = v;
        picks = [x];
      } else if (v === best) picks.push(x);
    }
    return pickRandom(picks, rng);
  };
  const jump = bestBy(jumps, (j) => {
    const t = cloneState(state);
    applyJump(t, j);
    return legalJumps(t, side).length;
  });
  const t = cloneState(state);
  applyJump(t, jump);
  if (!hasOpenSquare(t)) return { jump, trap: -1 };
  const oppJumps = legalJumps(t, side ^ 1);
  let trap;
  if (oppJumps.length) {
    trap = bestBy(oppJumps, (sq) => {
      let n = 0;
      for (const k of NEIGHBORS[sq]) if (isOpen(t, k) && k !== sq) n++;
      return n;
    });
  } else {
    trap = pickRandom(openSquares(t), rng);
  }
  return { jump, trap };
}
