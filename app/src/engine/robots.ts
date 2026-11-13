// Модели роботов. Названия и цифры — рабочие заглушки (см. DESIGN.md, раздел 5).

export type AbilityKind = 'armor' | 'maneuver' | 'repair' | 'blast' | 'charge' | 'shock';
/** Класс робота = его способность; у роботов без способности класс «Базовый». */
export type RobotClass = AbilityKind | 'none';

export interface Ability {
  kind: AbilityKind;
  n: number; // сила способности (для Манёвра не используется)
}

export interface RobotModel {
  id: string;
  name: string;
  cost: number; // энергия
  atk: number;
  hp: number;
  ability?: Ability;
  basePrice: number; // CR
  maxDur: number; // прочность нового робота
}

export const ABILITY_LABEL: Record<AbilityKind, string> = {
  armor: 'Armor',
  maneuver: 'Maneuver',
  repair: 'Repair',
  blast: 'Blast',
  charge: 'Charge',
  shock: 'Shock',
};

export const CLASSES: RobotClass[] = ['none', 'armor', 'maneuver', 'repair', 'blast', 'charge', 'shock'];

export const CLASS_LABEL: Record<RobotClass, string> = { none: 'Basic', ...ABILITY_LABEL };
export const CLASS_ICON: Record<RobotClass, string> = {
  none: '🤖',
  armor: '🛡️',
  maneuver: '💨',
  repair: '🔧',
  blast: '💥',
  charge: '🔥',
  shock: '🌩️',
};
export const CLASS_HELP: Record<RobotClass, string> = {
  none: 'No abilities, but they run cool: overheat only at 6 heat instead of 4.',
  armor: 'Guards: while one stands, enemies must hit it first — except Maneuver robots, which slip past.',
  maneuver: 'Flankers: ignore enemy guards and can strike any robot or the Core.',
  repair: 'Medics: fix and cool your robots or the Core, and patch a little every turn.',
  blast: 'Walking bombs: when destroyed, they hurt every enemy robot.',
  charge: 'Rushers: strike on the turn they arrive, with extra force.',
  shock: 'Stunners: knock an enemy robot offline and overheat targets fast.',
};

export const ABILITY_HELP: Record<AbilityKind, string> = {
  armor: 'Guard: enemies must attack it before your other robots or your Core (Maneuver robots ignore guards). Takes N less damage from every hit.',
  maneuver: 'Flanker: ignores enemy guards — can attack any robot or the Core.',
  repair: 'When deployed: repairs N HP and fully cools a robot of yours, or repairs your Core — you choose. Then at the start of every one of your turns it patches 1 HP of your most damaged robot (or the Core).',
  blast: 'When destroyed: deals N damage to every enemy robot.',
  charge: 'Attacks on the turn it is deployed, with +N attack (robots only, not the Core).',
  shock: 'When deployed: stuns an enemy robot — it skips its next turn. Its attacks add +2 heat to the target.',
};

/**
 * Базовая цена по стоимости в энергии — не ровная, а по кривой (×~1,8 за ступень):
 * дешёвых покупаешь сразу, на самых сильных приходится копить.
 */
export const BASE_PRICE = [0, 30, 55, 100, 180, 320, 560];

const m = (
  id: string,
  name: string,
  cost: number,
  atk: number,
  hp: number,
  ability?: Ability,
): RobotModel => ({ id, name, cost, atk, hp, ability, basePrice: BASE_PRICE[cost], maxDur: 4 + 2 * cost });



