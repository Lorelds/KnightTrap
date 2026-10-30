// App shell: screens, menus, settings, online lobby, and the glue between Game and the DOM.

import { DIFFICULTY, LEADERBOARD } from './config.js';
import { createState, legalJumps, serialize, deserialize, squareName } from './rules.js';
import { WIN } from './ai.js';
import { BoardView, knightSvg } from './board.js';
import { Game } from './game.js';
import { OnlineSession, normalizeCode } from './net.js';
import { setLang, getLang, t } from './i18n.js';
import { sfx, setSoundEnabled, unlockAudio } from './audio.js';
import { startBackgroundEmbers, reducedMotion } from './fx.js';
import {
  scoreGame, pointsEnabled, cleanName, validName, nameKey, defaultRules, normalizeRules, levelValues, LEVELS,
} from './scoring.js';
import { pointsTable } from './points-table.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- Settings (per-browser convenience only) --------------------------------
const SETTINGS_KEY = 'knighttrap.settings';
const settings = { sound: true, lang: 'id', diff: 'medium', first: 'human', prune: true };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch {}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

// Team name for the leaderboard, and scores that could not be sent yet.
const TEAM_KEY = 'knighttrap.team';
const PENDING_KEY = 'knighttrap.pending';
let team = '';
try {
  team = cleanName(localStorage.getItem(TEAM_KEY) || '');
  if (!validName(team)) team = '';
} catch {}
function setTeam(name) {
  team = name;
  try {
    localStorage.setItem(TEAM_KEY, name);
  } catch {}
  $('#sp-team-name').textContent = team || '—';
}
function loadPending() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function savePending(list) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {}
}

// ---- Screens ----------------------------------------------------------------
let currentScreen = 'menu';
const backTarget = { sp: 'menu', mp: 'menu', howto: 'menu', settings: 'menu', lobby: 'mp', board: 'menu' };

function showScreen(name) {
  for (const s of $$('.screen')) s.classList.toggle('is-active', s.dataset.screen === name);
  currentScreen = name;
  window.scrollTo(0, 0);
  if (name === 'menu') startMenuBoard();
  else stopMenuBoard();
  if (name === 'board') startLeaderboard();
  else stopLeaderboard();
}

// ---- Toast & confirm ---------------------------------------------------------
let toastTimer = 0;
function toast(text, bad = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function confirmDialog(text) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        <h2 style="font-size:24px;margin-top:0">${text}</h2>
        <div class="go-actions" style="margin-top:20px">
          <button class="btn btn-primary btn-lg" data-yes>${t('mainMenu')}</button>
          <button class="btn btn-ghost" data-no>${getLang() === 'id' ? 'Lanjut main' : 'Keep playing'}</button>
        </div>
      </div>`;
    const done = (v) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-no]')) done(false);
      else if (e.target.closest('[data-yes]')) done(true);
    });
    document.body.appendChild(wrap);
    $('[data-no]', wrap).focus();
  });
}

function nameDialog() {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <form class="modal-card name-card" role="dialog" aria-modal="true" aria-labelledby="name-title" novalidate>
        <h2 id="name-title" style="font-size:24px">${t('teamName')}</h2>
        <p>${t('teamPrompt')}</p>
        <input class="name-input" maxlength="${LEADERBOARD.nameMax}" autocomplete="off" spellcheck="false" aria-label="${t('teamName')}">
        <p class="name-error" aria-live="polite"></p>
        <div class="go-actions">
          <button class="btn btn-primary btn-lg" type="submit">${t('save')}</button>
          <button class="btn btn-ghost" type="button" data-no>${t('cancel')}</button>
        </div>
      </form>`;
    const input = $('input', wrap);
    input.value = team;
    const done = (v) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-no]')) done(null);
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(null);
    });
    $('form', wrap).addEventListener('submit', (e) => {
      e.preventDefault();
      const name = cleanName(input.value);
      if (!validName(name)) {
        $('.name-error', wrap).textContent = t('teamInvalid', LEADERBOARD.nameMin, LEADERBOARD.nameMax);
        input.focus();
        return;
      }
      done(name);
    });
    document.body.appendChild(wrap);
    input.focus();
    input.select();
  });
}

// Asks for the team name once; later games reuse it.
async function ensureTeam(force = false) {
  if (team && !force) return team;
  const name = await nameDialog();
  if (name) setTeam(name);
  return name;
}

