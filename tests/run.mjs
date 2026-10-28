// Knight Trap test runner. No framework: `node tests/run.mjs` (add --quick for 20 games per match-up).
import { performance } from 'node:perf_hooks';
import { DIFFICULTY, AI as AICFG } from '../js/config.js';
import {
  createState, cloneState, legalJumps, applyJump, applyTrap, endTurn, applyMove,
  validateMove, winner, canMove, isOpen, EMPTY, BURNED, TRAP, serialize, deserialize,
} from '../js/rules.js';
import { search, randomMove, greedyMove, evaluate, SPLIT_WEIGHT } from '../js/ai.js';

const QUICK = process.argv.includes('--quick');
const GAMES = QUICK ? 20 : 100;
const BASE_SEED = 20261028;

let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) passes++;
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sq = (name) => (7 - Number(name[1])) * 7 + 'abcdefg'.indexOf(name[0]);
const pad = (v, n) => String(v).padStart(n);

// ---------------------------------------------------------------------------
console.log('\n1. Rules');
{
  const s = createState();
  check('start: P1 on a1', s.pos[0] === sq('a1'));
  check('start: P2 on g7', s.pos[1] === sq('g7'));
  check('start: P1 moves first', s.turn === 0);
  check('a1 legal jumps = b3, c2', JSON.stringify(legalJumps(s).sort((a, b) => a - b)) === JSON.stringify([sq('b3'), sq('c2')].sort((a, b) => a - b)));

  const t = cloneState(s);
  const from = applyJump(t, sq('b3'));
  check('jump moves knight', t.pos[0] === sq('b3'));
  check('origin square burns', from === sq('a1') && t.cells[sq('a1')] === BURNED);
  applyTrap(t, sq('d4'));
  check('trap marks square', t.cells[sq('d4')] === TRAP);
  endTurn(t);
  check('turn passes', t.turn === 1 && t.moves === 1);

  // Cannot land on burned, trap or occupied squares.
  const u = createState({ p1: sq('d4'), p2: sq('e6'), first: 0 });
  u.cells[sq('b3')] = BURNED;
  u.cells[sq('c6')] = TRAP;
  const j = legalJumps(u);
  check('blocked: burned square', !j.includes(sq('b3')));
  check('blocked: trap square', !j.includes(sq('c6')));
  check('blocked: opponent square', !j.includes(sq('e6')));
  check('open squares still legal', j.includes(sq('f5')) && j.includes(sq('b5')));

  // Trap validation.
  check('valid move accepted', validateMove(u, { jump: sq('f5'), trap: sq('a1') }));
  check('trap on burned rejected', !validateMove(u, { jump: sq('f5'), trap: sq('b3') }));
  check('trap on opponent rejected', !validateMove(u, { jump: sq('f5'), trap: sq('e6') }));
  check('trap on own new square rejected', !validateMove(u, { jump: sq('f5'), trap: sq('f5') }));
  check('trap on burned origin rejected', !validateMove(u, { jump: sq('f5'), trap: sq('d4') }));
  check('illegal jump rejected', !validateMove(u, { jump: sq('d5'), trap: sq('a1') }));
  check('missing trap rejected while squares are open', !validateMove(u, { jump: sq('f5'), trap: -1 }));
  check('garbage rejected', !validateMove(u, { jump: 'x', trap: 3 }) && !validateMove(u, null));

  // Loss detection: P1 on a1 with b3 and c2 gone loses on its turn.
  const v = createState();
  v.cells[sq('b3')] = TRAP;
  v.cells[sq('c2')] = BURNED;
  check('no legal jump -> side to move loses', winner(v) === 1 && !canMove(v));
  v.turn = 1;
  check('other side still alive', winner(v) === null);

  // Trap skipped only when nothing is open.
  const w = createState({ p1: sq('a1'), p2: sq('g7'), first: 0 });
  for (let i = 0; i < 49; i++) if (i !== sq('a1') && i !== sq('g7') && i !== sq('b3')) w.cells[i] = BURNED;
  check('no open square after jump -> trap -1 valid', validateMove(w, { jump: sq('b3'), trap: -1 }));
  check('no open square after jump -> real trap invalid', !validateMove(w, { jump: sq('b3'), trap: sq('c5') }));

  const r = deserialize(JSON.parse(JSON.stringify(serialize(u))));
  check('serialize round trip', r.pos[0] === u.pos[0] && r.cells[sq('c6')] === TRAP && r.turn === u.turn);
  let threw = false;
  try { deserialize({ cells: [1, 2], pos: [0, 1] }); } catch { threw = true; }
  check('deserialize rejects bad payload', threw);

  // Evaluation sanity.
  const e = createState();
  check('start position is symmetric (P1 gets tie squares)', evaluate(e, 0) === -evaluate(e, 1));
  // Split board: P1 can only reach b3, c2; P2 can reach f5, e6, g3, g5.
  const split = createState({ p1: sq('a1'), p2: sq('g7'), first: 0 });
  const keep = new Set(['a1', 'g7', 'b3', 'c2', 'f5', 'e6', 'g3', 'g5'].map(sq));
  for (let i = 0; i < 49; i++) if (!keep.has(i)) split.cells[i] = BURNED;
  check('DFS split: area difference x weight', evaluate(split, 1) === 2 * SPLIT_WEIGHT, String(evaluate(split, 1)));
  check('split weight outranks territory', SPLIT_WEIGHT > 49 + 4);
  // BFS territory: P1 to move on an open board gets the tie squares.
  const terr = createState({ p1: sq('d4'), p2: sq('g7'), first: 0 });
  check('BFS territory favors the central knight', evaluate(terr, 0) > 0);
}
console.log(`   ${passes} checks passed so far, ${failures} failed`);

