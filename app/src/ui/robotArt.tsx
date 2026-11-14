// Pixel robot generator for the cards (placeholder art until real illustrations exist).
// Every robot is assembled on a 28×28 grid from parts that depend on its class, in an action pose:
//   Basic — fighting stance with a raised arm cannon; Armor — braced behind a tower shield;
//   Maneuver — sprinting forward on a jet; Repair — a hovering medic drone with a red cross;
//   Blast — a walking bomb with a lit fuse; Charge — a horned bull-rush, head down;
//   Shock — arms up, lightning arcing between the hands and the coil.
// Size grows with energy cost; small details are picked deterministically from the model id.
// Fast classes lean forward: rows are sheared toward the enemy, which reads as motion.
// Each class also gets an animated layer (lightning, flames, fuse sparks, steam, rotor blur, shield glint),
// drawn as two pixel frames that the CSS flips between (index.css · "living sprites").

import { memo } from 'react';
import { classOf, model } from '../engine/robots';

const N = 28;
const OUT = '#0b0012';

interface Pal {
  base: string;
  light: string;
  dark: string;
  accent: string;
}
const PALETTES: Record<string, Pal> = {
  none: { base: '#6f7d99', light: '#a9b6cf', dark: '#3c4560', accent: '#00f0ff' },
  armor: { base: '#b07a2a', light: '#e3b04f', dark: '#5e3b14', accent: '#ffe600' },
  maneuver: { base: '#2a8f8f', light: '#5fd6d0', dark: '#144a4f', accent: '#00f0ff' },
  repair: { base: '#d9dfe0', light: '#ffffff', dark: '#7c8a8f', accent: '#ff2b3a' },
  blast: { base: '#8a2e1f', light: '#d1543a', dark: '#451410', accent: '#ff8a00' },
  charge: { base: '#9a3b2a', light: '#d86a4a', dark: '#4c1a12', accent: '#ffe600' },
  shock: { base: '#5b3c9e', light: '#8f6fe0', dark: '#2c1b55', accent: '#7fd8ff' },
};
const EYES = ['#00f0ff', '#ff2a8a', '#ffe600', '#39ff14'];

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

type Grid = (string | null)[][];
const grid = (): Grid => Array.from({ length: N }, () => Array(N).fill(null));

class Canvas {
  px: Grid = grid();
  /** animated overlay: two frames the CSS alternates between */
  fxA: Grid = grid();
  fxB: Grid = grid();
  set(x: number, y: number, c: string) {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    this.px[y][x] = c;
  }
  fx(frame: 'a' | 'b' | 'ab', x: number, y: number, c: string) {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    if (frame !== 'b') this.fxA[y][x] = c;
    if (frame !== 'a') this.fxB[y][x] = c;
  }
  /** A shaded body part: light top/left edge, dark bottom/right edge. */
  part(x: number, y: number, w: number, h: number, p: Pal, opts: { cut?: boolean } = {}) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        if (opts.cut && (i === 0 || i === w - 1) && (j === 0 || j === h - 1)) continue; // rounded corners
        const edgeL = i === 0 || j === 0;
        const edgeD = i === w - 1 || j === h - 1;
        this.set(x + i, y + j, edgeD ? p.dark : edgeL ? p.light : p.base);
      }
  }
  fill(x: number, y: number, w: number, h: number, c: string) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  /** Lean: shift rows above `pivotY` toward +x (forward) proportionally to height — a sense of speed. */
  shear(pivotY: number, k: number) {
    const sh = (g: Grid) => {
      const out = grid();
      for (let y = 0; y < N; y++) {
        const dx = Math.round(Math.max(0, pivotY - y) * k);
        for (let x = 0; x < N; x++) if (g[y][x] && x + dx < N && x + dx >= 0) out[y][x + dx] = g[y][x];
      }
      return out;
    };
    this.px = sh(this.px);
  }
  /** Dark outline around everything that's drawn. */
  outline() {
    const add: [number, number][] = [];
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (this.px[y][x]) continue;
        const near = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => this.px[y + dy]?.[x + dx]);
        if (near) add.push([x, y]);
      }
    for (const [x, y] of add) this.px[y][x] = OUT;
  }
}

