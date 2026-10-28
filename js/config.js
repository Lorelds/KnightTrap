// Game constants shared by the UI, the AI worker, the online host and the tests.

export const N = 7;
export const SIZE = N * N;

// The proposal does not fix start squares. P1 starts at a1 (bottom-left),
// P2 at g7 (top-right). Index = row * 7 + col, row 0 is the top rank (7).
export const START = Object.freeze({ p1: 42, p2: 6, first: 0 });

export const DIFFICULTY = Object.freeze({
  easy: 1,
  medium: 2,
  hard: 3,
  expert: 4,
});

export const AI = Object.freeze({
  timeLimitMs: 4000,
  maxTrapCandidates: 12,
  orderMinDepth: 2,
  // Shortest visible "thinking" time so instant replies at Easy do not feel jarring.
  // UI only; not counted in the reported think time.
  minUiDelayMs: 450,
});

export const NET = Object.freeze({
  peerPrefix: 'knighttrap-v1-',
  codeLength: 5,
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  heartbeatMs: 3000,
  timeoutMs: 12000,
});