// ---- Menu decoration: a perspective board that burns and traps squares -----
let menuTimer = 0;
const menuCells = [];
function buildMenuBoard() {
  const el = $('#menu-board');
  for (let i = 0; i < 49; i++) {
    const s = document.createElement('span');
    el.appendChild(s);
    menuCells.push(s);
  }
}
function startMenuBoard() {
  if (menuTimer || reducedMotion()) return;
  menuTimer = setInterval(() => {
    const c = menuCells[Math.floor(Math.random() * 49)];
    if (c.classList.contains('lit') || c.classList.contains('pit')) c.className = '';
    else c.className = Math.random() < 0.7 ? 'lit' : 'pit';
  }, 650);
}
function stopMenuBoard() {
  clearInterval(menuTimer);
  menuTimer = 0;
}

// ---- How to play ------------------------------------------------------------
function miniBoard(spec) {
  // spec: { k0, k1, legal: [], burned: [], trap: [], threat: [] } in 5x5 coordinates "r,c"
  const set = (arr) => new Set((arr || []).map((p) => p.join(',')));
  const legal = set(spec.legal);
  const burned = set(spec.burned);
  const trap = set(spec.trap);
  const threat = set(spec.threat);
  let html = '<div class="mini-board">';
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const key = `${r},${c}`;
      const cls = ['cell'];
      if ((r + c) % 2) cls.push('dark');
      if (legal.has(key)) cls.push('legal');
      if (burned.has(key)) cls.push('burned');
      if (trap.has(key)) cls.push('trap');
      if (threat.has(key)) cls.push('threat');
      let inner = '';
      if (spec.k0?.join(',') === key) inner = knightSvg(0);
      if (spec.k1?.join(',') === key) inner = knightSvg(1);
      html += `<div class="${cls.join(' ')}" style="display:grid;place-items:center">${inner}</div>`;
    }
  }
  return html + '</div>';
}

function buildHowTo() {
  const steps = [
    {
      title: t('step1Title'),
      text: t('step1Text'),
      board: miniBoard({ k0: [2, 2], legal: [[0, 1], [0, 3], [1, 0], [1, 4], [3, 0], [3, 4], [4, 1], [4, 3]] }),
    },
    {
      title: t('step2Title'),
      text: t('step2Text'),
      board: miniBoard({ k0: [0, 3], burned: [[2, 2]] }),
    },
    {
      title: t('step3Title'),
      text: t('step3Text'),
      board: miniBoard({ k0: [0, 3], k1: [4, 4], burned: [[2, 2]], trap: [[2, 3]], threat: [[3, 2]] }),
    },
  ];
  $('#howto-steps').innerHTML = steps
    .map(
      (s, i) => `<article class="step">${s.board}<h3><span class="step-num">${i + 1}</span>${s.title}</h3><p>${s.text}</p></article>`,
    )
    .join('');
}

// ---- Game UI glue -----------------------------------------------------------
const board = new BoardView($('#board'), $('#board-shell'));
let game = null;
let gameConfig = null; // how to start a rematch
let session = null;
let online = { round: 0, myRematch: false, peerRematch: false, left: false };

let liveScore = 0;
let lastGame = null; // finished Single Player game waiting for "Submit score"

const gameMoves = (g) => g.history.map(({ jump, trap }) => ({ jump, trap }));
const currentScore = (g) => scoreGame(gameMoves(g), { mode: g.mode, level: g.level, humanSide: g.mySide, rules: g.rules });

// Point values: the defaults until /api/config answers with the admin's saved copy.
let rules = defaultRules();

async function loadRules() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    const fresh = normalizeRules(data?.rules);
    if (fresh) rules = fresh;
  } catch {}
  renderPointsInfo();
}

function renderPointsInfo() {
  for (const lvl of LEVELS) {
    const el = $(`[data-pts="${lvl}"]`);
    if (el) el.textContent = t('ptsPerMove', levelValues(rules, lvl).move);
  }
  $('#sp-points').innerHTML = pointsTable(rules, t, settings.diff);
}

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function updateScore(history, sc) {
  $('#score-pill').hidden = !sc;
  if (!sc) return;
  const gained = sc.total - liveScore;
  liveScore = sc.total;
  $('#score-val').textContent = sc.total.toLocaleString();
  const last = history.at(-1);
  if (gained > 0 && last?.side === game.mySide) {
    board.popText(last.jump, `+${gained}`);
    flash($('#score-val'));
  }
}

