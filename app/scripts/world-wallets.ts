// One-off setup: the world's own NEAR accounts — the 3 brokers (broker-<name>) and the 12 Pit League teams
// (npc-<name>) under heat-index-game.testnet. Each gets a full-access key kept in the local near CLI credentials;
// each broker also gets a key limited to `record_broker_decision` for the world server (it signs its own AI decisions).
// Prints the secrets to add to the Worker (written into the deploy-secrets file, never into the repo).
// Run: npx tsx scripts/world-wallets.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js';
import { WORLD_WALLETS } from '../src/engine/wallets';

const CONTRACT = 'heat-index-game.testnet';
const RPC = 'https://test.rpc.fastnear.com';
const CREDS = join(homedir(), '.near-credentials', 'testnet');
const SECRETS = join(homedir(), '.near-credentials', 'heat-index-web', 'secrets.json'); // the source web/scripts/secrets.mjs builds the deploy file from
const provider = new JsonRpcProvider({ url: RPC });
const parentKey = JSON.parse(readFileSync(join(CREDS, `${CONTRACT}.json`), 'utf8')).private_key;
const parent = new Account(CONTRACT, provider, parentKey);

const exists = async (id: string) => {
  try {
    await provider.viewAccount({ accountId: id });
    return true;
  } catch {
    return false;
  }
};

const secrets = JSON.parse(readFileSync(SECRETS, 'utf8'));
const brokerKeys: Record<string, string> = secrets.BROKER_KEYS ? JSON.parse(secrets.BROKER_KEYS) : {};

for (const w of WORLD_WALLETS) {
  await new Promise((r) => setTimeout(r, 2500)); // public RPC rate limits
  const file = join(CREDS, `${w.account}.json`);
  if (!(await exists(w.account))) {
    const kp = KeyPair.fromRandom('ed25519');
    writeFileSync(file, JSON.stringify({ account_id: w.account, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    await parent.createSubAccount({
      accountOrPrefix: w.account.split('.')[0],
      publicKey: kp.getPublicKey().toString(),
      nearToTransfer: w.kind === 'broker' ? 300_000_000_000_000_000_000_000n : 50_000_000_000_000_000_000_000n,
    });
    console.log('created', w.account);
  } else console.log('exists ', w.account);
  if (w.kind === 'broker' && !brokerKeys[w.account]) {
    const own = new Account(w.account, provider, JSON.parse(readFileSync(file, 'utf8')).private_key);
    const fk = KeyPair.fromRandom('ed25519');
    await own.addFunctionCallAccessKey({ publicKey: fk.getPublicKey().toString(), contractId: CONTRACT, methodNames: ['record_broker_decision'], allowance: 250_000_000_000_000_000_000_000n });
    brokerKeys[w.account] = fk.toString();
    console.log('  + decision key for the world server');
    secrets.BROKER_KEYS = JSON.stringify(brokerKeys);
    writeFileSync(SECRETS, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }
}

// (the world server's own key is managed separately: it is rotated whenever the contract gains a server method)
secrets.BROKER_KEYS = JSON.stringify(brokerKeys);
writeFileSync(SECRETS, JSON.stringify(secrets, null, 2), { mode: 0o600 });
console.log('secrets updated:', Object.keys(secrets).join(', '));
