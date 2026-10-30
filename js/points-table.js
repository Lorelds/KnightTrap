// "What each level is worth" table, shared by the Single Player screen and the admin page.

import { levelValues, LEVELS } from './scoring.js';

export function pointsTable(rules, t, selected = null) {
  const head = ['ptLevel', 'ptColMove', 'ptColWin'].map((k) => `<th>${t(k)}</th>`).join('');
  const rows = LEVELS.map((lvl) => {
    const v = levelValues(rules, lvl);
    return `<tr${lvl === selected ? ' class="is-selected"' : ''}>` +
      `<th>${t(lvl)} <small>×${v.mult}</small></th>` +
      `<td>+${v.move.toLocaleString()}</td><td>+${v.win.toLocaleString()}</td></tr>`;
  }).join('');
  return `<table class="pts-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}