function renderBreakdown(sc, level, used) {
  const per = levelValues(used, level);
  $('#go-mult').textContent = `${t(level)} · ×${sc.mult}`;
  const rows = [[t('ptMoves', sc.humanMoves, per.move), sc.movePoints]];
  if (sc.won) rows.push([t('ptWin'), sc.winPoints]);
  $('#go-breakdown').innerHTML =
    rows.map(([label, v]) => `<li><span>${label}</span><b>+${v.toLocaleString()}</b></li>`).join('') +
    `<li class="total"><span>${t('ptTotal')}</span><b>${sc.total.toLocaleString()}</b></li>`;
}

function newGameId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function setSubmitStatus(text, kind = '') {
  const el = $('#go-submit-status');
  el.textContent = text;
  el.className = `go-submit-status ${kind}`;
}

// POST one game. kind: 'ok' | 'rate' | 'dup' | 'rejected' | 'offline'.
async function postScore(payload) {
  let res;
  try {
    res = await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: 'offline' };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.ok && data?.ok) return { kind: 'ok', data };
  if (res.status === 429) return { kind: 'rate' };
  if (res.status === 409) return { kind: 'dup' };
  if (res.status === 400 && data) return { kind: 'rejected', data };
  // 404 on a plain static server, 503 without Redis, 5xx: keep the game for later.
  return { kind: 'offline' };
}

async function submitLastGame() {
  const g = lastGame;
  if (!g || g.sent) return;
  const name = await ensureTeam();
  if (!name || lastGame !== g) return;
  const btn = $('#go-submit');
  btn.disabled = true;
  setSubmitStatus(t('submitting'));
  const payload = { name, difficulty: g.difficulty, side: g.side, id: g.id, moves: g.moves };
  const r = await postScore(payload);
  if (lastGame !== g) return;
  if (r.kind === 'rate') {
    btn.disabled = false;
    setSubmitStatus(t('submitRate'), 'bad');
    return;
  }
  g.sent = true;
  if (r.kind === 'ok') {
    setSubmitStatus(t('submitted', r.data.score.total.toLocaleString(), r.data.rank, r.data.team.total.toLocaleString()), 'ok');
  }
  else if (r.kind === 'dup') setSubmitStatus(t('submitDup'), 'bad');
  else if (r.kind === 'rejected') setSubmitStatus(`${t('submitRejected')} (${r.data.error})`, 'bad');
  else {
    savePending([...loadPending(), payload]);
    setSubmitStatus(t('submitOffline'), 'bad');
  }
}

function colorName(side) {
  return side === 0 ? t('blue') : t('orange');
}

