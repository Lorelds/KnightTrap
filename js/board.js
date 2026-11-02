// Board view: DOM cells and knight sprites.
// Holds no game state; game.js tells it what to draw.

import { N, SIZE } from './config.js';
import { BURNED, TRAP, squareName } from './rules.js';

const knightSvg = (side) => `<svg viewBox="0 0 64 64" aria-hidden="true"><use href="#knight-glyph" class="kglyph p${side}"/></svg>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rc = (sq) => ({ r: Math.floor(sq / N), c: sq % N });

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
   * view: { state, legal: [], eating: [], trappable: bool, threats: [], lastLand, lastTrap, dead, eaten, selectableKnight }
   */
  render(view) {
    const { state } = view;
    const legal = new Set(view.legal || []);
    const eating = new Set(view.eating || []);
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
      b.classList.toggle('eat', eating.has(sq));
      b.classList.toggle('trappable', isTrappable);
      b.classList.toggle('threat', isTrappable && threats.has(sq));
      b.classList.toggle('last-land', sq === view.lastLand);
      b.classList.toggle('last-trap', sq === view.lastTrap && v === TRAP);
      const actionable = isLegal || isTrappable;
      b.tabIndex = actionable ? 0 : -1;
      b.setAttribute('aria-disabled', actionable ? 'false' : 'true');
      const what = v === BURNED ? 'burned' : v === TRAP ? 'trap' : occupied ? 'knight' : 'open';
      b.setAttribute('aria-label', `${squareName(sq)} ${what}${isLegal ? ', jump here' : ''}${eating.has(sq) ? ', eat' : ''}${isTrappable ? ', place trap' : ''}`);
    }
    this.shell.classList.toggle('trap-mode', !!view.trappable);
    for (const side of [0, 1]) {
      const k = this.knights[side];
      this.placeKnight(side, state.pos[side]);
      k.classList.toggle('is-dead', view.dead === side);
      k.hidden = view.eaten === side;
      k.classList.toggle('selectable', view.selectableKnight === side);
    }
  }
}

export { knightSvg, sleep };
