// Sound engine (Web Audio API).
// Sound effects: Kenney.nl packs, CC0 license (see public/sfx/SOURCES.txt and SOUNDS.md).
// Background ambience is synthesized right here in code (drone + crackle), so it has no license at all.
// Browsers only allow sound after the first click/keypress — the engine starts on that gesture.

type Sfx =
  | 'ui-click'
  | 'ui-scroll'
  | 'ui-tab'
  | 'ui-hover'
  | 'ui-error'
  | 'ui-buy'
  | 'ui-sell'
  | 'glitch'
  | 'deploy'
  | 'repair'
  | 'shock'
  | 'hit'
  | 'core-hit'
  | 'block'
  | 'charge'
  | 'destroy'
  | 'blast'
  | 'victory'
  | 'defeat'
  | 'fast-forward'
  | 'card-pick'
  | 'card-drop'
  | 'ui-toggle'
  | 'ui-open'
  | 'ui-close'
  | 'ui-sort'
  | 'ui-select';

// Sound -> files (variants), base volume and pitch spread (so repeats don't get boring)
const BANK: Record<Sfx, { files: string[]; vol: number; spread?: number }> = {
  'ui-click': { files: ['ui-click', 'ui-click-2', 'ui-click-3'], vol: 0.5, spread: 0.18 },
  'ui-tab': { files: ['ui-tab', 'ui-tab-2', 'ui-tab-3'], vol: 0.35, spread: 0.16 },
  // filters / toggles: a casino chip laid on the table + a quiet light-metal tap
  'ui-toggle': { files: ['ui-filter-1', 'ui-filter-2'], vol: 0.3, spread: 0.14 },
  'ui-open': { files: ['ui-open'], vol: 0.3, spread: 0.12 },
  'ui-close': { files: ['ui-close'], vol: 0.3, spread: 0.12 },
  'ui-sort': { files: ['ui-sort'], vol: 0.18, spread: 0.2 },
  // row select: a click with a faint metallic ring
  'ui-select': { files: ['ui-select-m1', 'ui-select-m2'], vol: 0.32, spread: 0.2 },
  // ratchet tick while box/Shift-selecting rows; the pitch rises with each added row (opts.rate)
  'ui-scroll': { files: ['ui-scroll'], vol: 0.22, spread: 0.04 },
  'ui-hover': { files: ['ui-hover'], vol: 0.12 },
  'ui-error': { files: ['ui-error'], vol: 0.28 },
  'ui-buy': { files: ['ui-buy'], vol: 0.55 },
  'ui-sell': { files: ['ui-sell'], vol: 0.5 },
  glitch: { files: ['glitch-1', 'glitch-2', 'glitch-3', 'glitch-4'], vol: 0.25 },
  deploy: { files: ['deploy'], vol: 0.35 },
  repair: { files: ['repair'], vol: 0.45 },
  shock: { files: ['shock-1', 'shock-2'], vol: 0.45 },
  hit: { files: ['hit-1', 'hit-2', 'hit-3'], vol: 0.6 },
  'core-hit': { files: ['core-hit-1', 'core-hit-2'], vol: 0.6 },
  block: { files: ['block'], vol: 0.5 },
  charge: { files: ['charge-1', 'charge-2'], vol: 0.7 },
  destroy: { files: ['destroy-1', 'destroy-2'], vol: 0.6 },
  blast: { files: ['blast'], vol: 0.7 },
  victory: { files: ['victory'], vol: 0.6 },
  defeat: { files: ['defeat'], vol: 0.6 },
  'fast-forward': { files: ['fast-forward'], vol: 0.4 },
  // карточные звуки (Kenney Casino Audio) с тихим «киберпанк»-слоем: стекло/глитч при подъёме, металл/стекло при посадке
  'card-pick': { files: ['card-pick-1', 'card-pick-2'], vol: 0.45 },
  'card-drop': { files: ['card-drop-1', 'card-drop-2'], vol: 0.55 },
};

