// HEAT INDEX public site: static assets (the game) + one API route for the email login on the public site.
//
// POST /api/privy/login  (Authorization: Bearer <Privy access token>, body { name, gameKey })
//  1. verifies the Privy login (email + one-time code) against Privy's public keys — no Privy secret here;
//  2. derives this player's owner key from their Privy user id and OWNER_SECRET (HMAC → ed25519 seed), so the same
//     email always maps to the same NEAR account and nothing has to be stored;
//  3. first login: asks the game contract to create `<name>.heat-index-game.testnet` owned by that key, with the
//     browser's limited game key (RELAYER_KEY is a function-call key of the contract account that can only call
//     `create_player_account`); later logins / new devices: adds the browser's new game key to the existing
//     account, signed with the owner key.
// Custodial by design (like most email-login games): the server can re-derive the owner key. Testnet only.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions, baseEncode } from 'near-api-js';
import { ed25519 } from '@noble/curves/ed25519.js';

export { SharedWorld } from './world';

interface Env {
  /** the shared world (one Durable Object) */
  WORLD: DurableObjectNamespace;
  /** battle action logs, by their SHA-256 (POST/GET /api/battles) */
  BATTLES: KVNamespace;
  PRIVY_APP_ID: string;
  RELAYER_KEY: string;
  OWNER_SECRET: string;
}

const CONTRACT_ID = 'heat-index-game.testnet';
const RPC_URL = 'https://test.rpc.fastnear.com';
const GAME_METHODS = ['register', 'buy_robot', 'sell_robot', 'repair_robot', 'record_battle'];
const GAME_KEY_ALLOWANCE = 120_000_000_000_000_000_000_000n; // 0.12 NEAR, as the contract gives a new account
const SITE_ORIGINS = ['https://heat-index-web.ginger-box.workers.dev', 'http://localhost:3000'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' } });

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** The Privy user id (did:privy:…) of a valid access token, or null. */
async function privyUser(token: string, appId: string): Promise<string | null> {
  jwks ??= createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: 'privy.io', audience: appId });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** The player's owner key: an ed25519 key whose seed is HMAC-SHA256(OWNER_SECRET, Privy user id). */
async function ownerKeyOf(userId: string, secret: string): Promise<KeyPair> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const seed = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`heat-index-owner:${userId}`)));
  const pub = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed);
  full.set(pub, 32);
  return KeyPair.fromString(`ed25519:${baseEncode(full)}`);
}

const accountName = (name: string) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 20) || 'player';

async function login(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  // only the game itself (a JSON content type forces a CORS preflight that other sites can't pass)
  const origin = req.headers.get('origin') ?? '';
  if (!SITE_ORIGINS.includes(origin) || !(req.headers.get('content-type') ?? '').startsWith('application/json'))
    return json({ error: 'Forbidden' }, 403);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const userId = token && (await privyUser(token, env.PRIVY_APP_ID));
  if (!userId) return json({ error: 'The email login could not be verified — please sign in again' }, 401);

  const body = (await req.json().catch(() => ({}))) as { name?: string; gameKey?: string };
  let gameKey: PublicKey;
  try {
    gameKey = PublicKey.fromString(String(body.gameKey));
  } catch {
    return json({ error: 'Bad game key' }, 400);
  }

  const provider = new JsonRpcProvider({ url: RPC_URL });
  const owner = await ownerKeyOf(userId, env.OWNER_SECRET);
  const ownerPub = owner.getPublicKey().toString();
  const existing = (await provider.callFunction({
    contractId: CONTRACT_ID,
    method: 'account_for_owner_key',
    args: { owner_key: ownerPub },
  })) as string | null;

  if (existing) {
    // returning player (another device, or a cleared browser): add this browser's game key to their account
    const acc = new Account(existing, provider, owner.toString() as `ed25519:${string}`);
    try {
      await acc.signAndSendTransaction({
        receiverId: existing,
        actions: [actions.addFunctionCallAccessKey(gameKey, CONTRACT_ID, GAME_METHODS, GAME_KEY_ALLOWANCE)],
      });
    } catch (e) {
      // the player took custody of the account: this server holds no key to it any more
      if (/does not exist|AccessKeyNotFound|InvalidAccessKey/i.test(e instanceof Error ? e.message : String(e)))
        return json({ error: `${existing} is self-custodied: you hold its key now. Sign in with "Connect NEAR wallet" (import your key into a NEAR wallet).` }, 409);
      throw e;
    }
    return json({ accountId: existing, returning: true });
  }

  // first login: the first free name (name, name-2, name-3…)
  const exists = async (id: string) => {
    try {
      await provider.query({ request_type: 'view_account', finality: 'final', account_id: id });
      return true;
    } catch {
      return false;
    }
  };
  const base = accountName(body.name ?? 'player');
  let name = base;
  for (let i = 2; (await exists(`${name}.${CONTRACT_ID}`)) && i < 50; i++) name = `${base}-${i}`;
  const relayer = new Account(CONTRACT_ID, provider, env.RELAYER_KEY as `ed25519:${string}`);
  const accountId = await relayer.callFunction({
    contractId: CONTRACT_ID,
    methodName: 'create_player_account',
    args: { name, owner_key: ownerPub, game_key: gameKey.toString() },
    gas: 150_000_000_000_000n,
  });
  if (!accountId) return json({ error: 'The account was not created — please try again' }, 500);
  return json({ accountId, returning: false });
}

