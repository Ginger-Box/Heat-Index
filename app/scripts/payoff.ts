// Окупаемость роботов: сколько призовых денег робот «зарабатывает» за жизнь (по своей доле в стоимости команды)
// по сравнению с ценой, и сколько стоит изношенный робот против лома.
// Запуск: npx tsx scripts/payoff.ts [боёв]
import '../src/engine/ai';
import { simulateBattle, wearLoss } from '../src/engine/battle';
import { ECON, battleReward, durabilityFactor } from '../src/engine/pricing';
import { Rng } from '../src/engine/rng';
import { MODELS, maxDurability, model } from '../src/engine/robots';
import { randomTeam } from '../src/engine/team';

const N = Number(process.argv[2] ?? 3000);
const rng = new Rng(5);
const ids = MODELS.map((m) => m.id);
const acc: Record<string, { battles: number; wear: number; earned: number }> = {};
for (const id of ids) acc[id] = { battles: 0, wear: 0, earned: 0 };
const value = (t: { modelId: string }[]) => t.reduce((s, r) => s + model(r.modelId).basePrice, 0);
for (let i = 0; i < N; i++) {
  const a = randomTeam(rng, ids);
  const b = randomTeam(rng, ids);
  const st = simulateBattle(a, b, i + 1, [{ careful: 0.4 }, { careful: 0.4 }]);
  const va = value(a);
  const vb = value(b);
  for (const [side, team, mine, theirs] of [
    [0, a, va, vb],
    [1, b, vb, va],
  ] as const) {
    const res = st.winner === side ? 1 : st.winner === null ? 0.5 : 0;
    const reward = battleReward(mine, theirs, res);
    for (const r of team) {
      const w = st.wear[r.uid];
      if (!w.fielded) continue;
      const s = acc[r.modelId];
      s.battles++;
      s.wear += wearLoss(st, r.uid);
      s.earned += reward * (model(r.modelId).basePrice / mine);
    }
  }
}
console.log(`purseRate ${ECON.purseRate}. Lifetime = battles until broken at the average wear.`);
console.log('Model'.padEnd(13), 'cost', ' price', 'dur', 'wear/b', 'life', 'earn/b', ' ROI', 'repair/b', 'play&fix', '  resale@1  scrap');
for (const m of [...MODELS].sort((x, y) => x.cost - y.cost)) {
  const s = acc[m.id];
  const wpb = s.wear / s.battles;
  const life = maxDurability(m.id) / wpb;
  const epb = s.earned / s.battles;
  const roi = (epb * life + m.basePrice * ECON.scrapShare) / m.basePrice;
  const repairPerBattle = wpb * ECON.repairShare * (m.basePrice / maxDurability(m.id));
  const resale1 = Math.round(m.basePrice * 0.9 * durabilityFactor({ uid: 'x', modelId: m.id, durability: 1 }));
  console.log(
    m.name.padEnd(13),
    String(m.cost).padStart(4),
    String(m.basePrice).padStart(6),
    String(maxDurability(m.id)).padStart(3),
    wpb.toFixed(2).padStart(6),
    life.toFixed(1).padStart(5),
    epb.toFixed(1).padStart(6),
    roi.toFixed(2).padStart(5),
    repairPerBattle.toFixed(1).padStart(8),
    (epb / repairPerBattle).toFixed(2).padStart(8),
    String(resale1).padStart(9),
    String(Math.round(m.basePrice * ECON.scrapShare)).padStart(6),
  );
}
