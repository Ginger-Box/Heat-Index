// Re-derive the shared world from its public record: takes hour N-1's published snapshot, replays hour N's journal
// with this engine (engine/journal.ts — the same code the server runs) and checks the result against the SHA-256
// the server committed on NEAR for hour N (contract: commit_world). Prices, brokers, bot matches, balances: if the
// server had changed anything outside the rules, the hashes wouldn't match.
// Run: npm run verify-world [epoch]   (default: the latest)
import { createHash } from 'node:crypto';
import { JsonRpcProvider } from 'near-api-js';
import '../src/engine/ai';
import { applyEntry, publicWorldText, type JournalEntry } from '../src/engine/journal';
import type { World } from '../src/engine/world';

const SITE = process.env.SITE ?? 'https://heat-index-web.ginger-box.workers.dev';
const C = 'heat-index-game.testnet';
const rpc = new JsonRpcProvider({ url: process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com' });
const view = <T>(method: string, args: Record<string, unknown> = {}) => rpc.callFunction({ contractId: C, method, args }) as Promise<T>;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const get = async (path: string) => {
  const r = await fetch(`${SITE}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.text();
};

const epochs = await view<number>('world_epochs');
const E = process.argv[2] ? Number(process.argv[2]) : epochs - 1;
if (E < 1) {
  console.log(`only ${epochs} commitment(s) on-chain — the first verifiable hour is epoch 1`);
  process.exit(0);
}
type Commit = { state: string; journal: string; prev: string; at_ms: number };
const [prev, cur] = await Promise.all([view<Commit>('world_commit', { epoch: E - 1 }), view<Commit>('world_commit', { epoch: E })]);
const [snapPrev, journal, snap] = await Promise.all([get(`/api/world-log/${E - 1}/snapshot`), get(`/api/world-log/${E}/journal`), get(`/api/world-log/${E}/snapshot`)]);
let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failed++;
};
check(sha(snapPrev) === prev.state, `snapshot ${E - 1} is the one committed on-chain (${prev.state.slice(0, 12)}…)`);
check(sha(snap) === cur.state, `snapshot ${E} is the one committed on-chain (${cur.state.slice(0, 12)}…)`);
check(cur.prev === prev.state, `commitment ${E} chains to ${E - 1}`);
check(sha(journal) === cur.journal, `journal ${E} is the one committed on-chain`);
const entries = JSON.parse(journal) as JournalEntry[];
const w = JSON.parse(snapPrev) as World;
const counts: Record<string, number> = {};
for (const e of entries) {
  counts[e.t] = (counts[e.t] ?? 0) + 1;
  applyEntry(w, e);
}
const replayed = sha(publicWorldText(w));
check(replayed === cur.state, `replaying ${entries.length} entries (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}) on snapshot ${E - 1} gives exactly snapshot ${E}`);
console.log(failed ? `\n${failed} check(s) failed` : `\nhour ${E} of the shared world re-derived from its public record`);
process.exit(failed ? 1 : 0);
