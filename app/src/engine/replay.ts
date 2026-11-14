// Battle replays: a finished battle is fully described by its input (seed + both decks in order) and the log of
// accepted actions (engine/battle.ts records both). Anyone can replay it with this engine and check the result and
// the wear a player reported on NEAR — `npm run verify-battle <tx>` does exactly that. The log's SHA-256 is
// written on-chain with the battle (record_battle → `replay`), and the log itself is published by the game's
// Worker at /api/battles/<hash>.

import { applyAction, createBattle, wearLoss, type Action, type BattleInput, type BattleState } from './battle';
import type { Robot } from './robots';

export interface BattleLog {
  v: 1;
  input: BattleInput;
  actions: Action[];
}

export function battleLogOf(st: BattleState): BattleLog | null {
  return st.input && st.log ? { v: 1, input: st.input, actions: st.log } : null;
}

/** The canonical text of a log (what is hashed). */
export const logText = (log: BattleLog) => JSON.stringify(log);

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Replays a log. Returns the final state, or an error if any action is illegal or the battle doesn't end. */
export function replayBattle(log: BattleLog): { st: BattleState; error?: string } {
  const team = (side: 'a' | 'b'): Robot[] =>
    log.input[side].map((r) => ({ uid: r.uid, modelId: r.modelId, durability: r.dur ?? 1, ...(r.vw ? { vet: { b: r.vw, w: r.vw } } : {}) }));
  const st = createBattle(team('a'), team('b'), log.input.seed);
  for (const [i, a] of log.actions.entries()) {
    const err = applyAction(st, a, null);
    if (err) return { st, error: `action ${i + 1} (${a.t}) is illegal: ${err}` };
  }
  if (st.winner === undefined) return { st, error: 'the log ends before the battle does' };
  return { st };
}

/** What a replay says about side A's robots: durability after the battle (the player's light wear rules). */
export function replayWear(log: BattleLog, st: BattleState): { uid: string; tokenId?: string; before: number; after: number }[] {
  return log.input.a.map((r) => {
    const before = r.dur ?? 0;
    return { uid: r.uid, tokenId: r.tokenId, before, after: Math.max(0, before - wearLoss(st, r.uid, true)) };
  });
}
