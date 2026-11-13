// Battle engine «Overheat»: turns alternate, up to 4 robots per side, you choose who attacks whom.
// Every attack heats the robot up; an overheated robot skips its next turn and wears out more after the battle.
// Rules — DESIGN.md, section 4. Pure code (no UI): used by the game, the AI and the simulations.

import { Rng } from './rng';
import { model, type Robot } from './robots';

export const CORE_HP = 20;
export const BOARD_SLOTS = 4;
export const MAX_TURNS = 10; // turns per side; after that the bigger Core wins
export const START_HAND = 3;
export const MAX_HAND = 6;
export const HEAT_PER_ATTACK = 2;
export const HEAT_COOL_PER_TURN = 1;
export const VENT_COOL = 3;
export const HEAT_CAP = 4;
export const HEAT_CAP_BASIC = 6; // robots without an ability run cool

export const energyForTurn = (turn: number) => Math.min(6, turn + 1);

export interface Unit {
  uid: string;
  modelId: string;
  hp: number;
  maxHp: number;
  heat: number;
  ready: boolean; // can act this turn
  offline: boolean; // overheated: will skip its owner's next turn
  chargeBonus: number; // Charge: bonus on the first attack in the deploy turn
  fresh: boolean; // placed this turn (Charge may attack only robots then, not the Core)
  pos: number; // board slot 0..BOARD_SLOTS-1 (where the player put it; no rule depends on it)
}

export interface SideState {
  core: number;
  deck: string[];
  hand: string[];
  board: Unit[];
  energy: number;
  turns: number; // how many turns this side has started
}

export interface WearInfo {
  fielded: boolean;
  damaged: boolean;
  destroyed: boolean;
  overheated: boolean;
}

export type Target = { side: number; uid: string } | { side: number; core: true };

export type BattleEvent =
  | { t: 'turn'; side: number; turn: number }
  | { t: 'draw'; side: number; uid: string }
  | { t: 'deploy'; side: number; uid: string }
  | { t: 'attack'; side: number; from: string; to: string | 'core'; dmg: number; counter: number }
  | { t: 'vent'; side: number; uid: string; cooled: number }
  | { t: 'overheat'; side: number; uid: string }
  | { t: 'repair'; side: number; from: string; target: string | 'core'; amount: number }
  | { t: 'shock'; side: number; from: string; target: string }
  | { t: 'destroyed'; side: number; uid: string }
  | { t: 'blast'; side: number; from: string; n: number; hits: { uid: string; dmg: number }[] }
  | { t: 'end'; winner: number | null };

export interface BattleState {
  active: number; // whose turn it is
  sides: [SideState, SideState];
  modelOf: Record<string, string>;
  /** чей робот: 0 или 1 (нужно, например, чтобы посчитать стоимость команд для призового фонда) */
  sideOf: Record<string, number>;
  wear: Record<string, WearInfo>;
  history: BattleEvent[];
  winner: number | null | undefined; // undefined — ongoing; null — draw
  rngState: number;
}

export type Action =
  | { t: 'deploy'; uid: string; target?: Target; slot?: number }
  | { t: 'attack'; from: string; to: string | 'core' }
  | { t: 'vent'; uid: string }
  | { t: 'end' };

// ---------- helpers ----------

const ability = (u: { modelId: string }) => model(u.modelId).ability;
export const heatCap = (modelId: string) => (model(modelId).ability ? HEAT_CAP : HEAT_CAP_BASIC);
export const armorOf = (u: Unit) => (ability(u)?.kind === 'armor' ? ability(u)!.n : 0);
/** Armor robots are guards: enemies must attack them first. */
export const isGuard = (u: Unit) => ability(u)?.kind === 'armor';
/** Maneuver robots flank: they ignore guards. */
export const isFlanker = (u: Unit) => ability(u)?.kind === 'maneuver';

export const unitOf = (st: BattleState, side: number, uid: string) => st.sides[side].board.find((u) => u.uid === uid);

/** Which targets a unit may attack. */
export function attackTargets(st: BattleState, side: number, attacker: Unit): (string | 'core')[] {
  const en = st.sides[1 - side];
  const guards = en.board.filter(isGuard);
  if (guards.length && !isFlanker(attacker)) return guards.map((u) => u.uid);
  // Charge on its first turn attacks robots only — no rushing the Core
  if (attacker.fresh) return en.board.map((u) => u.uid);
  return [...en.board.map((u) => u.uid), 'core'];
}

export const SHOCK_HEAT = 2; // Shock robots heat up whatever they hit
export const PATCH_PER_TURN = 1; // Repair robots patch 1 HP at the start of their owner's turn