const PREF_KEY = 'neon-pit-sound';
const MIN_GAP_MS: Partial<Record<Sfx, number>> = { glitch: 180, 'ui-hover': 60, 'ui-error': 250 };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/** Отдельная шина эффектов: тише эмбиента, чтобы клики и удары не резали слух на фоне гула. */
let sfxBus: GainNode | null = null;
const SFX_LEVEL = 0.4;
const buffers = new Map<string, AudioBuffer>();
const lastPlayed = new Map<Sfx, number>();
const lastVariant = new Map<Sfx, { file: string; rate: number }>();
let enabled = readPref();
let volume = readVolume();
const VOL_KEY = 'neon-pit-volume';

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem('neon-pit-volume'));
    return localStorage.getItem('neon-pit-volume') !== null && isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
  } catch {
    return 0.7;
  }
}

/** Слух воспринимает громкость нелинейно — квадрат даёт ровный ход ползунка. */
const masterLevel = () => (enabled ? volume * volume : 0);
function applyLevel() {
  if (master && ctx) master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.05);
}
const listeners = new Set<() => void>();

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export const soundEnabled = () => enabled;
export const soundVolume = () => volume;

/** Громкость 0..1 (сохраняется между сессиями). */
export function setSoundVolume(v: number) {
  volume = Math.min(1, Math.max(0, v));
  try {
    localStorage.setItem(VOL_KEY, String(volume));
  } catch {
    /* storage unavailable — keep the setting for this session only */
  }
  applyLevel();
  for (const l of listeners) l();
}
export function onSoundChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* storage unavailable — keep the setting for this session only */
  }
  applyLevel();
  for (const l of listeners) l();
}

