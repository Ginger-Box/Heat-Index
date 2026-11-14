// Engine tests: battle rules and determinism, pricing invariants (and that they match the NEAR contract's
// constants), the economy over simulated days, league, veterans, daily caps, restoring a player from the chain.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../src/engine/ai';
import { applyAction, attackTargets, createBattle, endTurn, simulateBattle, wearLoss, type BattleState } from '../src/engine/battle';
import { DIVISIONS, NPC_SETUP, divisionPrize, CROWN_DEFENSE_PRIZE } from '../src/engine/league';
import { BASE_PRICE, MODELS, maxDurability, model, type Robot } from '../src/engine/robots';
import { DAILY_GAIN_MAX, GAIN_MAX, bidPrice, gainCap, repairCost } from '../src/engine/pricing';
import { VET_PRICE, VET_WINS, VET_WINS_PER_DAY, vetRank } from '../src/engine/veteran';
import { teamError } from '../src/engine/team';
import { Rng } from '../src/engine/rng';
import {
  DAILY_PURSE_MAX,
  HOURS_PER_DAY,
  PLAYER_ID,
  advanceHours,
  applyMatch,
  brokerFair,
  createWorld,
  getManager,
  leagueOf,
  pickOpponentForPlayer,
  quote,
  restorePlayerFromChain,
  robotsOf,
  sell,
  buy,
  teamOf,
  type World,
} from '../src/engine/world';

const contract = readFileSync(new URL('../../contract/src/lib.rs', import.meta.url), 'utf8');
const rustConst = (name: string) => {
  const m = contract.match(new RegExp(`const ${name}: [^=]+= ([^;]+);`));
  assert.ok(m, `constant ${name} not found in the contract`);
  return m![1].replace(/_/g, '');
};
const mk = (ids: string[], tag: string): Robot[] => ids.map((id, i) => ({ uid: `${id}#${tag}${i}`, modelId: id, durability: maxDurability(id) }));
const deckA = mk(['spark', 'scout', 'bolt', 'ram', 'welder', 'volt', 'wall', 'dozer', 'drone', 'cracker', 'dash', 'plate'], 'a');
const deckB = mk(['hound', 'zapper', 'arc', 'bolt', 'plate', 'mine', 'ram', 'drone', 'scout', 'spark'], 'b');

// ---------- the contract mirrors the game's rules ----------

test('model table and prices match the NEAR contract', () => {
  const table = [...contract.matchAll(/\("([a-z]+)", (\d)\)/g)].map((m) => [m[1], Number(m[2])]);
  assert.equal(table.length, MODELS.length);
  for (const [id, cost] of table) assert.equal(model(id as string).cost, cost, `${id} cost`);
  assert.deepEqual(JSON.parse(rustConst('BASE_PRICE')), BASE_PRICE);
  for (const x of MODELS) assert.equal(x.maxDur, 4 + 2 * x.cost, `${x.id} durability`);
});

test('veteran thresholds, prices and caps match the NEAR contract', () => {
  assert.deepEqual(JSON.parse(rustConst('VET_WINS')), VET_WINS);
  assert.deepEqual(JSON.parse(rustConst('VET_PRICE_PCT')), VET_PRICE.map((x) => Math.round(x * 100)));
  assert.equal(Number(rustConst('VET_WINS_PER_DAY')), VET_WINS_PER_DAY);
  assert.equal(Number(rustConst('GAIN_MAX_PCT')), GAIN_MAX * 100);
  assert.equal(Number(rustConst('DAILY_GAIN_MAX')), DAILY_GAIN_MAX);
  assert.equal(Number(rustConst('DAILY_PURSE_MAX')), DAILY_PURSE_MAX);
  assert.deepEqual(JSON.parse(rustConst('LEAGUE_PRIZE')), DIVISIONS.map((d) => d.prize));
  assert.equal(Number(rustConst('CROWN_DEFENSE_PRIZE')), CROWN_DEFENSE_PRIZE);
});

test('league teams and divisions match the NEAR contract', () => {
  const league = [...contract.matchAll(/\("([A-Za-z0-9 -]+)", (\d)\)/g)].map((m) => [m[1], Number(m[2])]);
  for (const t of NPC_SETUP) assert.ok(league.some(([n, d]) => n === t.name && d === t.div), `${t.name} in division ${t.div}`);
});

