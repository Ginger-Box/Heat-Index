// HEAT INDEX ↔ NEAR: the player's on-chain session and the queue of game transactions.
//
// Two ways in:
//  • Email (NEAR Auth): log in with email/Google/passkey → the MPC network derives the player's own NEAR key →
//    the game contract creates `<name>.heat-index-game.testnet` owned by that key, plus a limited game key from
//    this browser (via the dev server, see vite.config.ts). Works on http://localhost:3000 (shared testnet app).
//  • Wallet (NEAR Connect): Meteor, Intear, MyNearWallet… — one approval adds the limited game key to the
//    player's existing testnet account.
// After that every game move (buy, sell, repair, battle result) is signed in the browser with the game key —
// no popups — and sent in order through a small queue. The game itself keeps running locally; the chain is its
// ledger (credits and robots as NEP-245 tokens, events for every trade and battle).

import { Buffer } from 'buffer';
import { Account, JsonRpcProvider, KeyPair, actions } from 'near-api-js';
import { CONTRACT_ID, EXPLORER, GAME_KEY_ALLOWANCE, GAME_METHODS, NEAR_AUTH, PRIVY_APP_ID, PUBLIC_ORIGIN, RPC_URL } from './config';

// near-api-js v5 inside the NEAR Auth SDK expects Node's Buffer
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

export interface ChainSession {
  accountId: string;
  /** secret of the limited game key (function calls to the game contract only) */
  gameKey: string;
  via: 'email' | 'wallet';
}
export interface ChainTx {
  id: number;
  label: string;
  status: 'pending' | 'ok' | 'error';
  hash?: string;
  error?: string;
  at: number;
}

const SESSION_KEY = 'heat-index-near-session';
const provider = new JsonRpcProvider({ url: RPC_URL });

let session: ChainSession | null = readSession();
let txs: ChainTx[] = [];
let txId = 0;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function readSession(): ChainSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as ChainSession) : null;
  } catch {
    return null;
  }
}
function saveSession(s: ChainSession | null) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
  emit();
}
const emit = () => listeners.forEach((f) => f());

export const chainSession = () => session;
export const chainTxs = () => txs;
export const onChain = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;
export const signOutChain = () => saveSession(null);

// ---------- reads ----------

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId: CONTRACT_ID, method, args })) as T;
}

export interface ChainRobot {
  token_id: string;
  owner_id: string;
  metadata: { model_id: string; durability: number; owner_id: string };
  /** veteran record (contract v0.4+) */
  record?: { battles: number; wins: number; rank: number } | null;
}
export async function chainRobots(accountId: string): Promise<ChainRobot[]> {
  const out: ChainRobot[] = [];
  for (let from = 0; ; from += 50) {
    const page = await view<ChainRobot[]>('mt_tokens_for_owner', { account_id: accountId, from_index: String(from), limit: 50 });
    out.push(...page);
    if (page.length < 50) return out;
  }
}
export const chainCredits = async (accountId: string) =>
  Number(await view<string>('mt_balance_of', { account_id: accountId, token_id: 'cr' }));

// ---------- writes: one queue, signed with the game key ----------

/** Send a game move to the contract. Never throws into the game: errors are shown in the chain log. */
/** A move the game server recorded on-chain for this player (shared world) — shown in the NEAR panel. */
export function addServerTx(label: string, hash?: string, error?: string) {
  const tx: ChainTx = { id: ++txId, label, status: error ? 'error' : 'ok', hash, error, at: Date.now() };
  txs = [tx, ...txs].slice(0, 30);
  emit();
}

/** Queues a game transaction. `args` may be a promise (e.g. waiting for a battle log upload) — the call keeps its
 *  place in the queue, so transactions always land in the order the player made the moves. */