/** Does deploying this model need a target choice, and which targets are valid. */
export function deployTargets(st: BattleState, side: number, modelId: string): Target[] {
  const ab = model(modelId).ability;
  if (ab?.kind === 'repair') {
    const me = st.sides[side];
    const units: Target[] = me.board.filter((u) => u.hp < u.maxHp || u.heat > 0).map((u) => ({ side, uid: u.uid }));
    return me.core < CORE_HP ? [...units, { side, core: true as const }] : units;
  }
  if (ab?.kind === 'shock')
    return st.sides[1 - side].board.filter((u) => !u.offline).map((u) => ({ side: 1 - side, uid: u.uid }));
  return [];
}

/** Cheap copy for the AI and simulations (without the history). */
export function cloneLite(st: BattleState): BattleState {
  return {
    active: st.active,
    sides: st.sides.map((s) => ({ ...s, deck: [...s.deck], hand: [...s.hand], board: s.board.map((u) => ({ ...u })) })) as [
      SideState,
      SideState,
    ],
    modelOf: st.modelOf,
    sideOf: st.sideOf,
    wear: Object.fromEntries(Object.entries(st.wear).map(([k, v]) => [k, { ...v }])),
    history: [],
    winner: st.winner,
    rngState: st.rngState,
  };
}

// ---------- creation ----------

export function createBattle(teamA: Robot[], teamB: Robot[], seed: number): BattleState {
  const rng = new Rng(seed);
  const modelOf: Record<string, string> = {};
  const sideOf: Record<string, number> = {};
  const wear: Record<string, WearInfo> = {};
  const mkSide = (team: Robot[], extra: number, side: number): SideState => {
    for (const r of team) {
      modelOf[r.uid] = r.modelId;
      sideOf[r.uid] = side;
      wear[r.uid] = { fielded: false, damaged: false, destroyed: false, overheated: false };
    }
    const deck = rng.shuffle(team.map((r) => r.uid));
    const hand = deck.splice(0, START_HAND + extra);
    return { core: CORE_HP, deck, hand, board: [], energy: 0, turns: 0 };
  };
  // the second player gets one extra card to make up for moving second
  const st: BattleState = {
    active: 0,
    sides: [mkSide(teamA, 0, 0), mkSide(teamB, 1, 1)],
    modelOf,
    sideOf,
    wear,
    history: [],
    winner: undefined,
    rngState: rng.state,
  };
  startTurn(st, st.history);
  return st;
}

// ---------- turn ----------

function startTurn(st: BattleState, ev: BattleEvent[] | null) {
  const me = st.sides[st.active];
  me.turns += 1;
  me.energy = energyForTurn(me.turns);
  ev?.push({ t: 'turn', side: st.active, turn: me.turns });
  if (me.deck.length && me.hand.length < MAX_HAND) {
    const uid = me.deck.shift()!;
    me.hand.push(uid);
    ev?.push({ t: 'draw', side: st.active, uid });
  }
  for (const u of me.board) {
    u.heat = Math.max(0, u.heat - HEAT_COOL_PER_TURN);
    u.chargeBonus = 0;
    u.fresh = false;
    if (u.offline) {
      u.offline = false;
      u.ready = false; // skips this turn
    } else u.ready = true;
  }
  // Repair robots patch the most damaged ally (or the Core) a little every turn
  for (const r of me.board) {
    if (ability(r)?.kind !== 'repair') continue;
    const hurt = me.board.filter((u) => u.hp < u.maxHp).sort((a, b) => b.maxHp - b.hp - (a.maxHp - a.hp))[0];
    if (hurt) {
      const amount = Math.min(PATCH_PER_TURN, hurt.maxHp - hurt.hp);
      hurt.hp += amount;
      ev?.push({ t: 'repair', side: st.active, from: r.uid, target: hurt.uid, amount });
    } else if (me.core < CORE_HP) {
      me.core += PATCH_PER_TURN;
      ev?.push({ t: 'repair', side: st.active, from: r.uid, target: 'core', amount: PATCH_PER_TURN });
    }
  }
}

export function endTurn(st: BattleState, ev: BattleEvent[] | null = st.history) {
  if (st.winner !== undefined) return;
  for (const u of st.sides[st.active].board) u.chargeBonus = 0;
  // both sides played MAX_TURNS — compare Cores
  if (st.active === 1 && st.sides[1].turns >= MAX_TURNS) {
    const [a, b] = st.sides;
    st.winner = a.core === b.core ? null : a.core > b.core ? 0 : 1;
    ev?.push({ t: 'end', winner: st.winner });
    return;
  }
  st.active = 1 - st.active;
  startTurn(st, ev);
}

// ---------- damage and deaths ----------