/** A jagged lightning bolt between two points (pixel steps), for the Shock class. */
function bolt(c: Canvas, frame: 'a' | 'b', x0: number, y0: number, x1: number, y1: number, seed: number, col: string) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  let s = seed;
  for (let i = 0; i <= steps; i++) {
    const t = i / Math.max(1, steps);
    s = (s * 1103515245 + 12345) >>> 0;
    const jit = i > 0 && i < steps ? ((s >> 16) % 3) - 1 : 0;
    const x = Math.round(x0 + (x1 - x0) * t + (y0 === y1 ? 0 : jit));
    const y = Math.round(y0 + (y1 - y0) * t + (y0 === y1 ? jit : 0));
    c.fx(frame, x, y, i % 3 === 0 ? '#ffffff' : col);
  }
}

function draw(modelId: string): Canvas {
  const md = model(modelId);
  const cls = classOf(modelId);
  const p = PALETTES[cls];
  const h = hash(modelId);
  const eye = EYES[h % EYES.length];
  const k = md.cost; // 1..6 — size
  const c = new Canvas();
  const cx = 13;
  const ground = 26;

  // ---------------- Repair: hovering medic drone ----------------
  if (cls === 'repair') {
    const bw = 9 + k;
    const bh = 6 + Math.floor(k / 2);
    const by = 9 - Math.floor(k / 3);
    const bx = cx - Math.floor(bw / 2);
    c.part(bx, by, bw, bh, p, { cut: true });
    // red cross on a white plate
    const mx = cx - 1;
    const my = by + Math.floor(bh / 2) - 1;
    c.fill(mx - 2, my - 2, 6, 6, '#ffffff');
    c.fill(mx, my - 2, 2, 6, p.accent);
    c.fill(mx - 2, my, 6, 2, p.accent);
    // rotor arms; the blades are animated (blur frames)
    c.fill(bx + 1, by - 2, 1, 2, p.dark);
    c.fill(bx + bw - 2, by - 2, 1, 2, p.dark);
    for (const rx of [bx + 1, bx + bw - 2]) {
      for (let i = -3; i <= 3; i++) c.fx(Math.abs(i) % 2 ? 'a' : 'b', rx + i, by - 3, i === 0 ? '#ffffff' : '#c8d6dc');
    }
    // visor
    c.fill(bx + 2, by + 1, 3, 1, eye);
    // tool arms: wrench + welder, reaching down
    const ax = bx + bw;
    c.part(ax, by + 2, 3, 2, p);
    c.part(ax + 2, by + 4, 2, 4, p);
    c.set(ax + 2, by + 8, '#d9d2c0');
    c.set(ax + 4, by + 8, '#d9d2c0');
    c.part(bx - 3, by + 3, 3, 2, p);
    c.part(bx - 3, by + 5, 2, 3, p);
    // healing beam + welding sparks (animated)
    for (let i = 0; i < 6; i++) c.fx(i % 2 ? 'a' : 'b', ax + 3 - Math.floor(i / 2), by + 9 + i, i % 2 ? '#39ff14' : '#b6ffb0');
    c.fx('a', bx - 3, by + 9, '#ffe600');
    c.fx('b', bx - 4, by + 10, '#ffffff');
    c.fx('a', bx - 2, by + 10, '#ff8a00');
    // hover glow on the ground
    c.fill(cx - 4, ground - 1, 8, 1, '#39ff1455');
    c.outline();
    return c;
  }

  // ---------------- legged robots ----------------
  const tw = cls === 'armor' ? 6 + k : cls === 'shock' ? 5 + Math.ceil(k / 2) : cls === 'charge' ? 7 + k : 6 + k;
  const th = cls === 'shock' ? 6 + Math.ceil(k / 2) : cls === 'armor' ? 6 + Math.ceil(k / 2) : cls === 'charge' ? 4 + Math.ceil(k / 3) : 4 + Math.ceil(k / 2);
  const lh = cls === 'blast' ? 2 : cls === 'maneuver' ? 5 : cls === 'armor' ? 3 : 3 + Math.floor(k / 3);
  const ty = ground - lh - th;
  const tx = cx - Math.floor(tw / 2) + (cls === 'maneuver' || cls === 'charge' ? -2 : 0);

  // ---- legs: in a stride / braced stance ----
  if (cls === 'maneuver') {
    // sprinting: back leg pushing off, front leg reaching forward
    c.part(tx, ty + th, 2, 2, p);
    c.part(tx - 2, ty + th + 2, 3, 2, p);
    c.part(tx - 4, ground - 1, 3, 1, p);
    c.part(tx + tw - 3, ty + th, 2, 2, p);
    c.part(tx + tw - 1, ty + th + 2, 2, 2, p);
    c.part(tx + tw, ground - 1, 4, 1, p);
  } else if (cls === 'charge') {
    // bull stance: legs spread wide, back leg extended
    const legW = 3;
    c.part(tx - 1, ty + th, legW, lh - 1, p);
    c.part(tx - 3, ground - 1, legW + 2, 1, p);
    c.part(tx + tw - legW, ty + th, legW, lh, p);
    c.part(tx + tw - legW, ground - 1, legW + 2, 1, p);
  } else {
    const legW = cls === 'armor' ? 3 : 2;
    const spread = cls === 'armor' || cls === 'none' ? 1 : 0; // wide fighting stance
    for (const [i, lx] of [tx + 1 - spread, tx + tw - 1 - legW + spread].entries()) {
      c.part(lx, ty + th, legW, lh, p);
      c.part(lx - 1 + (i ? 1 : -1), ground - 1, legW + 2, 1, p); // feet point outward
    }
  }

  // ---- torso ----
  if (cls === 'blast') {
    c.part(tx, ty, tw, th + 1, p, { cut: true });
    // reactor core (pulses)
    const ccx = cx - 1;
    const ccy = ty + Math.floor(th / 2);
    c.fill(ccx - 1, ccy - 1, 4, 3, '#ff8a00');
    c.fill(ccx, ccy, 2, 1, '#ffe600');
    c.fx('a', ccx - 2, ccy, '#ffe600');
    c.fx('a', ccx + 3, ccy, '#ffe600');
    c.fx('b', ccx, ccy - 2, '#ffffff');
    // hazard band
    for (let i = 0; i < tw - 2; i++) c.set(tx + 1 + i, ty + 1, i % 2 ? '#ffe600' : '#1a1a1a');
    // skull-ish warning mark for the big ones
    if (k >= 4) {
      c.set(tx + 2, ty + th - 2, '#f2eee2');
      c.set(tx + 3, ty + th - 2, '#f2eee2');
    }
  } else {
    c.part(tx, ty, tw, th, p);
    c.fill(tx + 2, ty + th - 2, tw - 4, 1, p.dark);
    c.set(tx + tw - 3, ty + 1, eye);
  }

  // ---- arms: posed ----
  if (cls === 'none') {
    // guard arm down, the other raised forward as a cannon/fist
    c.part(tx - 1, ty + 1, 1, th - 1, p);
    c.part(tx + tw, ty, 2, 2, p);
    c.part(tx + tw + 2, ty - 1, 3 + Math.floor(k / 3), 2, p);
    const mx = tx + tw + 5 + Math.floor(k / 3);
    c.set(mx, ty - 1, '#1a1a1a');
    c.set(mx, ty, '#1a1a1a');
    // muzzle flash
    c.fx('a', mx + 1, ty - 1, '#ffe600');
    c.fx('a', mx + 1, ty, '#ffffff');
    c.fx('a', mx + 2, ty - 2, '#ff8a00');
    c.fx('a', mx + 2, ty + 1, '#ff8a00');
    c.fx('b', mx + 1, ty - 1, '#ff8a00');
  } else if (cls === 'shock') {
    // both arms raised high, lightning arcs between the hands
    c.part(tx - 1, ty - 4, 1, 5, p);
    c.part(tx + tw, ty - 4, 1, 5, p);
    c.set(tx - 2, ty - 5, '#d08a3a');
    c.set(tx + tw + 1, ty - 5, '#d08a3a');
  } else if (cls === 'maneuver') {
    // arms swept back like a sprinter
    c.part(tx - 2, ty + 1, 2, 1, p);
    c.part(tx - 4, ty + 2, 2, 1, p);
    c.part(tx + tw, ty + 1, 2, 1, p);
    c.part(tx + tw + 1, ty + 2, 1, 2, p);
    // blade arm for the bigger ones
    if (k >= 3) for (let i = 0; i < 3 + k; i++) c.set(tx + tw + 2 + i, ty + 3 - Math.floor(i / 3), i % 2 ? '#e8f8ff' : '#a9d6e6');
  } else if (cls === 'charge') {
    // arms forward and down, like a lineman
    c.part(tx + tw - 1, ty + th - 1, 3, 2, p);
    c.part(tx + 1, ty + th - 1, 2, 2, p);
  } else if (cls === 'armor') {
    c.part(tx + tw, ty + 1, 2, th - 1, p);
  }
  // shoulder pads on bigger robots
  if (k >= 4 && cls !== 'blast' && cls !== 'shock' && cls !== 'maneuver') {
    c.part(tx - 2, ty - 1, 3, 2, p);
    c.part(tx + tw - 1, ty - 1, 3, 2, p);
  }

  // ---- head ----
  if (cls === 'shock') {
    // tesla coil head: stacked rings + glowing ball
    const rings = 3 + Math.floor(k / 2);
    for (let i = 0; i < rings; i++) {
      const w = i % 2 ? 3 : 5;
      c.fill(cx - Math.floor(w / 2) - 1, ty - 1 - i, w, 1, i % 2 ? '#2c1b55' : '#d08a3a');
    }
    const ballY = ty - rings - 2;
    c.fill(cx - 2, ballY, 3, 2, p.accent);
    // lightning: hand → coil → hand, two different jagged frames
    bolt(c, 'a', tx - 2, ty - 6, cx - 2, ballY, h, p.accent);
    bolt(c, 'a', cx, ballY, tx + tw + 1, ty - 6, h >> 3, '#b46bff');
    bolt(c, 'b', tx - 2, ty - 6, cx - 2, ballY + 1, h >> 5, '#b46bff');
    bolt(c, 'b', cx, ballY + 1, tx + tw + 1, ty - 6, h >> 7, p.accent);
    // big arcs thrown outward from each hand (alternating sides per frame) and one between the hands
    bolt(c, 'a', tx - 2, ty - 6, tx - 7, ty - 1, h >> 9, '#b46bff');
    bolt(c, 'a', tx - 7, ty - 1, tx - 6, ty + 5, h >> 11, p.accent);
    bolt(c, 'b', tx + tw + 1, ty - 6, tx + tw + 6, ty - 1, h >> 13, '#b46bff');
    bolt(c, 'b', tx + tw + 6, ty - 1, tx + tw + 5, ty + 5, h >> 15, p.accent);
    bolt(c, 'a', tx - 2, ty - 7, tx + tw + 1, ty - 7, h >> 2, '#ffffff');
    bolt(c, 'b', tx - 2, ty - 5, tx + tw + 1, ty - 5, h >> 4, p.accent);
    // glowing hands
    c.fx('ab', tx - 2, ty - 6, '#ffffff');
    c.fx('ab', tx + tw + 1, ty - 6, '#ffffff');
    // stray sparks off the body
    c.fx('a', tx - 3, ty + 2, '#ffffff');
    c.fx('b', tx + tw + 2, ty + 3, '#ffffff');
    c.fx('b', cx - 4, ballY - 1, p.accent);
    c.fx('a', cx + 2, ballY - 1, p.accent);
  } else if (cls === 'blast') {
    // dome lid + fuse with an animated spark
    c.part(cx - 3, ty - 2, 6, 2, p, { cut: true });
    c.fill(cx - 1, ty - 1, 2, 1, eye);
    c.set(cx + 2, ty - 3, '#d9d2c0');
    c.set(cx + 3, ty - 4, '#d9d2c0');
    c.fx('a', cx + 4, ty - 5, '#ffe600');
    c.fx('a', cx + 3, ty - 6, '#ff8a00');
    c.fx('b', cx + 4, ty - 5, '#ffffff');
    c.fx('b', cx + 5, ty - 6, '#ffe600');
    c.fx('b', cx + 5, ty - 4, '#ff8a00');
  } else {
    const hw = cls === 'armor' ? 5 + Math.floor(k / 3) : 4 + Math.floor(k / 2);
    const hh = 4;
    const hx = cls === 'charge' ? tx + tw - 1 : cls === 'maneuver' ? tx + tw - hw + 1 : cx - Math.floor(hw / 2);
    const hy = cls === 'charge' ? ty + 1 : ty - hh; // charge: head lowered, out in front
    c.part(hx, hy, hw, hh, p);
    if (cls === 'armor') c.fill(hx + 1, hy + 1, hw - 2, 1, eye); // visor slit
    else if (h % 2 === 0) c.fill(hx + hw - 3, hy + 1, 2, 2, eye); // one big lens, looking forward
    else {
      c.set(hx + 1, hy + 1, eye);
      c.set(hx + hw - 2, hy + 1, eye);
    }
    if (cls === 'charge') {
      // horns pointing forward + steam from the nostrils (animated)
      c.set(hx + hw, hy - 1, '#f2eee2');
      c.set(hx + hw + 1, hy - 2, '#f2eee2');
      c.set(hx + hw + 2, hy - 2, '#d9d2c0');
      c.set(hx + 1, hy - 1, '#f2eee2');
      c.set(hx + 2, hy - 2, '#d9d2c0');
      c.fx('a', hx + hw, hy + 3, '#e8e8f0');
      c.fx('a', hx + hw + 1, hy + 4, '#b8b8c8');
      c.fx('b', hx + hw + 1, hy + 3, '#e8e8f0');
      c.fx('b', hx + hw + 2, hy + 4, '#b8b8c8');
      c.fx('b', hx + hw + 3, hy + 3, '#8a8a99');
      // dust kicked up behind
      c.fx('a', tx - 4, ground - 2, '#8a7a66');
      c.fx('a', tx - 6, ground - 3, '#6a5c4c');
      c.fx('b', tx - 5, ground - 2, '#8a7a66');
      c.fx('b', tx - 7, ground - 4, '#6a5c4c');
    }
    if (cls === 'none' || cls === 'maneuver') {
      const n = cls === 'none' ? 1 + (h % 2) : 1;
      for (let i = 0; i < n; i++) {
        const ax = hx + 1 + i * (hw - 3);
        const lean = cls === 'maneuver' ? -1 : 0; // antenna swept back by the wind
        c.fill(ax, hy - 2, 1, 2, p.dark);
        c.set(ax + lean, hy - 3, p.accent);
      }
    }
  }

  // ---- class extras ----
  if (cls === 'armor') {
    // tower shield with hazard stripes and an emblem; a glint runs across it
    const sw = 4 + Math.floor(k / 3);
    const sh = th + lh;
    const sx = tx - sw - 1;
    const sy = ty - 1;
    c.part(sx, sy, sw, sh, { ...p, base: '#d6d0c0', light: '#f2eee2', dark: '#7a7468' });
    for (let j = 1; j < sh - 1; j++) c.set(sx + 1 + ((j + 1) % Math.max(1, sw - 2)), sy + j, j % 3 === 0 ? '#ffe600' : '#1a1a1a');
    c.fill(sx + Math.floor(sw / 2) - 1, sy + 2, 2, 2, p.accent);
    for (let j = 0; j < 3; j++) {
      c.fx('a', sx + 1 + j, sy + 1 + j, '#ffffff');
      c.fx('b', sx + 1 + j, sy + sh - 4 + j, '#ffffff');
    }
  }
  if (cls === 'maneuver') {
    // back thruster with an animated flame + speed lines
    c.part(tx - 2, ty, 2, 3, p);
    c.fx('a', tx - 3, ty + 1, '#ffe600');
    c.fx('a', tx - 4, ty + 1, '#ff8a00');
    c.fx('a', tx - 5, ty + 1, '#ff2a8a');
    c.fx('a', tx - 3, ty + 2, '#ff8a00');
    c.fx('b', tx - 3, ty + 1, '#ffffff');
    c.fx('b', tx - 4, ty + 1, '#ffe600');
    c.fx('b', tx - 4, ty + 2, '#ff8a00');
    c.fx('b', tx - 6, ty + 1, '#ff8a00');
    c.fx('b', tx - 7, ty + 2, '#ff2a8a');
    for (const [i, yy] of [ty - 2, ty + 4, ty + th + 2].entries())
      for (let j = 0; j < 3 + i; j++) c.fx(i % 2 ? 'a' : 'b', tx - 6 - j - i, yy, '#5fd6d088');
  }

  // fast classes lean toward the enemy
  if (cls === 'maneuver') c.shear(ground, 0.18);
  if (cls === 'charge') c.shear(ground, 0.1);
  c.outline();
  return c;
}

