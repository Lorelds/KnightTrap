// Knight Trap test runner. No framework: `node tests/run.mjs` (add --quick for 20 games per match-up).
import { performance } from 'node:perf_hooks';
import { DIFFICULTY, AI as AICFG, TURN_SECONDS, TURN_GRACE_MS } from '../js/config.js';
import {
  createState, cloneState, legalJumps, applyJump, applyTrap, endTurn, applyMove,
  validateMove, winner, canMove, isOpen, EMPTY, BURNED, TRAP, serialize, deserialize,
} from '../js/rules.js';
import { search, randomMove, greedyMove, evaluate, generateMoves, orderMoves, unpack, SPLIT_WEIGHT, WIN } from '../js/ai.js';

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

  // Cannot land on burned or trap squares. The enemy's square is a legal jump: landing there eats it.
  const u = createState({ p1: sq('d4'), p2: sq('e6'), first: 0 });
  u.cells[sq('b3')] = BURNED;
  u.cells[sq('c6')] = TRAP;
  const j = legalJumps(u);
  check('blocked: burned square', !j.includes(sq('b3')));
  check('blocked: trap square', !j.includes(sq('c6')));
  check('opponent square is a legal jump', j.includes(sq('e6')));
  check('opponent square is not open for a trap', !isOpen(u, sq('e6')));
  check('open squares still legal', j.includes(sq('f5')) && j.includes(sq('b5')));

  // Trap validation.
  check('valid move accepted', validateMove(u, { jump: sq('f3'), trap: sq('a1') }));
  check('trap on burned rejected', !validateMove(u, { jump: sq('f3'), trap: sq('b3') }));
  check('trap on opponent rejected', !validateMove(u, { jump: sq('f3'), trap: sq('e6') }));
  check('trap on own new square rejected', !validateMove(u, { jump: sq('f3'), trap: sq('f3') }));
  check('trap on burned origin rejected', !validateMove(u, { jump: sq('f3'), trap: sq('d4') }));
  check('illegal jump rejected', !validateMove(u, { jump: sq('d5'), trap: sq('a1') }));
  check('missing trap rejected while squares are open', !validateMove(u, { jump: sq('f3'), trap: -1 }));
  check('garbage rejected', !validateMove(u, { jump: 'x', trap: 3 }) && !validateMove(u, null));

  // Loss detection: P1 on a1 with b3 and c2 gone loses on its turn.
  const v = createState();
  v.cells[sq('b3')] = TRAP;
  v.cells[sq('c2')] = BURNED;
  check('no legal jump -> side to move loses', winner(v) === 1 && !canMove(v));
  v.turn = 1;
  check('other side still alive', winner(v) === null);

  // Eating: landing exactly on the enemy's square wins at once, with no trap.
  const eatBlue = createState({ p1: sq('a1'), p2: sq('c2'), first: 0 });
  check('blue eats: no trap is valid', validateMove(eatBlue, { jump: sq('c2'), trap: -1 }));
  check('blue eats: a real trap is rejected', !validateMove(eatBlue, { jump: sq('c2'), trap: sq('a7') }));
  applyMove(eatBlue, { jump: sq('c2'), trap: -1 });
  check('blue eats: blue wins', winner(eatBlue) === 0);
  check('blue eats: both knights share the square', eatBlue.pos[0] === sq('c2') && eatBlue.pos[1] === sq('c2'));

  const eatOrange = createState({ p1: sq('e6'), p2: sq('g7'), first: 1 });
  check('orange eats: no trap is valid', validateMove(eatOrange, { jump: sq('e6'), trap: -1 }));
  applyMove(eatOrange, { jump: sq('e6'), trap: -1 });
  check('orange eats: orange wins', winner(eatOrange) === 1);

  // Touching the enemy no longer eats it: a1 -> c2 lands next to c3, and the game goes on.
  const near = createState({ p1: sq('a1'), p2: sq('c3'), first: 0 });
  check('touching: a jump next to the enemy still needs a trap', !validateMove(near, { jump: sq('c2'), trap: -1 }));
  check('touching: the trap is accepted', validateMove(near, { jump: sq('c2'), trap: sq('a7') }));
  applyMove(near, { jump: sq('c2'), trap: sq('a7') });
  check('touching: no winner', winner(near) === null && near.pos[0] !== near.pos[1]);

  // A trap can never go on either knight, even when the enemy could eat there next turn.
  const occ = createState({ p1: sq('a1'), p2: sq('d4'), first: 0 });
  check('trap on the enemy knight rejected', !validateMove(occ, { jump: sq('b3'), trap: sq('d4') }));
  check('trap on the jumping knight rejected', !validateMove(occ, { jump: sq('b3'), trap: sq('b3') }));

  // Eating is a legal move, so a knight whose only jump eats is not stuck.
  const only = createState({ p1: sq('a1'), p2: sq('c2'), first: 0 });
  only.cells[sq('b3')] = BURNED;
  check('only jump eats: the side to move is alive', canMove(only) && winner(only) === null);

  check('no trap rejected when the jump does not eat', !validateMove(createState(), { jump: sq('b3'), trap: -1 }));

  const eatAi = search(createState({ p1: sq('a1'), p2: sq('c2'), first: 0 }), { depth: 1 });
  check('AI eats at depth 1', eatAi.move.trap === -1 && eatAi.move.jump === sq('c2') && eatAi.score === WIN - 1, JSON.stringify(eatAi.move));

  // Evaluation knows eating, with scores that match WIN - ply from the search.
  const canEat = createState({ p1: sq('a1'), p2: sq('c2'), first: 0 });
  check('eval: side to move can eat, it wins on the next ply', evaluate(canEat, 0) === WIN - 1 && evaluate(canEat, 1) === -(WIN - 1));
  check('eval: the score counts the ply', evaluate(canEat, 0, 3) === WIN - 4 && evaluate(canEat, 1, 3) === -(WIN - 4));
  const stuck = createState();
  stuck.cells[sq('b3')] = TRAP;
  stuck.cells[sq('c2')] = BURNED;
  check('eval: side to move has no jump, it has lost', evaluate(stuck, 0, 2) === -(WIN - 2) && evaluate(stuck, 1, 2) === WIN - 2);
  const ate = createState({ p1: sq('c2'), p2: sq('c2'), first: 1 });
  check('eval: side to move was eaten, it has lost', evaluate(ate, 1, 1) === -(WIN - 1) && evaluate(ate, 0, 1) === WIN - 1);

  // From a5 orange can reach b3 but not c2, so even depth 1 must take the safe jump.
  const safe = search(createState({ p1: sq('a1'), p2: sq('a5'), first: 0 }), { depth: 1 });
  check('AI at depth 1 avoids a square the enemy can eat', safe.move.jump === sq('c2') && Math.abs(safe.score) < WIN / 2, JSON.stringify(safe.move));
  // From d4 orange can reach both b3 and c2: depth 1 and depth 2 must both report the same forced loss.
  const doomed = createState({ p1: sq('a1'), p2: sq('d4'), first: 0 });
  const d1 = search(doomed, { depth: 1 });
  const d2 = search(doomed, { depth: 2 });
  check('forced loss: depth 1 and 2 agree on the score', d1.score === -(WIN - 2) && d2.score === -(WIN - 2), `${d1.score} ${d2.score}`);

  // Move ordering puts the eating move first for both the maximizing and the minimizing side.
  for (const maximizing of [true, false]) {
    const o = createState({ p1: sq('a1'), p2: sq('c2'), first: 0 });
    const ms = generateMoves(o, 0);
    orderMoves(o, ms, maximizing ? 0 : 1, maximizing);
    check(`move ordering: eating first (maximizing ${maximizing})`, unpack(ms[0]).jump === sq('c2') && unpack(ms[0]).trap === -1);
  }

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
      const m = winner(s) === null ? randomMove(s, rng) : null;
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
  const sent = [];
  const noop = () => {};
  const board = { render: noop };
  const ui = { update: noop, thinking: noop, stats: noop, log: noop, over: noop, timer: noop, timeUp: noop };
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

  // The guest eats the host: no trap, the host accepts it, and the game ends.
  sent.length = 0;
  const e = new Game({
    board, ui, mode: 'online', role: 'host', net: { send: (m) => sent.push(m) },
    players: [{ kind: 'human', name: 'host' }, { kind: 'remote', name: 'guest' }],
  });
  e.start(createState({ p1: sq('e6'), p2: sq('g7'), first: 1 }));
  e.onNetMessage({ t: 'move', jump: sq('e6'), trap: -1 });
  await e.netQueue;
  check('guest eating move accepted, game over and state sent', e.phase === 'over' && e.winner === 1 && sent[0]?.t === 'state', JSON.stringify(sent[0]?.t));
  e.dispose();
}

