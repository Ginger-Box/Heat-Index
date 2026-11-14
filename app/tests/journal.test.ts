// The world's journal: replaying the entries on a snapshot gives exactly the same world (scripts/verify-world.ts
// relies on it to check the hourly commitments on NEAR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/engine/ai';
import { applyEntry, publicWorldText, worldText, type JournalEntry } from '../src/engine/journal';
import { createSharedWorld, quote, robotsOf, type World } from '../src/engine/world';

test('replaying the journal on the previous snapshot reproduces the world exactly', () => {
  const live = createSharedWorld(42);
  // a joined player
  const join: JournalEntry = {
    t: 'join',
    accountId: 'amy.testnet',
    name: 'amy',
    devs: [],
    chain: { credits: 1000, league: { div: 0, beaten: [], crowns: 0 }, robots: [{ tokenId: 'robot:volt:1', modelId: 'volt', durability: 10 }, { tokenId: 'robot:ram:2', modelId: 'ram', durability: 8 }] },
  };
  applyEntry(live, join);
  // the player's secret battle deck (deck moves stay out of the journal and out of the published snapshot)
  const amy = live.managers.find((m) => m.id === 'amy.testnet')!;
  amy.team = robotsOf(live, 'amy.testnet').map((r) => r.uid);
  const snap = worldText(live);
  const pubSnap = publicWorldText(live);
  const entries: JournalEntry[] = [];
  const apply = (e: JournalEntry) => {
    entries.push(e);
    return applyEntry(live, e);
  };
  for (let i = 0; i < 40; i++) apply({ t: 'tick', now: 1_800_000_000_000 });
  apply({ t: 'policy', broker: 'soroka', p: { spread: 0.07, react: 0.7, targetStock: 2, focus: ['spark'], dump: [], remark: 'hi' }, meta: { model: 'm', chatId: 'c1' } });
  apply({ t: 'aiTx', broker: 'soroka', tx: 'abc' });
  const b = live.brokers.find((x) => !x.closed && Object.values(live.robots).some((r) => r.owner === x.id))!;
  const modelId = Object.values(live.robots).find((r) => r.owner === b.id)!.modelId;
  assert.ok(quote(live, b, modelId).ask > 0);
  assert.equal(apply({ t: 'op', me: 'amy.testnet', name: 'buy', args: [b.id, modelId], now: 1_800_000_000_000 }), null);
  const mine = robotsOf(live, 'amy.testnet')[0];
  apply({ t: 'op', me: 'amy.testnet', name: 'list', args: [mine.uid, 5], now: 1_800_000_000_500 });
  apply({ t: 'chainId', uid: mine.uid, id: 'robot:x:9' });
  apply({ t: 'fallback', broker: 'kessler' });
  for (let i = 0; i < 20; i++) apply({ t: 'tick', now: 1_800_000_000_000 });
  apply({ t: 'forfeit', me: 'amy.testnet', oppId: live.managers[0].id, now: 1_800_000_100_000 });
  apply({ t: 'adopted', account: 'npc-x.testnet' });

  const replayed = JSON.parse(snap) as World;
  for (const e of JSON.parse(JSON.stringify(entries)) as JournalEntry[]) applyEntry(replayed, e);
  assert.equal(worldText(replayed), worldText(live));
  // what the verifier really has: the published snapshot (players' decks stripped) — the replay still lands on
  // exactly the published state
  const fromPublic = JSON.parse(pubSnap) as World;
  for (const e of JSON.parse(JSON.stringify(entries)) as JournalEntry[]) applyEntry(fromPublic, e);
  assert.equal(publicWorldText(fromPublic), publicWorldText(live));
  // the published form (decks stripped) matches too, and holds no player's deck
  assert.equal(publicWorldText(replayed), publicWorldText(live));
  assert.ok(!publicWorldText(live).includes('"decks"') || !JSON.parse(publicWorldText(live)).managers.some((m: { human?: boolean; decks?: unknown }) => m.human && m.decks));
  // and a changed entry gives another world
  const forged = JSON.parse(snap) as World;
  const bad = JSON.parse(JSON.stringify(entries)) as JournalEntry[];
  (bad.find((e) => e.t === 'op') as { args: unknown[] }).args = [b.id, 'apoc'];
  for (const e of bad) applyEntry(forged, e);
  assert.notEqual(worldText(forged), worldText(live));
});
