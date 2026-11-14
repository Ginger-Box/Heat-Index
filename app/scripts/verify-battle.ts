// Replays a battle recorded on NEAR and checks the record: npm run verify-battle <transaction hash>
// 1. reads the record_battle transaction (seed, result, reported wear, replay hash) from testnet;
// 2. downloads the action log from the game's Worker and checks its SHA-256 against the on-chain hash;
// 3. replays every action with the game engine (illegal moves fail) and compares the winner and each robot's
//    durability after the battle with what was recorded on-chain.
import { replayBattle, replayWear, sha256Hex, type BattleLog } from '../src/engine/replay';

const SITE = 'https://heat-index-web.ginger-box.workers.dev';
const hash = process.argv[2];
if (!hash) {
  console.log('usage: npm run verify-battle <record_battle transaction hash>');
  process.exit(2);
}
const rpc = (method: string, params: unknown) =>
  fetch('https://archival-rpc.testnet.near.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json() as Promise<{ result?: { receipts_outcome?: { outcome: { logs: string[] } }[] }; error?: unknown }>);

const meta = (await fetch(`https://api-testnet.nearblocks.io/v1/txns/${hash}`).then((r) => r.json())) as { txns?: { signer_account_id?: string; predecessor_account_id?: string }[] };
const signer = meta?.txns?.[0]?.signer_account_id ?? meta?.txns?.[0]?.predecessor_account_id;
if (!signer) throw new Error('transaction not found');
const tx = await rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' });
const logs: string[] = (tx.result?.receipts_outcome ?? []).flatMap((o) => o.outcome.logs);
const ev = logs
  .filter((l) => l.startsWith('EVENT_JSON:'))
  .map((l) => JSON.parse(l.slice(11)))
  .find((e) => e.standard === 'heat_index' && e.event === 'battle')?.data?.[0];
if (!ev) throw new Error('no battle event in this transaction');
console.log(`battle by ${ev.account_id} vs ${ev.opponent}: result ${['loss', 'win', 'draw'][ev.result]}, seed ${ev.seed}, +${ev.reward} CR`);
if (!ev.replay) {
  console.log('✗ no replay hash recorded (battles before the replay update)');
  process.exit(1);
}

let failed = 0;
const say = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
};
const res = await fetch(`${SITE}/api/battles/${ev.replay}`);
if (!res.ok) {
  console.log(`✗ action log ${ev.replay} not found (${res.status})`);
  process.exit(1);
}
const text = await res.text();
say((await sha256Hex(text)) === ev.replay, `the action log matches the on-chain hash ${ev.replay.slice(0, 16)}…`);
const log = JSON.parse(text) as BattleLog;
say(log.input.seed === Number(ev.seed), `the log starts from the recorded seed ${ev.seed}`);
const { st, error } = replayBattle(log);
say(!error, error ? `replay failed: ${error}` : `replayed ${log.actions.length} actions — every move is legal`);
const replayResult = st.winner === null ? 2 : st.winner === 0 ? 1 : 0;
say(replayResult === ev.result, `the replay's result (${['loss', 'win', 'draw'][replayResult]}) matches the record`);
const after = new Map(replayWear(log, st).map((r) => [r.tokenId ?? r.uid, r.after]));
for (const w of ev.wear as { token_id: string; durability: number }[]) {
  const exp = after.get(w.token_id);
  say(exp !== undefined && Math.min(16, exp) === w.durability, `${w.token_id}: durability ${w.durability} (replay: ${exp ?? 'not in the deck'})`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nthe on-chain record matches the replay');
process.exit(failed ? 1 : 0);
