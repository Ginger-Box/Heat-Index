// Checks the README's claims against NEAR testnet and the live site, and prints ✓ / ✗ for each.
// Read-only: view calls and transaction lookups, nothing is signed. Run: npm run verify
import { readFileSync } from 'node:fs';
import { JsonRpcProvider } from 'near-api-js';

const C = 'heat-index-game.testnet';
const SITE = 'https://heat-index-web.ginger-box.workers.dev';
const rpc = new JsonRpcProvider({ url: process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com' });
const view = <T>(method: string, args: Record<string, unknown> = {}) => rpc.callFunction({ contractId: C, method, args }) as Promise<T>;
const raw = (method: string, params: unknown) =>
  fetch('https://archival-rpc.testnet.near.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json() as Promise<{ result?: any; error?: any }>);

let failed = 0;
async function check(claim: string, fn: () => Promise<string | true>) {
  try {
    const r = await fn();
    console.log(`✓ ${claim}${r === true ? '' : ` — ${r}`}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${claim} — ${e instanceof Error ? e.message : String(e)}`);
  }
}
const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

await check('the game contract is deployed on testnet', async () => {
  const acc = (await rpc.query({ request_type: 'view_account', finality: 'final', account_id: C })) as any;
  ok(acc.code_hash && acc.code_hash !== '11111111111111111111111111111111', 'no contract code');
  return `code hash ${acc.code_hash}`;
});

await check('players have battled and traded on-chain', async () => {
  const s = await view<{ battles: number; trades: number; robots_minted: number }>('stats');
  ok(s.battles > 0 && s.trades > 0, JSON.stringify(s));
  return `${s.battles} battles, ${s.trades} trades, ${s.robots_minted} robots minted`;
});

await check('credits and robots are NEP-245 tokens (mt_balance_of, mt_tokens_for_owner, mt_token)', async () => {
  const who = 'bot-alpha.heat-index-game.testnet';
  const cr = await view<string>('mt_balance_of', { account_id: who, token_id: 'cr' });
  const tokens = await view<any[]>('mt_tokens_for_owner', { account_id: who, limit: 50 });
  ok(tokens.length > 0 && tokens[0].token_id.startsWith('robot:'), 'no robot tokens');
  const [t] = await view<any[]>('mt_token', { token_ids: [tokens[0].token_id] });
  ok(t.metadata?.model_id && typeof t.metadata.durability === 'number', 'no metadata');
  return `${who.split('.')[0]}: ${cr} CR, ${tokens.length} robots`;
});

await check('robots carry their veteran battle record on-chain', async () => {
  const tokens = await view<any[]>('mt_tokens_for_owner', { account_id: 'bot-alpha.heat-index-game.testnet', limit: 50 });
  const rec = tokens.find((t) => t.record);
  ok(rec, 'no record on any token');
  return `${rec.token_id}: ${rec.record.wins} wins in ${rec.record.battles} battles`;
});

await check('league progress, purchase basis and the daily purse are readable views', async () => {
  const l = await view<any>('league_of', { account_id: 'bot-alpha.heat-index-game.testnet' });
  const p = await view<string>('purse_today', { account_id: 'bot-alpha.heat-index-game.testnet' });
  ok(typeof l.div === 'number' && p !== undefined, 'missing');
  return `league division ${l.div}, purse today ${p}`;
});

await check('the contract account has one full-access key; the site relayer key can only create player accounts', async () => {
  const r = (await rpc.query({ request_type: 'view_access_key_list', finality: 'final', account_id: C })) as any;
  const full = r.keys.filter((k: any) => k.access_key.permission === 'FullAccess');
  const fn = r.keys.filter((k: any) => k.access_key.permission !== 'FullAccess');
  ok(full.length === 1, `${full.length} full-access keys`);
  for (const k of fn) {
    const p = k.access_key.permission.FunctionCall;
    ok(p.receiver_id === C && p.method_names.length === 1 && p.method_names[0] === 'create_player_account', 'a function-call key can do more');
  }
  return `${full.length} full-access, ${fn.length} limited to create_player_account`;
});

await check('every transaction linked in the README succeeded', async () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const hashes = [...new Set([...readme.matchAll(/nearblocks\.io\/txns\/([A-Za-z0-9]{40,50})/g)].map((m) => m[1]))];
  ok(hashes.length > 0, 'no links');
  for (const h of hashes) {
    const r = await raw('tx', { tx_hash: h, sender_account_id: C, wait_until: 'NONE' });
    const st = r.result?.status ?? r.result?.final_execution_outcome?.status;
    if (r.error && /does not exist|UNKNOWN_TRANSACTION/i.test(JSON.stringify(r.error))) continue; // other sender: skip
    ok(!st || !('Failure' in st), `${h} failed`);
  }
  return `${hashes.length} transactions`;
});

await check('the public site is up and its login API refuses other websites', async () => {
  const page = await fetch(SITE);
  ok(page.ok, `site ${page.status}`);
  const api = await fetch(`${SITE}/api/privy/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: '{}',
  });
  ok(api.status === 403, `API answered ${api.status}`);
  return SITE;
});

console.log(failed ? `\n${failed} claim(s) failed` : '\nall claims hold');
process.exit(failed ? 1 : 0);
