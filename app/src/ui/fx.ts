// Screen effects outside React: the cyberpunk cursor and the "tube" glow under it.
// Both are separate layers on body (outside #root, so the UI scale doesn't affect them) and are moved directly
// through style, once per frame, without re-rendering React.
//
// Cursor: the system one is hidden; ours is a pixel arrow (generated from a mask below) plus HUD parts that switch
// by state. The state comes from the --ck CSS property of the element under the pointer
// (default / pointer / grab / grabbing / target / row / text) or is forced from code via setCursorMode()
// (e.g. "scan" while box-selecting on the market).
// Glow: three layers chase the cursor at different speeds (warm core, magenta halo, cyan halo), so when moving
// the colors drift apart like CRT phosphor afterglow; inside — scanlines and a slight flicker.

// ---------- pixel arrow ----------
// X — arrow body. Outline and dithered fill are derived from it automatically.
const MASK = [
  'X...........',
  'XX..........',
  'XXX.........',
  'XXXX........',
  'XXXXX.......',
  'XXXXXX......',
  'XXXXXXX.....',
  'XXXXXXXX....',
  'XXXXXXXXX...',
  'XXXXXXXXXX..',
  'XXXXXXX.....',
  'XXX.XXXX....',
  'XX...XXX....',
  'X....XXXX...',
  '......XXX...',
  '......XX....',
];
const PX = 2; // one "pixel" of the cursor = 2×2 screen pixels

function arrowPixels() {
  const at = (x: number, y: number) => MASK[y]?.[x] === 'X';
  const outline: string[] = [];
  const fill: string[] = [];
  const dither: string[] = [];
  MASK.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c !== 'X') return;
      const edge = !at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1);
      const r = `<rect x="${x * PX}" y="${y * PX}" width="${PX}" height="${PX}"/>`;
      if (edge) outline.push(r);
      else if ((x + y) % 2 === 0) dither.push(r);
      else fill.push(r);
    }),
  );
  return { outline: outline.join(''), fill: fill.join(''), dither: dither.join('') };
}

const NEON_ARROW = '1.5,1.5 1.5,20 6,15.6 9.4,23 12.6,21.5 9.3,14.3 15.6,14.3';

function arrowSvg(style: CursorStyle) {
  if (style === 'neon') {
    // hollow glowing arrow — like a neon tube
    return `
<svg class="cy-arrow" width="27" height="27" viewBox="0 0 24 24" aria-hidden="true">
  <polygon class="gm" points="${NEON_ARROW}" />
  <polygon class="nb" points="${NEON_ARROW}" />
  <polygon class="nc" points="${NEON_ARROW}" />
</svg>`;
  }
  const a = arrowPixels();
  const w = MASK[0].length * PX + 4;
  const h = MASK.length * PX + 4;
  return `
<svg class="cy-arrow" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true">
  <g class="gm">${a.outline}</g>
  <g class="gc">${a.outline}</g>
  <g class="f">${a.fill}</g>
  <g class="d">${a.dither}</g>
  <g class="o">${a.outline}</g>
</svg>`;
}

function cursorHtml(style: CursorStyle) {
  return `${arrowSvg(style)}
<div class="cy-brackets"><i></i><i></i><i></i><i></i></div>
<svg class="cy-reticle" viewBox="0 0 40 40" width="40" height="40" shape-rendering="crispEdges" aria-hidden="true">
  <path d="M20 3 V11 M20 29 V37 M3 20 H11 M29 20 H37" />
  <path class="arc" d="M9 9 A15.5 15.5 0 0 1 31 9 M31 31 A15.5 15.5 0 0 1 9 31" />
  <rect x="18" y="18" width="4" height="4" />
</svg>
<svg class="cy-scan" viewBox="0 0 30 30" width="30" height="30" shape-rendering="crispEdges" aria-hidden="true">
  <path d="M2 10 V2 H10 M20 2 H28 V10 M28 20 V28 H20 M10 28 H2 V20" />
  <rect x="13" y="13" width="4" height="4" />
</svg>
<span class="cy-label"></span>`;
}

// ---------- chosen look: neon cursor + glitch click (other variants were tried and removed) ----------
export type CursorStyle = 'pixel' | 'neon';
const prefs: { cursor: CursorStyle } = { cursor: 'neon' };

// ---------- labels ----------
let mods = { ctrl: false, shift: false };
const labelFor = (k: string, extra: string): string => {
  if (k === 'row') return mods.shift ? 'RANGE' : mods.ctrl ? '+ADD' : 'SEL';
  if (k === 'scan') return extra || 'SCAN';
  return ({ pointer: 'EXEC', grab: 'GRAB', grabbing: 'HOLD', target: 'LOCK' } as Record<string, string>)[k] ?? '';
};

