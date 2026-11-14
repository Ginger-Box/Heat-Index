// Client-side world store: one World object + a version counter to re-render React.
// The player's trades and battles are mirrored on NEAR by src/near/bridge.ts.
import { startTransition, useEffect, useReducer } from 'react';
import { sfx } from './audio';
import { KeyPair } from 'near-api-js';
import { BROKER_RANGE, BROKER_TAGLINE, createWorld, ensureDecks, migrateLeague, playerHooks, type World } from './engine/world';
import { chainSession } from './near/chain';
import { PUBLIC_ORIGIN } from './near/config';

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

// ---------- the shared world (logged-in players) ----------
// Guests play a local world (this browser: pause, fast-forward, their own timeline). A player logged in with
// email or a wallet plays the one shared world run by the game's server (web/src/world.ts): every move is applied
// here at once (so the game stays snappy) and sent to the server, which replays it on the shared world; the
// server's world then replaces the local copy (every 10 s, and after each move).

let mode: 'local' | 'shared' = 'local';
export const isShared = () => mode === 'shared';
const WORLD_API = `${typeof location !== 'undefined' && location.origin === PUBLIC_ORIGIN ? '' : PUBLIC_ORIGIN}/api/world`;
let shared: { token: string; version: number; poll: ReturnType<typeof setInterval> | null; pending: number; startMs: number } | null = null;
let sharedName = '';
let serverNote: { text: string; at: number } | null = null;
export const sharedInfo = () => (shared ? { startMs: shared.startMs, version: shared.version } : null);
export const lastServerNote = () => (serverNote && Date.now() - serverNote.at < 6000 ? serverNote.text : null);

/** Log in to the shared world with the NEAR session's game key and load it. */
export async function startShared(name: string) {
  const s = chainSession();
  if (!s) throw new Error('Not logged in');
  const kp = KeyPair.fromString(s.gameKey as `ed25519:${string}`);
  const ts = String(Date.now());
  const sig = kp.sign(new TextEncoder().encode(`heat-index-world:${s.accountId}:${ts}`)).signature;
  const res = await fetch(`${WORLD_API}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: s.accountId,
      publicKey: kp.getPublicKey().toString(),
      ts,
      signature: btoa(String.fromCharCode(...sig)),
      name,
    }),
  });
  const out = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !out.token) throw new Error(out.error ?? 'Could not join the shared world');
  if (shared?.poll) clearInterval(shared.poll);
  sharedName = name;
  shared = { token: out.token, version: -1, poll: null, pending: 0, startMs: 0 };
  await pull(true);
  mode = 'shared';
  shared.poll = setInterval(() => void pull(false), 10_000);
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
  notify();
}

/** Fetch the shared world if it changed (not while our own moves are still on their way). */
async function pull(force: boolean) {
  if (!shared || (!force && shared.pending > 0)) return;
  const res = await fetch(`${WORLD_API}/state?since=${force ? -1 : shared.version}`, { headers: { Authorization: `Bearer ${shared.token}` } });
  if (res.status === 204) return;
  if (res.status === 401) {
    // the session expired or the shared world was restarted: log in again (rejoins from the chain)
    await startShared(sharedName).catch(() => {});
    return;
  }
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `World server: ${res.status}`);
  const out = (await res.json()) as { version: number; startMs: number; world: World };
  if (!shared || (!force && shared.pending > 0)) return;
  shared.version = out.version;
  shared.startMs = out.startMs;
  world = migrate(out.world);
  notify(true);
}

/** Send one of the player's moves to the shared world (playerHooks.op — the engine calls it for every move). */
function sendOp(name: string, args: unknown[]) {
  if (!shared) return;
  shared.pending++;
  const token = shared.token;
  void fetch(`${WORLD_API}/op`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, args }),
  })
    .then((r) => r.json())
    .then((out: { error?: string | null }) => {
      if (out.error) serverNote = { text: `Shared world: ${out.error}`, at: Date.now() };
    })
    .catch(() => (serverNote = { text: 'Shared world: the move did not reach the server', at: Date.now() }))
    .finally(() => {
      if (shared) shared.pending--;
      void pull(true).catch(() => {});
    });
}
playerHooks.op = (name, args) => {
  if (mode === 'shared') sendOp(name, args);
};

function leaveShared() {
  if (shared?.poll) clearInterval(shared.poll);
  shared = null;
  mode = 'local';
}

function save() {
  if (mode === 'shared') return; // the shared world lives on the server; the local save stays the guest's
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
  leaveShared();
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
  // a logged-in player gets the shared world (startShared), never this browser's guest save
  if (!world && mode === 'local' && !chainSession() && getPlayerName()) world = load();
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