async function load(name: string) {
  if (!ctx || buffers.has(name)) return;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}sfx/${name}.mp3`);
    buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
  } catch {
    /* a missing sound must not break the game */
  }
}

/** Play a sound. volume multiplies the base volume. */
export function sfx(name: Sfx, opts: { volume?: number; delay?: number; rate?: number } = {}) {
  if (!ctx || !master || !enabled || volume === 0) return;
  const now = performance.now();
  const gap = MIN_GAP_MS[name];
  if (gap && now - (lastPlayed.get(name) ?? 0) < gap) return;
  lastPlayed.set(name, now);
  const entry = BANK[name];
  const prev = lastVariant.get(name);
  // a different file than last time (if there are several) …
  const pool = entry.files.length > 1 ? entry.files.filter((f) => f !== prev?.file) : entry.files;
  const file = pool[Math.floor(Math.random() * pool.length)];
  const buf = buffers.get(file);
  if (!buf) return;
  // … and a noticeably different pitch, so repeated clicks don't sound identical
  const spread = entry.spread ?? 0.12;
  let rate = 1 - spread / 2 + Math.random() * spread;
  if (prev && Math.abs(rate - prev.rate) < spread / 4) rate = rate > 1 ? rate - spread / 3 : rate + spread / 3;
  lastVariant.set(name, { file, rate });
  if (opts.rate) rate *= opts.rate;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = entry.vol * (opts.volume ?? 1);
  src.connect(g).connect(sfxBus ?? master);
  src.start(ctx.currentTime + (opts.delay ?? 0));
}

// ---------- background: synthesized city hum ----------

function startAmbience(c: AudioContext, out: AudioNode) {
  const bus = c.createGain();
  bus.gain.value = 0;
  bus.gain.setTargetAtTime(1, c.currentTime, 2); // slow fade-in
  bus.connect(out);

  // Low drone: two slightly detuned saws through a "breathing" filter
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 160;
  filter.Q.value = 6;
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.06;
  const lfoDepth = c.createGain();
  lfoDepth.gain.value = 70;
  lfo.connect(lfoDepth).connect(filter.frequency);
  lfo.start();
  const droneGain = c.createGain();
  droneGain.gain.value = 0.045;
  for (const f of [55, 55.35, 82.4]) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.connect(filter);
    o.start();
  }
  filter.connect(droneGain).connect(bus);

  // Neon-tube hiss/crackle: filtered noise. The loop is 8 s and its ends are cross-faded into each other,
  // otherwise the jump at the loop seam is heard as a click every couple of seconds.
  const len = c.sampleRate * 8;
  const fade = Math.floor(c.sampleRate * 0.25);
  const raw = new Float32Array(len + fade);
  for (let i = 0; i < raw.length; i++) raw[i] = (Math.random() * 2 - 1) * (Math.random() < 0.0006 ? 0.55 : 0.25);
  const noise = c.createBuffer(1, len, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < len; i++) {
    if (i < fade) {
      const k = i / fade;
      d[i] = raw[i] * k + raw[len + i] * (1 - k); // the tail flows into the head
    } else d[i] = raw[i];
  }
  const ns = c.createBufferSource();
  ns.buffer = noise;
  ns.loop = true;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 2400;
  band.Q.value = 0.8;
  const nGain = c.createGain();
  nGain.gain.value = 0.012;
  ns.connect(band).connect(nGain).connect(bus);
  ns.start();
}

/** Starts the engine on the first user gesture. Call once at app start. */
export function initAudio() {
  const start = () => {
    window.removeEventListener('pointerdown', start);
    window.removeEventListener('keydown', start);
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = masterLevel();
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_LEVEL;
    sfxBus.connect(master);
    for (const e of Object.values(BANK)) for (const f of e.files) void load(f);
    startAmbience(ctx, master);
    // Pause the sound while the tab is in the background
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      if (document.hidden) void ctx.suspend();
      else void ctx.resume();
    });
  };
  window.addEventListener('pointerdown', start);
  window.addEventListener('keydown', start);

  // Interface sounds for all buttons: data-sfx="tab|buy|sell|none" overrides the default click
  document.addEventListener('pointerdown', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || b.disabled) return;
    const kind = b.dataset.sfx;
    if (kind === 'none') return;
    const map: Record<string, Sfx> = {
      tab: 'ui-tab',
      toggle: 'ui-toggle',
      open: 'ui-open',
      close: 'ui-close',
      sort: 'ui-sort',
      select: 'ui-select',
    };
    sfx(map[kind ?? ''] ?? 'ui-click');
  });
  document.addEventListener('pointerover', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    const from = (e.relatedTarget as HTMLElement | null)?.closest?.('button');
    if (b && b !== from && !b.disabled) sfx('ui-hover');
  });
}

// ---------- loading screen sounds (synthesized: old TV + old PC) ----------

/** Short synthesized sounds for the boot screen. No files — generated on the fly. */
export function bootSound(kind: 'power-on' | 'beep' | 'tick' | 'ok' | 'power-off') {
  if (!ctx || !master || !enabled || volume === 0) return;
  const c = ctx;
  const t = c.currentTime;
  const out = c.createGain();
  out.connect(sfxBus ?? master);
  const env = (g: GainNode, peak: number, attack: number, decay: number, start = t) => {
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
  };
  const noiseBuf = (sec: number) => {
    const b = c.createBuffer(1, Math.floor(c.sampleRate * sec), c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  };
  if (kind === 'power-on') {
    // low "thump" of the tube + static burst + the thin flyback whine fading out
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    const g = c.createGain();
    env(g, 0.9, 0.01, 0.45);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.5);
    const n = c.createBufferSource();
    n.buffer = noiseBuf(0.5);
    const nf = c.createBiquadFilter();
    nf.type = 'highpass';
    nf.frequency.value = 1500;
    const ng = c.createGain();
    env(ng, 0.35, 0.005, 0.4);
    n.connect(nf).connect(ng).connect(out);
    n.start(t);
    const w = c.createOscillator();
    w.type = 'sine';
    w.frequency.value = 12000;
    const wg = c.createGain();
    env(wg, 0.035, 0.05, 1.6, t + 0.05);
    w.connect(wg).connect(out);
    w.start(t);
    w.stop(t + 1.8);
  } else if (kind === 'beep') {
    // the classic BIOS POST beep
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.value = 880;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.005);
    g.gain.setValueAtTime(0.12, t + 0.13);
    g.gain.linearRampToValueAtTime(0.0001, t + 0.15);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3000;
    o.connect(f).connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.16);
  } else if (kind === 'tick') {
    // a disk/relay click
    const n = c.createBufferSource();
    n.buffer = noiseBuf(0.03);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2500 + Math.random() * 1500;
    f.Q.value = 2;
    const g = c.createGain();
    env(g, 0.35, 0.001, 0.025);
    n.connect(f).connect(g).connect(out);
    n.start(t);
  } else if (kind === 'ok') {
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1180 + Math.random() * 120, t);
    const g = c.createGain();
    env(g, 0.09, 0.004, 0.06);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.08);
  } else {
    // power-off: the picture collapses with a falling "zap"
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.28);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2200;
    const g = c.createGain();
    env(g, 0.12, 0.005, 0.3);
    o.connect(f).connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.32);
  }
}

/** Is the audio engine running yet (it starts on the first click/keypress). */
export const audioReady = () => !!ctx;