let forced: { kind: string; label: string } | null = null;
let refresh: () => void = () => {};

/** Force a cursor state from code (null — back to automatic). */
export function setCursorMode(kind: string | null, label = '') {
  forced = kind ? { kind, label } : null;
  refresh();
}

export function initFx() {
  const fine = window.matchMedia('(pointer: fine)').matches;

  // ---------- glow ----------
  const glow = document.createElement('div');
  glow.id = 'cursor-glow';
  glow.innerHTML = '<i class="g-halo"></i><i class="g-bloom"></i><i class="g-core"></i>';
  document.body.prepend(glow);
  const layers = [...glow.querySelectorAll('i')] as HTMLElement[];
  // how fast each layer catches up: the halo lags the most — that's the "afterglow"
  const SPEED = [0.07, 0.16, 0.38];
  const pos = layers.map(() => ({ x: -999, y: -999 }));
  let tx = -999;
  let ty = -999;
  let running = false;
  const tick = () => {
    let moving = false;
    layers.forEach((el, i) => {
      const p = pos[i];
      p.x += (tx - p.x) * SPEED[i];
      p.y += (ty - p.y) * SPEED[i];
      if (Math.abs(tx - p.x) > 0.3 || Math.abs(ty - p.y) > 0.3) moving = true;
      el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
    });
    if (moving) requestAnimationFrame(tick);
    else running = false;
  };

  // ---------- cursor ----------
  let cur: HTMLDivElement | null = null;
  if (fine) {
    cur = document.createElement('div');
    cur.id = 'cy-cursor';
    cur.className = 'st-default';
    cur.dataset.style = prefs.cursor;
    cur.innerHTML = cursorHtml(prefs.cursor);
    document.body.appendChild(cur);
    document.documentElement.classList.add('cy-on');
  }
  const label = cur?.querySelector('.cy-label') as HTMLElement | null;

  let hoverKind = 'default';
  let shown = '';
  refresh = () => {
    if (!cur) return;
    const k = forced?.kind ?? (document.body.classList.contains('is-dragging') ? 'grabbing' : hoverKind);
    const text = labelFor(k, forced?.label ?? '');
    const cls = `st-${k}`;
    if (cur.className.split(' ')[0] !== cls) cur.className = [cls, ...cur.className.split(' ').slice(1)].join(' ');
    if (label && text !== shown) {
      label.textContent = text;
      shown = text;
    }
  };
  const kindAt = (el: Element | null): string =>
    el ? getComputedStyle(el).getPropertyValue('--ck').trim() || 'default' : 'default';

  window.addEventListener('pointermove', (e) => {
    tx = e.clientX;
    ty = e.clientY;
    if (pos[0].x < -900) for (const p of pos) Object.assign(p, { x: tx, y: ty });
    glow.style.opacity = '1';
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
    if (cur) {
      cur.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
      cur.style.opacity = '1';
    }
  });
  window.addEventListener('pointerover', (e) => {
    hoverKind = kindAt(e.target as Element);
    refresh();
  });
  document.addEventListener('pointerleave', () => {
    glow.style.opacity = '0';
    if (cur) cur.style.opacity = '0';
  });
  const onKey = (e: KeyboardEvent) => {
    mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    refresh();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', () => {
    mods = { ctrl: false, shift: false };
    refresh();
  });

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    glow.classList.remove('flare');
    void glow.offsetWidth;
    glow.classList.add('flare');
    if (!cur) return;
    cur.classList.add('press');
    glitchHit(e.clientX, e.clientY);
  });
  window.addEventListener('pointerup', (e) => {
    cur?.classList.remove('press');
    hoverKind = kindAt(document.elementFromPoint(e.clientX, e.clientY));
    refresh();
  });
}

/**
 * Click impact — two "arrows": sharp needles shoot left and right from the click point
 * (white-hot core, cyan glow, tapering to a point), with a faint magenta trail and a tiny diamond flash.
 */
function glitchHit(x: number, y: number) {
  const box = document.createElement('div');
  box.className = 'cy-hit';
  box.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  const len = 46 + Math.round(Math.random() * 22);
  box.style.setProperty('--len', `${len}px`);
  box.innerHTML = '<i class="ray l trail"></i><i class="ray r trail"></i><i class="ray l"></i><i class="ray r"></i><b class="spark"></b>';
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 260);
}