const ui = {
  update(g, text) {
    const s = g.state;
    const status = $('#status');
    const side = g.phase === 'over' ? g.winner : s.turn;
    status.dataset.side = side;
    status.classList.toggle('trap-mode', g.phase === 'trap');
    $('#status-text').textContent = text;
    $('#undo-jump').hidden = !(g.phase === 'trap' && g.current?.kind === 'human');
    for (const card of $$('.pcard')) {
      const sd = Number(card.dataset.side);
      const p = g.players[sd];
      $('.pcard-name', card).textContent = p.name;
      $('.pcard-sub', card).textContent = p.sub;
      const mob = legalJumps(s, sd).length;
      $('.pcard-mob b', card).textContent = mob;
      $('.pcard-mob', card).classList.toggle('danger', g.phase !== 'over' && mob <= 1);
      card.classList.toggle('is-turn', g.phase !== 'over' && s.turn === sd);
      card.classList.toggle('is-winner', g.phase === 'over' && g.winner === sd);
    }
  },
  thinking(on) {
    $('#thinking').classList.toggle('on', on);
  },
  stats(res) {
    const set = (id, html) => {
      const el = $(id);
      el.innerHTML = html;
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    };
    set('#st-depth', String(res.depth));
    set('#st-nodes', res.nodes.toLocaleString());
    set('#st-cutoffs', res.prune ? res.cutoffs.toLocaleString() : '0 <span class="tag">OFF</span>');
    const ms = res.timeMs < 10 ? res.timeMs.toFixed(1) : Math.round(res.timeMs).toLocaleString();
    set('#st-time', `${ms} ms${res.timedOut ? ` <span class="tag">${t('timedOut')}</span>` : ''}`);
    let score = '–';
    if (res.score != null) {
      if (res.score >= WIN / 2) score = t('scoreWin', WIN - res.score);
      else if (res.score <= -WIN / 2) score = t('scoreLoss', WIN + res.score);
      else score = (res.score > 0 ? '+' : '') + (Number.isInteger(res.score) ? res.score : res.score.toFixed(1));
    }
    set('#st-score', score);
  },
  log(history) {
    const ol = $('#log');
    const sc = game && pointsEnabled(game.mode) ? currentScore(game) : null;
    if (!history.length) {
      ol.innerHTML = `<li class="log-empty" style="display:block;background:none">${t('logEmpty')}</li>`;
      updateScore(history, sc);
      return;
    }
    ol.innerHTML = history
      .map(
        (h, i) => `<li class="s${h.side}"><span class="n">${i + 1}.</span><span class="sw"></span>` +
          `<span class="mv">${squareName(h.from)} → <b>${squareName(h.jump)}</b>${h.trap >= 0 ? `<span class="x">✕ ${squareName(h.trap)}</span>` : ''}</span>` +
          (sc?.steps[i] ? `<span class="pts">+${sc.steps[i].toLocaleString()}</span>` : '') + '</li>',
      )
      .join('');
    ol.scrollTop = ol.scrollHeight;
    updateScore(history, sc);
  },
  over(info) {
    const g = info.game;
    const me = g.mySide;
    const winName = g.players[info.winner].name;
    const loseName = g.players[info.loser].name;
    let title;
    let sub;
    let win = true;
    if (g.mode === 'local') {
      title = t('sideWins', winName);
      sub = t('trappedSub', loseName);
    } else {
      win = me === info.winner;
      title = win ? t('youWin') : t('youLose');
      if (g.mode === 'ai') sub = win ? t('youWinSub') : t('aiWinSub');
      else sub = t('trappedSub', loseName);
    }
    let score = null;
    if (pointsEnabled(g.mode)) {
      score = currentScore(g);
      renderBreakdown(score, g.level, g.rules);
    }
    openGameOver({ title, sub, win, winnerSide: info.winner, moves: info.moves, score });
    if (score) lastGame = { difficulty: g.level, side: me, id: newGameId(), moves: gameMoves(g), sent: false };
  },
};

function openGameOver({ title, sub, win, winnerSide, moves, leftOnly = false, score = null }) {
  const card = $('#gameover .modal-card');
  card.classList.toggle('win', win);
  card.classList.toggle('lose', !win);
  $('#go-title').textContent = title;
  $('#go-sub').textContent = sub;
  $('#go-moves').textContent = moves;
  $('#go-glyph').setAttribute('class', `kglyph p${winnerSide ?? 0}`);
  $('#go-rematch').hidden = leftOnly;
  $('#go-rematch').disabled = false;
  $('#go-wait').hidden = true;
  $('#go-score').hidden = !score;
  $('#go-submit').disabled = false;
  setSubmitStatus('');
  lastGame = null;
  $('#gameover').hidden = false;
  (leftOnly ? $('#go-menu') : $('#go-rematch')).focus();
}

function closeGameOver() {
  $('#gameover').hidden = true;
  lastGame = null;
}

function resetSidePanels(mode) {
  $('#ai-panel').hidden = mode !== 'ai';
  for (const id of ['#st-depth', '#st-nodes', '#st-cutoffs', '#st-time', '#st-score']) $(id).textContent = '–';
  ui.thinking(false);
  $('#net-pill').hidden = mode !== 'online';
}

function launch(cfg, state) {
  game?.dispose();
  closeGameOver();
  gameConfig = cfg;
  resetSidePanels(cfg.mode);
  game = new Game({ board, ui, ...cfg });
  $('#game-mode').textContent =
    cfg.mode === 'ai' ? t('modeAi', t(cfg.level)) : cfg.mode === 'local' ? t('modeLocal') : t('modeOnline');
  showScreen('game');
  game.start(state ?? createState());
}

