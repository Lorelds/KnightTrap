// Board view: DOM cells, knight sprites, jump animation and particle effects.
// Holds no game state; game.js tells it what to draw.

import { N, SIZE } from './config.js';
import { BURNED, TRAP, squareName } from './rules.js';
import { Particles, reducedMotion } from './fx.js';

const knightSvg = (side) => `<svg viewBox="0 0 64 64" aria-hidden="true"><use href="#knight-glyph" class="kglyph p${side}"/></svg>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rc = (sq) => ({ r: Math.floor(sq / N), c: sq % N });
const tf = (c, r, gap, lift = 0, scale = 1) =>
  `translate(calc(${c} * (100% + ${gap}px)), calc(${r} * (100% + ${gap}px))) translateY(${lift}%) scale(${scale})`;

export class BoardView {
  constructor(boardEl, shellEl) {
    this.el = boardEl;
    this.shell = shellEl;
    this.onCell = null;
    this.onKnight = null;
    this.cells = [];

    const frag = document.createDocumentFragment();
    for (let sq = 0; sq < SIZE; sq++) {
      const { r, c } = rc(sq);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.dataset.sq = sq;
      if ((r + c) % 2 === 1) b.classList.add('dark');
      if (r === N - 1) b.insertAdjacentHTML('beforeend', `<span class="coord f">${'abcdefg'[c]}</span>`);
      if (c === 0) b.insertAdjacentHTML('beforeend', `<span class="coord r">${N - r}</span>`);
      frag.appendChild(b);
      this.cells.push(b);
    }
    this.el.appendChild(frag);

    this.knights = [0, 1].map((side) => {
      const k = document.createElement('div');
      k.className = 'knight';
      k.dataset.side = side;
      k.innerHTML = knightSvg(side);
      k.addEventListener('click', () => this.onKnight?.(side));
      this.el.appendChild(k);
      return k;
    });

    const canvas = document.createElement('canvas');
    canvas.className = 'fx';
    this.el.appendChild(canvas);
    this.fxCanvas = canvas;
    this.particles = new Particles(canvas);

    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('.cell');
      if (b) this.onCell?.(Number(b.dataset.sq));
    });
  }

  placeKnight(side, sq) {
    const { r, c } = rc(sq);
    const k = this.knights[side];
    k.style.setProperty('--r', r);
    k.style.setProperty('--c', c);
  }

  /**
   * view: { state, legal: [], trappable: bool, threats: [], turnSide, lastLand, lastTrap, dead, selectableKnight }
   */
  render(view) {
    const { state } = view;
    const legal = new Set(view.legal || []);
    const threats = new Set(view.threats || []);
    for (let sq = 0; sq < SIZE; sq++) {
      const b = this.cells[sq];
      const v = state.cells[sq];
      const occupied = sq === state.pos[0] || sq === state.pos[1];
      b.classList.toggle('burned', v === BURNED);
      b.classList.toggle('trap', v === TRAP);
      const isLegal = legal.has(sq);
      const isTrappable = view.trappable && v === 0 && !occupied;
      b.classList.toggle('legal', isLegal);
      b.classList.toggle('trappable', isTrappable);
      b.classList.toggle('threat', isTrappable && threats.has(sq));
      b.classList.toggle('last-land', sq === view.lastLand);
      b.classList.toggle('last-trap', sq === view.lastTrap && v === TRAP);
      const actionable = isLegal || isTrappable;
      b.tabIndex = actionable ? 0 : -1;
      b.setAttribute('aria-disabled', actionable ? 'false' : 'true');
      const what = v === BURNED ? 'burned' : v === TRAP ? 'trap' : occupied ? 'knight' : 'open';
      b.setAttribute('aria-label', `${squareName(sq)} ${what}${isLegal ? ', jump here' : ''}${isTrappable ? ', place trap' : ''}`);
    }
    this.el.dataset.side = view.turnSide ?? '';
    this.shell.dataset.turn = view.turnSide ?? '';
    this.shell.classList.toggle('trap-mode', !!view.trappable);
    for (const side of [0, 1]) {
      const k = this.knights[side];
      this.placeKnight(side, state.pos[side]);
      k.classList.toggle('is-turn', view.turnSide === side && view.dead == null);
      k.classList.toggle('is-dead', view.dead === side);
      k.classList.toggle('selectable', view.selectableKnight === side);
    }
  }

  async animateJump(side, from, to) {
    const k = this.knights[side];
    this.placeKnight(side, to);
    if (reducedMotion()) return;
    const a = rc(from);
    const b = rc(to);
    const mc = (a.c + b.c) / 2;
    const mr = (a.r + b.r) / 2;
    // Keyframes need a concrete gap; it changes with the breakpoint (--gap in CSS).
    const gap = parseFloat(getComputedStyle(this.el).columnGap) || 0;
    const anim = k.animate(
      [
        { transform: tf(a.c, a.r, gap, 0, 1), offset: 0 },
        { transform: tf(mc, mr, gap, -42, 1.28), offset: 0.5 },
        { transform: tf(b.c, b.r, gap, 4, 0.94), offset: 0.88 },
        { transform: tf(b.c, b.r, gap, 0, 1), offset: 1 },
      ],
      { duration: 480, easing: 'cubic-bezier(.45,.05,.35,1)' },
    );
    k.style.zIndex = 5;
    try {
      await anim.finished;
    } catch {
      /* cancelled */
    }
    k.style.zIndex = '';
    this.fx(to, 'land');
  }

  center(sq) {
    const cr = this.cells[sq].getBoundingClientRect();
    const fr = this.fxCanvas.getBoundingClientRect();
    return { x: cr.left + cr.width / 2 - fr.left, y: cr.top + cr.height / 2 - fr.top, scale: cr.width / 70 };
  }

  fx(sq, kind) {
    const { x, y, scale } = this.center(sq);
    this.particles.burst(x, y, kind, Math.max(0.6, Math.min(1.3, scale)));
  }

  popText(sq, label) {
    const { x, y, scale } = this.center(sq);
    this.particles.text(x, y - 12 * scale, label, Math.max(0.7, Math.min(1.2, scale)));
  }

  pulse(sq, cls) {
    const b = this.cells[sq];
    b.classList.remove(cls);
    void b.offsetWidth;
    b.classList.add(cls);
    setTimeout(() => b.classList.remove(cls), 800);
  }

  burn(sq) {
    this.pulse(sq, 'ignite');
    this.fx(sq, 'ember');
  }

  async trap(sq) {
    this.pulse(sq, 'drop');
    this.fx(sq, 'debris');
    if (!reducedMotion()) {
      this.shell.classList.remove('shake');
      void this.shell.offsetWidth;
      this.shell.classList.add('shake');
      setTimeout(() => this.shell.classList.remove('shake'), 350);
    }
    await sleep(reducedMotion() ? 0 : 260);
  }

  victory(side, sq) {
    this.fx(sq, 'victory');
  }
}

export { knightSvg, sleep };
