// Small synthesized sound effects (WebAudio, no audio files).

let ctx = null;
let master = null;
let enabled = true;

function ensure() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setSoundEnabled(on) {
  enabled = on;
  if (!on && ctx) ctx.suspend();
}

export function isSoundEnabled() {
  return enabled;
}

// Browsers only allow audio after a user gesture; call this from the first click.
export function unlockAudio() {
  ensure();
}

function tone({ type = 'sine', from, to, dur, gain = 0.3, delay = 0 }) {
  const c = ensure();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

let noiseBuf = null;
function noise({ dur, gain = 0.3, freq = 1200, q = 0.8, type = 'bandpass', delay = 0, sweepTo }) {
  const c = ensure();
  if (!c) return;
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

export const sfx = {
  select() { tone({ type: 'triangle', from: 660, to: 880, dur: 0.07, gain: 0.12 }); },
  jump() {
    tone({ type: 'triangle', from: 260, to: 620, dur: 0.22, gain: 0.22 });
    tone({ type: 'sine', from: 140, to: 90, dur: 0.12, gain: 0.25, delay: 0.3 });
  },
  burn() {
    noise({ dur: 0.55, gain: 0.22, freq: 900, sweepTo: 2600, q: 0.6 });
    noise({ dur: 0.3, gain: 0.1, freq: 3500, type: 'highpass', delay: 0.05 });
  },
  trap() {
    tone({ type: 'sine', from: 120, to: 42, dur: 0.38, gain: 0.5 });
    noise({ dur: 0.35, gain: 0.3, freq: 420, sweepTo: 120, q: 1.2, type: 'lowpass' });
    noise({ dur: 0.12, gain: 0.18, freq: 2400, type: 'highpass', delay: 0.02 });
  },
  invalid() { tone({ type: 'square', from: 180, to: 140, dur: 0.12, gain: 0.08 }); },
  turn() { tone({ type: 'sine', from: 880, dur: 0.09, gain: 0.08 }); },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', from: f, dur: 0.35, gain: 0.2, delay: i * 0.11 }));
    tone({ type: 'sine', from: 1568, dur: 0.6, gain: 0.08, delay: 0.45 });
  },
  lose() {
    [392, 330, 262, 196].forEach((f, i) => tone({ type: 'triangle', from: f, to: f * 0.97, dur: 0.38, gain: 0.18, delay: i * 0.14 }));
  },
};
