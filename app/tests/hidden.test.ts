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

test('a broker whose AI is unavailable falls back to its rules, and returns to the AI when it answers', async () => {
  const { applyPolicy, fallBackToRules, RULE_STYLE } = await import('../src/engine/brokerAi');
  const { createSharedWorld } = await import('../src/engine/world');
  const w = createSharedWorld(3);
  const b = w.brokers.find((x) => x.id === 'kessler')!;
  applyPolicy(w, b, { spread: 0.2, react: 0.3, targetStock: 4, focus: [], dump: [], remark: '' }, { model: 'm' });
  assert.equal(b.style.spread, 0.2);
  fallBackToRules(w, b);
  assert.equal(b.ai, undefined);
  assert.equal(b.mindOff, w.hour);
  // the rules, bent by a mood — still inside the bounds
  const { POLICY_BOUNDS, MOODS } = await import('../src/engine/brokerAi');
  const bd = POLICY_BOUNDS.kessler;
  assert.ok(MOODS.kessler.some((m) => m.text === b.mood));
  assert.ok(b.style.spread >= bd.spread[0] && b.style.spread <= bd.spread[1]);
  assert.ok(b.style.react >= bd.react[0] && b.style.react <= bd.react[1]);
  assert.ok(b.style.targetStock >= bd.stock[0] && b.style.targetStock <= bd.stock[1]);
  assert.ok(Math.abs(b.style.spread - RULE_STYLE.kessler.spread) <= 0.05);
  const events = w.events.length;
  fallBackToRules(w, b); // already on the rules: no repeated news
  assert.equal(w.events.length, events);
  applyPolicy(w, b, { spread: 0.12, react: 0.1, targetStock: 2, focus: [], dump: [], remark: '' }, { model: 'm' });
  assert.equal(b.mindOff, undefined);
  assert.equal(b.mood, undefined);
  assert.equal(b.style.spread, 0.12);
});

test("the player's own moves applied to the redacted view give the server's view (the client predicts them)", () => {
  let checks = 0;
  for (let g = 0; g < 20; g++) {
    const w = createWorld(g + 1, 'You', 2);
    const [a, b] = w.managers.filter((m) => m.team.length >= 4);
    const st = createBattle(teamOf(w, a), teamOf(w, b), 2000 + g);
    for (let t = 0; t < 60 && st.winner === undefined; t++) {
      const side = st.active;
      for (const act of planTurn(st, side, { careful: 0.5, sloppy: 0.1 })) {
        if (side === 0 && act.t !== 'end') {
          const local = redactBattle(st);
          const errLocal = applyAction(local, act, []);
          const errServer = applyAction(st, act, []);
          assert.equal(errLocal, errServer);
          const server = redactBattle(st);
          local.history = server.history = [];
          assert.deepEqual(redactBattle(local), server);
          checks++;
        } else applyAction(st, act, []);
        if (st.winner !== undefined) break;
      }
      if (st.active === side && st.winner === undefined) applyAction(st, { t: 'end' } as Action, []);
    }
  }
  assert.ok(checks > 100, `only ${checks} moves checked`);
});

test('the player market: list within the limit, escrow, buy pays the seller minus the fee, withdraw', async () => {
  const { MARKET, buyListing, getManager, listLimit, listRobot, robotsOf, unlistRobot, PLAYER_ID } = await import('../src/engine/world');
  const w = createWorld(5, 'You', 2);
  const me = getManager(w, PLAYER_ID);
  const [r, r2] = robotsOf(w, PLAYER_ID).filter((x) => !x.loaner && x.durability > 0);
  assert.ok(listRobot(w, PLAYER_ID, r.uid, listLimit(r) + 1));
  assert.equal(listRobot(w, PLAYER_ID, r.uid, listLimit(r)), null);
  assert.equal(w.robots[r.uid].owner, MARKET);
  const bot = w.managers.find((m) => m.id !== PLAYER_ID)!;
  bot.credits += 1000;
  const before = me.credits;
  const price = listLimit(w.robots[r.uid]);
  assert.equal(buyListing(w, bot.id, r.uid), null);
  assert.equal(w.robots[r.uid].owner, bot.id);
  assert.equal(me.credits, before + price - Math.floor((price * 5) / 100));
  assert.equal(listRobot(w, PLAYER_ID, r2.uid, 1), null);
  assert.equal(unlistRobot(w, PLAYER_ID, r2.uid), null);
  assert.equal(w.robots[r2.uid].owner, PLAYER_ID);
});
