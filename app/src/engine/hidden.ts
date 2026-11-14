// Hidden information in an online battle: what the player may see of the battle state. The server keeps the
// full state; the browser gets this view — the opponent's hand and deck become anonymous placeholders (their
// robot ids name the model, so even the ids are hidden), and nothing that could rebuild them (the input decks,
// the log, the random state) is sent. Robots on the board are public.

import type { BattleEvent, BattleState } from './battle';

export function redactBattle(st: BattleState): BattleState {
  const hidden = [...st.sides[1].hand, ...st.sides[1].deck];
  const v: BattleState = JSON.parse(JSON.stringify({ ...st, history: [], input: undefined, log: undefined }));
  v.sides[1].hand = st.sides[1].hand.map((_, i) => `?h${i}`);
  v.sides[1].deck = st.sides[1].deck.map((_, i) => `?d${i}`);
  for (const uid of hidden) {
    delete v.modelOf[uid];
    delete v.sideOf[uid];
    delete v.wear[uid];
    if (v.hpBonus) delete v.hpBonus[uid];
  }
  v.rngState = 0;
  return v;
}

/** Events as the player may see them: the opponent's draws don't say what was drawn. */
export function redactEvents(ev: BattleEvent[]): BattleEvent[] {
  return ev.map((e) => (e.t === 'draw' && e.side === 1 ? { ...e, uid: '?' } : e));
}
