// Правила состава команды: 10–15 роботов, лимит 42 энергии, не больше 2 одной модели, без сломанных.
import { MAX_SAME_MODEL, TEAM_ENERGY_CAP, TEAM_MAX, TEAM_MIN, model, type Robot } from './robots';
import type { Rng } from './rng';

export function teamError(team: Robot[]): string | null {
  if (team.length < TEAM_MIN || team.length > TEAM_MAX)
    return `A deck needs ${TEAM_MIN}–${TEAM_MAX} robots (now ${team.length})`;
  const energy = teamEnergy(team);
  if (energy > TEAM_ENERGY_CAP) return `Deck cost limit is ${TEAM_ENERGY_CAP} (now ${energy}) — the sum of the robots' energy costs`;
  const counts: Record<string, number> = {};
  for (const r of team) {
    if (r.durability <= 0) return `${model(r.modelId).name} is broken`;
    counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
    if (counts[r.modelId] > MAX_SAME_MODEL) return `At most ${MAX_SAME_MODEL} robots of the same model`;
  }
  return null;
}

/** Проверка неполной команды (пока игрок собирает её в Ангаре): всё, кроме «ровно 8». */
export function partialTeamError(team: Robot[]): string | null {
  if (team.length > TEAM_MAX) return `A deck holds at most ${TEAM_MAX} robots`;
  if (new Set(team.map((r) => r.uid)).size !== team.length) return 'This robot is already in the team';
  const energy = teamEnergy(team);
  if (energy > TEAM_ENERGY_CAP) return `Over the deck cost limit: would be ${energy} of ${TEAM_ENERGY_CAP}`;
  const counts: Record<string, number> = {};
  for (const r of team) {
    if (r.durability <= 0) return `${model(r.modelId).name} is broken — repair it first`;
    counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
    if (counts[r.modelId] > MAX_SAME_MODEL) return `At most ${MAX_SAME_MODEL} robots of the same model`;
  }
  return null;
}

export const teamEnergy = (team: Robot[]) => team.reduce((s, r) => s + model(r.modelId).cost, 0);

/**
 * Собирает лучшую команду из доступных роботов по оценке `value`.
 * Жадно: берём самых ценных, пока влезают в лимит, оставляя энергию на оставшиеся места.
 */
export function buildTeam(pool: Robot[], value: (r: Robot) => number): Robot[] | null {
  // Жадно по ценности; если не вышло — запасной вариант «самые дешёвые», он почти всегда влезает.
  return buildGreedy(pool, value) ?? buildGreedy(pool, (r) => -model(r.modelId).cost * 100 + value(r) * 0.001);
}

function buildGreedy(pool: Robot[], value: (r: Robot) => number): Robot[] | null {
  const usable = pool.filter((r) => r.durability > 0).sort((a, b) => value(b) - value(a));
  const team: Robot[] = [];
  const counts: Record<string, number> = {};
  let energy = 0;
  const cheapest = (excludeUids: Set<string>) =>
    usable
      .filter((r) => !excludeUids.has(r.uid))
      .map((r) => model(r.modelId).cost)
      .sort((a, b) => a - b);
  for (const r of usable) {
    if (team.length === TEAM_MAX) break;
    const c = model(r.modelId).cost;
    if ((counts[r.modelId] ?? 0) >= MAX_SAME_MODEL) continue;
    // keep enough energy to still reach the minimum deck size with the cheapest robots left
    const slotsLeft = Math.max(0, TEAM_MIN - team.length - 1);
    const taken = new Set([...team.map((t) => t.uid), r.uid]);
    const reserve = cheapest(taken).slice(0, slotsLeft).reduce((s, x) => s + x, 0);
    if (energy + c + reserve > TEAM_ENERGY_CAP) continue;
    team.push(r);
    counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
    energy += c;
  }
  return team.length >= TEAM_MIN && !teamError(team) ? team : null;
}

let tmpSerial = 0;
/** Случайная допустимая команда из новых роботов — для тестов баланса. */
export function randomTeam(rng: Rng, modelIds: string[]): Robot[] {
  for (;;) {
    const pool: Robot[] = [];
    for (let i = 0; i < 30; i++) {
      const id = rng.pick(modelIds);
      pool.push({ uid: `${id}#t${tmpSerial++}`, modelId: id, durability: 10 });
    }
    const t = buildTeam(pool, () => rng.next());
    if (t) return t;
  }
}
