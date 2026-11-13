// Sound engine (Web Audio API).
// Sound effects: Kenney.nl packs, CC0 license (see public/sfx/SOURCES.txt and SOUNDS.md).
// Background ambience is synthesized right here in code (drone + crackle), so it has no license at all.
// Browsers only allow sound after the first click/keypress — the engine starts on that gesture.

type Sfx =
  | 'ui-click'
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
  | 'card-drop';

// Sound -> files (variants are picked at random) and base volume
const BANK: Record<Sfx, { files: string[]; vol: number }> = {
  'ui-click': { files: ['ui-click'], vol: 0.5 },
  'ui-tab': { files: ['ui-tab'], vol: 0.35 },
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
export function sfx(name: Sfx, opts: { volume?: number; delay?: number } = {}) {
  if (!ctx || !master || !enabled || volume === 0) return;
  const now = performance.now();
  const gap = MIN_GAP_MS[name];
  if (gap && now - (lastPlayed.get(name) ?? 0) < gap) return;
  lastPlayed.set(name, now);
  const entry = BANK[name];
  const file = entry.files[Math.floor(Math.random() * entry.files.length)];
  const buf = buffers.get(file);
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.94 + Math.random() * 0.12; // so repeats don't sound identical
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

  // Neon-tube hiss/crackle: filtered noise
  const len = c.sampleRate * 2;
  const noise = c.createBuffer(1, len, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.002 ? 1 : 0.25);
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
    sfx(kind === 'tab' ? 'ui-tab' : 'ui-click');
  });
  document.addEventListener('pointerover', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    const from = (e.relatedTarget as HTMLElement | null)?.closest?.('button');
    if (b && b !== from && !b.disabled) sfx('ui-hover');
  });
}
