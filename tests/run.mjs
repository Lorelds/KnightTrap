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

// ---------------------------------------------------------------------------
console.log('\n6. Points and leaderboard (scoring.js, server replay and /api handlers with a mock Redis)');
{
  const { SCORING } = await import('../js/config.js');
  const { scoreGame, pointsEnabled, cleanName, validName, normalizeRules, defaultRules, levelValues } = await import('../js/scoring.js');
  const { submitScore, readLeaderboard, updateRules, getRules } = await import('../api/_lib/leaderboard.js');
  const { setRedis } = await import('../api/_lib/redis.js');

  // Finished games from seeded random play: one P1 wins, one P1 loses.
  const playOut = (seed) => {
    const rng = mulberry32(seed);
    const s = createState();
    const moves = [];
    while (winner(s) === null) {
      const m = randomMove(s, rng);
      moves.push(m);
      applyMove(s, m);
    }
    return { moves, w: winner(s) };
  };
  let winGame = null;
  let lossGame = null;
  for (let seed = BASE_SEED; !(winGame && lossGame); seed++) {
    const g = playOut(seed);
    if (g.w === 0) winGame ??= g.moves;
    else lossGame ??= g.moves;
  }

  for (const [level, mult] of Object.entries(SCORING.multiplier)) {
    const l = scoreGame(lossGame, { level, humanSide: 0 });
    check(`${level}: ${SCORING.move * mult} points per move`, l.humanMoves > 0 && l.movePoints === l.humanMoves * SCORING.move * mult);
    check(`${level}: loss keeps move points, no win bonus`, l.finished && !l.won && l.winPoints === 0 && l.total === l.movePoints);
    const w = scoreGame(winGame, { level, humanSide: 0 });
    check(`${level}: win bonus ${SCORING.win * mult}`, w.won && w.winPoints === SCORING.win * mult);
    check(`${level}: total = moves + win`, w.total === w.movePoints + w.winPoints && w.total === (w.humanMoves * SCORING.move + SCORING.win) * mult);
    check(`${level}: per-move points add up to the move points`, w.steps.reduce((a, b) => a + b, 0) === w.movePoints && w.steps.length === winGame.length);
  }
  const steps = scoreGame(winGame, { level: 'easy', humanSide: 0 }).steps;
  check('every human move earns the same points, AI moves earn none', steps.every((p, i) => p === (i % 2 === 0 ? SCORING.move : 0)));
  const easy = scoreGame(winGame, { level: 'easy', humanSide: 0 }).total;
  check('same game scores x2.5 on Expert vs Easy', scoreGame(winGame, { level: 'expert', humanSide: 0 }).total === 2.5 * easy);
  check('multipliers are 1, 1.5, 2, 2.5', JSON.stringify(SCORING.multiplier) === JSON.stringify({ easy: 1, medium: 1.5, hard: 2, expert: 2.5 }));
  const traps = [sq('f5'), sq('d4')].map((tr) => scoreGame([{ jump: sq('b3'), trap: tr }], { level: 'easy', humanSide: 0 }).total);
  check('where the trap goes does not change the points', traps[0] === SCORING.move && traps[1] === SCORING.move);

  check('Local mode gives no points', !pointsEnabled('local') && scoreGame(winGame, { mode: 'local', level: 'expert', humanSide: 0 }).total === 0);
  check('Online mode gives no points', !pointsEnabled('online') && scoreGame(winGame, { mode: 'online', level: 'expert', humanSide: 0 }).total === 0);
  check('Single Player gives points', pointsEnabled('ai'));

  const cleaned = cleanName('  <script>Tim   A</script> ');
  check('name markup stripped', !/[<>&"']/.test(cleaned) && cleaned === 'scriptTim A/script', cleaned);
  check('name length 2..20', !validName('A') && validName('AB') && validName('x'.repeat(20)) && !validName('x'.repeat(21)));

  // In-memory stand-in for the Upstash client: same method names and return shapes.
  const mockRedis = () => {
    const kv = new Map();
    const zsets = new Map();
    const hashes = new Map();
    const zset = (k) => zsets.get(k) ?? zsets.set(k, new Map()).get(k);
    const hash = (k) => hashes.get(k) ?? hashes.set(k, new Map()).get(k);
    const ops = {
      async set(k, v, o = {}) {
        if (o.nx && kv.has(k)) return null;
        kv.set(k, String(v));
        return 'OK';
      },
      async zincrby(k, inc, m) {
        const z = zset(k);
        z.set(m, (z.get(m) ?? 0) + inc);
        return z.get(m);
      },
      async zcount(k, min) {
        const excl = String(min).startsWith('(');
        const lo = Number(String(min).replace('(', ''));
        return [...zset(k).values()].filter((v) => (excl ? v > lo : v >= lo)).length;
      },
      async zrange(k, a, b, o = {}) {
        const rows = [...zset(k).entries()].sort((x, y) => (o.rev ? y[1] - x[1] : x[1] - y[1])).slice(a, b + 1);
        return o.withScores ? rows.flat() : rows.map((r) => r[0]);
      },
      async hincrby(k, f, n) {
        const h = hash(k);
        h.set(f, String(Number(h.get(f) ?? 0) + n));
        return Number(h.get(f));
      },
      async hsetnx(k, f, v) {
        const h = hash(k);
        if (h.has(f)) return 0;
        h.set(f, String(v));
        return 1;
      },
      async get(k) {
        return kv.get(k) ?? null;
      },
      async del(k) {
        return kv.delete(k) ? 1 : 0;
      },
      async incr(k) {
        kv.set(k, String(Number(kv.get(k) ?? 0) + 1));
        return Number(kv.get(k));
      },
      async expire() {
        return 1;
      },
      async hmget(k, ...fields) {
        const h = hashes.get(k);
        return h ? Object.fromEntries(fields.map((f) => [f, h.get(f) ?? null])) : null;
      },
    };
    const batch = () => {
      const queue = [];
      const chain = new Proxy({}, {
        get: (_, op) => op === 'exec'
          ? async () => { const out = []; for (const [n, args] of queue) out.push(await ops[n](...args)); return out; }
          : (...args) => { queue.push([op, args]); return chain; },
      });
      return chain;
    };
    return { ...ops, multi: batch, pipeline: batch };
  };

  const redis = mockRedis();
  const body = (over = {}) => ({ name: 'Tim Alpha', difficulty: 'hard', side: 0, id: 'game-0001', moves: winGame, ...over });
  const expected = scoreGame(winGame, { level: 'hard', humanSide: 0 }).total;

  let r = await submitScore(redis, body({ score: 999999, total: 999999 }), '10.0.0.1', 1000);
  check('server: finished legal game accepted', r.status === 200, JSON.stringify(r.body));
  check('server: forged score ignored, total comes from the replay', r.body.score?.total === expected && r.body.team?.total === expected, `${r.body.team?.total} vs ${expected}`);

  // Swap one human move for a jump that is not legal in that position.
  const tampered = winGame.map((m) => ({ ...m }));
  const before = createState();
  for (let i = 0; i < 2; i++) applyMove(before, tampered[i]);
  const legal = legalJumps(before);
  tampered[2].jump = [...Array(49).keys()].find((x) => !legal.includes(x) && x !== before.pos[before.turn]);
  r = await submitScore(redis, body({ id: 'game-tamper1', moves: tampered }), '10.0.0.2');
  check('server: tampered move log rejected', r.status === 400 && r.body.error === 'illegal-move', JSON.stringify(r.body));
  r = await submitScore(redis, body({ id: 'game-tamper2', moves: [...winGame, winGame[0]] }), '10.0.0.2');
  check('server: move after the game ended rejected', r.status === 400 && r.body.error === 'illegal-move');
  r = await submitScore(redis, body({ id: 'game-unfinished', moves: winGame.slice(0, -1) }), '10.0.0.2');
  check('server: unfinished game rejected', r.status === 400 && r.body.error === 'unfinished');
  r = await submitScore(redis, body({ id: 'game-badlevel', difficulty: 'godlike' }), '10.0.0.2');
  check('server: unknown difficulty rejected', r.status === 400 && r.body.error === 'bad-difficulty');
  r = await submitScore(redis, body({ id: 'game-badname', name: '<>' }), '10.0.0.2');
  check('server: empty-after-cleaning name rejected', r.status === 400 && r.body.error === 'bad-name');
  r = await submitScore(redis, body({ id: 'game-badmoves', moves: [{ jump: '3', trap: 1 }] }), '10.0.0.2');
  check('server: malformed moves rejected', r.status === 400 && r.body.error === 'bad-moves');

  r = await submitScore(redis, body({ id: 'game-0002' }), '10.0.0.1');
  check('server: second submission within 10 s from the same IP rate-limited', r.status === 429);
  r = await submitScore(redis, body(), '10.0.0.3');
  check('server: same game id submitted twice rejected', r.status === 409);

  // Same team in another case adds up; ties on total and wins go to the earlier team.
  await submitScore(redis, body({ id: 'game-0003', name: 'tim alpha', moves: lossGame }), '10.0.0.4');
  await submitScore(redis, body({ id: 'game-0004', name: 'Tie Late', moves: lossGame }), '10.0.0.5', 9000);
  await submitScore(redis, body({ id: 'game-0005', name: 'Tie Early', moves: lossGame }), '10.0.0.6', 5000);
  const lb = (await readLeaderboard(redis)).body.teams;
  const loss = scoreGame(lossGame, { level: 'hard', humanSide: 0 }).total;
  const alpha = lb.find((x) => x.key === 'tim alpha');
  check('leaderboard: totals accumulate per team, case-insensitive', alpha?.total === expected + loss && alpha.games === 2 && alpha.wins === 1 && alpha.name === 'Tim Alpha', JSON.stringify(alpha));
  check('leaderboard: sorted by total', lb.every((x, i) => i === 0 || lb[i - 1].total >= x.total));
  check('leaderboard: tie broken by earlier first submission', lb.findIndex((x) => x.name === 'Tie Early') < lb.findIndex((x) => x.name === 'Tie Late'));
  check('leaderboard: ranks are 1..n', lb.every((x, i) => x.rank === i + 1));
  console.log('   ' + lb.map((x) => `#${x.rank} ${x.name} ${x.total} (${x.wins}/${x.games})`).join(' · '));

  // Admin point values.
  check('rules: defaults are valid', JSON.stringify(defaultRules()) === JSON.stringify(normalizeRules(SCORING)));
  const custom = { move: 7, win: 500, multiplier: { easy: 1, medium: 1.5, hard: 2.25, expert: 5 } };
  check('rules: valid custom values accepted', !!normalizeRules(custom));
  // Values saved before the trap and speed bonuses were removed still load.
  check('rules: old saved values with extra fields still load', normalizeRules({ ...custom, trapBonus: 5, speedBase: 100, speedPerMove: 5 })?.move === 7);
  for (const [what, bad] of [
    ['negative points', { ...custom, move: -1 }],
    ['fractional points', { ...custom, win: 1.5 }],
    ['points as a string', { ...custom, move: '10' }],
    ['missing field', { ...custom, win: undefined }],
    ['missing level', { ...custom, multiplier: { easy: 1, medium: 2, hard: 3 } }],
    ['multiplier over the limit', { ...custom, multiplier: { ...custom.multiplier, expert: 101 } }],
    ['multiplier with 3 decimals', { ...custom, multiplier: { ...custom.multiplier, easy: 1.234 } }],
  ]) check(`rules: ${what} rejected`, normalizeRules(bad) === null);
  const lv = levelValues(normalizeRules(custom), 'medium');
  check('rules: level values round to whole points', lv.move === 11 && lv.win === 750, JSON.stringify(lv));
  const cs = scoreGame(winGame, { level: 'hard', humanSide: 0, rules: custom });
  check('rules: custom values change the score', cs.movePoints === cs.humanMoves * Math.round(7 * 2.25) && cs.winPoints === Math.round(500 * 2.25));

  const ADMIN = 'test-admin-key-123';
  r = await updateRules(redis, { rules: custom }, '', ADMIN, '10.0.2.1');
  check('admin: missing key -> 401', r.status === 401);
  r = await updateRules(redis, { rules: custom }, 'wrong', ADMIN, '10.0.2.1');
  check('admin: wrong key -> 401', r.status === 401);
  r = await updateRules(redis, { rules: custom }, ADMIN, undefined, '10.0.2.1');
  check('admin: no ADMIN_KEY set -> 503', r.status === 503);
  r = await updateRules(redis, { rules: { ...custom, move: -5 } }, ADMIN, ADMIN, '10.0.2.1');
  check('admin: invalid values -> 400', r.status === 400 && r.body.error === 'bad-rules');
  check('admin: rules unchanged after rejected attempts', JSON.stringify(await getRules(redis)) === JSON.stringify(defaultRules()));
  r = await updateRules(redis, { rules: custom }, ADMIN, ADMIN, '10.0.2.1');
  check('admin: correct key saves', r.status === 200 && JSON.stringify(await getRules(redis)) === JSON.stringify(normalizeRules(custom)));
  r = await submitScore(redis, body({ id: 'game-custom1', name: 'Tim Custom' }), '10.0.2.2');
  const customExpected = scoreGame(winGame, { level: 'hard', humanSide: 0, rules: custom }).total;
  check('admin: new submissions use the saved values', r.status === 200 && r.body.score.total === customExpected && customExpected !== expected, `${r.body.score?.total} vs ${customExpected}`);
  r = await updateRules(redis, { reset: true }, ADMIN, ADMIN, '10.0.2.1');
  check('admin: reset restores the defaults', r.status === 200 && JSON.stringify(r.body.rules) === JSON.stringify(defaultRules()));
  for (let i = 0; i < 10; i++) await updateRules(redis, { check: true }, 'guess' + i, ADMIN, '10.0.2.9');
  r = await updateRules(redis, { check: true }, ADMIN, ADMIN, '10.0.2.9');
  check('admin: locked out after 10 wrong keys, even with the right one', r.status === 429 && r.body.error === 'locked');

  // The real handlers, with req/res stubs shaped like Vercel's Node helpers.
  const call = async (handler, req) => {
    const res = {
      code: 0, headers: {}, body: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; },
    };
    await handler(req, res);
    return res;
  };
  setRedis(redis);
  const { default: scoreHandler } = await import('../api/score.js');
  const { default: lbHandler } = await import('../api/leaderboard.js');
  let res = await call(lbHandler, { method: 'GET', headers: {} });
  check('GET /api/leaderboard returns the teams', res.code === 200 && res.body.teams.length === (await readLeaderboard(redis)).body.teams.length && res.body.teams.length > 0);
  res = await call(scoreHandler, { method: 'GET', headers: {} });
  check('GET /api/score -> 405', res.code === 405);
  const post = (b, ip) => ({ method: 'POST', headers: { 'x-forwarded-for': `${ip}, 10.9.9.9` }, body: JSON.stringify(b) });
  res = await call(scoreHandler, post(body({ id: 'game-handler1', name: 'Tim Gamma' }), '10.0.1.1'));
  check('POST /api/score (string body) -> 200', res.code === 200 && res.body.team.total === expected, JSON.stringify(res.body));
  res = await call(scoreHandler, post(body({ id: 'game-handler2', name: 'Tim Gamma' }), '10.0.1.1'));
  check('POST /api/score rate-limited by the first forwarded IP', res.code === 429);
  res = await call(scoreHandler, { method: 'POST', headers: {}, body: '{not json' });
  check('POST /api/score bad JSON -> 400', res.code === 400);
  const { default: configHandler } = await import('../api/config.js');
  res = await call(configHandler, { method: 'GET', headers: {} });
  check('GET /api/config returns the point values', res.code === 200 && JSON.stringify(res.body.rules) === JSON.stringify(defaultRules()));
  process.env.ADMIN_KEY = ADMIN;
  res = await call(configHandler, { method: 'POST', headers: { 'x-forwarded-for': '10.0.3.1' }, body: JSON.stringify({ rules: custom }) });
  check('POST /api/config without a key -> 401', res.code === 401);
  res = await call(configHandler, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'x-forwarded-for': '10.0.3.1' }, body: { rules: custom } });
  check('POST /api/config with the key -> 200', res.code === 200 && res.body.rules.move === 7);
  delete process.env.ADMIN_KEY;
  setRedis(null);
  res = await call(lbHandler, { method: 'GET', headers: {} });
  check('no Redis env vars -> 503 not-configured', res.code === 503 && res.body.error === 'not-configured');
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : 'FAILED'}: ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
