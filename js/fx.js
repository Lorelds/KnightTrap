// Canvas particle effects: board bursts and the ambient ember background.

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const rand = (a, b) => a + Math.random() * (b - a);

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

export class Particles {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ps = [];
    this.rings = [];
    this.running = false;
    this.last = 0;
  }

  // x, y in CSS pixels relative to the canvas.
  burst(x, y, kind, scale = 1) {
    if (reducedMotion()) return;
    if (kind === 'ember') {
      for (let i = 0; i < 34; i++) {
        const a = rand(-Math.PI, 0);
        const sp = rand(30, 150) * scale;
        this.ps.push({
          x: x + rand(-10, 10) * scale, y: y + rand(-6, 10) * scale,
          vx: Math.cos(a) * sp * 0.7, vy: Math.sin(a) * sp - 30,
          g: -60, drag: 1.6, life: rand(0.6, 1.3), age: 0,
          size: rand(1.2, 3.4) * scale, hue: rand(14, 42), glow: true,
        });
      }
      this.rings.push({ x, y, r: 4, max: 34 * scale, age: 0, life: 0.45, color: '255,140,60' });
    } else if (kind === 'debris') {
      for (let i = 0; i < 26; i++) {
        const a = rand(0, Math.PI * 2);
        const sp = rand(40, 190) * scale;
        this.ps.push({
          x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
          g: 420, drag: 2.2, life: rand(0.35, 0.7), age: 0,
          size: rand(1.5, 4) * scale, shade: rand(30, 80), glow: false, square: true,
        });
      }
      for (let i = 0; i < 10; i++) {
        const a = rand(0, Math.PI * 2);
        this.ps.push({
          x, y, vx: Math.cos(a) * rand(20, 80), vy: Math.sin(a) * rand(20, 80),
          g: 0, drag: 3, life: rand(0.25, 0.5), age: 0, size: rand(1, 2.2) * scale, hue: 4, glow: true,
        });
      }
      this.rings.push({ x, y, r: 6, max: 46 * scale, age: 0, life: 0.4, color: '255,90,79' });
    } else if (kind === 'land') {
      for (let i = 0; i < 14; i++) {
        const a = rand(Math.PI * 0.9, Math.PI * 2.1);
        const sp = rand(20, 70) * scale;
        this.ps.push({
          x: x + rand(-12, 12) * scale, y: y + 14 * scale, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.4,
          g: 30, drag: 3, life: rand(0.3, 0.6), age: 0, size: rand(2, 4) * scale, shade: 150, glow: false, soft: true,
        });
      }
    } else if (kind === 'victory') {
      for (let i = 0; i < 90; i++) {
        const a = rand(0, Math.PI * 2);
        const sp = rand(60, 320) * scale;
        this.ps.push({
          x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80,
          g: 140, drag: 1.2, life: rand(0.9, 1.8), age: 0, size: rand(1.5, 3.5) * scale, hue: rand(30, 52), glow: true,
        });
      }
    }
    this.start();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  frame(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const dpr = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const r of this.rings) {
      r.age += dt;
      const k = r.age / r.life;
      const rad = r.r + (r.max - r.r) * (1 - (1 - k) ** 3);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(${r.color},${Math.max(0, 0.7 * (1 - k))})`;
      ctx.lineWidth = 2.5 * (1 - k) + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.rings = this.rings.filter((r) => r.age < r.life);

    for (const p of this.ps) {
      p.age += dt;
      p.vx -= p.vx * p.drag * dt;
      p.vy -= p.vy * p.drag * dt;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = 1 - p.age / p.life;
      if (k <= 0) continue;
      if (p.glow) {
        ctx.globalCompositeOperation = 'lighter';
        const s = p.size * (0.6 + 0.4 * k);
        ctx.fillStyle = `hsla(${p.hue}, 100%, ${55 + 25 * k}%, ${k})`;
        ctx.shadowColor = `hsla(${p.hue}, 100%, 55%, ${k})`;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = p.soft ? `rgba(${p.shade},${p.shade - 10},${p.shade - 20},${0.35 * k})` : `rgba(${p.shade},${p.shade - 6},${p.shade - 10},${k})`;
        if (p.square) ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (1.5 - k * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    this.ps = this.ps.filter((p) => p.age < p.life);
    ctx.globalCompositeOperation = 'source-over';

    if (this.ps.length || this.rings.length) requestAnimationFrame((tt) => this.frame(tt));
    else {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.running = false;
    }
  }
}

// Slow embers drifting up behind every screen.
export function startBackgroundEmbers(canvas) {
  if (reducedMotion()) return;
  const ctx = canvas.getContext('2d');
  let embers = [];
  let w = 0;
  let h = 0;
  let last = performance.now();
  let raf = 0;

  const spawn = (initial) => ({
    x: rand(0, w),
    y: initial ? rand(0, h) : h + 10,
    vy: rand(10, 34),
    sway: rand(0.4, 1.4),
    phase: rand(0, Math.PI * 2),
    size: rand(0.6, 2.1),
    hue: rand(16, 38),
    a: rand(0.25, 0.8),
  });

  function resize() {
    const dpr = fitCanvas(canvas);
    w = canvas.width / dpr;
    h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.round(Math.min(70, (w * h) / 22000));
    while (embers.length < target) embers.push(spawn(true));
    embers.length = target;
  }

  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (const e of embers) {
      e.y -= e.vy * dt;
      e.phase += dt * e.sway;
      const x = e.x + Math.sin(e.phase) * 14;
      const fade = Math.min(1, e.y / (h * 0.9));
      if (e.y < -10) Object.assign(e, spawn(false));
      ctx.fillStyle = `hsla(${e.hue}, 100%, 62%, ${e.a * fade})`;
      ctx.beginPath();
      ctx.arc(x, e.y, e.size, 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });
  raf = requestAnimationFrame(frame);
}