function startAiGame() {
  const humanFirst = settings.first === 'human' || (settings.first === 'random' && Math.random() < 0.5);
  const hs = humanFirst ? 0 : 1;
  const players = [];
  players[hs] = { kind: 'human', name: t('you'), sub: colorName(hs) };
  players[hs ^ 1] = { kind: 'ai', name: `AI · ${t(settings.diff)}`, sub: colorName(hs ^ 1) };
  $('#game-ab').checked = settings.prune;
  $('#ab-state').textContent = settings.prune ? 'ON' : 'OFF';
  // The game keeps the point values it started with, even if the admin changes them mid-game.
  launch({ mode: 'ai', level: settings.diff, players, rules, ai: { depth: DIFFICULTY[settings.diff], prune: settings.prune } });
}

function startLocalGame() {
  launch({
    mode: 'local',
    players: [
      { kind: 'human', name: t('player', 1), sub: colorName(0) },
      { kind: 'human', name: t('player', 2), sub: colorName(1) },
    ],
  });
}

// ---- Online -----------------------------------------------------------------
function setNetStatus(kind, text) {
  for (const dot of [$('#lobby-dot'), $('#net-pill .dot')]) dot.className = `dot ${kind}`;
  $('#lobby-status').textContent = text;
  $('#net-pill .net-text').textContent = text;
}

function onlinePlayers(mySide) {
  const p = [];
  p[mySide] = { kind: 'human', name: t('you'), sub: colorName(mySide) };
  p[mySide ^ 1] = { kind: 'remote', name: t('opponent'), sub: colorName(mySide ^ 1) };
  return p;
}

function startOnlineRound() {
  // Sides swap every round so both players get to move first.
  const guestSide = online.round % 2 === 0 ? 1 : 0;
  online.round++;
  online.myRematch = online.peerRematch = false;
  const state = createState();
  session.send({ t: 'start', guestSide, state: serialize(state) });
  launch({ mode: 'online', role: 'host', net: session, players: onlinePlayers(guestSide ^ 1) }, state);
}

function beginGuestRound(msg) {
  const guestSide = msg.guestSide === 0 ? 0 : 1;
  let state;
  try {
    state = deserialize(msg.state);
  } catch {
    return;
  }
  online.myRematch = online.peerRematch = false;
  launch({ mode: 'online', role: 'guest', net: session, players: onlinePlayers(guestSide) }, state);
}

function newSession() {
  endSession();
  online = { round: 0, myRematch: false, peerRematch: false, left: false };
  session = new OnlineSession();
  session
    .on('status', (s) => {
      if (s === 'connected') setNetStatus('ok', t('netConnected'));
      else if (s === 'unstable') setNetStatus('wait', t('netUnstable'));
    })
    .on('connected', () => {
      if (session.role === 'host') startOnlineRound();
    })
    .on('message', (msg) => {
      if (msg.t === 'start' && session.role === 'guest') beginGuestRound(msg);
      else if (msg.t === 'full') {
        toast(t('netRoomFull'), true);
        endSession();
        showScreen('mp');
      } else if (msg.t === 'rematch') {
        online.peerRematch = true;
        if (online.myRematch && session.role === 'host') startOnlineRound();
        else if (!$('#gameover').hidden) {
          $('#go-wait').hidden = false;
          $('#go-wait').textContent = t('oppWantsRematch');
        } else toast(t('oppWantsRematch'));
      } else game?.onNetMessage(msg);
    })
    .on('left', () => {
      online.left = true;
      setNetStatus('bad', t('netLeft'));
      if (currentScreen === 'lobby') return;
      if (game && game.phase !== 'over') {
        game.dispose();
        openGameOver({ title: t('netLeft'), sub: '', win: true, winnerSide: game.mySide, moves: game.state.moves, leftOnly: true });
      } else if (!$('#gameover').hidden) {
        $('#go-rematch').hidden = true;
        $('#go-wait').hidden = false;
        $('#go-wait').textContent = t('netLeft');
      }
    });
  return session;
}

function endSession() {
  session?.close();
  session = null;
}

async function hostRoom() {
  const s = newSession();
  $('#room-code').textContent = '·····';
  $('#lobby-label').textContent = t('roomCode');
  $('#lobby-hint').textContent = t('lobbyHint');
  $('#copy-code').hidden = true;
  setNetStatus('wait', t('netCreating'));
  showScreen('lobby');
  try {
    const code = await s.host();
    if (session !== s) return;
    $('#room-code').textContent = code;
    $('#copy-code').hidden = false;
    setNetStatus('wait', t('netWaiting'));
  } catch (err) {
    if (session !== s) return;
    console.warn(err);
    toast(err.message === 'load-fail' ? t('netLoadFail') : t('netError'), true);
    endSession();
    showScreen('mp');
  }
}

