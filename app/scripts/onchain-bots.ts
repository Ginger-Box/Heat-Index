// Demo traffic on NEAR testnet: a few clearly named bot players (bot-<name>.heat-index-game.testnet) play the real
// game engine and record everything on-chain through the same contract methods the game uses:
// battles against the NPC teams (reward and wear by the game's rules), and trades at the simulated market's prices
// (buy at a broker's ask, sell worn robots at a broker's bid, repair at the cheapest workshop).
// Account creation is signed with the contract account's key from the local near CLI credentials
// (~/.near-credentials/testnet/heat-index-game.testnet.json); the bots' keys are kept outside the repo.
// Run: npx tsx --tsconfig tsconfig.app.json scripts/onchain-bots.ts [battles per bot] [bot names…]

import '../src/engine/ai';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js';
import { simulateBattle, wearLoss } from '../src/engine/battle';
import { battleReward, ECON } from '../src/engine/pricing';
import { MODELS, maxDurability, model } from '../src/engine/robots';
import { advanceHours, bestBid, createWorld, quote, repairQuote, sideTeamValues, teamOf, type World } from '../src/engine/world';
import { Rng } from '../src/engine/rng';

const C = 'heat-index-game.testnet';
const BATTLES = Number(process.argv[2] ?? 8);
const NAMES = process.argv.slice(3).length ? process.argv.slice(3) : ['bot-alpha', 'bot-bravo', 'bot-charlie', 'bot-delta'];
const KEYS_DIR = join(homedir(), '.near-credentials', 'heat-index-bots'); // outside the repo
// FastNEAR's public testnet RPC (the default one rate-limits bursts with HTTP 429)
const rpc = new JsonRpcProvider({ url: process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** retry on rate limits (HTTP 429) with a growing pause */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 8 || !/429|Too Many|rate/i.test(`${String(e)} ${String((e as { cause?: unknown })?.cause)}`)) throw e;
      await sleep(4000 * (i + 1));
    }
  }
}
const view = (method: string, args: Record<string, unknown>) => retry(() => rpc.callFunction({ contractId: C, method, args }));

interface ChainRobot {
  token_id: string;
  metadata: { model_id: string; durability: number };
}