export function chainCall<T = unknown>(
  label: string,
  method: string,
  args: Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<T | null> {
  const s = session;
  if (!s) return Promise.resolve(null);
  const tx: ChainTx = { id: ++txId, label, status: 'pending', at: Date.now() };
  txs = [tx, ...txs].slice(0, 30);
  emit();
  const run = async () => {
    try {
      const acc = new Account(s.accountId, provider, s.gameKey as `ed25519:${string}`);
      // 30 TGas: the heaviest call (record_battle) burns ~7; prepaid gas must be covered by the account balance
      const res = await acc.callFunctionRaw({ contractId: CONTRACT_ID, methodName: method, args: await args, gas: 30_000_000_000_000n });
      const status = res.status as { SuccessValue?: string; Failure?: unknown };
      tx.hash = res.transaction?.hash;
      if (status && typeof status === 'object' && 'Failure' in status) throw new Error(JSON.stringify(status.Failure).slice(0, 200));
      tx.status = 'ok';
      emit();
      const raw = status?.SuccessValue ? Buffer.from(status.SuccessValue, 'base64').toString() : '';
      return (raw ? JSON.parse(raw) : null) as T;
    } catch (e) {
      tx.status = 'error';
      tx.error = e instanceof Error ? e.message : String(e);
      emit();
      return null;
    }
  };
  const p = queue.then(run, run);
  queue = p;
  return p;
}

// ---------- login: email (NEAR Auth) ----------

export const emailLoginAvailable = () => location.origin === NEAR_AUTH.origin;
/** Which email login this page uses: NEAR Auth on localhost:3000, Privy on the public site, or none. */
export const emailLoginKind = (): 'nearauth' | 'privy' | null =>
  emailLoginAvailable() ? 'nearauth' : PRIVY_APP_ID && location.origin === PUBLIC_ORIGIN ? 'privy' : null;

/**
 * Public site, after Privy confirmed the email: the Worker checks the Privy token and creates the player's
 * `<name>.heat-index-game.testnet` (or, for a returning player, adds this browser's game key to it).
 */
export async function finishPrivyLogin(accessToken: string, playerName: string): Promise<string> {
  const game = KeyPair.fromRandom('ed25519');
  const res = await fetch('/api/privy/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name: accountName(playerName), gameKey: game.getPublicKey().toString() }),
  });
  const out = (await res.json().catch(() => ({}))) as { accountId?: string; error?: string };
  if (!res.ok || !out.accountId) throw new Error(out.error ?? 'Could not create the account');
  saveSession({ accountId: out.accountId, gameKey: game.toString(), via: 'email' });
  return out.accountId;
}

export async function nearAuthClient() {
  const [{ FastAuthClient }, { JavascriptProvider }] = await Promise.all([
    import('@fast-auth-near/browser-sdk'),
    import('@fast-auth-near/javascript-provider'),
  ]);
  const authProvider = new JavascriptProvider({ network: 'testnet', clientId: NEAR_AUTH.clientId });
  // the SDK only needs `provider.query` (view calls) from a near-api-js connection
  const connection = { provider } as unknown as ConstructorParameters<typeof FastAuthClient>[1];
  return new FastAuthClient(authProvider, connection, {
    fastAuthContractId: NEAR_AUTH.fastAuthContractId,
    mpcContractId: NEAR_AUTH.mpcContractId,
  });
}

/** Normalise a player name into a NEAR sub-account name. */
export const accountName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 24) || 'player';

const EMAIL_PENDING = 'heat-index-email-login';

/**
 * Email login: an Auth0 popup, or — where popups are blocked (e.g. the app's built-in browser) — a redirect to the
 * login page and back (the game then finishes in resumeEmailLogin on load). Returns the account id, or null when
 * the page is about to redirect. Throws a readable error on failure.
 */
export async function loginWithEmail(playerName: string): Promise<string | null> {
  if (!emailLoginAvailable()) throw new Error(`Email login works on ${NEAR_AUTH.origin} (testnet NEAR Auth)`);
  const client = await nearAuthClient();
  try {
    await client.login();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/popup/i.test(msg)) throw e;
    // no popups here: go to the login page and come back
    try {
      localStorage.setItem(EMAIL_PENDING, JSON.stringify({ name: playerName }));
    } catch {
      /* without storage the name falls back to "player" */
    }
    await client.login({ redirectUri: `${location.origin}/` });
    return null;
  }
  return finishEmailLogin(client, playerName);
}