async function joinRoom(raw) {
  const code = normalizeCode(raw);
  if (code.length < 4 || code.length > 6) {
    toast(t('netBadCode'), true);
    $('#join-code').focus();
    return;
  }
  const s = newSession();
  $('#room-code').textContent = code;
  $('#lobby-label').textContent = t('roomCode');
  $('#lobby-hint').textContent = t('joiningHint');
  $('#copy-code').hidden = true;
  setNetStatus('wait', t('netConnecting'));
  showScreen('lobby');
  try {
    await s.join(code);
  } catch (err) {
    if (session !== s) return;
    console.warn(err);
    const msg = err.message === 'load-fail' ? t('netLoadFail') : err.type === 'peer-unavailable' ? t('netRoomNotFound') : t('netError');
    toast(msg, true);
    endSession();
    showScreen('mp');
  }
}

// ---- Leaderboard ------------------------------------------------------------
let lbTimer = 0;
let lbBusy = false;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function startLeaderboard() {
  if (lbTimer) return;
  if (!$('#lb-list').children.length) $('#lb-status').textContent = t('lbLoading');
  refreshLeaderboard();
  lbTimer = setInterval(refreshLeaderboard, LEADERBOARD.pollMs);
}
function stopLeaderboard() {
  clearInterval(lbTimer);
  lbTimer = 0;
}

function renderPending() {
  const n = loadPending().length;
  $('#lb-pending').hidden = n === 0;
  $('#lb-pending').textContent = n ? t('lbPending', n) : '';
}

function renderLeaderboard(teams) {
  const me = team ? nameKey(team) : '';
  $('#lb-list').innerHTML = teams.length
    ? teams
        .map(
          (tm) => `<li class="lb-row${tm.key === me ? ' me' : ''}${tm.rank <= 3 ? ` top${tm.rank}` : ''}">` +
            `<span class="lb-rank">${tm.rank}</span><span class="lb-name">${esc(tm.name)}</span>` +
            `<b>${Number(tm.total).toLocaleString()}</b><span>${Number(tm.wins)}</span><span>${Number(tm.games)}</span></li>`,
        )
        .join('')
    : `<li class="lb-empty">${t('lbEmpty')}</li>`;
}

// Sends the oldest saved score, one per refresh so the per-IP rate limit is respected.
async function flushPending() {
  const list = loadPending();
  if (!list.length) return false;
  const r = await postScore(list[0]);
  if (r.kind === 'rate' || r.kind === 'offline') return false;
  savePending(loadPending().slice(1));
  if (r.kind !== 'ok') return false;
  toast(t('pendingSent'));
  return true;
}

async function fetchLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard', { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

async function refreshLeaderboard() {
  if (lbBusy) return;
  lbBusy = true;
  $('#lb-refresh').classList.add('spin');
  let data = await fetchLeaderboard();
  if (data?.ok && (await flushPending())) data = (await fetchLeaderboard()) ?? data;
  lbBusy = false;
  $('#lb-refresh').classList.remove('spin');
  if (currentScreen !== 'board') return;
  if (data?.ok && Array.isArray(data.teams)) {
    $('#lb-dot').className = 'dot ok';
    $('#lb-status').textContent = t('lbUpdated', new Date().toLocaleTimeString(getLang() === 'id' ? 'id-ID' : 'en-GB'));
    renderLeaderboard(data.teams);
  } else {
    $('#lb-dot').className = 'dot bad';
    $('#lb-status').textContent = t('lbOffline');
  }
  renderPending();
}

// ---- Wiring -----------------------------------------------------------------
function selectRadio(group, attr, value) {
  for (const b of $$(`[${attr}]`, group)) b.setAttribute('aria-checked', String(b.getAttribute(attr) === value));
}

function applySettingsToUi() {
  setLang(settings.lang);
  setSoundEnabled(settings.sound);
  $('#set-sound').checked = settings.sound;
  $('#game-sound').classList.toggle('is-off', !settings.sound);
  selectRadio($('#lang-seg'), 'data-lang', settings.lang);
  selectRadio($('#diff-grid'), 'data-diff', settings.diff);
  selectRadio($('#first-seg'), 'data-first', settings.first);
  $('#sp-ab').checked = settings.prune;
  $('#sp-team-name').textContent = team || '—';
  buildHowTo();
  renderPointsInfo();
}

