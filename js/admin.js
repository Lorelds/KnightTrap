// Admin page: sign in with ADMIN_KEY, edit the point values, preview, save to /api/config.

import { normalizeRules, POINT_FIELDS, LEVELS } from './scoring.js';
import { pointsTable } from './points-table.js';
import { setLang, t } from './i18n.js';
import { startBackgroundEmbers } from './fx.js';

const $ = (sel, root = document) => root.querySelector(sel);
const KEY_STORE = 'knighttrap.adminKey';

let key = '';
try {
  key = sessionStorage.getItem(KEY_STORE) || '';
} catch {}
try {
  setLang(JSON.parse(localStorage.getItem('knighttrap.settings') || '{}').lang || 'id');
} catch {
  setLang('id');
}

const ERRORS = {
  unauthorized: 'adminUnauthorized',
  locked: 'adminLocked',
  'admin-disabled': 'adminDisabled',
  'bad-rules': 'adminInvalid',
};

function status(text, kind = '') {
  const el = $('#admin-status');
  el.textContent = text;
  el.className = `admin-status ${kind}`;
}

async function call(body) {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok) return { ok: true, rules: data.rules };
    return { ok: false, error: data?.error ?? 'offline' };
  } catch {
    return { ok: false, error: 'offline' };
  }
}

function fail(error) {
  status(t(ERRORS[error] ?? 'adminOffline'), 'bad');
  if (error === 'unauthorized') {
    key = '';
    try {
      sessionStorage.removeItem(KEY_STORE);
    } catch {}
    $('#editor').hidden = true;
    $('#login').hidden = false;
  }
}

const form = $('#editor');

function fill(rules) {
  for (const f of POINT_FIELDS) form.elements[f].value = rules[f];
  for (const lvl of LEVELS) form.elements[`mult-${lvl}`].value = rules.multiplier[lvl];
  preview();
}

function read() {
  const num = (name) => (form.elements[name].value === '' ? NaN : Number(form.elements[name].value));
  const raw = { multiplier: {} };
  for (const f of POINT_FIELDS) raw[f] = num(f);
  for (const lvl of LEVELS) raw.multiplier[lvl] = num(`mult-${lvl}`);
  return normalizeRules(raw);
}

function preview() {
  const rules = read();
  $('#admin-save').disabled = !rules;
  if (rules) {
    $('#admin-preview').innerHTML = pointsTable(rules, t);
    if ($('#admin-status').classList.contains('bad')) status('');
  } else {
    status(t('adminInvalid'), 'bad');
  }
}

async function signIn() {
  status('…');
  const r = await call({ check: true });
  if (!r.ok) return fail(r.error);
  try {
    sessionStorage.setItem(KEY_STORE, key);
  } catch {}
  $('#login').hidden = true;
  form.hidden = false;
  fill(r.rules);
  status('');
}

$('#login').addEventListener('submit', (e) => {
  e.preventDefault();
  key = $('#admin-key').value.trim();
  if (key) signIn();
});

form.addEventListener('input', preview);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const rules = read();
  if (!rules) return preview();
  $('#admin-save').disabled = true;
  const r = await call({ rules });
  $('#admin-save').disabled = false;
  if (!r.ok) return fail(r.error);
  fill(r.rules);
  status(t('adminSaved'), 'ok');
});

$('#admin-reset').addEventListener('click', async () => {
  if (!window.confirm(t('adminResetConfirm'))) return;
  const r = await call({ reset: true });
  if (!r.ok) return fail(r.error);
  fill(r.rules);
  status(t('adminResetDone'), 'ok');
});

startBackgroundEmbers($('#bg-embers'));
if (key) signIn();
else $('#admin-key').focus();
