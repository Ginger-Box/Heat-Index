// Client-side world store: one World object + a version counter to re-render React.
// The player's trades and battles are mirrored on NEAR by src/near/bridge.ts.
import { startTransition, useEffect, useReducer } from 'react';
import { sfx } from './audio';
import { KeyPair } from 'near-api-js';
import type { Action, BattleEvent, BattleState } from './engine/battle';
import { BROKER_RANGE, BROKER_TAGLINE, createWorld, ensureDecks, migrateLeague, playerHooks, type World } from './engine/world';
import { addServerTx, chainCall, chainSession, view } from './near/chain';
import { logText, sha256Hex, type BattleLog } from './engine/replay';
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
  const out = (await res.json()) as {
    version: number;
    startMs: number;
    world: World;
    me?: { team: string[]; decks?: World['managers'][number]['decks']; activeDeck?: number };
  };
  if (!shared || (!force && shared.pending > 0)) return;
  shared.version = out.version;
  shared.startMs = out.startMs;
  // other players' decks never come to the browser (Online is blind); our own come separately
  const me = out.world.managers.find((m) => m.id === 'player');
  if (me && out.me) Object.assign(me, out.me);
  world = migrate(out.world);
  notify(true);
}

// ---------- signed moves: the player's own key authorises every move recorded for them on NEAR ----------

let moveSeq = 0;
/** Signs a move with this browser's game key (contract: signed_move checks it — the server only relays it). */
export function signMove(op: Record<string, unknown>): { message: string; signature: string; publicKey: string } | null {
  const s = chainSession();
  if (!s) return null;
  const kp = KeyPair.fromString(s.gameKey as `ed25519:${string}`);
  const at = Date.now();
  const message = JSON.stringify({ v: 1, account: s.accountId, nonce: at * 1000 + (moveSeq++ % 1000), at, ...op });
  const sig = kp.sign(new TextEncoder().encode(message)).signature;
  return { message, signature: [...sig].map((b) => b.toString(16).padStart(2, '0')).join(''), publicKey: kp.getPublicKey().toString() };
}

/** This device's key must be enrolled once (it calls `register`, the one method a game key may call). */
let enrolled: Promise<void> | null = null;
function ensureEnrolled(): Promise<void> {
  const s = chainSession();
  if (!s) return Promise.resolve();
  enrolled ??= (async () => {
    const pub = KeyPair.fromString(s.gameKey as `ed25519:${string}`).getPublicKey().toString();
    const keys = await view<string[]>('signing_keys_of', { account_id: s.accountId }).catch(() => [] as string[]);
    if (!keys.includes(pub)) await chainCall('Enrol this device for signed moves', 'register', {});
  })().catch(() => {
    enrolled = null;
  });
  return enrolled;
}

/** What the player agrees to for a move (bounds the server can't exceed), read from the local world right after it. */
async function moveOf(name: string, args: unknown[]): Promise<Record<string, unknown> | null> {
  const w = world;
  if (!w) return null;
  const tail = [...w.ledger].reverse();
  const a = args as string[];
  switch (name) {
    case 'buy': {
      const e = tail.find((x) => x.kind === 'buy' && x.from === 'player');
      return e ? { op: 'buy', model: a[1], broker: a[0], max_price: String(Math.ceil(e.amount * 1.05) + 1) } : null;
    }
    case 'sell': {
      const e = tail.find((x) => (x.kind === 'sell' || x.kind === 'scrap') && x.to === 'player');
      return e && a[2] ? { op: 'sell', token: a[2], broker: e.from, min_price: String(Math.floor(e.amount * 0.95)) } : null;
    }
    case 'repair': {
      const e = tail.find((x) => x.kind === 'repair' && x.from === 'player');
      const r = w.robots[a[0]];
      return e && r?.chainId ? { op: 'repair', token: r.chainId, max_cost: String(Math.ceil(e.amount * 1.05) + 1) } : null;
    }
    case 'list':
      return w.robots[a[0]]?.chainId ? { op: 'list', token: w.robots[a[0]].chainId, price: String(Math.round(Number(args[1]))) } : null;
    case 'unlist':
      return w.robots[a[0]]?.chainId ? { op: 'unlist', token: w.robots[a[0]].chainId } : null;
    case 'buyListing': {
      const r = w.robots[a[0]];
      return r?.chainId ? { op: 'buy_listing', token: r.chainId, max_price: String(r.paid ?? 0) } : null;
    }
    case 'match': {
      if (args[2] === 'ranked') return null;
      const opp = w.managers.find((m) => m.id === a[0]);
      return { op: 'battle', log_sha256: await sha256Hex(logText(args[1] as BattleLog)), opponent: opp?.name ?? a[0] };
    }
    default:
      return null;
  }
}

/** Send one of the player's moves to the shared world (playerHooks.op — the engine calls it for every move).
 *  Moves go in order; each chain-recorded one carries the player's signature. */
let opQueue: Promise<unknown> = Promise.resolve();
function sendOp(name: string, args: unknown[]) {
  if (!shared) return;
  shared.pending++;
  const token = shared.token;
  const move = moveOf(name, args); // read the local world now, before the next move changes it
  opQueue = opQueue.then(() => sendOne(name, args, token, move));
}
async function sendOne(name: string, args: unknown[], token: string, movePromise: Promise<Record<string, unknown> | null>) {
  const move = await movePromise.catch(() => null);
  if (move) await ensureEnrolled();
  const sig = move ? signMove(move) : null;
  return fetch(`${WORLD_API}/op`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, args, sig }),
  })
    .then((r) => r.json())
    .then((out: { error?: string | null; tx?: { label: string; hash?: string } | null }) => {
      if (out.error) serverNote = { text: `Shared world: ${out.error}`, at: Date.now() };
      // the server recorded the move on NEAR (it is the only writer of trades and battles)
      if (out.tx) addServerTx(out.tx.label, out.tx.hash);
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

// ---------- online battles (run by the shared world's server) ----------

async function pvpCall<T>(path: string, body: unknown): Promise<T> {
  if (!shared) throw new Error('Log in to play online');
  const res = await fetch(`${WORLD_API}/pvp/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shared.token}` },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || out.error) throw new Error(out.error ?? `Online battle: ${res.status}`);
  return out;
}
export const pvpStart = async () => {
  // the player consents to the online battle with their signature; the contract then draws the deal's seed
  await ensureEnrolled();
  return pvpCall<{ view: BattleState; oppId: string; opp: { name: string; elo: number; human: boolean } }>('start', { sig: signMove({ op: 'open_battle' }) });
};
export const pvpAct = (action: Action) =>
  pvpCall<{
    steps: { action: Action; ev: BattleEvent[]; view: BattleState }[];
    result: { reward: number; tx: { label: string; hash?: string } | null; txError?: string } | null;
  }>('act', { action });
/** after an online battle: show the chain record and fetch the world the server just updated */
export async function pvpFinished(tx: { label: string; hash?: string } | null, txError?: string) {
  if (tx) addServerTx(tx.label, tx.hash);
  else if (txError) addServerTx('Online battle', undefined, txError);
  await pull(true).catch(() => {});
}

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
