// Runs the search off the main thread so the board keeps animating while the AI thinks.
import { deserialize } from './rules.js';
import { search } from './ai.js';

self.onmessage = (e) => {
  const { id, state, depth, prune } = e.data;
  try {
    const result = search(deserialize(state), { depth, prune });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