/** Is the page coming back from the email login page? */
export const emailLoginPending = () => {
  try {
    return !!localStorage.getItem(EMAIL_PENDING) && new URLSearchParams(location.search).has('code');
  } catch {
    return false;
  }
};

let resuming: Promise<{ name: string; accountId: string } | null> | null = null;

/**
 * Back from the login page: finish the email login. Returns the player name and account, or null if not pending.
 * Runs once per page load even if called twice (React StrictMode runs effects twice in development — the second
 * call used to see the "pending" flag already cleared and show the login screen again). The Auth0 session lives
 * only in this page's memory, so the account has to be finished right here, on the page the login returned to.
 */
export function resumeEmailLogin(): Promise<{ name: string; accountId: string } | null> {
  resuming ??= (async () => {
    if (!emailLoginPending()) return null;
    let name = 'player';
    try {
      name = (JSON.parse(localStorage.getItem(EMAIL_PENDING) ?? '{}') as { name?: string }).name ?? name;
    } catch {
      /* ignore */
    }
    try {
      const client = await nearAuthClient();
      // the provider handles the ?code=&state= callback inside isLoggedIn()
      const provider = (client as unknown as { provider: { isLoggedIn: () => Promise<boolean> } }).provider;
      const ok = await provider.isLoggedIn();
      history.replaceState(null, '', location.pathname); // drop ?code=&state= from the address bar
      if (!ok) throw new Error('The email login did not complete — please try again');
      return { name, accountId: await finishEmailLogin(client, name) };
    } finally {
      try {
        localStorage.removeItem(EMAIL_PENDING);
      } catch {
        /* ignore */
      }
    }
  })();
  return resuming;
}

/** After Auth0: the player's NEAR Auth key → their account (created on first login). */
async function finishEmailLogin(client: Awaited<ReturnType<typeof nearAuthClient>>, playerName: string): Promise<string> {
  const signer = await client.getSigner();
  const ownerKey = String(await signer.getPublicKey());
  const existing = await view<string | null>('account_for_owner_key', { owner_key: ownerKey });
  if (existing) {
    // returning player: reuse this browser's game key if we have it
    const prev = readSession();
    if (prev?.accountId === existing) {
      saveSession(prev);
      return existing;
    }
    // this browser has no game key for that account (another device, or it was lost): the dev server gives
    // this login a fresh account below
  }
  const game = KeyPair.fromRandom('ed25519');
  const res = await fetch('/api/near/create-player', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: accountName(playerName), ownerKey, gameKey: game.getPublicKey().toString() }),
  });
  const out = (await res.json()) as { accountId?: string; error?: string };
  if (!res.ok || !out.accountId) throw new Error(out.error ?? 'Could not create the account');
  saveSession({ accountId: out.accountId, gameKey: game.toString(), via: 'email' });
  return out.accountId;
}

// ---------- login: wallet (NEAR Connect) ----------

/**
 * Wallet login: pick a wallet → approve ONE transaction that adds the limited game key and registers the
 * player (starter robots + credits are minted). Works on any origin.
 */
export async function loginWithWallet(): Promise<string> {
  const { NearConnector } = await import('@hot-labs/near-connect');
  const connector = new NearConnector({ network: 'testnet' });
  const wallet = await connector.connect();
  const [acc] = await wallet.getAccounts();
  if (!acc) throw new Error('No account selected');
  const accountId = acc.accountId;
  const game = KeyPair.fromRandom('ed25519');
  const registered = await view<unknown>('player_of', { account_id: accountId });
  await wallet.signAndSendTransaction({
    receiverId: accountId,
    actions: [actions.addFunctionCallAccessKey(game.getPublicKey(), CONTRACT_ID, GAME_METHODS, GAME_KEY_ALLOWANCE)],
  } as never);
  saveSession({ accountId, gameKey: game.toString(), via: 'wallet' });
  if (!registered) await chainCall('Join the arena', 'register', {});
  return accountId;
}