// ---------------------------------------------------------------------------
console.log('\n2. Alpha-Beta correctness (Alpha-Beta vs plain Minimax, same eval/order, no time limit)');
const positions = [];
{
  let seed = BASE_SEED;
  while (positions.length < 30) {
    const rng = mulberry32(seed);
    const turns = 4 + Math.floor(rng() * 5);
    const s = createState();
    let ok = true;
    for (let i = 0; i < turns; i++) {
      const m = randomMove(s, rng);
      if (!m) { ok = false; break; }
      applyMove(s, m);
    }
    if (ok && winner(s) === null) positions.push({ seed, turns, s });
    seed++;
  }
  console.log(`   30 positions from seeds ${positions[0].seed}..${positions.at(-1).seed} (seed ${BASE_SEED} + k, random play of 4-8 turns)`);
  console.log('   depth | identical score | identical move | nodes Minimax | nodes Alpha-Beta | saved | cutoffs | ms MM | ms AB');
  for (const depth of [1, 2, 3]) {
    let sameScore = 0, sameMove = 0, nMM = 0, nAB = 0, cut = 0, tMM = 0, tAB = 0;
    for (const p of positions) {
      const mm = search(p.s, { depth, prune: false, timeLimitMs: Infinity, now: performance.now.bind(performance) });
      const ab = search(p.s, { depth, prune: true, timeLimitMs: Infinity, now: performance.now.bind(performance) });
      if (mm.score === ab.score) sameScore++;
      else console.log(`   mismatch seed ${p.seed} depth ${depth}: MM ${mm.score} AB ${ab.score}`);
      if (mm.move.jump === ab.move.jump && mm.move.trap === ab.move.trap) sameMove++;
      nMM += mm.nodes; nAB += ab.nodes; cut += ab.cutoffs; tMM += mm.timeMs; tAB += ab.timeMs;
    }
    const saved = (100 * (1 - nAB / nMM)).toFixed(1) + '%';
    console.log(`   ${pad(depth, 5)} | ${pad(sameScore + '/30', 15)} | ${pad(sameMove + '/30', 13)} | ${pad(nMM, 13)} | ${pad(nAB, 16)} | ${pad(saved, 5)} | ${pad(cut, 7)} | ${pad(tMM.toFixed(0), 5)} | ${pad(tAB.toFixed(0), 5)}`);
    check(`depth ${depth}: identical scores`, sameScore === 30);
    check(`depth ${depth}: identical moves`, sameMove === 30);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n3. Strength (${GAMES} games per level per opponent, AI alternates first/second, 4 s limit, Alpha-Beta on)`);
const timing = {};
const winRates = {};
{
  console.log('   level  | depth | vs random | vs greedy');
  for (const [level, depth] of Object.entries(DIFFICULTY)) {
    timing[level] = [];
    winRates[level] = {};
    for (const [oppName, opp] of [['random', randomMove], ['greedy', greedyMove]]) {
      let wins = 0;
      for (let g = 0; g < GAMES; g++) {
        const rng = mulberry32(BASE_SEED * 7 + depth * 100003 + g * 31 + (oppName === 'greedy' ? 17 : 0));
        const aiSide = g % 2;
        const s = createState();
        let illegal = false;
        while (winner(s) === null) {
          let move;
          if (s.turn === aiSide) {
            const res = search(s, { depth, prune: true, timeLimitMs: AICFG.timeLimitMs, now: performance.now.bind(performance) });
            timing[level].push(res.timeMs);
            move = res.move;
          } else {
            move = opp(s, rng);
          }
          if (!validateMove(s, move)) { illegal = true; break; }
          applyMove(s, move);
        }
        check(`${level} vs ${oppName} game ${g}: only legal moves`, !illegal);
        if (winner(s) === aiSide) wins++;
      }
      winRates[level][oppName] = (100 * wins) / GAMES;
    }
    console.log(`   ${level.padEnd(6)} | ${pad(depth, 5)} | ${pad(winRates[level].random.toFixed(0) + '%', 9)} | ${pad(winRates[level].greedy.toFixed(0) + '%', 9)}`);
    if (depth >= 2) check(`${level}: >= 90% vs random`, winRates[level].random >= 90, `${winRates[level].random}%`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n4. Response time per AI move (Node, same code as the browser worker)');
{
  console.log('   level  | moves | avg ms | p95 ms | max ms');
  for (const [level, times] of Object.entries(timing)) {
    const sorted = [...times].sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted.at(-1);
    console.log(`   ${level.padEnd(6)} | ${pad(times.length, 5)} | ${pad(avg.toFixed(1), 6)} | ${pad(p95.toFixed(1), 6)} | ${pad(max.toFixed(1), 6)}`);
    check(`${level}: max < 4000 ms`, max < 4000, `${max.toFixed(0)} ms`);
    if (level !== 'expert') check(`${level}: max < 1000 ms`, max < 1000, `${max.toFixed(0)} ms`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n5. Online host validation (real Game class, stubbed board and network)');
{
  const { Game } = await import('../js/game.js');
  const { setSoundEnabled } = await import('../js/audio.js');
  setSoundEnabled(false);
  const sent = [];
  const noop = () => {};
  const board = { render: noop, animateJump: async () => {}, burn: noop, trap: async () => {}, victory: noop };
  const ui = { update: noop, thinking: noop, stats: noop, log: noop, over: noop };
  const g = new Game({
    board, ui, mode: 'online', role: 'host', net: { send: (m) => sent.push(m) },
    players: [{ kind: 'human', name: 'host' }, { kind: 'remote', name: 'guest' }],
  });
  g.start(createState());
  const flush = () => g.netQueue.then(() => new Promise((r) => setTimeout(r, 400)));

  // Guest tries to move on the host's turn.
  g.onNetMessage({ t: 'move', jump: sq('f5'), trap: sq('d4') });
  await flush();
  check('out-of-turn guest move rejected', sent.at(-1)?.t === 'reject' && g.state.moves === 0);

  // Host plays a1 -> b3, trap d4 through the same input path as clicks.
  await g.handleCell(sq('b3'));
  await g.handleCell(sq('d4'));
  check('host move applied and broadcast', g.state.moves === 1 && sent.at(-1)?.t === 'state' && g.phase === 'remote');

  const before = JSON.stringify(serialize(g.state));
  for (const bad of [
    { jump: sq('g6'), trap: sq('a7') }, // not a knight move from g7
    { jump: sq('f5'), trap: sq('d4') }, // trap on an existing trap
    { jump: sq('f5'), trap: sq('b3') }, // trap on the host knight
    { jump: sq('f5'), trap: -1 }, // skipping the trap while squares are open
    { jump: 'f5', trap: 3 }, // wrong types
  ]) {
    sent.length = 0;
    g.onNetMessage({ t: 'move', ...bad });
    await flush();
    check(`illegal guest move rejected ${JSON.stringify(bad)}`, sent[0]?.t === 'reject' && JSON.stringify(serialize(g.state)) === before);
  }

  sent.length = 0;
  g.onNetMessage({ t: 'move', jump: sq('f5'), trap: sq('a7') });
  await flush();
  check('legal guest move accepted and broadcast', g.state.moves === 2 && sent[0]?.t === 'state' && g.phase === 'jump');
  g.dispose();
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : 'FAILED'}: ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
