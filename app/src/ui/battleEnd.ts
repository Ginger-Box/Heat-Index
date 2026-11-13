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
  // two cannons in the bottom corners: a muzzle flash, then a stream that tapers off over ~0.7 s,
  // and a second smaller volley — the confetti pours out instead of appearing all at once
  const flashes: { x: number; t: number }[] = [];
  const volley = (at: number, total: number) =>
    setTimeout(() => {
      flashes.push({ x: 0, t: performance.now() }, { x: c.width, t: performance.now() });
      let left = total;
      const pour = () => {
        const n = Math.max(4, Math.round(left * 0.16));
        burst(true, n);
        burst(false, n);
        left -= n;
        if (left > 0) timers.push(setTimeout(pour, 33));
      };
      pour();
    }, at);
  const timers: ReturnType<typeof setTimeout>[] = [];
  timers.push(volley(0, 300), volley(650, 180));
  let last = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const dt = Math.min(0.04, (now - last) / 1000);
    last = now;
    g.clearRect(0, 0, c.width, c.height);
    for (const f of flashes) {
      const k = (now - f.t) / 260;
      if (k > 1) continue;
      const r = 40 + k * 160;
      const grd = g.createRadialGradient(f.x, c.height, 0, f.x, c.height, r);
      grd.addColorStop(0, `rgba(255,255,255,${0.9 * (1 - k)})`);
      grd.addColorStop(0.4, `rgba(255,230,0,${0.5 * (1 - k)})`);
      grd.addColorStop(1, 'rgba(255,42,138,0)');
      g.fillStyle = grd;
      g.fillRect(f.x - r, c.height - r, r * 2, r);
    }
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
    if (bits.length || timers.length) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    timers.forEach(clearTimeout);
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


export function glitchTakeover(x: number, y: number): () => void {
  const { c, g } = makeCanvas('fx-end-canvas glitch');
  if (reduce()) {
    g.fillStyle = '#050409';
    g.fillRect(0, 0, c.width, c.height);
    return () => c.remove();
  }
  // The screen is split into pixel cells. A clean wave runs out of the Core: each cell lights up when the front
  // reaches it (a white flash → a cyan/magenta glitch tone), so the glitch visibly "pours" from the Core.
  // When everything is covered the cells churn as whole scanline bands, then rows switch off to black.
  const W = c.width;
  const H = c.height;
  const CW = 24;
  const CH = 12;
  const cols = Math.ceil(W / CW);
  const rows = Math.ceil(H / CH);
  const maxD = Math.hypot(Math.max(x, W - x), Math.max(y, H - y));
  const on = new Float32Array(cols * rows); // the moment (ms) each cell gets hit by the front
  const tone = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const d = Math.hypot(i * CW + CW / 2 - x, (j * CH + CH / 2 - y) * 1.15);
      // a slightly ragged, blocky front: noise per cell and per row
      on[j * cols + i] = (d / maxD) * SPREAD_MS * 0.92 + Math.random() * 70 + ((j * 7) % 5) * 8;
      tone[j * cols + i] = Math.floor(Math.random() * 4);
    }
  const TONES = ['#ff2a8a', '#00f0ff', '#2a0f3a', '#0b2a3a'];
  const rowOff = new Int16Array(rows); // horizontal tear of a whole row
  const offRow = new Float32Array(rows).map(() => CHURN_MS + Math.random() * (GLITCH_TOTAL - CHURN_MS - 60));
  const start = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const t = now - start;
    g.clearRect(0, 0, W, H);
    for (let j = 0; j < rows; j++) {
      if (Math.random() < 0.08) rowOff[j] = (Math.random() - 0.5) * 60;
      else if (Math.random() < 0.2) rowOff[j] = 0;
      const yy = j * CH;
      if (t >= offRow[j]) {
        g.fillStyle = '#050409';
        g.fillRect(0, yy, W, CH);
        continue;
      }
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const since = t - on[k];
        if (since < 0) continue;
        let col: string;
        if (since < 60) col = '#ffffff'; // the front: a bright edge
        else if (since < 140) col = since % 40 < 20 ? '#ff2a8a' : '#00f0ff';
        else {
          // settled: dark glitch with sparse bright flickers
          const r = Math.random();
          col = r < 0.06 ? '#ffffff' : r < 0.2 ? TONES[(tone[k] + (t > SPREAD_MS ? 1 : 0)) % 2] : TONES[2 + (tone[k] % 2)];
        }
        g.fillStyle = col;
        g.fillRect(i * CW + rowOff[j], yy, CW - 1, CH - 1);
      }
      // past full coverage: occasional full-width scanline bands
      if (t > SPREAD_MS && Math.random() < 0.05) {
        g.fillStyle = Math.random() < 0.5 ? '#ff2a8a' : '#00f0ff';
        g.fillRect(0, yy + CH / 2 - 1, W, 2);
      }
    }
    // the Core keeps spitting at the source while the wave runs
    if (t < SPREAD_MS) {
      g.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#ff2a8a';
      g.fillRect(x - 18, y - 5, 36, 10);
    }
    if (t >= GLITCH_TOTAL) {
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