async function botAccount(name: string): Promise<Account> {
  mkdirSync(KEYS_DIR, { recursive: true });
  const file = join(KEYS_DIR, `${name}.json`);
  const id = `${name}.${C}`;
  if (existsSync(file)) return new Account(id, rpc, JSON.parse(readFileSync(file, 'utf8')).gameKey);
  const creds = JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${C}.json`), 'utf8'));
  const owner = KeyPair.fromRandom('ed25519');
  const game = KeyPair.fromRandom('ed25519');
  const factory = new Account(C, rpc, creds.private_key);
  const created = await retry(() => factory.callFunction({
    contractId: C,
    methodName: 'create_player_account',
    args: { name, owner_key: owner.getPublicKey().toString(), game_key: game.getPublicKey().toString() },
    gas: 150_000_000_000_000n,
  }));
  if (!created) throw new Error(`could not create ${id}`);
  writeFileSync(file, JSON.stringify({ accountId: id, ownerKey: owner.toString(), gameKey: game.toString() }), { mode: 0o600 });
  console.log(`[${name}] account created: ${id}`);
  return new Account(id, rpc, game.toString() as `ed25519:${string}`);
}

async function robotsOf(id: string): Promise<ChainRobot[]> {
  return (await view('mt_tokens_for_owner', { account_id: id, limit: 50 })) as ChainRobot[];
}

async function call(acc: Account, label: string, method: string, args: Record<string, unknown>) {
  try {
    const r = await retry(() => acc.callFunctionRaw({ contractId: C, methodName: method, args, gas: 30_000_000_000_000n }));
    console.log(`[${acc.accountId.split('.')[0]}] ${label} → ${r.transaction.hash}`);
    return r;
  } catch (e) {
    console.log(`[${acc.accountId.split('.')[0]}] ${label} FAILED: ${String(e).slice(0, 160)}`);
    return null;
  }
}

async function botRound(acc: Account, w: World, seed: number, rng: Rng, i: number) {
  {
    // the deck = the bot's working robots on-chain (up to 15)
    const chain = (await robotsOf(acc.accountId)).filter((t) => t.metadata.durability > 0);
    const deck = chain.slice(0, 15).map((t) => ({
      uid: t.token_id,
      modelId: t.metadata.model_id,
      durability: Math.min(t.metadata.durability, maxDurability(t.metadata.model_id)),
    }));
    if (deck.length >= 10) {
      const npcs = w.managers.filter((m) => m.id !== 'player');
      const opp = npcs[Math.floor(rng.next() * npcs.length)];
      const st = simulateBattle(deck, teamOf(w, opp), seed * 100 + i, [{ careful: 0.5 }, { careful: opp.careful }]);
      const res = st.winner === null ? 0.5 : st.winner === 0 ? 1 : 0;
      const [vA, vB] = sideTeamValues(st);
      const reward = battleReward(vA, vB, res, ECON.playerPurseRate);
      const wear = deck
        .filter((r) => st.wear[r.uid]?.fielded)
        .map((r) => ({ token_id: r.uid, durability: Math.max(0, r.durability - wearLoss(st, r.uid, true)) }));
      await call(acc, `battle vs ${opp.name}: ${res === 1 ? 'win' : res === 0 ? 'loss' : 'draw'} +${reward} CR`, 'record_battle', {
        opponent: opp.name,
        result: res === 1 ? 1 : res === 0 ? 0 : 2,
        reward: String(reward),
        seed: (seed * 100 + i) >>> 0,
        wear,
      });
    }
    // a trade between battles, at the simulated market's prices
    const robots = await robotsOf(acc.accountId);
    const credits = Number(await view('mt_balance_of', { account_id: acc.accountId, token_id: 'cr' }));
    const worn = robots
      .map((t) => ({ t, frac: t.metadata.durability / maxDurability(t.metadata.model_id) }))
      .sort((a, b) => a.frac - b.frac)[0];
    const roll = rng.next();
    if (worn && worn.frac < 0.5 && roll < 0.5) {
      const r = { uid: worn.t.token_id, modelId: worn.t.metadata.model_id, durability: Math.min(worn.t.metadata.durability, maxDurability(worn.t.metadata.model_id)), owner: 'bot' };
      const q = repairQuote(w, r);
      if (q && q.cost <= credits)
        await call(acc, `repair ${model(r.modelId).name} · ${q.cost} CR`, 'repair_robot', {
          token_id: r.uid,
          cost: String(q.cost),
          durability: maxDurability(r.modelId),
        });
    } else if (worn && worn.frac < 0.35) {
      const r = { uid: worn.t.token_id, modelId: worn.t.metadata.model_id, durability: Math.min(worn.t.metadata.durability, maxDurability(worn.t.metadata.model_id)), owner: 'bot' };
      const bid = bestBid(w, r);
      if (bid) await call(acc, `sell ${model(r.modelId).name} to ${bid.broker.name} · ${bid.price} CR`, 'sell_robot', { token_id: r.uid, price: String(bid.price), broker: bid.broker.id });
    } else {
      // buy something it can afford from the broker with the best ask
      const options = MODELS.flatMap((m) =>
        w.brokers.filter((b) => !b.closed).map((b) => ({ m, b, q: quote(w, b, m.id) })),
      ).filter((o) => o.q.stock > 0 && o.q.ask <= credits * 0.6);
      const pick = options[Math.floor(rng.next() * Math.max(1, options.length))];
      if (pick)
        await call(acc, `buy ${pick.m.name} from ${pick.b.name} · ${pick.q.ask} CR`, 'buy_robot', {
          model_id: pick.m.id,
          price: String(pick.q.ask),
          durability: maxDurability(pick.m.id),
          broker: pick.b.id,
        });
    }
  }
}

const w = createWorld(20261113, 'bots');
// one bot at a time (public RPCs rate-limit bursts); a round = every bot plays one battle and makes one trade
const bots: { acc: Account; rng: Rng; seed: number }[] = [];
for (const [i, n] of NAMES.entries()) {
  bots.push({ acc: await botAccount(n), rng: new Rng(1000 + i * 37), seed: 1000 + i * 37 });
  await sleep(1500);
}
for (let round = 0; round < BATTLES; round++) {
  const t0 = Date.now();
  for (const b of bots) {
    await botRound(b.acc, w, b.seed, b.rng, round);
    await sleep(1500);
  }
  advanceHours(w, 2); // the market moves between rounds
  const left = 31_000 - (Date.now() - t0); // the contract allows one battle per 30 s per account
  if (round < BATTLES - 1 && left > 0) await sleep(left);
}
console.log('stats:', await view('stats', {}));
