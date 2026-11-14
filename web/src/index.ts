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

interface Env {
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
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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
    await acc.signAndSendTransaction({
      receiverId: existing,
      actions: [actions.addFunctionCallAccessKey(gameKey, CONTRACT_ID, GAME_METHODS, GAME_KEY_ALLOWANCE)],
    });
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
