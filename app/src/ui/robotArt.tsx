// Pixel robot generator for the cards (placeholder art until real illustrations exist).
// Every robot is assembled on a 24×24 grid from parts that depend on its class; its size grows with energy cost,
// small details (eye color, antennas, shoulder pads) are picked deterministically from the model id.
// After the parts are drawn, light (top-left edges) and shadow (bottom-right edges) are added, then a dark outline.

import { memo, type ReactElement } from 'react';
import { classOf, model } from '../engine/robots';

const N = 24;
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
  repair: { base: '#c9d3c9', light: '#ffffff', dark: '#6e7f73', accent: '#39ff14' },
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

class Canvas {
  px: (string | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));
  /** "Body" cells — get light/shadow and an outline; decals don't. */
  body: boolean[][] = Array.from({ length: N }, () => Array(N).fill(false));
  set(x: number, y: number, c: string, isBody = false) {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    this.px[y][x] = c;
    if (isBody) this.body[y][x] = true;
  }
  /** A shaded body part: light top/left edge, dark bottom/right edge. */
  part(x: number, y: number, w: number, h: number, p: Pal, opts: { cut?: boolean } = {}) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        if (opts.cut && (i === 0 || i === w - 1) && (j === 0 || j === h - 1)) continue; // rounded corners
        const edgeL = i === 0 || j === 0;
        const edgeD = i === w - 1 || j === h - 1;
        this.set(x + i, y + j, edgeD ? p.dark : edgeL ? p.light : p.base, true);
      }
  }
  fill(x: number, y: number, w: number, h: number, c: string) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
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