// ---------- battle ----------

test('battles are deterministic for the same seed and decks', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const a = simulateBattle(deckA, deckB, seed, [{ careful: 0.5 }, { careful: 0.5 }]);
    const b = simulateBattle(deckA, deckB, seed, [{ careful: 0.5 }, { careful: 0.5 }]);
    assert.equal(a.winner, b.winner);
    assert.deepEqual(a.wear, b.wear);
    assert.deepEqual([a.sides[0].core, a.sides[1].core], [b.sides[0].core, b.sides[1].core]);
  }
});

test('every battle ends, with a winner or a draw, and cores never go above 20', () => {
  const rng = new Rng(7);
  for (let i = 0; i < 60; i++) {
    const st = simulateBattle(deckA, deckB, rng.int(2 ** 31), [{ careful: rng.next() }, { careful: rng.next() }]);
    assert.notEqual(st.winner, undefined);
    for (const s of st.sides) assert.ok(s.core <= 20);
  }
});

test('guards must be attacked first; an illegal move is rejected and changes nothing', () => {
  const st: BattleState = createBattle(mk(['scout', 'bolt', 'spark', 'ram', 'dash', 'drone', 'cracker', 'plate', 'volt', 'wall'], 'x'), mk(['wall', 'bolt', 'spark', 'ram', 'dash', 'drone', 'cracker', 'plate', 'volt', 'scout'], 'y'), 3);
  const before = JSON.stringify(st.sides);
  assert.ok(applyAction(st, { t: 'attack', from: 'nope', to: 'core' }));
  assert.equal(JSON.stringify(st.sides), before);
  // an enemy guard on the board: a normal attacker may only hit guards
  const guard = { uid: 'g', modelId: 'wall', hp: 3, maxHp: 3, heat: 0, ready: true, offline: false, chargeBonus: 0, fresh: false, pos: 0 };
  st.sides[1].board.push(guard);
  const me = { uid: 'm', modelId: 'bolt', hp: 4, maxHp: 4, heat: 0, ready: true, offline: false, chargeBonus: 0, fresh: false, pos: 0 };
  assert.deepEqual(attackTargets(st, 0, me), ['g']);
  // a flanker (maneuver) ignores guards
  assert.ok(attackTargets(st, 0, { ...me, modelId: 'scout' }).includes('core'));
  endTurn(st);
  assert.equal(st.active, 1);
});

test('wear: the player loses durability only when destroyed or overheated; NPCs lose 1–3 per fielded robot', () => {
  const st = simulateBattle(deckA, deckB, 11, [{ careful: 0.5 }, { careful: 0.5 }]);
  for (const [uid, w] of Object.entries(st.wear)) {
    const light = wearLoss(st, uid, true);
    const heavy = wearLoss(st, uid, false);
    if (!w.fielded) assert.deepEqual([light, heavy], [0, 0]);
    else {
      assert.equal(light, (w.destroyed ? 1 : 0) + (w.overheated ? 1 : 0));
      assert.ok(heavy >= 1 && heavy <= 3);
    }
  }
});

// ---------- prices ----------

test('every broker price stays inside the range the contract accepts', () => {
  const w = createWorld(42, 't');
  advanceHours(w, HOURS_PER_DAY * 3);
  for (const b of w.brokers)
    for (const x of MODELS) {
      const ask = quote(w, b, x.id).ask;
      assert.ok(ask >= x.basePrice * 0.3 && ask <= x.basePrice * 2.8, `${b.name} ${x.id} ask ${ask}`);
      const fair = brokerFair(w, b, x.id);
      for (const d of [1, Math.ceil(x.maxDur / 2), x.maxDur]) {
        const r = { uid: 'r', modelId: x.id, durability: d };
        const bid = bidPrice(fair, b.style, r);
        assert.ok(bid <= gainCap(r), 'bid within the anti-arbitrage cap');
        assert.ok(bid <= x.basePrice * 2.4, 'bid within the contract sell cap');
        assert.ok(repairCost(fair, r) >= 0);
      }
    }
});

