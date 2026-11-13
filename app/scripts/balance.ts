// Balance check: thousands of battles between random teams, win rate per model.
// Run: npx tsx scripts/balance.ts [battles]
import '../src/engine/ai';
import { simulateBattle, wearLoss } from '../src/engine/battle';
import { Rng } from '../src/engine/rng';
import { MODELS, model } from '../src/engine/robots';
import { randomTeam } from '../src/engine/team';

const N = Number(process.argv[2] ?? 5000);
const rng = new Rng(42);
const ids = MODELS.map((m) => m.id);
const stat: Record<string, { games: number; wins: number }> = {};
for (const id of ids) stat[id] = { games: 0, wins: 0 };
let draws = 0;
let rounds = 0;
let wear = 0;
let fielded = 0;

for (let i = 0; i < N; i++) {
  const a = randomTeam(rng, ids);
  const b = randomTeam(rng, ids);
  const st = simulateBattle(a, b, i + 1, [{ careful: rng.next() }, { careful: rng.next() }]);
  rounds += st.sides[0].turns + st.sides[1].turns;
  if (st.winner === null) draws++;
  for (const [side, team] of [
    [0, a],
    [1, b],
  ] as const) {
    for (const r of team) {
      const w = st.wear[r.uid];
      if (!w.fielded) continue;
      fielded++;
      wear += wearLoss(st, r.uid);
      stat[r.modelId].games++;
      if (st.winner === side) stat[r.modelId].wins++;
    }
  }
}

console.log(`Battles: ${N}, draws: ${((draws / N) * 100).toFixed(1)}%, average turns: ${(rounds / N).toFixed(2)}`);
console.log(`Average wear of a fielded robot per battle: ${(wear / fielded).toFixed(2)}`);
console.log('Model'.padEnd(14), 'Energy', 'Win%', 'Fielded');
for (const id of ids.sort((x, y) => stat[y].wins / stat[y].games - stat[x].wins / stat[x].games)) {
  const s = stat[id];
  console.log(
    model(id).name.padEnd(14),
    String(model(id).cost).padStart(7),
    ((s.wins / s.games) * 100).toFixed(1).padStart(6),
    String(s.games).padStart(11),
  );
}
