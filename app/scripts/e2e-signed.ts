// End-to-end check of signed moves against the live site and testnet, with a test account whose full-access key is
// in the local near CLI credentials (TESTER, default tester.heat-index-game.testnet):
// a fresh game key (limited to `register`) enrols → joins the shared world → buys a robot with a signed move →
// the purchase is on-chain; then a move signed for a lower price is refused by the contract. At the end the test
// account leaves the shared world again (it never stays in the rankings).
// Run: npx tsx scripts/e2e-signed.ts
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js';
import { quote, type World } from '../src/engine/world';

const SITE = 'https://heat-index-web.ginger-box.workers.dev';
const C = 'heat-index-game.testnet';
const ME = process.env.TESTER ?? `tester.${C}`;
const rpc = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const full = new Account(ME, rpc, JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${ME}.json`), 'utf8')).private_key);
const view = <T>(method: string, args: Record<string, unknown>) => rpc.callFunction({ contractId: C, method, args }) as Promise<T>;

const game = KeyPair.fromRandom('ed25519');
const pub = game.getPublicKey().toString();
await full.addFunctionCallAccessKey({ publicKey: pub, contractId: C, methodNames: ['register'], allowance: 100_000_000_000_000_000_000_000n });
const g = new Account(ME, rpc, game.toString() as `ed25519:${string}`);
await g.callFunction({ contractId: C, methodName: 'register', args: {}, gas: 30_000_000_000_000n });
const keys = await view<string[]>('signing_keys_of', { account_id: ME });
console.log(keys.includes(pub) ? '✓ the game key enrolled through register' : '✗ not enrolled');

const ts = String(Date.now());
const authSig = game.sign(new TextEncoder().encode(`heat-index-world:${ME}:${ts}`)).signature;
const auth = await fetch(`${SITE}/api/world/auth`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ accountId: ME, publicKey: pub, ts, signature: btoa(String.fromCharCode(...authSig)), name: 'tester' }),
}).then((r) => r.json() as Promise<{ token?: string; error?: string }>);
if (!auth.token) throw new Error(`auth: ${auth.error}`);
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` };
const st = (await fetch(`${SITE}/api/world/state`, { headers: H }).then((r) => r.json())) as { world: World };
const w = st.world;
let seq = 0;
const sign = (op: Record<string, unknown>) => {
  const at = Date.now();
  const message = JSON.stringify({ v: 1, account: ME, nonce: at * 1000 + seq++, at, ...op });
  const s = game.sign(new TextEncoder().encode(message)).signature;
  return { message, signature: [...s].map((b) => b.toString(16).padStart(2, '0')).join(''), publicKey: pub };
};
// the cheapest robot a broker has in stock
const offers = w.brokers
  .filter((b) => !b.closed)
  .flatMap((b) => Object.values(w.robots).filter((r) => r.owner === b.id && r.durability > 0).map((r) => ({ b, modelId: r.modelId, ask: quote(w, b, r.modelId).ask })))
  .sort((x, y) => x.ask - y.ask);
const o = offers[0];
const before = (await view<unknown[]>('mt_tokens_for_owner', { account_id: ME, limit: 200 })).length;
// a signature for less than the price → the contract refuses (the world rolls the move back)
const low = await fetch(`${SITE}/api/world/op`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: 'buy', args: [o.b.id, o.modelId], sig: sign({ op: 'buy', model: o.modelId, broker: o.b.id, max_price: String(Math.floor(o.ask / 2)) }) }),
}).then((r) => r.json() as Promise<{ error?: string }>);
console.log(low.error?.includes('signed') || low.error?.includes('NEAR refused') ? `✓ a move signed for less is refused: ${low.error?.slice(0, 90)}` : `✗ ${JSON.stringify(low)}`);
const ok = await fetch(`${SITE}/api/world/op`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: 'buy', args: [o.b.id, o.modelId], sig: sign({ op: 'buy', model: o.modelId, broker: o.b.id, max_price: String(Math.ceil(o.ask * 1.05) + 1) }) }),
}).then((r) => r.json() as Promise<{ error?: string; tx?: { label: string; hash?: string } }>);
const after = (await view<unknown[]>('mt_tokens_for_owner', { account_id: ME, limit: 200 })).length;
console.log(ok.tx?.hash && after === before + 1 ? `✓ signed buy recorded: ${ok.tx.label} — tx ${ok.tx.hash}` : `✗ ${JSON.stringify(ok)} (${before} → ${after})`);
// without a signature the move doesn't reach the chain
const none = await fetch(`${SITE}/api/world/op`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'buy', args: [o.b.id, o.modelId] }) }).then((r) => r.json() as Promise<{ error?: string }>);
console.log(none.error ? `✓ an unsigned move is refused: ${none.error.slice(0, 80)}` : '✗ an unsigned move went through');
await full.deleteKey(pub);
// the test account leaves the shared world again — it must not show up in any ranking
const secrets = JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'heat-index-web', 'secrets.json'), 'utf8'));
const leaveToken = createHmac('sha256', secrets.OWNER_SECRET).update('leave').digest('hex');
const left = await fetch(`${SITE}/api/world/leave`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leaveToken}` },
  body: JSON.stringify({ accountId: ME }),
}).then((r) => r.json() as Promise<{ error?: string | null }>);
console.log(left.error ? `✗ the test account didn't leave: ${left.error}` : '✓ the test account left the shared world (no ranking shows it)');
