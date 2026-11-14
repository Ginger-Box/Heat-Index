// Client-side world store: one World object + a version counter to re-render React.
// The player's trades and battles are mirrored on NEAR by src/near/bridge.ts.
import { startTransition, useEffect, useReducer } from 'react';
import { sfx } from './audio';
import { BROKER_RANGE, BROKER_TAGLINE, createWorld, ensureDecks, migrateLeague, type World } from './engine/world';

const KEY = 'neon-pit-world-v5'; // v5: decks of 10–15 robots, 5 board slots (v4: new economy)
const NAME_KEY = 'neon-pit-player';

let world: World | null = null;
let version = 0;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): World | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? migrate(JSON.parse(raw) as World) : null;
  } catch {
    return null;
  }
}

/** Bring an old save up to date with settings that changed after balancing. */
function migrate(w: World): World {
  // player decks (added after v5 started): the current team becomes deck 1
  const me = w.managers.find((m) => m.id === 'player');
  if (me) ensureDecks(me);
  // the Pit League (added after v5): NPC teams get their divisions, the player starts in the Scrap League
  migrateLeague(w);
  for (const b of w.brokers) {
    if (b.id === 'kessler') b.style.targetStock = 3;
    if (b.id === 'soroka') b.style.spread = 0.08;
    // broker segments (added Nov 14): Kessler energy 3–6, the Junkman 1–3, Magpie everything
    const range = BROKER_RANGE[b.id];
    if (range) [b.style.minCost, b.style.maxCost] = range;
    if (BROKER_TAGLINE[b.id]) b.tagline = BROKER_TAGLINE[b.id];
  }
  return w;
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (world) localStorage.setItem(KEY, JSON.stringify(world));
    } catch {
      /* storage unavailable — play without saving */
    }
  }, 500);
}

export function getPlayerName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function startGame(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
  world = load() ?? createWorld(Date.now() % 2 ** 31, name);
  notify();
}

export function resetGame() {
  if (saveTimer) {
    clearTimeout(saveTimer); // a pending save would write the old world back
    saveTimer = null;
  }
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(NAME_KEY);
    localStorage.removeItem('heat-index-tutorial'); // starting over replays the training
  } catch {
    /* ignore */
  }
  world = null;
  notify();
}

export function getWorld(): World | null {
  if (!world && getPlayerName()) world = load();
  return world;
}

/** Change the world and re-render. The function returns an error text or null. */
export function act(fn: (w: World) => string | null | void): string | null {
  const w = getWorld();
  if (!w) return 'World is not loaded';
  const res = fn(w) ?? null;
  if (res) sfx('ui-error');
  notify();
  return res;
}

export function notify(background = false) {
  version++;
  save();
  // Background changes (NPC battles, fast-forward) render at low priority: React splits the work
  // and yields to input — the cursor and clicks never lag. Player actions render right away.
  if (background) startTransition(() => listeners.forEach((l) => l()));
  else for (const l of listeners) l();
}

/** Like act(), but for background world updates (live world, fast-forward). */
export function actBackground(fn: (w: World) => void) {
  const w = getWorld();
  if (!w) return;
  fn(w);
  notify(true);
}

export function useWorld(): World | null {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return getWorld();
}

export const worldVersion = () => version;
