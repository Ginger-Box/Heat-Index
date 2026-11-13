// Battle effects that live outside React: spark particles, shockwave rings, screen shake and the aiming arrow.
// Everything is drawn in viewport pixels on overlays attached to <body> (outside the zoomed #root),
// so coordinates come straight from getBoundingClientRect / pointer events.

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- sparks (one shared canvas, the loop runs only while particles are alive) ----------

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

let canvas: HTMLCanvasElement | null = null;
let g: CanvasRenderingContext2D | null = null;
let parts: P[] = [];
let raf = 0;
let last = 0;

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  document.body.appendChild(canvas);
  g = canvas.getContext('2d');
  const fit = () => {
    if (!canvas) return;
    canvas.width = innerWidth;
    canvas.height = innerHeight;
  };
  fit();
  addEventListener('resize', fit);
}

function step(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!g || !canvas) return;
  g.clearRect(0, 0, canvas.width, canvas.height);
  parts = parts.filter((p) => (p.life -= dt) > 0);
  for (const p of parts) {
    p.vy += 900 * dt; // gravity
    p.vx *= 1 - 2.2 * dt; // drag
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const k = p.life / p.max;
    g.globalAlpha = Math.min(1, k * 1.6);
    g.fillStyle = p.color;
    // pixel sparks: square, with a short streak along the velocity
    const s = Math.max(1, Math.round(p.size * (0.5 + k * 0.5)));
    g.fillRect(Math.round(p.x), Math.round(p.y), s, s);
    g.globalAlpha *= 0.5;
    g.fillRect(Math.round(p.x - p.vx * 0.012), Math.round(p.y - p.vy * 0.012), s, s);
  }
  g.globalAlpha = 1;
  if (parts.length) raf = requestAnimationFrame(step);
  else raf = 0;
}

const HIT_COLORS = ['#ffffff', '#fff2a8', '#ffe600', '#ff8a00', '#ff2a8a'];
const HEAL_COLORS = ['#ffffff', '#b8ffcf', '#39ff14', '#00f0ff'];
const ZAP_COLORS = ['#ffffff', '#d9b3ff', '#b46bff', '#00f0ff'];

/**
 * A burst of sparks at (x, y). Damage sets the size: 1 damage — a small puff, 10 — a fireworks of metal.
 * core: the Core is hit — more, faster, bigger sparks.
 */
export function sparks(x: number, y: number, dmg: number, opts: { core?: boolean; kind?: 'hit' | 'heal' | 'zap' } = {}) {
  if (reduce()) return;
  ensureCanvas();
  // attacks go up to ~5, so 5 damage = full power
  const power = Math.min(1.2, Math.max(0.1, dmg / 5)) * (opts.core ? 1.3 : 1);
  const n = Math.round(8 + power * power * (opts.core ? 150 : 110));
  const colors = opts.kind === 'heal' ? HEAL_COLORS : opts.kind === 'zap' ? ZAP_COLORS : HIT_COLORS;
  for (let i = 0; i < n; i++) {
    const a = opts.kind === 'heal' ? -Math.PI / 2 + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2;
    const sp = (opts.kind === 'heal' ? 120 : 140) + Math.random() * (180 + power * 760);
    const life = 0.22 + Math.random() * (0.2 + power * 0.6);
    parts.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - (opts.kind === 'heal' ? 0 : 140 * power),
      life,
      max: life,
      size: 2 + Math.round(Math.random() * (1 + power * 4)),
      color: colors[Math.floor(Math.random() * colors.length)],
    });
  }
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(step);
  }
}

/** An expanding pixel ring (shockwave) — for Core hits and explosions. */
export function ring(x: number, y: number, size: number, color = '#ffe600') {
  if (reduce()) return;
  const el = document.createElement('div');
  el.className = 'fx-ring';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--size', `${size}px`);
  el.style.setProperty('--col', color);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 520);
}