test('a robot bought at the bottom can be resold for at most 2.5× its price', () => {
  const r = { uid: 'r', modelId: 'titan', durability: 16, paid: 168 };
  assert.equal(gainCap(r), 420);
  assert.equal(gainCap({ ...r, vet: { b: 20, w: 15 } }), Math.floor(168 * 2.5 * 1.6));
});

// ---------- economy ----------

test('a simulated week: nobody goes negative, every NPC deck is legal and within its league limit', () => {
  const w = createWorld(2026, 't');
  advanceHours(w, HOURS_PER_DAY * 7);
  for (const m of w.managers) assert.ok(m.credits >= 0, `${m.name} credits ${m.credits}`);
  for (const b of w.brokers) assert.ok(b.closed || b.credits >= 0, `${b.name} cash`);
  for (const m of w.managers.filter((x) => x.id !== PLAYER_ID)) {
    const team = teamOf(w, m);
    assert.equal(teamError(team), null, `${m.name} deck`);
    assert.ok(team.reduce((s, r) => s + model(r.modelId).cost, 0) <= DIVISIONS[m.div!].cap, `${m.name} within ${DIVISIONS[m.div!].name}`);
  }
  for (const r of Object.values(w.robots)) assert.ok(r.durability >= 0 && r.durability <= maxDurability(r.modelId));
});

test('buying and selling move credits between the player and a broker', () => {
  const w = createWorld(5, 't');
  const me = getManager(w, PLAYER_ID);
  const b = w.brokers.find((x) => x.id === 'soroka')!;
  const before = me.credits + b.credits;
  assert.equal(buy(w, PLAYER_ID, b.id, 'bolt'), null);
  const bought = robotsOf(w, PLAYER_ID).find((r) => r.paid !== undefined)!;
  assert.ok(bought);
  assert.equal(me.credits + b.credits, before, 'a purchase moves credits, it does not create them');
  assert.equal(sell(w, PLAYER_ID, bought.uid), null);
  assert.ok(me.credits <= before);
});

// ---------- league, veterans, daily purse ----------

function winAgainst(w: World, oppId: string, seed: number) {
  const me = getManager(w, PLAYER_ID);
  for (let i = 0; i < 200; i++) {
    const st = simulateBattle(teamOf(w, me), teamOf(w, getManager(w, oppId)), seed + i * 977, [{ careful: 0.5 }, { careful: 0.5, sloppy: 1 }]);
    if (st.winner === 0) {
      applyMatch(w, PLAYER_ID, oppId, st);
      return;
    }
  }
  assert.fail('could not win a battle');
}

test('beating every team of a division moves the player up and pays the prize', () => {
  const w = createWorld(9, 't');
  const me = getManager(w, PLAYER_ID);
  assert.equal(leagueOf(w).div, 0);
  for (const t of w.managers.filter((m) => m.div === 0)) winAgainst(w, t.id, 100);
  assert.equal(leagueOf(w).div, 1);
  assert.ok(me.credits > 1000);
  assert.equal(divisionPrize(3, 1), CROWN_DEFENSE_PRIZE);
  // the matchmaker now offers Chrome League teams
  assert.equal(pickOpponentForPlayer(w).div, 1);
});

test('wins make veterans, at most VET_WINS_PER_DAY a day for the player', () => {
  const w = createWorld(13, 't');
  const opp = w.managers.find((m) => m.div === 0)!;
  for (let i = 0; i < VET_WINS_PER_DAY + 3; i++) winAgainst(w, opp.id, 500 + i * 31);
  const best = Math.max(...robotsOf(w, PLAYER_ID).map((r) => r.vet?.w ?? 0));
  assert.equal(best, VET_WINS_PER_DAY);
  assert.ok(robotsOf(w, PLAYER_ID).some((r) => vetRank(r) >= 1));
});

test('battle rewards are capped by the daily purse', () => {
  const w = createWorld(17, 't');
  w.purseDay = { day: Math.floor(Date.now() / 86_400_000), amount: DAILY_PURSE_MAX - 10 };
  const me = getManager(w, PLAYER_ID);
  const before = me.credits;
  winAgainst(w, w.managers.find((m) => m.div === 0)!.id, 900);
  assert.ok(me.credits - before <= 10);
});

