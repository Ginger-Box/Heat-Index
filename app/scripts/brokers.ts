// Broker balance: equity (cash + cautious stock value) of each broker after a week, on several worlds.
// Run: npx tsx --tsconfig tsconfig.app.json scripts/brokers.ts [days] [worlds]
import { advanceHours, brokerEquity, createWorld, HOURS_PER_DAY, robotsOf } from '../src/engine/world';

const DAYS = Number(process.argv[2] ?? 7);
const WORLDS = Number(process.argv[3] ?? 4);
const sum: Record<string, { d: number; sales: number; closed: number }> = {};
for (let s = 0; s < WORLDS; s++) {
  const w = createWorld(1000 + s * 7919, 'x');
  const start = Object.fromEntries(w.brokers.map((b) => [b.id, brokerEquity(w, b)]));
  w.ledger = [];
  advanceHours(w, HOURS_PER_DAY * DAYS);
  const line = w.brokers.map((b) => {
    const d = brokerEquity(w, b) - start[b.id];
    const sales = w.ledger.filter((e) => e.kind === 'buy' && e.to === b.id).length;
    sum[b.name] ??= { d: 0, sales: 0, closed: 0 };
    sum[b.name].d += d;
    sum[b.name].sales += sales;
    sum[b.name].closed += b.closed ? 1 : 0;
    return `${b.name}: ${d >= 0 ? '+' : ''}${Math.round(d)} (cash ${Math.round(b.credits)}, stock ${robotsOf(w, b.id).length}, ${sales} sales${b.closed ? ', CLOSED' : ''})`;
  });
  const npc = w.managers.filter((m) => m.id !== 'player').reduce((x, m) => x + m.credits, 0);
  console.log(`world ${s}: ${line.join(' · ')} · NPC cash avg ${Math.round(npc / 12)}`);
}
console.log('average equity change per week:', Object.entries(sum).map(([n, v]) => `${n} ${Math.round(v.d / WORLDS)} (${Math.round(v.sales / WORLDS)} sales, closed ${v.closed}/${WORLDS})`).join(' · '));
