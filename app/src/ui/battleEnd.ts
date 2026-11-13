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
  const G = 1100;
  // launch speed from the screen height, so the confetti reaches the very top on any monitor
  const top = Math.sqrt(2 * G * c.height);
  const burst = (fromLeft: boolean, n: number) => {
    for (let i = 0; i < n; i++) {
      const off = 0.12 + Math.random() * 0.5; // radians from vertical, leaning toward the centre
      const a = -Math.PI / 2 + (fromLeft ? off : -off);
      const sp = top * (0.85 + Math.random() * 0.45);
      bits.push({
        x: fromLeft ? -10 + Math.random() * 30 : c.width + 10 - Math.random() * 30,
        y: c.height + 10,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        w: 6 + Math.random() * 7,
        h: 4 + Math.random() * 5,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 14,
        flip: Math.random() * Math.PI,
        vf: 6 + Math.random() * 10,
        color: CONFETTI[Math.floor(Math.random() * CONFETTI.length)],
      });
    }
  };
  burst(true, 240);
  burst(false, 240);
  const t2 = setTimeout(() => {
    burst(true, 160);
    burst(false, 160);
  }, 380);
  const t3 = setTimeout(() => {
    burst(true, 100);
    burst(false, 100);
  }, 800);
  let last = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const dt = Math.min(0.04, (now - last) / 1000);
    last = now;
    g.clearRect(0, 0, c.width, c.height);
    for (const b of bits) {
      b.vy += G * dt;
      b.vx *= 1 - 0.9 * dt;
      // light air drag while rising; once falling the bits float down slowly like paper
      b.vy *= b.vy < 0 ? 1 - 0.25 * dt : 1 - 3.2 * dt;
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
    clearTimeout(t3);
    cancelAnimationFrame(raf);
    c.remove();
  };
}

// ---------- defeat: glitches pour out of the Core, cover the screen, then cut to black ----------

/** Timeline (ms from the start): glitches spread from the Core until they cover everything, the whole screen
 *  churns, then it is wiped to black row by row. Total ≈ GLITCH_TOTAL; after that the canvas stays black. */
export const GLITCH_TOTAL = 1900;
const SPREAD_MS = 1100;
const CHURN_MS = 1450;

const TEAR = ['#ff2a8a', '#00f0ff', '#ffffff', '#ff3b4e', '#b46bff', '#ffe600', '#14101f', '#000000'];

export function glitchTakeover(x: number, y: number): () => void {
  const { c, g } = makeCanvas('fx-end-canvas glitch');
  if (reduce()) {
    g.fillStyle = '#050409';
    g.fillRect(0, 0, c.width, c.height);
    return () => c.remove();
  }
  const W = c.width;
  const H = c.height;
  const maxR = Math.hypot(Math.max(x, W - x), Math.max(y, H - y)) + 60;
  const start = performance.now();
  const rows = Math.ceil(H / 6);
  const blackRows = new Set<number>();
  const pick = () => TEAR[Math.floor(Math.random() * TEAR.length)];
  let raf = 0;

  const step = (now: number) => {
    const t = now - start;
    if (t < SPREAD_MS) {
      // 1) glitches pour out of the Core: tears and pixel blocks accumulate (the canvas is not cleared),
      //    the front moves outward and the blocks get bigger, so the screen fills up from the Core
      const k = t / SPREAD_MS;
      const r = maxR * (k * k * (3 - 2 * k));
      const n = 14 + Math.floor(k * k * 260);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = r * Math.sqrt(Math.random());
        const bx = x + Math.cos(a) * d;
        const by = y + Math.sin(a) * d * 0.9;
        const bw = 12 + Math.random() * (40 + k * 520);
        const bh = [2, 3, 4, 6, 8, 12, 18][Math.floor(Math.random() * (3 + k * 4))];
        const col = pick();
        g.globalAlpha = 0.75 + Math.random() * 0.25;
        g.fillStyle = col;
        g.fillRect(bx - bw / 2, by, bw, bh);
        // RGB echo of the tear
        if (Math.random() < 0.35) {
          g.globalAlpha = 0.6;
          g.fillStyle = col === '#00f0ff' ? '#ff2a8a' : '#00f0ff';
          g.fillRect(bx - bw / 2 + 6, by + bh, bw * 0.6, 2);
        }
      }
      // the Core itself flickers white at the source
      g.globalAlpha = 1;
      g.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#ff2a8a';
      g.fillRect(x - 20, y - 6, 40, 12);
    } else if (t < CHURN_MS) {
      // 2) the whole screen is glitch: full-width bars churn every frame
      g.globalAlpha = 1;
      let yy = 0;
      while (yy < H) {
        const bh = 2 + Math.floor(Math.random() * 16);
        g.fillStyle = pick();
        g.fillRect(0, yy, W, bh);
        if (Math.random() < 0.4) {
          g.fillStyle = pick();
          const sx = Math.random() * W;
          g.fillRect(sx, yy, 40 + Math.random() * 300, bh);
        }
        yy += bh;
      }
    } else if (t < GLITCH_TOTAL) {
      // 3) cut to black: rows go dark in random order (the rest keeps glitching)
      const k = (t - CHURN_MS) / (GLITCH_TOTAL - CHURN_MS);
      while (blackRows.size < Math.floor(rows * k * k)) blackRows.add(Math.floor(Math.random() * rows));
      for (let r = 0; r < rows; r++) {
        if (blackRows.has(r)) {
          g.fillStyle = '#050409';
          g.fillRect(0, r * 6, W, 6);
        } else if (Math.random() < 0.5) {
          g.fillStyle = pick();
          g.fillRect(Math.random() * W * 0.5, r * 6, W * (0.3 + Math.random() * 0.7), 6);
        }
      }
    } else {
      g.globalAlpha = 1;
      g.fillStyle = '#050409';
      g.fillRect(0, 0, W, H);
      return; // stays black under the DEFEAT screen
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    c.remove();
  };
}