// ---------- NEAR restore ----------

test('restoring a player from chain data rebuilds robots, credits, records, league and a legal deck', () => {
  const w = createWorld(21, 't');
  const robots = MODELS.slice(0, 14).map((x, i) => ({ tokenId: `robot:${x.id}:${i}`, modelId: x.id, durability: x.maxDur - 1, battles: 9, wins: 8 }));
  restorePlayerFromChain(w, 'alice.testnet', { credits: 1234, robots, league: { div: 2, beaten: ['Night Shift'], crowns: 0 } });
  const me = getManager(w, PLAYER_ID);
  assert.equal(me.credits, 1234);
  assert.equal(robotsOf(w, PLAYER_ID).filter((r) => r.chainId).length, 14);
  assert.ok(robotsOf(w, PLAYER_ID).every((r) => vetRank(r) === 2));
  assert.equal(teamError(teamOf(w, me)), null);
  assert.equal(leagueOf(w).div, 2);
  assert.equal(leagueOf(w).beaten.length, 1);
  assert.equal(w.chainAccount, 'alice.testnet');
});

// ---------- replays ----------

test('a recorded battle replays to the same winner and wear; a tampered log is rejected', async () => {
  const { battleLogOf, replayBattle, replayWear, logText, sha256Hex } = await import('../src/engine/replay');
  for (const seed of [3, 8, 21]) {
    const st = simulateBattle(deckA, deckB, seed, [{ careful: 0.4 }, { careful: 0.6, sloppy: 0.3 }]);
    const log = JSON.parse(logText(battleLogOf(st)!));
    const r = replayBattle(log);
    assert.equal(r.error, undefined);
    assert.equal(r.st.winner, st.winner);
    for (const w of replayWear(log, r.st)) assert.equal(w.after, Math.max(0, w.before - wearLoss(st, w.uid, true)));
    assert.equal((await sha256Hex(logText(log))).length, 64);
  }
  const st = simulateBattle(deckA, deckB, 5, [{ careful: 0.5 }, { careful: 0.5 }]);
  const log = battleLogOf(st)!;
  // claim a win the replay doesn't show: drop the last actions
  const cut = { ...log, actions: log.actions.slice(0, Math.floor(log.actions.length / 2)) };
  assert.ok(replayBattle(cut).error);
  // an attack by a robot that isn't on the board
  const bad = { ...log, actions: [{ t: 'attack', from: 'ghost#x', to: 'core' } as const, ...log.actions] };
  assert.match(replayBattle(bad).error ?? '', /illegal/);
});

// ---------- broker minds (NEAR AI) ----------

test('a broker model answer is clamped to the broker\'s bounds; garbage is ignored', async () => {
  const { parsePolicy, applyPolicy, brokerPrompt, POLICY_BOUNDS } = await import('../src/engine/brokerAi');
  const w = createWorld(31, 't');
  const k = w.brokers.find((b) => b.id === 'kessler')!;
  const p = parsePolicy(k, '<think>{"x":1}</think> sure: {"spread": 0.9, "react": 5, "targetStock": 99, "focus": ["titan","spark","nope"], "dump": ["bastion"], "remark": "Steady."}'.replace(/<think>[\s\S]*?<\/think>/g, ''))!;
  assert.deepEqual([p.spread, p.react, p.targetStock], [POLICY_BOUNDS.kessler.spread[1], POLICY_BOUNDS.kessler.react[1], POLICY_BOUNDS.kessler.stock[1]]);
  assert.deepEqual(p.focus, ['titan']); // spark is outside Kessler's segment, "nope" isn't a model
  assert.equal(parsePolicy(k, 'no json here'), null);
  applyPolicy(w, k, p, { model: 'test' });
  assert.equal(k.style.spread, POLICY_BOUNDS.kessler.spread[1]);
  assert.ok(k.ai && k.ai.dump.includes('bastion'));
  assert.ok(brokerPrompt(w, k)[1].content.includes('"market"'));
  advanceHours(w, 3); // the world keeps running with the policy applied
  assert.ok(robotsOf(w, 'kessler').every((r) => r.modelId !== 'bastion' || r.durability >= 0));
});
