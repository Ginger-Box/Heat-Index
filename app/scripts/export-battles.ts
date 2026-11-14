// Exports AI-vs-AI battles played by the TypeScript engine (log + winner + every robot's wear, light and full)
// for the contract's differential test: the Rust port must replay each one to the same result.
// Run: npx tsx scripts/export-battles.ts
import { writeFileSync } from 'node:fs';
import '../src/engine/ai';
import { simulateBattle, wearLoss } from '../src/engine/battle';
import { battleLogOf, logText } from '../src/engine/replay';
import { createWorld, teamOf } from '../src/engine/world';

const out: { log: string; winner: number | null; wear: Record<string, [number, number]> }[] = [];
for (let g = 0; g < 40; g++) {
  const w = createWorld(100 + g, 'You', 3);
  const ms = w.managers.filter((m) => teamOf(w, m).length >= 4);
  const a = ms[g % ms.length];
  const b = ms[(g * 7 + 3) % ms.length];
  if (a.id === b.id) continue;
  const ta = teamOf(w, a).map((r, i) => (i === 0 ? { ...r, vet: { b: 9, w: g % 2 ? 9 : 16 } } : r)); // veterans' HP bonus too
  const st = simulateBattle(ta, teamOf(w, b), 7000 + g * 13, [{ careful: 0.3, sloppy: 0.2 }, { careful: 0.7, sloppy: 0.1 }]);
  const log = battleLogOf(st)!;
  const wear: Record<string, [number, number]> = {};
  for (const r of [...log.input.a, ...log.input.b]) wear[r.uid] = [wearLoss(st, r.uid, true), wearLoss(st, r.uid)];
  out.push({ log: logText(log), winner: st.winner ?? null, wear });
}
writeFileSync(new URL('../../contract/fixtures/battles.json', import.meta.url), JSON.stringify(out));
console.log(`${out.length} battles exported`);
