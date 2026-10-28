// Promise wrapper around the AI worker. Falls back to the main thread if
// module workers are unavailable (e.g. very old browsers).
import { serialize } from './rules.js';

let worker = null;
let workerBroken = false;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL('./ai.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    worker.onerror = (e) => {
      console.warn('AI worker failed, using main thread', e.message);
      workerBroken = true;
      worker = null;
      for (const [id, p] of pending) {
        pending.delete(id);
        runInline(p.args).then(p.resolve, p.reject);
      }
    };
  } catch (err) {
    console.warn('Module workers unsupported, using main thread', err);
    workerBroken = true;
    worker = null;
  }
  return worker;
}

async function runInline({ state, depth, prune }) {
  const [{ search }, { deserialize }] = await Promise.all([import('./ai.js'), import('./rules.js')]);
  return search(deserialize(state), { depth, prune });
}

export function think(state, { depth, prune }) {
  const args = { state: serialize(state), depth, prune };
  const w = getWorker();
  if (!w) return runInline(args);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, args });
    w.postMessage({ id, ...args });
  });
}

// Drop any search in flight (leaving a game while the AI thinks).
export function cancelThinking() {
  if (worker && pending.size) {
    worker.terminate();
    worker = null;
  }
  pending.clear();
}
