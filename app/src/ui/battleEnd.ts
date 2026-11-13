// End-of-battle effects, drawn on full-screen canvases attached to <body>:
//  • confetti() — two cannons fire pixel confetti from the left and right edges (victory);
//  • glitchTakeover(x, y) — the Core cracks and a signal glitch spreads from it until it fills the screen (defeat).
// Both return a function that removes the effect.

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function makeCanvas(cls: string) {
  const c = document.createElement('canvas');
  c.className = cls;
  c.width = innerWidth;
  c.height = innerHeight;
  document.body.appendChild(c);
  return { c, g: c.getContext('2d')! };
}

// ---------- confetti ----------

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  flip: number;
  vf: number;
  color: string;
}
const CONFETTI = ['#00f0ff', '#ff2a8a', '#ffe600', '#39ff14', '#ffffff', '#b46bff', '#ff8a00'];

export function confetti(): () => void {
  if (reduce()) return () => {};
  const { c, g } = makeCanvas('fx-end-canvas');
  const bits: Bit[] = [];
  const burst = (fromLeft: boolean, n: number) => {
    for (let i = 0; i < n; i++) {
      const a = fromLeft ? -Math.PI / 2 + 0.35 + Math.random() * 0.55 : -Math.PI / 2 - 0.35 - Math.random() * 0.55;
      const sp = 700 + Math.random() * 900;
      bits.push({
        x: fromLeft ? -10 : c.width + 10,
        y: c.height * (0.72 + Math.random() * 0.2),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        w: 6 + Math.random() * 6,
        h: 4 + Math.random() * 5,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 14,
        flip: Math.random() * Math.PI,
        vf: 6 + Math.random() * 10,
        color: CONFETTI[Math.floor(Math.random() * CONFETTI.length)],
      });
    }
  };
  burst(true, 110);
  burst(false, 110);
  const t2 = setTimeout(() => {
    burst(true, 70);
    burst(false, 70);
  }, 380);
  let last = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const dt = Math.min(0.04, (now - last) / 1000);
    last = now;
    g.clearRect(0, 0, c.width, c.height);
    for (const b of bits) {
      b.vy += 1100 * dt;
      b.vx *= 1 - 1.6 * dt;
      b.vy *= 1 - 1.2 * dt;
      // flutter: once falling, confetti drifts sideways
      if (b.vy > 0) b.vx += Math.sin(now / 180 + b.rot) * 40 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.rot += b.vr * dt;
      b.flip += b.vf * dt;
      g.save();
      g.translate(Math.round(b.x), Math.round(b.y));
      g.rotate(b.rot);
      g.fillStyle = b.color;
      const w = b.w * Math.abs(Math.cos(b.flip)) + 1; // the flip makes it twinkle
      g.fillRect(-w / 2, -b.h / 2, w, b.h);
      g.restore();
    }
    for (let i = bits.length - 1; i >= 0; i--) if (bits[i].y > c.height + 40) bits.splice(i, 1);
    if (bits.length) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    clearTimeout(t2);
    cancelAnimationFrame(raf);
    c.remove();
  };
}

// ---------- defeat: the Core breaks and a glitch takes over the screen ----------

export function glitchTakeover(x: number, y: number): () => void {
  if (reduce()) return () => {};
  const { c, g } = makeCanvas('fx-end-canvas glitch');
  const maxR = Math.hypot(Math.max(x, c.width - x), Math.max(y, c.height - y)) + 40;
  const start = performance.now();
  const SPREAD = 1300;
  // crack lines from the Core
  const cracks = Array.from({ length: 9 }, () => {
    const pts: [number, number][] = [[x, y]];
    let a = Math.random() * Math.PI * 2;
    let px = x;
    let py = y;
    for (let i = 0; i < 7; i++) {
      a += (Math.random() - 0.5) * 0.9;
      const len = 20 + Math.random() * 40;
      px += Math.cos(a) * len;
      py += Math.sin(a) * len;
      pts.push([px, py]);
    }
    return pts;
  });
  let raf = 0;
  const step = (now: number) => {
    const t = now - start;
    const k = Math.min(1, t / SPREAD);
    const r = maxR * (k < 1 ? k * k * (3 - 2 * k) : 1); // smoothstep
    g.clearRect(0, 0, c.width, c.height);
    g.save();
    g.beginPath();
    g.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
    g.clip();
    // dark veil that thickens as the glitch settles
    g.fillStyle = `rgba(5, 4, 9, ${0.35 + k * 0.45})`;
    g.fillRect(0, 0, c.width, c.height);
    // horizontal tear bars: dense near the edge of the spreading circle, sparse inside
    const bars = k < 1 ? 70 : 22;
    for (let i = 0; i < bars; i++) {
      const by = Math.random() * c.height;
      const dy = Math.abs(by - y);
      if (dy > r) continue;
      const half = Math.sqrt(Math.max(0, r * r - dy * dy));
      const bw = 30 + Math.random() * (k < 1 ? 380 : 220);
      const bx = x - half + Math.random() * half * 2 - bw / 2;
      const h = [2, 3, 4, 6, 10][Math.floor(Math.random() * 5)];
      const pick = Math.random();
      g.fillStyle = pick < 0.35 ? '#ff2a8a' : pick < 0.65 ? '#00f0ff' : pick < 0.8 ? '#ffffff' : pick < 0.9 ? '#ff3b4e' : '#000000';
      g.globalAlpha = 0.25 + Math.random() * (k < 1 ? 0.6 : 0.3);
      g.fillRect(bx, by, bw, h);
    }
    // blocky "dead pixel" clusters
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * r;
      const s = 4 + Math.floor(Math.random() * 3) * 4;
      g.globalAlpha = 0.5;
      g.fillStyle = Math.random() < 0.5 ? '#ff2a8a' : '#00f0ff';
      g.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, s, s);
    }
    g.globalAlpha = 1;
    g.restore();
    // the ring of the glitch front
    if (k < 1) {
      g.strokeStyle = Math.random() < 0.5 ? '#ff2a8a' : '#ffffff';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.stroke();
    }
    // cracks glowing red over the Core
    g.strokeStyle = '#ff3b4e';
    g.lineWidth = 3;
    g.shadowColor = '#ff3b4e';
    g.shadowBlur = 12;
    for (const pts of cracks) {
      g.beginPath();
      const n = Math.min(pts.length, 1 + Math.floor((t / 260) * pts.length));
      pts.slice(0, n).forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.stroke();
    }
    g.shadowBlur = 0;
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    c.remove();
  };
}