function damageUnit(st: BattleState, u: Unit, dmg: number) {
  if (dmg <= 0) return;
  u.hp -= dmg;
  st.wear[u.uid].damaged = true;
}

function checkWinner(st: BattleState, ev: BattleEvent[] | null) {
  const [a, b] = st.sides;
  if (a.core <= 0 || b.core <= 0) {
    st.winner = a.core <= 0 && b.core <= 0 ? null : a.core <= 0 ? 1 : 0;
    ev?.push({ t: 'end', winner: st.winner });
  }
}

/** Removes destroyed robots; Blast hits all enemy robots (chains are possible). */
function resolveDeaths(st: BattleState, ev: BattleEvent[] | null) {
  for (let guard = 0; guard < 20; guard++) {
    const dead: { side: number; u: Unit }[] = [];
    for (const side of [0, 1]) for (const u of st.sides[side].board) if (u.hp <= 0) dead.push({ side, u });
    if (!dead.length) return;
    for (const d of dead) {
      st.sides[d.side].board = st.sides[d.side].board.filter((x) => x !== d.u);
      st.wear[d.u.uid].destroyed = true;
      ev?.push({ t: 'destroyed', side: d.side, uid: d.u.uid });
    }
    for (const d of dead) {
      const ab = ability(d.u);
      if (ab?.kind !== 'blast') continue;
      const hits: { uid: string; dmg: number }[] = [];
      for (const e of st.sides[1 - d.side].board) {
        const dmg = Math.max(0, ab.n - armorOf(e));
        hits.push({ uid: e.uid, dmg });
        damageUnit(st, e, dmg);
      }
      ev?.push({ t: 'blast', side: d.side, from: d.u.uid, n: ab.n, hits });
    }
  }
}

// ---------- actions ----------

export const sameTarget = (a: Target, b: Target) =>
  a.side === b.side && ('core' in a ? 'core' in b : !('core' in b) && a.uid === b.uid);

/** Default target for Repair/Shock (for the AI and when the player does not choose). */
export function autoTarget(st: BattleState, side: number, modelId: string, targets: Target[]): Target | undefined {
  if (!targets.length) return undefined;
  const kind = model(modelId).ability?.kind;
  const score = (t: Target) => {
    if ('core' in t) return kind === 'repair' ? (CORE_HP - st.sides[side].core) * 0.8 : 0;
    const u = unitOf(st, t.side, t.uid)!;
    const md = model(u.modelId);
    return kind === 'repair'
      ? u.maxHp - u.hp + u.heat * 0.8 + md.atk * 0.2
      : md.atk * 2 + md.hp * 0.3 + (u.ready ? 1 : 0);
  };
  return [...targets].sort((a, b) => score(b) - score(a))[0];
}

