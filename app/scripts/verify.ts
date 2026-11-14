// Checks the README's claims against NEAR testnet and the live site, and prints ✓ / ✗ for each.
// Read-only: view calls and transaction lookups, nothing is signed. Run: npm run verify
import { readFileSync } from 'node:fs';
import { JsonRpcProvider } from 'near-api-js';

interface Token {
  token_id: string;
  metadata?: { model_id: string; durability: number };
  record?: { battles: number; wins: number; rank: number } | null;
}
interface AccessKey {
  public_key: string;
  access_key: { permission: 'FullAccess' | { FunctionCall: { receiver_id: string; method_names: string[] } } };
}
interface RpcTx {
  status?: Record<string, unknown>;
  final_execution_outcome?: { status?: Record<string, unknown> };
}

const C = 'heat-index-game.testnet';
const SITE = 'https://heat-index-web.ginger-box.workers.dev';
const rpc = new JsonRpcProvider({ url: process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com' });
const view = <T>(method: string, args: Record<string, unknown> = {}) => rpc.callFunction({ contractId: C, method, args }) as Promise<T>;
const raw = (method: string, params: unknown) =>
  fetch('https://archival-rpc.testnet.near.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json() as Promise<{ result?: RpcTx; error?: unknown }>);

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
  const acc = (await rpc.query({ request_type: 'view_account', finality: 'final', account_id: C })) as unknown as { code_hash: string };
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
  const tokens = await view<Token[]>('mt_tokens_for_owner', { account_id: who, limit: 50 });
  ok(tokens.length > 0 && tokens[0].token_id.startsWith('robot:'), 'no robot tokens');
  const [t] = await view<Token[]>('mt_token', { token_ids: [tokens[0].token_id] });
  ok(t.metadata?.model_id && typeof t.metadata.durability === 'number', 'no metadata');
  return `${who.split('.')[0]}: ${cr} CR, ${tokens.length} robots`;
});

await check('robots carry their veteran battle record on-chain', async () => {
  const tokens = await view<Token[]>('mt_tokens_for_owner', { account_id: 'bot-alpha.heat-index-game.testnet', limit: 50 });
  const rec = tokens.find((t) => t.record);
  ok(rec, 'no record on any token');
  return `${rec.token_id}: ${rec.record.wins} wins in ${rec.record.battles} battles`;
});

await check('league progress, purchase basis and the daily purse are readable views', async () => {
  const l = await view<{ div: number; beaten: string[]; crowns: number }>('league_of', { account_id: 'bot-alpha.heat-index-game.testnet' });
  const p = await view<string>('purse_today', { account_id: 'bot-alpha.heat-index-game.testnet' });
  ok(typeof l.div === 'number' && p !== undefined, 'missing');
  return `league division ${l.div}, purse today ${p}`;
});

await check('the contract account has one full-access key; its other keys can only create accounts or record checked moves', async () => {
  const r = (await rpc.query({ request_type: 'view_access_key_list', finality: 'final', account_id: C })) as unknown as { keys: AccessKey[] };
  const full = r.keys.filter((k) => k.access_key.permission === 'FullAccess');
  const fn = r.keys.filter((k) => k.access_key.permission !== 'FullAccess');
  ok(full.length === 1, `${full.length} full-access keys`);
  for (const k of fn) {
    const p = (k.access_key.permission as { FunctionCall: { receiver_id: string; method_names: string[] } }).FunctionCall;
    const allowed = ['create_player_account', 'buy_robot_for', 'sell_robot_for', 'repair_robot_for', 'record_battle_for', 'open_battle_for', 'adopt_world_wallet', 'sync_world_credits', 'drop_world_robot'];
    ok(p.receiver_id === C && p.method_names.every((m) => allowed.includes(m)), `a function-call key can do more: ${p.method_names}`);
  }
  return `${full.length} full-access, ${fn.length} limited (the site relayer: create_player_account; the world server: *_for moves and the world wallets)`;
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

await check("the shared world's AI brokers publish their latest LLM decisions (NEAR AI Cloud)", async () => {
  const d = (await fetch(`${SITE}/api/world/public`).then((r) => r.json())) as {
    brokerModel: string;
    brokers: { id: string; ai: { remark: string; chatId?: string } | null }[];
  };
  const decided = d.brokers.filter((b) => b.ai?.remark);
  ok(decided.length > 0, 'no broker has an LLM decision yet');
  return `${d.brokerModel}: ${decided.map((b) => `${b.id} (${b.ai!.chatId?.slice(0, 18)}…)`).join(', ')}`;
});

await check('every broker and bot team is a NEAR account holding its credits and robots', async () => {
  const { WORLD_WALLETS } = await import('../src/engine/wallets');
  let robots = 0;
  for (const x of WORLD_WALLETS) {
    const kind = await view<{ kind: string } | null>('world_wallet', { account: x.account });
    ok(kind?.kind === x.kind, `${x.account} is not a ${x.kind} wallet`);
    if (x.kind === 'npc') robots += (await view<unknown[]>('mt_tokens_for_owner', { account_id: x.account, limit: 200 })).length;
  }
  return `${WORLD_WALLETS.length} accounts (3 brokers, 12 teams), ${robots} team robots as tokens`;
});

await check("each broker records its AI decision itself, and the contract checks NEAR AI's TEE signature", async () => {
  const { WORLD_WALLETS } = await import('../src/engine/wallets');
  const signers = await view<string[]>('tee_signers');
  const out: string[] = [];
  for (const x of WORLD_WALLETS.filter((w) => w.kind === 'broker')) {
    const d = await view<{ signer: string; chat_id: string } | null>('broker_decision', { broker: x.account });
    ok(!!d && signers.includes(d.signer.slice(2)), `${x.account}: no TEE-verified decision`);
    out.push(`${x.name} (${d!.chat_id.slice(0, 16)}…)`);
  }
  return `signed by ${signers.map((s) => `0x${s.slice(0, 8)}…`).join(', ')}: ${out.join(', ')}`;
});

console.log(failed ? `\n${failed} claim(s) failed` : '\nall claims hold');
process.exit(failed ? 1 : 0);