// ---------------------------------------------------------------------------
console.log('\n6. Turn timer (real Game class, stubbed board and network, short time limit)');
{
  const { Game } = await import('../js/game.js');
  const board = { render: () => {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond, ms = 4000) => {
    const t0 = performance.now();
    while (!cond() && performance.now() - t0 < ms) await sleep(10);
    return cond();
  };
  const makeUi = () => {
    const u = { update() {}, thinking() {}, stats() {}, log() {}, over() {}, shown: [], timeUps: 0 };
    u.timer = (s) => u.shown.push(s);
    u.timeUp = () => { u.timeUps++; };
    return u;
  };
  const humans = [{ kind: 'human', name: 'p1' }, { kind: 'human', name: 'p2' }];
  const local = (ui, turnMs) => new Game({ board, ui, mode: 'local', players: humans, turnMs });

  // The default comes from the config, and the display starts there.
  {
    const ui = makeUi();
    const g = new Game({ board, ui, mode: 'local', players: humans });
    g.start(createState());
    check('timer: the default limit is TURN_SECONDS', g.turnMs === TURN_SECONDS * 1000 && ui.shown.at(-1) === TURN_SECONDS, String(ui.shown.at(-1)));
    g.dispose();
  }

  // Jump phase: a whole legal move is played and the turn passes.
  {
    const ui = makeUi();
    const g = local(ui, 100);
    g.start(createState());
    await waitFor(() => g.history.length >= 1);
    const h = g.history[0];
    const turn = g.state.turn;
    g.dispose();
    check('time out while jumping: a legal move is played', !!h && validateMove(createState(), { jump: h.jump, trap: h.trap }), JSON.stringify(h));
    check('time out while jumping: the turn passes', turn === 1 && ui.timeUps === 1, `${turn} ${ui.timeUps}`);
  }

  // Trap phase: the player's own jump stays and a trap goes on an open square.
  {
    const ui = makeUi();
    const g = local(ui, 100);
    g.start(createState());
    g.handleCell(sq('c2'));
    await waitFor(() => g.history.length >= 1);
    const h = g.history[0];
    const pos = g.state.pos[0];
    const cell = h ? g.state.cells[h.trap] : -1;
    g.dispose();
    check('time out while placing a trap: the jump is kept', !!h && h.jump === sq('c2') && pos === sq('c2'), JSON.stringify(h));
    check('time out while placing a trap: a trap is placed', cell === TRAP && h.trap !== sq('c2') && h.trap !== sq('g7'), JSON.stringify(h));
  }

  // Undoing a jump keeps the time already used.
  {
    const ui = makeUi();
    const g = local(ui, 400);
    const t0 = performance.now();
    g.start(createState());
    const deadline = g.deadline;
    await sleep(300);
    g.handleCell(sq('c2'));
    g.undoJump();
    check('undo jump: the deadline does not move', g.phase === 'jump' && g.deadline === deadline);
    await waitFor(() => g.history.length >= 1);
    const took = performance.now() - t0;
    g.dispose();
    check('undo jump: time still runs out on schedule', took < 650, `${took.toFixed(0)} ms`);
  }

  // The AI has no timer, and the human's clock starts after its move.
  {
    const warn = console.warn;
    console.warn = () => {}; // Node has no module workers, so the AI client says it uses the main thread
    const ui = makeUi();
    const g = new Game({
      board, ui, mode: 'ai', turnMs: 50, ai: { depth: 1, prune: true },
      players: [{ kind: 'ai', name: 'ai' }, { kind: 'human', name: 'me' }],
    });
    g.start(createState());
    check('AI turn: no clock and a blank timer', g.phase === 'ai' && g.clock === null && ui.shown.at(-1) === null);
    await sleep(200);
    check('AI turn: its limit is not the turn limit', ui.timeUps === 0 && g.state.moves === 0 && g.clock === null);
    await waitFor(() => g.phase === 'jump');
    check('after the AI moves, the human clock runs', g.state.moves === 1 && g.clock !== null);
    g.dispose();
    console.warn = warn;
  }

  // The clock stops when the game ends and when it is disposed.
  {
    const ui = makeUi();
    const g = local(ui, 100);
    g.start(createState({ p1: sq('a1'), p2: sq('c2'), first: 0 }));
    g.handleCell(sq('c2'));
    check('game over: the clock stops', g.phase === 'over' && g.clock === null && ui.shown.at(-1) === null);
    await sleep(250);
    check('game over: nothing moves afterwards', g.state.moves === 1 && ui.timeUps === 0);
    g.dispose();

    const ui2 = makeUi();
    const d = local(ui2, 100);
    d.start(createState());
    d.dispose();
    await sleep(250);
    check('dispose: the clock stops and nothing moves', d.clock === null && d.state.moves === 0 && ui2.timeUps === 0 && ui2.shown.at(-1) === null);
  }

  const guestFirst = () => createState({ p1: sq('a1'), p2: sq('g7'), first: 1 });
  const hostGame = (ui, sent) => new Game({
    board, ui, mode: 'online', role: 'host', turnMs: 100, net: { send: (m) => sent.push(m) },
    players: [{ kind: 'human', name: 'host' }, { kind: 'remote', name: 'guest' }],
  });

  // The host waits out the grace period, then plays for a quiet guest and sends the result.
  {
    const sent = [];
    const ui = makeUi();
    const g = hostGame(ui, sent);
    g.start(guestFirst());
    await sleep(100 + TURN_GRACE_MS - 300);
    check('quiet guest: the host waits through the grace period', g.state.moves === 0 && sent.length === 0, `${g.state.moves} ${sent.length}`);
    await waitFor(() => sent.length > 0);
    const m = sent[0];
    check('quiet guest: the host plays a legal move and sends the state', m?.t === 'state' && m.last.side === 1 && validateMove(guestFirst(), { jump: m.last.jump, trap: m.last.trap }), JSON.stringify(m?.last));
    check('quiet guest: no time-out message on the host', ui.timeUps === 0);

    // A move that arrives after the host already played for the guest is refused.
    sent.length = 0;
    g.onNetMessage({ t: 'move', jump: sq('e6'), trap: sq('a7') });
    await g.netQueue;
    check('quiet guest: a late move is rejected with the true state', sent[0]?.t === 'reject');
    g.dispose();
  }

  // A guest move inside the grace period is accepted, and the host does not play for that turn.
  {
    const sent = [];
    const ui = makeUi();
    const g = hostGame(ui, sent);
    const t0 = performance.now();
    g.start(guestFirst());
    await sleep(300);
    g.onNetMessage({ t: 'move', jump: sq('e6'), trap: sq('a7') });
    await g.netQueue;
    check('guest move in the grace period: accepted', sent[0]?.t === 'state' && sent[0].last.jump === sq('e6') && g.state.pos[1] === sq('e6'), JSON.stringify(sent[0]?.last));
    await sleep(Math.max(0, 100 + TURN_GRACE_MS + 150 - (performance.now() - t0)));
    const first = g.history[0];
    const guestMoves = g.history.filter((h) => h.side === 1).length;
    g.dispose();
    check('guest move in the grace period: the backup does not fire', first?.jump === sq('e6') && guestMoves === 1, JSON.stringify(g.history));
  }

  // The guest's own device acts when its time runs out, and sends a normal move.
  {
    const sent = [];
    const ui = makeUi();
    const g = new Game({
      board, ui, mode: 'online', role: 'guest', turnMs: 100, net: { send: (m) => sent.push(m) },
      players: [{ kind: 'remote', name: 'host' }, { kind: 'human', name: 'guest' }],
    });
    g.start(guestFirst());
    await waitFor(() => sent.length > 0);
    const m = sent[0];
    const phase = g.phase;
    g.dispose();
    check('guest time out: its device sends a legal move', m?.t === 'move' && validateMove(guestFirst(), { jump: m.jump, trap: m.trap }), JSON.stringify(m));
    check('guest time out: its device waits for the host next', phase === 'remote' && ui.timeUps === 1, phase);
  }

  // A guest in the middle of its turn takes the host's result when the host played for it.
  {
    const ui = makeUi();
    const g = new Game({
      board, ui, mode: 'online', role: 'guest', turnMs: 5000, net: { send: () => {} },
      players: [{ kind: 'remote', name: 'host' }, { kind: 'human', name: 'guest' }],
    });
    g.start(guestFirst());
    g.handleCell(sq('e6'));
    const forced = guestFirst();
    applyMove(forced, { jump: sq('f5'), trap: sq('a7') });
    g.onNetMessage({ t: 'state', state: serialize(forced), last: { side: 1, from: sq('g7'), jump: sq('f5'), trap: sq('a7') } });
    await g.netQueue;
    check('guest mid-turn: it takes the host result', g.state.pos[1] === sq('f5') && g.pendingFrom === null && g.phase === 'remote' && g.clock !== null);
    g.dispose();
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : 'FAILED'}: ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