/** Applies an action of the active side. Returns an error text or null. Mutates st. */
export function applyAction(st: BattleState, a: Action, ev: BattleEvent[] | null = st.history): string | null {
  if (st.winner !== undefined) return 'The battle is over';
  const side = st.active;
  const me = st.sides[side];
  const en = st.sides[1 - side];

  if (a.t === 'end') {
    endTurn(st, ev);
    return null;
  }

  if (a.t === 'deploy') {
    const hi = me.hand.indexOf(a.uid);
    if (hi < 0) return 'This robot is not in hand';
    const md = model(st.modelOf[a.uid]);
    if (md.cost > me.energy) return 'Not enough energy';
    if (me.board.length >= BOARD_SLOTS) return `The board holds ${BOARD_SLOTS} robots`;
    const targets = deployTargets(st, side, md.id);
    let target = a.target;
    if (target && !targets.some((t) => sameTarget(t, target!))) return 'Invalid target';
    if (!target && targets.length) target = autoTarget(st, side, md.id, targets);
    const taken = new Set(me.board.map((u) => u.pos));
    if (a.slot !== undefined && (a.slot < 0 || a.slot >= BOARD_SLOTS || taken.has(a.slot))) return 'This slot is taken';
    const pos = a.slot ?? [...Array(BOARD_SLOTS).keys()].find((i) => !taken.has(i))!;
    me.energy -= md.cost;
    me.hand.splice(hi, 1);
    const ab = md.ability;
    me.board.push({
      pos,
      uid: a.uid,
      modelId: md.id,
      hp: md.hp,
      maxHp: md.hp,
      heat: 0,
      ready: ab?.kind === 'charge',
      offline: false,
      chargeBonus: ab?.kind === 'charge' ? ab.n : 0,
      fresh: ab?.kind === 'charge',
    });
    st.wear[a.uid].fielded = true;
    ev?.push({ t: 'deploy', side, uid: a.uid });
    if (ab?.kind === 'repair' && target) {
      if ('core' in target) {
        const amount = Math.min(ab.n, CORE_HP - me.core);
        me.core += amount;
        ev?.push({ t: 'repair', side, from: a.uid, target: 'core', amount });
      } else {
        const t = unitOf(st, side, target.uid)!;
        const amount = Math.min(ab.n, t.maxHp - t.hp);
        t.hp += amount;
        t.heat = 0; // repair also fully cools the robot
        ev?.push({ t: 'repair', side, from: a.uid, target: t.uid, amount });
      }
    }
    if (ab?.kind === 'shock' && target && !('core' in target)) {
      const t = unitOf(st, 1 - side, target.uid)!;
      t.offline = true;
      t.ready = false;
      ev?.push({ t: 'shock', side, from: a.uid, target: t.uid });
    }
    return null;
  }

  if (a.t === 'vent') {
    const u = unitOf(st, side, a.uid);
    if (!u) return 'No such robot';
    if (!u.ready) return 'This robot cannot act this turn';
    const cooled = Math.min(u.heat, VENT_COOL);
    u.heat -= cooled;
    u.ready = false;
    ev?.push({ t: 'vent', side, uid: u.uid, cooled });
    return null;
  }

  // attack
  const u = unitOf(st, side, a.from);
  if (!u) return 'No such robot';
  if (!u.ready) return 'This robot cannot attack this turn';
  if (!attackTargets(st, side, u).includes(a.to)) return 'You must attack a guard first';
  const atk = model(u.modelId).atk + u.chargeBonus;
  u.chargeBonus = 0;
  u.ready = false;
  let dmg = atk;
  let counter = 0;
  if (a.to === 'core') {
    en.core -= dmg;
  } else {
    const t = unitOf(st, 1 - side, a.to)!;
    dmg = Math.max(0, atk - armorOf(t));
    counter = Math.max(0, model(t.modelId).atk - armorOf(u));
    damageUnit(st, t, dmg);
    damageUnit(st, u, counter);
    // Shock heats up its target; at the limit the target overheats and skips its next turn
    if (ability(u)?.kind === 'shock' && t.hp > 0) {
      t.heat += SHOCK_HEAT;
      if (t.heat >= heatCap(t.modelId)) {
        t.offline = true;
        t.ready = false;
        t.heat = 0;
        st.wear[t.uid].overheated = true;
        ev?.push({ t: 'overheat', side: 1 - side, uid: t.uid });
      }
    }
  }
  ev?.push({ t: 'attack', side, from: u.uid, to: a.to, dmg, counter });
  // heat
  u.heat += HEAT_PER_ATTACK;
  if (u.heat >= heatCap(u.modelId) && u.hp > 0) {
    u.offline = true;
    u.heat = 0;
    st.wear[u.uid].overheated = true;
    ev?.push({ t: 'overheat', side, uid: u.uid });
  }
  resolveDeaths(st, ev);
  checkWinner(st, ev);
  return null;
}

/**
 * Robot wear after the battle (DESIGN.md §6): every robot that went into battle −1,
 * destroyed −1 more, overheated −1 more (at most −3). Robots that stayed in hand don't wear.
 */
export function wearLoss(st: BattleState, uid: string): number {
  const w = st.wear[uid];
  if (!w || !w.fielded) return 0;
  return Math.min(3, 1 + (w.destroyed ? 1 : 0) + (w.overheated ? 1 : 0));
}

// ---------- simulation (two AIs) ----------

export interface AiStyle {
  /** 0 — risks everything to win, 1 — saves expensive robots from wear */
  careful: number;
}

// The AI lives in ai.ts; here only a hook to avoid a circular import.
type TurnAi = (st: BattleState, side: number, style: AiStyle, durability: Record<string, number>) => Action[];
let turnAi: TurnAi | null = null;
export const registerTurnAi = (fn: TurnAi) => {
  turnAi = fn;
};

/** The whole battle played by two AIs — for simulation and fast-forward. */
export function simulateBattle(teamA: Robot[], teamB: Robot[], seed: number, styles: [AiStyle, AiStyle]): BattleState {
  if (!turnAi) throw new Error('AI is not registered (import ./ai)');
  const st = createBattle(teamA, teamB, seed);
  const dur: Record<string, number> = {};
  for (const r of [...teamA, ...teamB]) dur[r.uid] = r.durability;
  for (let guard = 0; guard < 200 && st.winner === undefined; guard++) {
    const side = st.active;
    for (const a of turnAi(st, side, styles[side], dur)) {
      if (st.winner !== undefined || st.active !== side) break;
      applyAction(st, a, null);
    }
    if (st.winner === undefined && st.active === side) endTurn(st, null);
  }
  return st;
}