/** Rows of same-colored pixels merged into rectangles. */
/** One layer of a sprite as an SVG string (runs of same-colour pixels merged into one rect). */
function layerSvg(g: Grid, vb: string, glow = ''): string {
  let out = '';
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const col = g[y][x];
      if (!col) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < N && g[y][x + w] === col) w++;
      out += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${col}"/>`;
      x += w;
    }
  }
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" shape-rendering="crispEdges">${glow}${out}</svg>`,
  )}`;
}

interface SpriteImages {
  body: string;
  a: string;
  b: string;
}
const spriteCache = new Map<string, SpriteImages>();

/** The three layers of a model's sprite, rendered once and cached as images. */
function spriteImages(modelId: string): SpriteImages {
  const hit = spriteCache.get(modelId);
  if (hit) return hit;
  const c = draw(modelId);
  // auto-crop: a square around everything drawn (effects included), standing on the ground line
  let minX = N,
    minY = N,
    maxX = 0,
    maxY = 0;
  for (const g of [c.px, c.fxA, c.fxB])
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++)
        if (g[y][x]) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
  const side = Math.max(16, maxX - minX + 3, maxY - minY + 3);
  const vx = Math.round((minX + maxX + 1) / 2 - side / 2);
  const vy = maxY + 2 - side;
  const vb = `${vx} ${vy} ${side} ${side}`;
  const imgs = { body: layerSvg(c.px, vb), a: layerSvg(c.fxA, vb), b: layerSvg(c.fxB, vb) };
  spriteCache.set(modelId, imgs);
  return imgs;
}

/**
 * Robot sprite: three cached images (body + two effect frames). The effect frames only toggle opacity, which the
 * GPU composites for free — the old inline SVGs (hundreds of rects each, filtered and re-rasterised every frame)
 * made the cursor lag on a Hangar full of robots.
 */
export const RobotSprite = memo(function RobotSprite({ modelId, size = 56 }: { modelId: string; size?: number }) {
  const im = spriteImages(modelId);
  const cls = classOf(modelId);
  return (
    <span className={`robot-sprite rs-${cls}`} style={{ width: size, height: size }}>
      <img className="rs-body" src={im.body} alt="" draggable={false} />
      <img className="rs-fx rs-a" src={im.a} alt="" draggable={false} />
      <img className="rs-fx rs-b" src={im.b} alt="" draggable={false} />
    </span>
  );
});
