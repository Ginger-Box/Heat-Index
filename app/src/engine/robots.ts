// Robot models. Names and numbers are tuned by the simulation scripts in scripts/.

export type AbilityKind = 'armor' | 'maneuver' | 'repair' | 'blast' | 'charge' | 'shock';
/** A robot's class = its ability; robots without an ability are "Basic". */
export type RobotClass = AbilityKind | 'none';

export interface Ability {
  kind: AbilityKind;
  n: number; // ability strength (unused for Maneuver)
}

export interface RobotModel {
  id: string;
  name: string;
  cost: number; // energy
  atk: number;
  hp: number;
  ability?: Ability;
  basePrice: number; // CR
  maxDur: number; // durability of a new robot
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
 * Base price by energy cost — not linear but on a curve (×~1.8 per step):
 * cheap robots you buy right away, the strongest you have to save up for.
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



// 7 7 classes × 4 robots. Stats tuned with scripts/classes.ts and an A/B test: classes win 44–56%.
export const MODELS: RobotModel[] = [
  // Basic
  m('spark', 'Spark', 1, 2, 3),
  m('bolt', 'Bolt', 2, 3, 4),
  m('volt', 'Volt-7', 3, 4, 6),
  m('dozer', 'Dozer', 4, 5, 6),
  // Armor
  m('plate', 'Plate', 2, 1, 2, { kind: 'armor', n: 1 }),
  m('wall', 'Wall-M', 3, 1, 3, { kind: 'armor', n: 1 }),
  m('bastion', 'Bastion', 4, 2, 3, { kind: 'armor', n: 1 }),
  m('titan', 'Titan', 6, 3, 6, { kind: 'armor', n: 1 }),
  // Maneuver
  m('scout', 'Scout Bug', 1, 3, 3, { kind: 'maneuver', n: 0 }),
  m('hound', 'Hound', 3, 4, 5, { kind: 'maneuver', n: 0 }),
  m('ghost', 'Ghost', 4, 4, 5, { kind: 'maneuver', n: 0 }),
  m('raptor', 'Raptor', 5, 5, 6, { kind: 'maneuver', n: 0 }),
  // Repair
  m('drone', 'Fixdrone', 1, 1, 1, { kind: 'repair', n: 2 }),
  m('welder', 'Welder', 2, 2, 3, { kind: 'repair', n: 2 }),
  m('medic', 'Medic-X', 4, 4, 5, { kind: 'repair', n: 3 }),
  m('ark', 'Ark', 6, 5, 9, { kind: 'repair', n: 5 }),
  // Blast
  m('cracker', 'Firecracker', 1, 2, 2, { kind: 'blast', n: 1 }),
  m('mine', 'Mine-bot', 3, 4, 3, { kind: 'blast', n: 2 }),
  m('shrapnel', 'Shrapnel', 5, 5, 7, { kind: 'blast', n: 2 }),
  m('apoc', 'Apocalypse', 6, 8, 9, { kind: 'blast', n: 4 }),
  // Charge
  m('dash', 'Dash', 1, 2, 2, { kind: 'charge', n: 1 }),
  m('ram', 'Ram', 2, 3, 2, { kind: 'charge', n: 1 }),
  m('hammer', 'Hammer', 3, 4, 3, { kind: 'charge', n: 1 }),
  m('bull', 'Bull', 5, 4, 5, { kind: 'charge', n: 1 }),
  // Shock
  m('zapper', 'Zapper', 2, 2, 5, { kind: 'shock', n: 0 }),
  m('arc', 'Arc', 3, 3, 6, { kind: 'shock', n: 0 }),
  m('tesla', 'Tesla-9', 4, 3, 6, { kind: 'shock', n: 0 }),
  m('storm', 'Stormcaller', 6, 5, 8, { kind: 'shock', n: 0 }),
];

export const MODEL_BY_ID: Record<string, RobotModel> = Object.fromEntries(
  MODELS.map((x) => [x.id, x]),
);

export const classOf = (id: string): RobotClass => model(id).ability?.kind ?? 'none';
/** Whether the ability shows a number (Maneuver and Shock don't have one). */
export const abilityHasN = (k: AbilityKind) => k !== 'maneuver' && k !== 'shock';

export const model = (id: string): RobotModel => {
  const x = MODEL_BY_ID[id];
  if (!x) throw new Error(`Unknown robot model: ${id}`);
  return x;
};

/** Durability depends on the model: cheap 6, the most expensive 16 (4 + 2 × energy). */
export const maxDurability = (modelId: string) => model(modelId).maxDur;
/** Share of durability left, 0..1. */
export const durFrac = (r: { modelId: string; durability: number }) => Math.max(0, r.durability) / maxDurability(r.modelId);
/** A deck holds 10–15 robots (TEAM_SIZE = the most, used for the Hangar slots). */
export const TEAM_MIN = 10;
export const TEAM_MAX = 15;
export const TEAM_SIZE = TEAM_MAX;
export const TEAM_ENERGY_CAP = 42;
export const MAX_SAME_MODEL = 2;

/** One concrete robot (instance). On NEAR it is a NEP-245 token with supply 1. */
export interface Robot {
  uid: string; // "<model>#<serial>"
  modelId: string;
  durability: number;
}