// 7 классов по 4 робота. Цифры подобраны скриптом scripts/classes.ts: классы выигрывают 47–56%.
export const MODELS: RobotModel[] = [
  // Базовые
  m('spark', 'Spark', 1, 2, 3),
  m('bolt', 'Bolt', 2, 3, 4),
  m('volt', 'Volt-7', 3, 4, 6),
  m('dozer', 'Dozer', 4, 5, 6),
  // Броня
  m('plate', 'Plate', 2, 1, 2, { kind: 'armor', n: 1 }),
  m('wall', 'Wall-M', 3, 1, 3, { kind: 'armor', n: 1 }),
  m('bastion', 'Bastion', 4, 2, 3, { kind: 'armor', n: 1 }),
  m('titan', 'Titan', 6, 3, 6, { kind: 'armor', n: 1 }),
  // Манёвр
  m('scout', 'Scout Bug', 1, 3, 3, { kind: 'maneuver', n: 0 }),
  m('hound', 'Hound', 3, 4, 5, { kind: 'maneuver', n: 0 }),
  m('ghost', 'Ghost', 4, 4, 5, { kind: 'maneuver', n: 0 }),
  m('raptor', 'Raptor', 5, 5, 6, { kind: 'maneuver', n: 0 }),
  // Ремонт
  m('drone', 'Fixdrone', 1, 1, 1, { kind: 'repair', n: 2 }),
  m('welder', 'Welder', 2, 2, 3, { kind: 'repair', n: 2 }),
  m('medic', 'Medic-X', 4, 4, 5, { kind: 'repair', n: 3 }),
  m('ark', 'Ark', 6, 5, 9, { kind: 'repair', n: 5 }),
  // Взрыв
  m('cracker', 'Firecracker', 1, 2, 2, { kind: 'blast', n: 1 }),
  m('mine', 'Mine-bot', 3, 4, 3, { kind: 'blast', n: 2 }),
  m('shrapnel', 'Shrapnel', 5, 5, 7, { kind: 'blast', n: 2 }),
  m('apoc', 'Apocalypse', 6, 8, 9, { kind: 'blast', n: 4 }),
  // Натиск
  m('dash', 'Dash', 1, 2, 2, { kind: 'charge', n: 1 }),
  m('ram', 'Ram', 2, 3, 2, { kind: 'charge', n: 1 }),
  m('hammer', 'Hammer', 3, 4, 3, { kind: 'charge', n: 1 }),
  m('bull', 'Bull', 5, 4, 5, { kind: 'charge', n: 1 }),
  // Шок
  m('zapper', 'Zapper', 2, 2, 5, { kind: 'shock', n: 0 }),
  m('arc', 'Arc', 3, 3, 6, { kind: 'shock', n: 0 }),
  m('tesla', 'Tesla-9', 4, 3, 6, { kind: 'shock', n: 0 }),
  m('storm', 'Stormcaller', 6, 5, 8, { kind: 'shock', n: 0 }),
];

export const MODEL_BY_ID: Record<string, RobotModel> = Object.fromEntries(
  MODELS.map((x) => [x.id, x]),
);

export const classOf = (id: string): RobotClass => model(id).ability?.kind ?? 'none';
/** Показывать ли число у способности (у Манёвра и Шока его нет). */
export const abilityHasN = (k: AbilityKind) => k !== 'maneuver' && k !== 'shock';

export const model = (id: string): RobotModel => {
  const x = MODEL_BY_ID[id];
  if (!x) throw new Error(`Unknown robot model: ${id}`);
  return x;
};

/** Прочность зависит от модели: дешёвые 6, самые дорогие 16 (4 + 2 × энергия). */
export const maxDurability = (modelId: string) => model(modelId).maxDur;
/** Доля оставшейся прочности 0..1. */
export const durFrac = (r: { modelId: string; durability: number }) => Math.max(0, r.durability) / maxDurability(r.modelId);
/** A deck holds 10–15 robots (TEAM_SIZE = the most, used for the Hangar slots). */
export const TEAM_MIN = 10;
export const TEAM_MAX = 15;
export const TEAM_SIZE = TEAM_MAX;
export const TEAM_ENERGY_CAP = 42;
export const MAX_SAME_MODEL = 2;

/** Конкретный робот (экземпляр). В блокчейне это токен NEP-245 с тиражом 1. */
export interface Robot {
  uid: string; // "<model>#<serial>"
  modelId: string;
  durability: number;
}