function draw(modelId: string): Canvas {
  const md = model(modelId);
  const cls = classOf(modelId);
  const p = PALETTES[cls];
  const h = hash(modelId);
  const eye = EYES[h % EYES.length];
  const k = md.cost; // 1..6 — size
  const c = new Canvas();
  const cx = 12;
  const ground = 22;

  if (cls === 'repair') {
    // hovering drone
    const bw = 8 + k;
    const bh = 5 + Math.floor(k / 2);
    const by = 9 - Math.floor(k / 3);
    const bx = cx - Math.floor(bw / 2);
    c.part(bx, by, bw, bh, p, { cut: true });
    // cross decal
    const mx = cx - 1;
    const my = by + Math.floor(bh / 2) - 1;
    c.fill(mx, my - 1, 2, 4, p.accent);
    c.fill(mx - 1, my, 4, 2, p.accent);
    // rotors
    c.fill(bx + 1, by - 2, 1, 2, p.dark);
    c.fill(bx + bw - 2, by - 2, 1, 2, p.dark);
    c.part(bx - 2, by - 3, 5, 1, p);
    c.part(bx + bw - 3, by - 3, 5, 1, p);
    // eye visor
    c.fill(bx + 2, by + 1, 2, 1, eye);
    // wrench arm
    const ax = bx + bw;
    c.part(ax, by + 2, 3, 2, p);
    c.part(ax + 2, by + 4, 2, 3, p);
    c.fill(ax + 1, by + 7, 1, 1, p.light);
    c.fill(ax + 3, by + 7, 1, 1, p.light);
    // repair beam + hover glow
    for (let i = 0; i < 4; i++) c.set(ax + 2 - i, by + 8 + i, i % 2 ? '#39ff14' : '#b6ffb0');
    c.fill(cx - 3, ground - 1, 6, 1, '#39ff1466');
    c.outline();
    return c;
  }

  // legged robots
  const tw = cls === 'armor' ? 6 + k : cls === 'shock' ? 5 + Math.ceil(k / 2) : 6 + k; // torso width
  const th = cls === 'shock' ? 6 + Math.ceil(k / 2) : cls === 'armor' ? 6 + Math.ceil(k / 2) : 4 + Math.ceil(k / 2); // torso height
  const lh = cls === 'blast' ? 2 : cls === 'maneuver' ? 5 : cls === 'armor' ? 4 : 3 + Math.floor(k / 3); // leg height
  const ty = ground - lh - th;
  const tx = cx - Math.floor(tw / 2) + (cls === 'maneuver' ? -1 : 0);

  // ---- legs ----
  if (cls === 'maneuver') {
    // digitigrade legs: down-back, then forward
    for (const off of [1, tw - 4]) {
      const lx = tx + off;
      c.part(lx, ty + th, 2, 2, p);
      c.part(lx - 1, ty + th + 2, 2, 2, p);
      c.part(lx, ty + th + 4, 3, 1, p);
    }
  } else {
    const legW = cls === 'armor' || cls === 'charge' ? 3 : 2;
    for (const lx of [tx + 1, tx + tw - 1 - legW]) {
      c.part(lx, ty + th, legW, lh, p);
      c.part(lx - 1, ground - 1, legW + 2, 1, p); // foot
    }
  }

  // ---- torso ----
  if (cls === 'blast') {
    c.part(tx, ty, tw, th + 1, p, { cut: true });
    // reactor core
    const ccx = cx - 1;
    const ccy = ty + Math.floor(th / 2);
    c.fill(ccx - 1, ccy - 1, 4, 3, '#ff8a00');
    c.fill(ccx, ccy, 2, 1, '#ffe600');
    // hazard band
    for (let i = 0; i < tw - 2; i++) c.set(tx + 1 + i, ty + 1, i % 2 ? '#ffe600' : '#1a1a1a');
    // smoke
    c.set(tx + 2, ty - 3, '#8a8a99');
    c.set(tx + 3, ty - 4, '#6a6a77');
  } else {
    c.part(tx, ty, tw, th, p);
    // panel line and a light
    c.fill(tx + 2, ty + th - 2, tw - 4, 1, p.dark);
    c.set(tx + tw - 3, ty + 1, eye);
  }

  // ---- arms ----
  if (cls !== 'blast') {
    const aw = cls === 'armor' || cls === 'charge' ? 2 : 1;
    c.part(tx - aw, ty + 1, aw, th - 1, p);
    c.part(tx + tw, ty + 1, aw, th - 1, p);
    if (cls === 'shock') {
      // copper prongs + arcs between the hands
      c.set(tx - 1, ty + th, '#d08a3a');
      c.set(tx + tw, ty + th, '#d08a3a');
      for (let i = 0; i < 5; i++) {
        c.set(tx - 3 + (i % 2), ty + th + 1 + i, p.accent);
        c.set(tx + tw + 2 - (i % 2), ty + th + 1 + i, p.accent);
      }
    }
  }
  // shoulder pads on bigger robots
  if (k >= 4 && cls !== 'blast' && cls !== 'shock') {
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
    c.fill(cx - 2, ty - rings - 2, 3, 2, p.accent);
    c.set(cx - 4, ty - rings - 1, p.accent);
    c.set(cx + 2, ty - rings, p.accent);
  } else if (cls === 'blast') {
    // dome lid
    c.part(cx - 3, ty - 2, 6, 2, p, { cut: true });
    c.fill(cx - 1, ty - 1, 2, 1, eye);
  } else {
    const hw = cls === 'armor' ? 5 + Math.floor(k / 3) : 4 + Math.floor(k / 2);
    const hh = cls === 'armor' ? 4 : 4;
    const hx = cls === 'charge' || cls === 'maneuver' ? tx + tw - hw + 1 : cx - Math.floor(hw / 2);
    const hy = cls === 'charge' ? ty : ty - hh; // charge: head lowered, at shoulder level
    c.part(hx, hy, hw, hh, p);
    if (cls === 'armor') c.fill(hx + 1, hy + 1, hw - 2, 1, eye); // visor slit
    else if (h % 2 === 0) c.fill(hx + 1, hy + 1, 2, 2, eye); // one big lens
    else {
      c.set(hx + 1, hy + 1, eye);
      c.set(hx + hw - 2, hy + 1, eye);
    }
    if (cls === 'charge') {
      // horns + steam
      c.set(hx - 1, hy - 1, '#d9d2c0');
      c.set(hx - 2, hy - 2, '#d9d2c0');
      c.set(hx + hw, hy - 1, '#d9d2c0');
      c.set(hx + hw + 1, hy - 2, '#d9d2c0');
      c.set(hx + hw + 1, hy + 2, '#e8e8f0');
      c.set(hx + hw + 2, hy + 1, '#b8b8c8');
    }
    if (cls === 'none' || cls === 'maneuver') {
      // antenna(s)
      const n = cls === 'none' ? 1 + (h % 2) : 1;
      for (let i = 0; i < n; i++) {
        const ax = hx + 1 + i * (hw - 3);
        c.fill(ax, hy - 2, 1, 2, p.dark);
        c.set(ax, hy - 3, p.accent);
      }
    }
  }

  // ---- class extras ----
  if (cls === 'armor') {
    // tower shield with hazard stripes
    const sw = 3 + Math.floor(k / 3);
    const sh = th + lh - 1;
    const sx = tx - sw - 1;
    const sy = ty;
    c.part(sx, sy, sw, sh, { ...p, base: '#d6d0c0', light: '#f2eee2', dark: '#7a7468' });
    for (let j = 1; j < sh - 1; j++) c.set(sx + 1 + ((j + 1) % Math.max(1, sw - 2)), sy + j, j % 3 === 0 ? '#ffe600' : '#1a1a1a');
  }
  if (cls === 'maneuver') {
    // back thruster + flame
    c.part(tx - 2, ty + 1, 2, 3, p);
    c.set(tx - 3, ty + 2, '#ffe600');
    c.set(tx - 4, ty + 2, '#ff8a00');
    c.set(tx - 3, ty + 3, '#ff8a00');
    c.set(tx - 5, ty + 3, '#ff2a8a');
  }
  c.outline();
  return c;
}

/** Robot sprite as crisp pixel SVG. Rows of same-colored pixels are merged into one rectangle. */
export const RobotSprite = memo(function RobotSprite({ modelId, size = 56 }: { modelId: string; size?: number }) {
  const c = draw(modelId);
  const rects: ReactElement[] = [];
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const col = c.px[y][x];
      if (!col) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < N && c.px[y][x + w] === col) w++;
      rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={w} height={1} fill={col} />);
      x += w;
    }
  }
  // автокадрирование: квадрат вокруг нарисованного (с отступом), чтобы маленькие роботы не терялись в рамке
  let minX = N,
    minY = N,
    maxX = 0,
    maxY = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (c.px[y][x]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  const side = Math.max(14, maxX - minX + 3, maxY - minY + 3);
  const vx = Math.round((minX + maxX + 1) / 2 - side / 2);
  const vy = maxY + 2 - side; // стоят «на земле» — выравниваем по низу
  return (
    <svg className="robot-sprite" viewBox={`${vx} ${vy} ${side} ${side}`} width={size} height={size} shapeRendering="crispEdges">
      {rects}
    </svg>
  );
});
