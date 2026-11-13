// Does the meta move during a season? Runs a world for a week (3 seeds) and prints, per day:
// the top-5 models by relevance, class average relevance, and how much the top-10 changed vs the day before.
import { createWorld, advanceHours, HOURS_PER_DAY, actualRelevance } from '../src/engine/world';
import { MODELS, CLASSES, CLASS_LABEL, classOf } from '../src/engine/robots';

for (const seed of [11, 22, 33]) {
  const w = createWorld(seed, 'Sim');
  console.log(`\n=== world ${seed} ===`);
  let prevTop: string[] = [];
  const firstTop: string[] = [];
  for (let day = 1; day <= 7; day++) {
    advanceHours(w, HOURS_PER_DAY);
    const rel = actualRelevance(w);
    const ranked = [...MODELS].sort((a, b) => rel[b.id] - rel[a.id]);
    const top10 = ranked.slice(0, 10).map((m) => m.id);
    if (day === 1) firstTop.push(...top10);
    const churn = prevTop.length ? top10.filter((x) => !prevTop.includes(x)).length : 0;
    prevTop = top10;
    const cls = CLASSES.map((c) => {
      const ms = MODELS.filter((m) => classOf(m.id) === c);
      return [CLASS_LABEL[c], Math.round(ms.reduce((s, m) => s + rel[m.id], 0) / ms.length)] as const;
    }).sort((a, b) => b[1] - a[1]);
    console.log(
      `day ${day} | top5: ${ranked.slice(0, 5).map((m) => `${m.name} ${Math.round(rel[m.id])}`).join(', ')} | new in top10: ${churn}` +
        `\n        classes: ${cls.map(([n, v]) => `${n} ${v}`).join(' · ')}`,
    );
  }
  console.log(`top10 day1 → day7 kept: ${prevTop.filter((x) => firstTop.includes(x)).length}/10`);
}
