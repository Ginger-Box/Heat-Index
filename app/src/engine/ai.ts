// AI for the «Overheat» battle: picks moves one at a time, greedily by position score.
// For every candidate move (deploy / attack each allowed target / cool down) the move is played on a copy
// of the board and the position is scored. The AI does not cheat: the opponent's hand is not counted.
// The score includes wear: a "careful" NPC avoids losing and overheating expensive robots (repairs cost money).

import { maxDurability, model } from './robots';
import {
  BOARD_SLOTS,
  applyAction,
  attackTargets,
  cloneLite,
  deployTargets,
  heatCap,
  registerTurnAi,
  type Action,
  type AiStyle,
  type BattleState,
  type Unit,
  type WearInfo,
} from './battle';

function unitValue(u: Unit): number {
  const md = model(u.modelId);
  const ab = md.ability;
  let v = md.atk * 1.4 + Math.max(0, u.hp);
  if (ab) {
    if (ab.kind === 'armor') v += ab.n * 1.5 + 1;
    else if (ab.kind === 'blast') v += ab.n * 1.2;
    else if (ab.kind === 'maneuver') v += 1.2;
    else v += 0.5;
  }
  v -= (u.heat / heatCap(u.modelId)) * md.atk * 0.6; // hot robot will overheat soon
  if (u.offline) v -= md.atk * 0.9;
  return v;
}

function evaluate(
  st: BattleState,
  side: number,
  style: AiStyle,
  dur: Record<string, number>,
  wear0: Record<string, WearInfo>,
): number {
  if (st.winner !== undefined) return st.winner === side ? 1e5 : st.winner === null ? -2000 : -1e5;
  const me = st.sides[side];
  const en = st.sides[1 - side];
  let v = (me.core - en.core) * 2;
  for (const u of me.board) v += unitValue(u);
  for (const u of en.board) v -= unitValue(u) * 1.05;
  for (const uid of me.hand) {
    const md = model(st.modelOf[uid]);
    v += (md.atk + md.hp) * 0.35;
  }
  // can the opponent finish us next turn?
  const threat = en.board.filter((u) => !u.offline).reduce((s, u) => s + model(u.modelId).atk, 0);
  if (threat >= me.core) v -= 60;
  // wear costs money: the careful style protects expensive and worn-out robots
  for (const uid of Object.keys(st.wear)) {
    const w = st.wear[uid];
    const w0 = wear0[uid];
    if (!w0 || !isMine(st, side, uid)) continue;
    const cost = model(st.modelOf[uid]).cost;
    const fragile = (dur[uid] ?? 10) / maxDurability(st.modelOf[uid]) <= 0.3 ? 2 : 1;
    const k = style.careful * fragile * cost;
    if (w.destroyed && !w0.destroyed) v -= k * 1.5;
    else if (w.damaged && !w0.damaged) v -= k * 0.4;
    if (w.overheated && !w0.overheated) v -= k * 0.5;
  }
  return v;
}

// Which side owns a robot (uids are unique; we remember who it belonged to at the start of the battle)
const ownerCache = new WeakMap<Record<string, string>, Record<string, number>>();
function isMine(st: BattleState, side: number, uid: string): boolean {
  let owners = ownerCache.get(st.modelOf);
  if (!owners) {
    owners = {};
    for (const s of [0, 1]) {
      const sd = st.sides[s];
      for (const x of [...sd.hand, ...sd.deck, ...sd.board.map((u) => u.uid)]) owners[x] = s;
    }
    ownerCache.set(st.modelOf, owners);
  }
  return owners[uid] === side;
}

/** All reasonable moves of the active side (identical models in hand are tried once). */
function candidates(st: BattleState): Action[] {
  const side = st.active;
  const me = st.sides[side];
  const out: Action[] = [];
  if (me.board.length < BOARD_SLOTS) {
    const seen = new Set<string>();
    for (const uid of me.hand) {
      const id = st.modelOf[uid];
      if (seen.has(id) || model(id).cost > me.energy) continue;
      seen.add(id);
      const targets = deployTargets(st, side, id);
      if (targets.length) for (const target of targets) out.push({ t: 'deploy', uid, target });
      else out.push({ t: 'deploy', uid });
    }
  }
  for (const u of me.board) {
    if (!u.ready) continue;
    for (const to of attackTargets(st, side, u)) out.push({ t: 'attack', from: u.uid, to });
    if (u.heat > 0) out.push({ t: 'vent', uid: u.uid });
  }
  return out;
}

/** The AI's whole turn: a list of moves (without the final end of turn). */
export function planTurn(st0: BattleState, side: number, style: AiStyle, dur: Record<string, number> = {}): Action[] {
  const st = cloneLite(st0);
  const wear0 = cloneLite(st0).wear;
  const plan: Action[] = [];
  for (let step = 0; step < 24 && st.winner === undefined && st.active === side; step++) {
    const base = evaluate(st, side, style, dur, wear0);
    let best: { a: Action; v: number; s: BattleState } | null = null;
    for (const a of candidates(st)) {
      const s = cloneLite(st);
      if (applyAction(s, a, null)) continue;
      const v = evaluate(s, side, style, dur, wear0);
      if (!best || v > best.v) best = { a, v, s };
    }
    if (!best || best.v <= base + 0.05) break;
    plan.push(best.a);
    applyAction(st, best.a, null);
  }
  return plan;
}

/** One next move for the player's opponent (for step-by-step animation). null — end the turn. */
export function nextMove(st: BattleState, side: number, style: AiStyle, dur: Record<string, number> = {}): Action | null {
  return planTurn(st, side, style, dur)[0] ?? null;
}

registerTurnAi(planTurn);
