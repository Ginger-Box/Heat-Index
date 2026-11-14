// Online battles run on the server; the browser only gets redacted views (engine/hidden.ts).
// This plays real AI-vs-AI battles and checks that no view or event ever names a robot in the opponent's hand or deck.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTurn } from '../src/engine/ai';
import { applyAction, createBattle, type Action, type BattleEvent } from '../src/engine/battle';
import { redactBattle, redactEvents } from '../src/engine/hidden';
import { createWorld, teamOf } from '../src/engine/world';

test("redacted battle views never reveal the opponent's hand or deck", () => {
  let checks = 0;
  for (let g = 0; g < 20; g++) {
    const w = createWorld(g + 1, 'You', 2);
    const [a, b] = w.managers.filter((m) => m.team.length >= 4);
    const st = createBattle(teamOf(w, a), teamOf(w, b), 1000 + g);
    for (let t = 0; t < 60 && st.winner === undefined; t++) {
      const side = st.active;
      for (const act of planTurn(st, side, { careful: 0.5, sloppy: 0.1 })) {
        const ev: BattleEvent[] = [];
        applyAction(st, act, ev);
        const v = redactBattle(st);
        const text = JSON.stringify([v, redactEvents(ev)]);
        for (const uid of [...st.sides[1].hand, ...st.sides[1].deck]) assert.ok(!text.includes(JSON.stringify(uid)), `leaked ${uid}`);
        assert.equal(v.input, undefined);
        assert.equal(v.log, undefined);
        assert.equal(v.rngState, 0);
        assert.equal(v.sides[1].hand.length, st.sides[1].hand.length);
        checks++;
        if (st.winner !== undefined) break;
      }
      if (st.active === side && st.winner === undefined) applyAction(st, { t: 'end' } as Action, []);
    }
  }
  assert.ok(checks > 300, `only ${checks} views checked`);
});
