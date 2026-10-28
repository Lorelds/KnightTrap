// Knight Trap rules. Single source of truth for the UI, the AI and the online host.
// No DOM access here so the module also runs in a Web Worker and in Node.

import { N, SIZE, START } from './config.js';

export const EMPTY = 0;
export const BURNED = 1;
export const TRAP = 2;

const JUMPS = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1],
];

// Knight neighbor lists, computed once.
export const NEIGHBORS = Array.from({ length: SIZE }, (_, i) => {
  const r = Math.floor(i / N);
  const c = i % N;
  const out = [];
  for (const [dr, dc] of JUMPS) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr >= 0 && rr < N && cc >= 0 && cc < N) out.push(rr * N + cc);
  }
  return out;
});

export function createState(start = START) {
  return {
    cells: new Int8Array(SIZE),
    pos: [start.p1, start.p2],
    turn: start.first ?? 0,
    moves: 0,
  };
}

export function cloneState(s) {
  return { cells: new Int8Array(s.cells), pos: [s.pos[0], s.pos[1]], turn: s.turn, moves: s.moves };
}

// Plain-object form for postMessage / PeerJS.
export function serialize(s) {
  return { cells: Array.from(s.cells), pos: [s.pos[0], s.pos[1]], turn: s.turn, moves: s.moves };
}

export function deserialize(o) {
  if (!o || !Array.isArray(o.cells) || o.cells.length !== SIZE || !Array.isArray(o.pos)) {
    throw new Error('bad state');
  }
  return { cells: Int8Array.from(o.cells), pos: [o.pos[0] | 0, o.pos[1] | 0], turn: o.turn & 1, moves: o.moves | 0 };
}

export function isOpen(s, sq) {
  return s.cells[sq] === EMPTY && sq !== s.pos[0] && sq !== s.pos[1];
}

export function legalJumps(s, side = s.turn) {
  const out = [];
  for (const n of NEIGHBORS[s.pos[side]]) if (isOpen(s, n)) out.push(n);
  return out;
}

export function canMove(s, side = s.turn) {
  for (const n of NEIGHBORS[s.pos[side]]) if (isOpen(s, n)) return true;
  return false;
}

export function hasOpenSquare(s) {
  for (let i = 0; i < SIZE; i++) if (isOpen(s, i)) return true;
  return false;
}

// Step 1 of a turn: jump and burn the square left behind. Returns the origin square.
export function applyJump(s, to) {
  const side = s.turn;
  const from = s.pos[side];
  s.cells[from] = BURNED;
  s.pos[side] = to;
  return from;
}

// Step 2 of a turn: destroy one open square.
export function applyTrap(s, sq) {
  if (sq >= 0) s.cells[sq] = TRAP;
}

export function endTurn(s) {
  s.turn ^= 1;
  s.moves++;
}

// Validate a full move {jump, trap} for the side to move without changing s.
export function validateMove(s, move) {
  if (!move || !Number.isInteger(move.jump) || !Number.isInteger(move.trap)) return false;
  if (winner(s) !== null) return false;
  if (!legalJumps(s).includes(move.jump)) return false;
  const t = cloneState(s);
  applyJump(t, move.jump);
  if (!hasOpenSquare(t)) return move.trap === -1;
  return move.trap >= 0 && move.trap < SIZE && isOpen(t, move.trap);
}

export function applyMove(s, move) {
  const from = applyJump(s, move.jump);
  applyTrap(s, move.trap);
  endTurn(s);
  return from;
}

// The side to move loses if it has no legal jump. Returns the winning side, or null.
export function winner(s) {
  return canMove(s, s.turn) ? null : s.turn ^ 1;
}

export function squareName(sq) {
  return 'abcdefg'[sq % N] + (N - Math.floor(sq / N));
}
