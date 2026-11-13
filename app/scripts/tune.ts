// Автоподбор характеристик классов под новый бой: сильнейшему классу −1, слабейшему +1, пока все не в 44–56%.
// Запуск: npx tsx scripts/tune.ts [боёв на пару] [итераций]. Печатает итоговые поправки по классам.
import '../src/engine/ai';
import { simulateBattle } from '../src/engine/battle';
import { Rng } from '../src/engine/rng';
import { CLASSES, CLASS_LABEL, MODELS, classOf, type Robot, type RobotClass } from '../src/engine/robots';
import { buildTeam } from '../src/engine/team';

const N = Number(process.argv[2] ?? 80);
const ITER = Number(process.argv[3] ?? 14);
const base = Object.fromEntries(MODELS.map((m) => [m.id, { atk: m.atk, hp: m.hp }]));
// поправки по отдельным роботам; в каждом классе крутим «указатель», чтобы шаг был в 1 робота, а не во весь класс
const dHp: Record<string, number> = Object.fromEntries(MODELS.map((m) => [m.id, 0]));
const dAtk: Record<string, number> = Object.fromEntries(MODELS.map((m) => [m.id, 0]));
const ptr: Record<string, number> = Object.fromEntries(CLASSES.map((c) => [c, 0]));
const apply = () => {
  for (const m of MODELS) {
    m.hp = Math.max(1, base[m.id].hp + dHp[m.id]);
    m.atk = Math.max(1, base[m.id].atk + dAtk[m.id]);
  }
};
/** Сдвинуть класс на один шаг: по очереди роботам класса, чередуя HP и атаку. */
function nudge(c: RobotClass, dir: 1 | -1) {
  const ms = MODELS.filter((m) => classOf(m.id) === c);
  const k = ptr[c]++;
  const m = ms[k % ms.length];
  const useAtk = Math.floor(k / ms.length) % 2 === 1 && base[m.id].atk + dAtk[m.id] + dir >= 1;
  if (useAtk) dAtk[m.id] += dir;
  else if (base[m.id].hp + dHp[m.id] + dir >= 1) dHp[m.id] += dir;
}
let serial = 0;
function classTeam(rng: Rng, c: RobotClass): Robot[] {
  const own = MODELS.filter((m) => classOf(m.id) === c);
  for (;;) {
    const pool: Robot[] = [];
    for (let j = 0; j < 14; j++) pool.push({ uid: `r${serial++}`, modelId: rng.pick(j < 8 ? own : MODELS).id, durability: 10 });
    const t = buildTeam(pool, (r) => rng.next() + (classOf(r.modelId) === c ? 1 : 0));
    if (t) return t;
  }
}
function matrix(seed: number) {
  const rng = new Rng(seed);
  const wins: Record<string, number> = {};
  const games: Record<string, number> = {};
  for (const c of CLASSES) wins[c] = games[c] = 0;
  for (const a of CLASSES)
    for (const b of CLASSES) {
      if (a >= b) continue;
      for (let i = 0; i < N; i++) {
        const swap = i % 2 === 1; // кто ходит первым — поровну
        const ta = classTeam(rng, a);
        const tb = classTeam(rng, b);
        const st = simulateBattle(swap ? tb : ta, swap ? ta : tb, seed * 1000 + i, [{ careful: 0.4 }, { careful: 0.4 }]);
        const aSide = swap ? 1 : 0;
        const s = st.winner === aSide ? 1 : st.winner === null ? 0.5 : 0;
        wins[a] += s;
        wins[b] += 1 - s;
        games[a]++;
        games[b]++;
      }
    }
  return Object.fromEntries(CLASSES.map((c) => [c, wins[c] / games[c]]));
}
for (let it = 0; it < ITER; it++) {
  apply();
  const wr = matrix(it + 1);
  const sorted = [...CLASSES].sort((x, y) => wr[y] - wr[x]);
  console.log(`#${it}`, sorted.map((c) => `${CLASS_LABEL[c]} ${(wr[c] * 100).toFixed(0)}%`).join('  '));
  const top = sorted[0];
  const bot = sorted[sorted.length - 1];
  if (wr[top] <= 0.56 && wr[bot] >= 0.44) break;
  if (wr[top] > 0.56) nudge(top, -1);
  if (wr[bot] < 0.44) nudge(bot, 1);
}
console.log(MODELS.map((m) => `${m.id}:${m.atk}/${m.hp}`).join(' '));