/** A white flash over the whole screen for the heaviest blows. */
export function flashScreen(strength: number) {
  if (reduce() || strength <= 0) return;
  const el = document.createElement('div');
  el.className = 'fx-flash';
  el.style.setProperty('--a', String(Math.min(0.35, strength)));
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 260);
}

/** Shakes an element; amplitude in px (≈ damage). */
export function shake(el: Element | null, amp: number) {
  if (!el || reduce() || amp < 1) return;
  const a = Math.min(16, amp);
  const frames = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const k = 1 - i / 7;
    const dx = (Math.random() - 0.5) * 2 * a * k;
    const dy = (Math.random() - 0.5) * 2 * a * 0.6 * k;
    return { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` };
  });
  (el as HTMLElement).animate([...frames, { transform: 'none' }], { duration: 160 + a * 22, easing: 'steps(8)' });
}

export const centerOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

// ---------- aiming arrow ----------

export type AimKind = 'attack' | 'repair' | 'shock';
const AIM_COLOR: Record<AimKind, string> = { attack: '#ff3b4e', repair: '#39ff14', shock: '#b46bff' };

/**
 * A neon arrow from (x0, y0) to the pointer: a curved chain of marching pixel dashes with an arrowhead.
 * When it snaps onto a target the head turns into a lock-on reticle.
 */
export function createAim(kind: AimKind, x0: number, y0: number) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `fx-aim aim-${kind}`);
  svg.style.setProperty('--aim', AIM_COLOR[kind]);
  const under = document.createElementNS(NS, 'path');
  under.setAttribute('class', 'aim-under');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'aim-line');
  const head = document.createElementNS(NS, 'polygon');
  head.setAttribute('class', 'aim-head');
  const lock = document.createElementNS(NS, 'g');
  lock.setAttribute('class', 'aim-lock');
  // reticle: four corner brackets
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const b = document.createElementNS(NS, 'path');
    b.setAttribute('d', `M ${sx * 22} ${sy * 10} L ${sx * 22} ${sy * 22} L ${sx * 10} ${sy * 22}`);
    lock.appendChild(b);
  }
  const dot = document.createElementNS(NS, 'rect');
  dot.setAttribute('x', '-3');
  dot.setAttribute('y', '-3');
  dot.setAttribute('width', '6');
  dot.setAttribute('height', '6');
  lock.appendChild(dot);
  svg.append(under, path, head, lock);
  document.body.appendChild(svg);

  let ox = x0;
  let oy = y0;
  const draw = (x1: number, y1: number, locked: boolean) => {
    const dx = x1 - ox;
    const dy = y1 - oy;
    const dist = Math.hypot(dx, dy);
    // control point: bend the arrow up a little, like a thrown arc
    const cx = ox + dx / 2;
    const cy = oy + dy / 2 - Math.min(120, dist * 0.25);
    // stop the line short of the head
    const tEnd = dist > 40 ? 1 - 26 / Math.max(dist, 1) : 1;
    const bx = (t: number) => (1 - t) * (1 - t) * ox + 2 * (1 - t) * t * cx + t * t * x1;
    const by = (t: number) => (1 - t) * (1 - t) * oy + 2 * (1 - t) * t * cy + t * t * y1;
    const ex = bx(tEnd);
    const ey = by(tEnd);
    const d = `M ${ox} ${oy} Q ${cx} ${cy} ${ex} ${ey}`;
    path.setAttribute('d', d);
    under.setAttribute('d', d);
    // head direction = curve tangent at the end
    const ang = Math.atan2(y1 - cy, x1 - cx);
    const L = 26;
    const W = 15;
    const pts = [
      [x1, y1],
      [x1 - Math.cos(ang) * L + Math.cos(ang + Math.PI / 2) * W, y1 - Math.sin(ang) * L + Math.sin(ang + Math.PI / 2) * W],
      [x1 - Math.cos(ang) * L * 0.62, y1 - Math.sin(ang) * L * 0.62],
      [x1 - Math.cos(ang) * L - Math.cos(ang + Math.PI / 2) * W, y1 - Math.sin(ang) * L - Math.sin(ang + Math.PI / 2) * W],
    ];
    head.setAttribute('points', pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' '));
    lock.setAttribute('transform', `translate(${x1} ${y1})`);
    svg.classList.toggle('locked', locked);
  };
  draw(x0, y0, false);
  return {
    move: draw,
    setOrigin(x: number, y: number) {
      ox = x;
      oy = y;
    },
    destroy() {
      svg.classList.add('gone');
      setTimeout(() => svg.remove(), 120);
    },
  };
}
export type Aim = ReturnType<typeof createAim>;

/**
 * A slash streak across the target: a bright tapered band at an angle, with a thin cyan/magenta echo.
 * power 0..1 sets its length and thickness.
 */
export function slash(x: number, y: number, angle: number, power: number) {
  if (reduce()) return;
  const el = document.createElement('div');
  el.className = 'fx-slash';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--len', `${110 + power * 260}px`);
  el.style.setProperty('--th', `${4 + power * 14}px`);
  el.style.setProperty('--ang', `${angle}rad`);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 360);
}

/** A short RGB-split + punch-in of the whole battle table, for the heaviest blows. */
export function chroma(el: Element | null, power: number) {
  if (!el || reduce()) return;
  const a = 2 + power * 6;
  (el as HTMLElement).animate(
    [
      { filter: `drop-shadow(${a}px 0 0 #ff2a8a) drop-shadow(${-a}px 0 0 #00f0ff)`, transform: `scale(${1 + power * 0.02})` },
      { filter: `drop-shadow(${-a / 2}px 0 0 #ff2a8a) drop-shadow(${a / 2}px 0 0 #00f0ff)`, offset: 0.4 },
      { filter: 'none', transform: 'none' },
    ],
    { duration: 220 + power * 120, easing: 'steps(5)' },
  );
}

