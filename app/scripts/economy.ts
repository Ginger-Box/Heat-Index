// Economy check: a week of the world without the player.
// Run: npx tsx scripts/economy.ts [days] [seed]
import { MODELS } from '../src/engine/robots';
import {
  HOURS_PER_DAY,
  PLAYER_ID,
  actualRelevance,
  advanceHours,
  createWorld,
  netWorth,
  refPrice,
  robotsOf,
  type World,
} from '../src/engine/world';

const days = Number(process.argv[2] ?? 7);
const seed = Number(process.argv[3] ?? 1);

const t0 = Date.now();
const w = createWorld(seed);
console.log(`World created (with warm-up): ${Date.now() - t0} ms`);

function report(w: World, label: string) {
  const npc = w.managers.filter((m) => m.id !== PLAYER_ID);
  const npcCredits = npc.reduce((s, m) => s + m.credits, 0);
  const brokers = w.brokers.map((b) => `${b.name}:${Math.round(b.credits)}${b.closed ? '(closed)' : ''}`).join(' ');
  const robots = Object.keys(w.robots).length;
  const broken = Object.values(w.robots).filter((r) => r.durability <= 0).length;
  console.log(
    `${label} | NPC credits ${npcCredits} (avg ${Math.round(npcCredits / npc.length)}) | ${brokers} | robots ${robots}, broken ${broken}`,
  );
}

report(w, 'Day 0');
const t1 = Date.now();
for (let d = 1; d <= days; d++) {
  advanceHours(w, HOURS_PER_DAY);
  report(w, `Day ${d}`);
}
console.log(`Simulated ${days} days (${w.tick} battles): ${Date.now() - t1} ms`);

const rel = actualRelevance(w);
console.log('\nModel          Relevance  Price  Base');
for (const x of [...MODELS].sort((a, b) => rel[b.id] - rel[a.id])) {
  console.log(
    x.name.padEnd(14),
    rel[x.id].toFixed(0).padStart(8),
    Math.round(refPrice(w, x.id)).toString().padStart(6),
    String(x.basePrice).padStart(5),
  );
}

// Price range over the period
console.log('\nPrice range over the period (min–max):');
for (const x of MODELS) {
  const ps = w.history.map((h) => h.price[x.id]);
  console.log(x.name.padEnd(14), `${Math.min(...ps)}–${Math.max(...ps)}`);
}

console.log('\nRating (ELO / net worth / robots):');
for (const m of [...w.managers].sort((a, b) => b.elo - a.elo)) {
  console.log(
    m.name.padEnd(20),
    m.strategy.padEnd(11),
    String(m.elo).padStart(5),
    String(netWorth(w, m)).padStart(6),
    String(robotsOf(w, m.id).length).padStart(4),
    `${m.wins}/${m.draws}/${m.losses}`,
  );
}
console.log('\nEvents (last 15):');
for (const e of w.events.slice(-15)) console.log(`  d${e.day} [${e.kind}] ${e.text}`);
