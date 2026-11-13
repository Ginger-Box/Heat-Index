// Баланс классов: команды «вокруг класса» (как у NPC) играют каждый с каждым.
// Запуск: npx tsx scripts/classes.ts [боёв на пару]
import '../src/engine/ai';
import { simulateBattle } from '../src/engine/battle';
import { Rng } from '../src/engine/rng';
import { CLASSES, CLASS_LABEL, MODELS, classOf, type Robot, type RobotClass } from '../src/engine/robots';
import { buildTeam } from '../src/engine/team';

const N = Number(process.argv[2] ?? 300);
const rng = new Rng(11);
let serial = 0;

function classTeam(c: RobotClass): Robot[] {
  const own = MODELS.filter((m) => classOf(m.id) === c);
  for (;;) {
    const pool: Robot[] = [];
    for (let j = 0; j < 14; j++) pool.push({ uid: `r${serial++}`, modelId: rng.pick(j < 8 ? own : MODELS).id, durability: 10 });
    const t = buildTeam(pool, (r) => rng.next() + (classOf(r.modelId) === c ? 1 : 0));
    if (t) return t;
  }
}

const wins: Record<string, number> = {};
const games: Record<string, number> = {};
const matrix: Record<string, Record<string, number>> = {};
for (const a of CLASSES) {
  matrix[a] = {};
  wins[a] = 0;
  games[a] = 0;
}
for (const a of CLASSES)
  for (const b of CLASSES) {
    if (a >= b) continue;
    let aw = 0;
    for (let i = 0; i < N; i++) {
      const ta = classTeam(a);
      const tb = classTeam(b);
      const swap = i % 2 === 1; // кто ходит первым — поровну
      const st = simulateBattle(swap ? tb : ta, swap ? ta : tb, i + 1, [{ careful: 0.4 }, { careful: 0.4 }]);
      const aSide = swap ? 1 : 0;
      const s = st.winner === aSide ? 1 : st.winner === null ? 0.5 : 0;
      aw += s;
    }
    matrix[a][b] = aw / N;
    matrix[b][a] = 1 - aw / N;
    wins[a] += aw;
    wins[b] += N - aw;
    games[a] += N;
    games[b] += N;
  }
const pad = (x: string) => x.padEnd(9);
console.log(pad(''), CLASSES.map((c) => pad(CLASS_LABEL[c])).join(''), 'ИТОГО');
for (const a of [...CLASSES].sort((x, y) => wins[y] / games[y] - wins[x] / games[x])) {
  console.log(
    pad(CLASS_LABEL[a]),
    CLASSES.map((b) => pad(a === b ? '—' : `${Math.round(matrix[a][b] * 100)}%`)).join(''),
    `${((wins[a] / games[a]) * 100).toFixed(1)}%`,
  );
}