/**
 * Self-custody: the player takes their account over. Their browser made a new key (and showed it to them); this adds
 * it as a full-access key and deletes the key this server derives from their email login — from then on only the
 * player can act for the account (the server can't, and email login no longer opens it: they sign in with a wallet).
 */
async function custody(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const origin = req.headers.get('origin') ?? '';
  if (!SITE_ORIGINS.includes(origin) || !(req.headers.get('content-type') ?? '').startsWith('application/json'))
    return json({ error: 'Forbidden' }, 403);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const userId = token && (await privyUser(token, env.PRIVY_APP_ID));
  if (!userId) return json({ error: 'The email login could not be verified — please sign in again' }, 401);
  const body = (await req.json().catch(() => ({}))) as { newKey?: string };
  let newKey: PublicKey;
  try {
    newKey = PublicKey.fromString(String(body.newKey));
  } catch {
    return json({ error: 'Bad key' }, 400);
  }
  const provider = new JsonRpcProvider({ url: RPC_URL });
  const owner = await ownerKeyOf(userId, env.OWNER_SECRET);
  const ownerPub = owner.getPublicKey();
  const accountId = (await provider.callFunction({ contractId: CONTRACT_ID, method: 'account_for_owner_key', args: { owner_key: ownerPub.toString() } })) as string | null;
  if (!accountId) return json({ error: 'No account for this login' }, 404);
  const acc = new Account(accountId, provider, owner.toString() as `ed25519:${string}`);
  // one transaction: the player's key in, the server's key out
  await acc.signAndSendTransaction({ receiverId: accountId, actions: [actions.addFullAccessKey(newKey), actions.deleteKey(ownerPub)] });
  return json({ accountId, selfCustody: true });
}

const MAX_LOG = 256 * 1024;
const cors = (origin: string | null): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin && SITE_ORIGINS.includes(origin) ? origin : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Battle replays. POST stores a battle's action log under its SHA-256 (content-addressed, so nobody can change a
 * stored log); the same hash goes on-chain with the battle result. GET returns it for `npm run verify-battle`.
 */
async function battles(req: Request, env: Env, path: string): Promise<Response> {
  const h = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: h });
  if (req.method === 'POST' && path === '/api/battles') {
    const text = await req.text();
    if (text.length > MAX_LOG) return new Response('Log too big', { status: 413, headers: h });
    try {
      const log = JSON.parse(text) as { v?: number; input?: { seed?: number }; actions?: unknown[] };
      if (log.v !== 1 || typeof log.input?.seed !== 'number' || !Array.isArray(log.actions)) throw new Error();
    } catch {
      return new Response('Not a battle log', { status: 400, headers: h });
    }
    const hash = await sha256Hex(text);
    await env.BATTLES.put(hash, text);
    return new Response(JSON.stringify({ hash }), { headers: { ...h, 'Content-Type': 'application/json' } });
  }
  const m = path.match(/^\/api\/battles\/([0-9a-f]{64})$/);
  if (req.method === 'GET' && m) {
    const text = await env.BATTLES.get(m[1]);
    if (!text) return new Response('No such battle log', { status: 404, headers: h });
    return new Response(text, { headers: { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }
  return new Response('Not found', { status: 404, headers: h });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/battles')) return battles(req, env, url.pathname);
    if (url.pathname.startsWith('/api/world/')) {
      const origin = req.headers.get('origin');
      const h = { ...cors(origin), 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
      if (req.method === 'OPTIONS') return new Response(null, { headers: h });
      if (origin && !SITE_ORIGINS.includes(origin)) return new Response('Forbidden', { status: 403, headers: h });
      const res = await env.WORLD.get(env.WORLD.idFromName('main')).fetch(req);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
      return out;
    }
    if (url.pathname === '/api/privy/custody') {
      try {
        return await custody(req, env);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message.slice(0, 300) : 'Failed' }, 500);
      }
    }
    if (url.pathname === '/api/privy/login') {
      try {
        return await login(req, env);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message.slice(0, 300) : 'Login failed' }, 500);
      }
    }
    return json({ error: 'Not found' }, 404);
  },
};
