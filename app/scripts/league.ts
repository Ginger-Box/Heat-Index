// League check: what the NPC decks look like in each division, and how a player's deck does against them.
// Run: npx tsx --tsconfig tsconfig.app.json scripts/league.ts [battles per team] [days]
import '../src/engine/ai';
import { simulateBattle } from '../src/engine/battle';
import { DIVISIONS } from '../src/engine/league';
import { CLASS_LABEL, classOf, model, type Robot } from '../src/engine/robots';
import { teamEnergy } from '../src/engine/team';
import { advanceHours, createWorld, HOURS_PER_DAY, teamOf } from '../src/engine/world';

const N = Number(process.argv[2] ?? 60);
const DAYS = Number(process.argv[3] ?? 3);
const w = createWorld(777, 'test');
advanceHours(w, HOURS_PER_DAY * DAYS);

const mk = (ids: string[]): Robot[] => ids.map((id, i) => ({ uid: `${id}#p${i}`, modelId: id, durability: 10 }));
const decks: Record<string, Robot[]> = {
  starter: mk(['spark', 'scout', 'bolt', 'ram', 'welder', 'volt', 'wall', 'dozer', 'drone', 'cracker', 'dash', 'plate']),
  // a typical upgraded deck at the 42 limit
  upgraded42: mk(['medic', 'medic', 'bastion', 'wall', 'hammer', 'hound', 'mine', 'volt', 'welder', 'plate', 'ram', 'scout']),
};
for (const d of Object.values(decks)) console.log('player deck cost', teamEnergy(d));

for (const [di, D] of DIVISIONS.entries()) {
  console.log(`\n== ${D.name} (cap ${D.cap}, sloppy ${D.sloppy})`);
  const teams = w.managers.filter((m) => m.id !== 'player' && m.div === di);
  for (const m of teams) {
    const t = teamOf(w, m);
    const cls: Record<string, number> = {};
    for (const r of t) cls[CLASS_LABEL[classOf(r.modelId)]] = (cls[CLASS_LABEL[classOf(r.modelId)]] ?? 0) + 1;
    const rates = Object.entries(decks).map(([name, deck]) => {
      let win = 0;
      for (let i = 0; i < N; i++) {
        const st = simulateBattle(deck, t, 1000 + i, [{ careful: 0.5 }, { careful: m.careful, sloppy: D.sloppy }]);
        if (st.winner === 0) win++;
        else if (st.winner === null) win += 0.5;
      }
      return `${name} ${Math.round((win / N) * 100)}%`;
    });
    console.log(
      `${m.name.padEnd(15)} cost ${teamEnergy(t)} · ${t.length} robots · ${JSON.stringify(cls)} · ${rates.join(' · ')}`,
    );
    console.log('   ', t.map((r) => model(r.modelId).name).join(', '));
  }
}