/**
 * The screen "glass" cracks at the point of impact — for heavy hits (4+ damage). A spider-web of cracks spreads
 * from a shattered centre; bigger damage = more and longer cracks and more rings. It propagates in ~90 ms,
 * holds, then fades. Each crack is its own short-lived canvas, so several can overlap.
 */
export function crack(x: number, y: number, dmg: number) {
  if (reduce()) return;
  const c = document.createElement('canvas');
  c.className = 'fx-crack';
  c.width = innerWidth;
  c.height = innerHeight;
  document.body.appendChild(c);
  const g = c.getContext('2d')!;
  const p = Math.min(1, Math.max(0, (dmg - 4) / 4)); // 4 → 0, 8+ → 1
  const spokes = 7 + Math.round(p * 9);
  const reach = 110 + p * 420 + Math.random() * 40;
  type Seg = [number, number, number, number, number]; // x0,y0,x1,y1, distance from the centre (for propagation)
  const segs: Seg[] = [];
  const tips: [number, number, number][] = []; // spoke points by ring: x, y, ring index
  const rings = 2 + Math.round(p * 3);
  const spokePts: [number, number][][] = [];
  for (let i = 0; i < spokes; i++) {
    const base = (i / spokes) * Math.PI * 2 + Math.random() * 0.3;
    let a = base;
    let px = x;
    let py = y;
    const pts: [number, number][] = [[x, y]];
    const steps = 5 + Math.round(p * 4);
    for (let k = 1; k <= steps; k++) {
      a += (Math.random() - 0.5) * 0.35;
      const len = (reach / steps) * (0.6 + Math.random() * 0.8);
      const nx = px + Math.cos(a) * len;
      const ny = py + Math.sin(a) * len;
      segs.push([px, py, nx, ny, Math.hypot(nx - x, ny - y)]);
      // little side branches
      if (Math.random() < 0.35) {
        const ba = a + (Math.random() < 0.5 ? 0.6 : -0.6);
        const bl = len * (0.4 + Math.random() * 0.5);
        segs.push([nx, ny, nx + Math.cos(ba) * bl, ny + Math.sin(ba) * bl, Math.hypot(nx - x, ny - y) + bl]);
      }
      px = nx;
      py = ny;
      pts.push([px, py]);
      tips.push([px, py, k]);
    }
    spokePts.push(pts);
  }
  // concentric web: connect neighbouring spokes at a few rings
  for (let r = 1; r <= rings; r++) {
    for (let i = 0; i < spokes; i++) {
      const A = spokePts[i];
      const B = spokePts[(i + 1) % spokes];
      const k = Math.min(A.length - 1, B.length - 1, Math.round((r / (rings + 1)) * (A.length - 1)) + 1);
      if (Math.random() < 0.15) continue;
      const [ax, ay] = A[k];
      const [bx, by] = B[k];
      const mx = (ax + bx) / 2 + (Math.random() - 0.5) * 10;
      const my = (ay + by) / 2 + (Math.random() - 0.5) * 10;
      const d = Math.hypot(ax - x, ay - y);
      segs.push([ax, ay, mx, my, d], [mx, my, bx, by, d]);
    }
  }
  // shards around the impact point
  const shards: [number, number][][] = [];
  const sh = 5 + Math.round(p * 6);
  for (let i = 0; i < sh; i++) {
    const a0 = (i / sh) * Math.PI * 2;
    const a1 = ((i + 1) / sh) * Math.PI * 2;
    const r0 = 14 + p * 18;
    shards.push([
      [x, y],
      [x + Math.cos(a0) * r0 * (0.7 + Math.random() * 0.6), y + Math.sin(a0) * r0],
      [x + Math.cos(a1) * r0, y + Math.sin(a1) * r0 * (0.7 + Math.random() * 0.6)],
    ]);
  }
  const start = performance.now();
  const GROW = 90;
  const HOLD = 520 + p * 400;
  const FADE = 420;
  const draw = (now: number) => {
    const t = now - start;
    g.clearRect(0, 0, c.width, c.height);
    const front = Math.min(1, t / GROW) * (reach + 80);
    const alpha = t < GROW + HOLD ? 1 : Math.max(0, 1 - (t - GROW - HOLD) / FADE);
    g.globalAlpha = alpha;
    // shattered centre: pale refracting shards
    for (const [i, tri] of shards.entries()) {
      g.fillStyle = i % 2 ? 'rgba(220,240,255,0.22)' : 'rgba(255,255,255,0.1)';
      g.beginPath();
      g.moveTo(tri[0][0], tri[0][1]);
      g.lineTo(tri[1][0], tri[1][1]);
      g.lineTo(tri[2][0], tri[2][1]);
      g.closePath();
      g.fill();
    }
    g.lineCap = 'round';
    for (const pass of [0, 1]) {
      // pass 0: a dark offset line (depth of the crack), pass 1: the bright edge
      g.strokeStyle = pass ? 'rgba(235,250,255,0.95)' : 'rgba(0,0,0,0.55)';
      g.lineWidth = pass ? 1.6 : 3;
      g.shadowColor = pass ? '#00f0ff' : 'transparent';
      g.shadowBlur = pass ? 6 : 0;
      g.beginPath();
      for (const [x0, y0, x1, y1, d] of segs) {
        if (d > front) continue;
        const o = pass ? 0 : 1.5;
        g.moveTo(x0 + o, y0 + o);
        g.lineTo(x1 + o, y1 + o);
      }
      g.stroke();
    }
    g.shadowBlur = 0;
    if (alpha > 0) requestAnimationFrame(draw);
    else c.remove();
  };
  requestAnimationFrame(draw);
  setTimeout(() => c.remove(), GROW + HOLD + FADE + 600); // safety: a hidden tab stops rAF
}
