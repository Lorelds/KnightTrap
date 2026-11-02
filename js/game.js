// Turn flow for one match. Players are 'human' (input on this device), 'ai' (worker)
// or 'remote' (online opponent). Rules come only from rules.js.

import {
  createState, legalJumps, hasOpenSquare, isOpen, applyJump, applyTrap, endTurn,
  winner, validateMove, serialize, deserialize, EMPTY,
} from './rules.js';
import { AI as AICFG, SIZE, TURN_SECONDS, TURN_GRACE_MS } from './config.js';
import { think, cancelThinking } from './ai-client.js';
import { randomMove } from './ai.js';
import { t } from './i18n.js';
import { sleep } from './board.js';

export class Game {
  /**
   * opts.board   BoardView
   * opts.ui      { update(game), thinking(on), stats(result), log(history), over(info), timer(seconds|null), timeUp() }
   * opts.mode    'ai' | 'local' | 'online'
   * opts.players [{ kind, name, sub }, { kind, name, sub }] indexed by side
   * opts.ai      { depth, prune } when mode === 'ai'
   * opts.net     OnlineSession when mode === 'online'; opts.role 'host' | 'guest'
   * opts.turnMs  time limit for one turn (defaults to TURN_SECONDS)
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.turnMs ??= TURN_SECONDS * 1000;
    this.clock = null;
    this.deadline = null;
    this.state = createState();
    this.phase = 'idle';
    this.history = [];
    this.disposed = false;
    this.lastLand = null;
    this.lastTrap = null;
    this.pendingFrom = null;
    this.pendingJump = null;
    this.netQueue = Promise.resolve();
    this.board.onCell = (sq) => this.handleCell(sq);
    this.board.onKnight = (side) => {
      if (this.phase === 'trap' && side === this.state.turn) this.undoJump();
    };
  }

  start(state) {
    this.state = state ?? createState();
    this.history = [];
    this.lastLand = null;
    this.lastTrap = null;
    this.ui.log(this.history);
    this.nextTurn();
  }

  dispose() {
    this.disposed = true;
    this.stopClock();
    cancelThinking();
    this.board.onCell = null;
    this.board.onKnight = null;
  }

  get current() {
    return this.players[this.state.turn];
  }

  // Side whose point of view this device shows (null in local mode).
  get mySide() {
    if (this.mode === 'local') return null;
    return this.players.findIndex((p) => p.kind === 'human');
  }

  statusText() {
    const p = this.current;
    const name = p?.name;
    switch (this.phase) {
      case 'jump':
        return this.mode === 'local' ? t('sideJump', name) : t('yourJump');
      case 'trap':
        return this.mode === 'local' ? t('sideTrap', name) : t('yourTrap');
      case 'ai':
        return t('aiThinking');
      case 'remote':
        return t('waitingOpponent');
      case 'over':
        if (this.mode === 'local') return t('sideWins', this.players[this.winner].name);
        return this.mySide === this.winner ? t('youWin') : t('youLose');
      default:
        return this._lastStatus ?? '';
    }
  }

  view() {
    const s = this.state;
    const side = s.turn;
    const humanTurn = this.current?.kind === 'human';
    const v = {
      state: s,
      lastLand: this.lastLand,
      lastTrap: this.lastTrap,
      legal: [],
      eating: [],
      trappable: false,
      threats: [],
      dead: this.phase === 'over' ? this.loser : null,
      eaten: this.phase === 'over' && s.pos[0] === s.pos[1] ? this.loser : null,
      selectableKnight: null,
    };
    if (humanTurn && this.phase === 'jump') {
      v.legal = legalJumps(s);
      v.eating = v.legal.filter((sq) => sq === s.pos[side ^ 1]);
    }
    if (humanTurn && this.phase === 'trap') {
      v.trappable = true;
      v.threats = legalJumps(s, side ^ 1);
      v.selectableKnight = side;
    }
    return v;
  }

  refresh() {
    if (this.disposed) return;
    this.board.render(this.view());
    const text = this.statusText();
    this._lastStatus = text;
    this.ui.update(this, text);
  }

  nextTurn() {
    if (this.disposed) return;
    const w = winner(this.state);
    if (w !== null) return this.finish(w);
    const p = this.current;
    if (p.kind === 'human') {
      this.phase = 'jump';
      this.startClock();
      this.refresh();
    } else if (p.kind === 'ai') {
      this.phase = 'ai';
      this.stopClock();
      this.refresh();
      this.runAi();
    } else {
      this.phase = 'remote';
      this.startClock();
      this.refresh();
    }
  }

  // ---- Turn clock -------------------------------------------------------------
  // One clock per turn, for the jump and the trap together. The AI has its own limit and no clock.

  startClock() {
    this.stopClock();
    this.deadline = performance.now() + this.turnMs;
    this.ui.timer(Math.ceil(this.turnMs / 1000));
    this.clock = setInterval(() => this.tickClock(), 100);
  }

  stopClock() {
    clearInterval(this.clock);
    this.clock = null;
    this.deadline = null;
    this.ui.timer(null);
  }

  tickClock() {
    const left = this.deadline - performance.now();
    this.ui.timer(Math.max(0, Math.ceil(left / 1000)));
    if (this.current.kind === 'human') {
      if (left <= 0) this.timeUp();
    } else if (this.role === 'host' && left <= -TURN_GRACE_MS) {
      this.stopClock();
      this.netQueue = this.netQueue.then(() => this.playForQuietGuest()).catch((err) => console.error(err));
    }
  }

  // Time ran out on this device's turn. Goes through handleCell like a click,
  // so the rules and the online send are not duplicated.
  timeUp() {
    this.stopClock();
    this.ui.timeUp();
    const s = this.state;
    if (this.phase === 'jump') {
      const { jump, trap } = randomMove(s);
      this.handleCell(jump);
      if (this.phase === 'trap') this.handleCell(trap);
    } else if (this.phase === 'trap') {
      const open = [];
      for (let sq = 0; sq < SIZE; sq++) if (isOpen(s, sq)) open.push(sq);
      this.handleCell(open[Math.floor(Math.random() * open.length)]);
    }
  }

  // The guest stayed quiet past its limit and the grace period, so the host plays for it.
  async playForQuietGuest() {
    if (this.disposed || this.phase !== 'remote') return;
    await this.hostPlay(randomMove(this.state));
  }

  // Host only: play a guest move and tell the guest the result.
  async hostPlay(move) {
    const side = this.state.turn;
    const from = this.state.pos[side];
    await this.playMove(move);
    if (this.disposed) return;
    this.broadcast(side, from, move);
    this.nextTurn();
  }

  async runAi() {
    this.ui.thinking(true);
    const t0 = performance.now();
    let res = null;
    try {
      res = await think(this.state, { depth: this.ai.depth, prune: this.ai.prune });
    } catch (err) {
      console.error('AI failed', err);
    }
    if (this.disposed) return;
    const elapsed = performance.now() - t0;
    if (elapsed < AICFG.minUiDelayMs) await sleep(AICFG.minUiDelayMs - elapsed);
    if (this.disposed) return;
    this.ui.thinking(false);
    let move = res?.move;
    if (!move || !validateMove(this.state, move)) {
      console.warn('AI returned no valid move; falling back to a random legal move');
      move = randomMove(this.state);
    } else {
      this.ui.stats(res);
    }
    await this.playMove(move);
    if (this.disposed) return;
    this.nextTurn();
  }

  // Full move for the AI or a remote player. Input stays locked until the trap is placed.
  async playMove(move) {
    const s = this.state;
    const side = s.turn;
    this.phase = 'animating';
    this.stopClock();
    const from = applyJump(s, move.jump);
    this.lastLand = move.jump;
    this.lastTrap = null;
    this.refresh();
    await sleep(160);
    if (this.disposed) return;
    if (move.trap >= 0) {
      applyTrap(s, move.trap);
      this.lastTrap = move.trap;
      this.refresh();
    }
    endTurn(s);
    this.record(side, from, move);
  }

  handleCell(sq) {
    if (this.disposed || this.current?.kind !== 'human') return;
    const s = this.state;
    if (this.phase === 'jump') {
      if (!legalJumps(s).includes(sq)) return;
      const from = applyJump(s, sq);
      this.pendingFrom = from;
      this.pendingJump = sq;
      this.lastLand = sq;
      this.lastTrap = null;
      if (sq === s.pos[s.turn ^ 1] || !hasOpenSquare(s)) return this.completeHumanMove(-1);
      this.phase = 'trap';
      this.refresh();
    } else if (this.phase === 'trap') {
      if (!isOpen(s, sq)) return;
      applyTrap(s, sq);
      this.lastTrap = sq;
      this.completeHumanMove(sq);
    }
  }

  undoJump() {
    if (this.phase !== 'trap' || this.pendingFrom == null) return;
    const s = this.state;
    const side = s.turn;
    s.pos[side] = this.pendingFrom;
    s.cells[this.pendingFrom] = EMPTY;
    this.lastLand = null;
    this.pendingFrom = null;
    this.pendingJump = null;
    this.phase = 'jump';
    this.refresh();
  }

  completeHumanMove(trap) {
    this.stopClock();
    const s = this.state;
    const side = s.turn;
    const move = { jump: this.pendingJump, trap };
    const from = this.pendingFrom;
    this.pendingFrom = null;
    this.pendingJump = null;
    endTurn(s);
    this.record(side, from, move);
    if (this.mode === 'online') {
      if (this.role === 'guest') this.net.send({ t: 'move', jump: move.jump, trap: move.trap, n: s.moves });
      else this.broadcast(side, from, move);
    }
    this.nextTurn();
  }

  record(side, from, move) {
    this.history.push({ side, from, jump: move.jump, trap: move.trap, ate: move.jump === this.state.pos[side ^ 1] });
    this.ui.log(this.history);
  }

  finish(w) {
    this.stopClock();
    this.phase = 'over';
    this.winner = w;
    this.loser = w ^ 1;
    this.refresh();
    const eaten = this.state.pos[0] === this.state.pos[1];
    setTimeout(() => {
      if (!this.disposed) this.ui.over({ winner: w, loser: w ^ 1, moves: this.state.moves, game: this, eaten });
    }, 900);
  }

  // ---- Online ---------------------------------------------------------------

  broadcast(side, from, move) {
    this.net.send({ t: 'state', state: serialize(this.state), last: { side, from, jump: move.jump, trap: move.trap } });
  }

  onNetMessage(msg) {
    // Handle messages one at a time so a move in progress never overlaps the next update.
    this.netQueue = this.netQueue.then(() => this.handleNet(msg)).catch((err) => console.error(err));
  }

  async handleNet(msg) {
    if (this.disposed) return;
    if (this.role === 'host' && msg.t === 'move') {
      const move = { jump: msg.jump, trap: msg.trap };
      if (this.phase !== 'remote' || !validateMove(this.state, move)) {
        this.net.send({ t: 'reject', state: serialize(this.state) });
        return;
      }
      await this.hostPlay(move);
      return;
    }
    if (this.role === 'guest' && (msg.t === 'state' || msg.t === 'reject')) {
      let incoming;
      try {
        incoming = deserialize(msg.state);
      } catch {
        return;
      }
      const last = msg.last;
      const isOpponentMove =
        msg.t === 'state' && last && incoming.moves === this.state.moves + 1 &&
        this.players[last.side]?.kind === 'remote' && this.phase === 'remote';
      if (isOpponentMove && validateMove(this.state, last)) {
        await this.playMove(last);
        if (this.disposed) return;
      }
      if (incoming.moves === this.state.moves && msg.t === 'state' && !isOpponentMove) {
        // Echo of our own move; adopt the host copy silently.
        this.state = incoming;
        if (this.phase !== 'jump' && this.phase !== 'trap') this.refresh();
        return;
      }
      this.state = incoming;
      if (msg.t === 'reject' || !isOpponentMove) {
        this.lastLand = null;
        this.lastTrap = null;
        this.pendingFrom = null;
        this.pendingJump = null;
      }
      this.nextTurn();
    }
  }
}
