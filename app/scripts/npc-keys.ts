// One-off setup: each bot team signs its own moves. For every npc-* account: top its balance up to 0.45 NEAR (it
// pays its own gas now) and add a key limited to the contract's npc_* methods, kept in the Worker's secrets
// (NPC_KEYS in the local secrets file — never in the repo).
// Run: npx tsx scripts/npc-keys.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js';
import { WORLD_WALLETS } from '../src/engine/wallets';

const C = 'heat-index-game.testnet';
const CREDS = join(homedir(), '.near-credentials', 'testnet');
const SECRETS = join(homedir(), '.near-credentials', 'heat-index-web', 'secrets.json');
const rpc = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const parent = new Account(C, rpc, JSON.parse(readFileSync(join(CREDS, `${C}.json`), 'utf8')).private_key);
const secrets = JSON.parse(readFileSync(SECRETS, 'utf8'));
const keys: Record<string, string> = secrets.NPC_KEYS ? JSON.parse(secrets.NPC_KEYS) : {};
const TARGET = 450_000_000_000_000_000_000_000n; // 0.45 NEAR
const METHODS = ['npc_buy', 'npc_sell', 'npc_repair', 'npc_record_battle', 'npc_buy_listing', 'npc_drop'];

for (const w of WORLD_WALLETS.filter((x) => x.kind === 'npc')) {
  await new Promise((r) => setTimeout(r, 1500)); // public RPC rate limits
  const bal = BigInt(((await rpc.viewAccount({ accountId: w.account })) as { amount: string }).amount);
  if (bal < TARGET) {
    await parent.transfer({ receiverId: w.account, amount: TARGET - bal });
    console.log(`funded ${w.account} +${Number((TARGET - bal) / 10n ** 21n) / 1000} NEAR`);
  }
  if (!keys[w.account]) {
    const own = new Account(w.account, rpc, JSON.parse(readFileSync(join(CREDS, `${w.account}.json`), 'utf8')).private_key);
    const k = KeyPair.fromRandom('ed25519');
    await own.addFunctionCallAccessKey({ publicKey: k.getPublicKey().toString(), contractId: C, methodNames: METHODS, allowance: 10n ** 25n });
    keys[w.account] = k.toString();
    secrets.NPC_KEYS = JSON.stringify(keys);
    writeFileSync(SECRETS, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    console.log(`key for ${w.account}`);
  }
}
console.log(`${Object.keys(keys).length} bot teams sign their own moves`);
