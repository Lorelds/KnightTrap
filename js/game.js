// Turn flow for one match. Players are 'human' (input on this device), 'ai' (worker)
// or 'remote' (online opponent). Rules come only from rules.js.

import {
  createState, legalJumps, hasOpenSquare, isOpen, applyJump, applyTrap, endTurn,
  winner, validateMove, serialize, deserialize, EMPTY,
} from './rules.js';
import { AI as AICFG } from './config.js';
import { think, cancelThinking } from './ai-client.js';
import { randomMove } from './ai.js';
import { sfx } from './audio.js';
import { t } from './i18n.js';
import { sleep } from './board.js';

export class Game {
  /**
   * opts.board   BoardView
   * opts.ui      { update(game), thinking(on), stats(result), log(history), over(info) }
   * opts.mode    'ai' | 'local' | 'online'
   * opts.players [{ kind, name, sub }, { kind, name, sub }] indexed by side
   * opts.ai      { depth, prune } when mode === 'ai'
   * opts.net     OnlineSession when mode === 'online'; opts.role 'host' | 'guest'
   */
  constructor(opts) {
    Object.assign(this, opts);
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
      turnSide: this.phase === 'over' ? null : side,
      lastLand: this.lastLand,
      lastTrap: this.lastTrap,
      legal: [],
      trappable: false,
      threats: [],
      dead: this.phase === 'over' ? this.loser : null,
      selectableKnight: null,
    };
    if (humanTurn && this.phase === 'jump') v.legal = legalJumps(s);
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
      if (this.mode === 'local' && this.history.length) sfx.turn();
      this.refresh();
    } else if (p.kind === 'ai') {
      this.phase = 'ai';
      this.refresh();
      this.runAi();
    } else {
      this.phase = 'remote';
      this.refresh();
    }
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

  // Animated full move for the AI or a remote player.
  async playMove(move) {
    const s = this.state;
    const side = s.turn;
    this.phase = 'animating';
    const from = applyJump(s, move.jump);
    this.lastLand = move.jump;
    this.lastTrap = null;
    sfx.jump();
    const anim = this.board.animateJump(side, from, move.jump);
    this.refresh();
    this.board.burn(from);
    sfx.burn();
    await anim;
    if (this.disposed) return;
    await sleep(160);
    if (move.trap >= 0) {
      applyTrap(s, move.trap);
      this.lastTrap = move.trap;
      this.refresh();
      sfx.trap();
      await this.board.trap(move.trap);
    }
    endTurn(s);
    this.record(side, from, move);
  }

  async handleCell(sq) {
    if (this.disposed || this.current?.kind !== 'human') return;
    const s = this.state;
    const side = s.turn;
    if (this.phase === 'jump') {
      if (!legalJumps(s).includes(sq)) {
        if (sq !== s.pos[side]) sfx.invalid();
        return;
      }
      this.phase = 'animating';
      const from = applyJump(s, sq);
      this.pendingFrom = from;
      this.pendingJump = sq;
      this.lastLand = sq;
      this.lastTrap = null;
      sfx.jump();
      const anim = this.board.animateJump(side, from, sq);
      this.refresh();
      this.board.burn(from);
      sfx.burn();
      await anim;
      if (this.disposed) return;
      if (!hasOpenSquare(s)) return this.completeHumanMove(-1);
      this.phase = 'trap';
      this.refresh();
    } else if (this.phase === 'trap') {
      if (!isOpen(s, sq)) {
        sfx.invalid();
        return;
      }
      this.phase = 'animating';
      applyTrap(s, sq);
      this.lastTrap = sq;
      this.refresh();
      sfx.trap();
      await this.board.trap(sq);
      if (this.disposed) return;
      this.completeHumanMove(sq);
    }
  }

  async undoJump() {
    if (this.phase !== 'trap' || this.pendingFrom == null) return;
    const s = this.state;
    const side = s.turn;
    const at = s.pos[side];
    this.phase = 'animating';
    s.pos[side] = this.pendingFrom;
    s.cells[this.pendingFrom] = EMPTY;
    this.lastLand = null;
    const anim = this.board.animateJump(side, at, this.pendingFrom);
    this.refresh();
    sfx.select();
    await anim;
    if (this.disposed) return;
    this.pendingFrom = null;
    this.pendingJump = null;
    this.phase = 'jump';
    this.refresh();
  }

  completeHumanMove(trap) {
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
    this.history.push({ side, from, jump: move.jump, trap: move.trap });
    this.ui.log(this.history);
  }

  finish(w) {
    this.phase = 'over';
    this.winner = w;
    this.loser = w ^ 1;
    this.refresh();
    this.board.victory(w, this.state.pos[w]);
    const me = this.mySide;
    if (me == null || me === w) sfx.win();
    else sfx.lose();
    setTimeout(() => {
      if (!this.disposed) this.ui.over({ winner: w, loser: w ^ 1, moves: this.state.moves, game: this });
    }, 900);
  }

  // ---- Online ---------------------------------------------------------------

  broadcast(side, from, move) {
    this.net.send({ t: 'state', state: serialize(this.state), last: { side, from, jump: move.jump, trap: move.trap } });
  }

  onNetMessage(msg) {
    // Handle messages one at a time so an animation never overlaps the next update.
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
      const side = this.state.turn;
      const from = this.state.pos[side];
      await this.playMove(move);
      if (this.disposed) return;
      this.broadcast(side, from, move);
      this.nextTurn();
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