async function leaveGame() {
  const inProgress = game && game.phase !== 'over' && game.state.moves > 0 && !online.left;
  if (inProgress && !(await confirmDialog(t('leaveConfirm')))) return;
  game?.dispose();
  game = null;
  closeGameOver();
  if (gameConfig?.mode === 'online') endSession();
  showScreen('menu');
}

function init() {
  buildMenuBoard();
  applySettingsToUi();
  startBackgroundEmbers($('#bg-embers'));
  showScreen('menu');
  ui.log([]);
  loadRules();

  document.addEventListener('pointerdown', unlockAudio, { once: true });

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      sfx.select();
      showScreen(go.dataset.go);
      if (go.dataset.go === 'sp') loadRules();
      return;
    }
    if (e.target.closest('[data-back]')) showScreen(backTarget[currentScreen] || 'menu');
  });

  $('#diff-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-diff]');
    if (!b) return;
    settings.diff = b.dataset.diff;
    selectRadio($('#diff-grid'), 'data-diff', settings.diff);
    renderPointsInfo();
    sfx.select();
    saveSettings();
  });
  $('#first-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-first]');
    if (!b) return;
    settings.first = b.dataset.first;
    selectRadio($('#first-seg'), 'data-first', settings.first);
    saveSettings();
  });
  $('#sp-ab').addEventListener('change', (e) => {
    settings.prune = e.target.checked;
    saveSettings();
  });
  $('#sp-start').addEventListener('click', async () => {
    if (await ensureTeam()) startAiGame();
  });
  $('#sp-team-change').addEventListener('click', () => ensureTeam(true));
  $('#go-submit').addEventListener('click', submitLastGame);
  $('#lb-refresh').addEventListener('click', refreshLeaderboard);

  $('#game-ab').addEventListener('change', (e) => {
    settings.prune = e.target.checked;
    $('#ab-state').textContent = settings.prune ? 'ON' : 'OFF';
    $('#sp-ab').checked = settings.prune;
    if (game?.ai) game.ai.prune = settings.prune;
    saveSettings();
  });

  $('#mp-local').addEventListener('click', startLocalGame);
  $('#mp-host').addEventListener('click', hostRoom);
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoom($('#join-code').value);
  });
  $('#join-code').addEventListener('input', (e) => {
    e.target.value = normalizeCode(e.target.value).slice(0, 6);
  });
  $('#lobby-cancel').addEventListener('click', () => {
    endSession();
    showScreen('mp');
  });
  $('#copy-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#room-code').textContent);
      toast(t('copied'));
    } catch {
      toast($('#room-code').textContent);
    }
  });

  $('#set-sound').addEventListener('change', (e) => {
    settings.sound = e.target.checked;
    applySettingsToUi();
    saveSettings();
  });
  $('#game-sound').addEventListener('click', () => {
    settings.sound = !settings.sound;
    applySettingsToUi();
    saveSettings();
  });
  $('#lang-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b) return;
    settings.lang = b.dataset.lang;
    applySettingsToUi();
    saveSettings();
  });

  $('#game-exit').addEventListener('click', leaveGame);
  $('#undo-jump').addEventListener('click', () => game?.undoJump());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && game?.phase === 'trap') game.undoJump();
  });

  $('#go-menu').addEventListener('click', () => {
    game?.dispose();
    game = null;
    closeGameOver();
    if (gameConfig?.mode === 'online') endSession();
    showScreen('menu');
  });
  $('#go-rematch').addEventListener('click', () => {
    if (!gameConfig) return;
    if (gameConfig.mode === 'ai') return startAiGame();
    if (gameConfig.mode === 'local') return startLocalGame();
    if (!session || online.left) return;
    online.myRematch = true;
    session.send({ t: 'rematch' });
    if (online.peerRematch && session.role === 'host') return startOnlineRound();
    $('#go-rematch').disabled = true;
    $('#go-wait').hidden = false;
    $('#go-wait').textContent = t('waitRematch');
  });

  window.addEventListener('beforeunload', () => session?.close());
}

init();
