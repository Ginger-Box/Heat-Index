// The HEAT INDEX world: brokers, managers (NPCs and the player), robots, statistics, the season.
// The state is a plain serializable object: it can live in the browser or on a server
// and be checked against the on-chain records (ledger).

import './ai'; // registers the battle AI used by simulateBattle
import { simulateBattle, wearLoss, type BattleState } from './battle';
import {
  DAILY_GAIN_MAX,
  ECON,
  askPrice,
  battleReward,
  bidPrice,
  explainPrice,
  fairPrice,
  relevance,
  repairCost,
  scrapPrice,
  updatePerceived,
  winRate,
  type BrokerStyle,
  type ModelStats,
} from './pricing';
import { Rng } from './rng';
import { MAX_SAME_MODEL, MODELS, TEAM_MIN, classOf, durFrac, maxDurability, model, type Robot, type RobotClass } from './robots';
import { buildTeam, partialTeamError, teamEnergy, teamError } from './team';
import { DIVISIONS, KING_TITLE, NPC_SETUP, divisionPrize, type LeagueState } from './league';
import { VET_NAME, VET_WINS_PER_DAY, vetRank, vetStars } from './veteran';
import { battleLogOf } from './replay';

export const PLAYER_ID = 'player';

/**
 * Hooks for the human player's moves — the NEAR bridge (src/near/bridge.ts) mirrors them on-chain.
 * The engine stays pure: it only calls these if someone set them.
 */
export const playerHooks: {
  buy?: (r: OwnedRobot, price: number, brokerId: string) => void;
  sell?: (r: OwnedRobot, price: number, brokerId: string) => void;
  repair?: (r: OwnedRobot, cost: number) => void;
  match?: (st: BattleState, opponentId: string, result: 0 | 1 | 2, reward: number) => void;
  /** shared world (logged-in players): every move of the local player is also sent to the world server as
   *  (operation, args) — the server replays it on the shared world with the player's account as the manager */
  op?: (name: string, args: unknown[]) => void;
} = {};
const shareOp = (managerId: string, name: string, args: unknown[]) => {
  if (managerId === PLAYER_ID) playerHooks.op?.(name, args);
};

/** A live person (the local player, or a logged-in player in the shared world) — they play by the human rules:
 *  light wear, the Arena purse, the league, daily caps. */
export const isHuman = (m: Manager) => m.id === PLAYER_ID || !!m.human;
/** NPC deck cost limit = their league's (Scrap 24 … Apex 42); the player's limit is always 42. */
export const npcDeckCost = (m: Manager) => DIVISIONS[m.div ?? 0].cap;
export const HOUSE = 'house'; // the broker's founders
export const HOURS_PER_DAY = 12;
export const MATCHES_PER_HOUR = 12;
export const DAYS_PER_SEASON = 7;

export type Strategy = 'hype' | 'contrarian' | 'thrifty' | 'player';

export const STRATEGY_LABEL: Record<Strategy, string> = {
  hype: 'Hype chasers: buy the most relevant',
  contrarian: 'Contrarians: hunt the underrated',
  thrifty: 'Thrifty: repair and save',
  player: 'Player',
};

export interface Manager {
  id: string;
  name: string;
  strategy: Strategy;
  careful: number; // AI battle style
  focus?: RobotClass; // the robot class this NPC plays (the player has none)
  /** second class for the combo teams of the upper leagues (e.g. Armor + Repair) */
  focus2?: RobotClass;
  /** league division 0…3 (NPCs; a human's climb is in `league`) */
  div?: number;
  /** a logged-in player in the shared world (id = their NEAR account) */
  human?: boolean;
  /** a human's climb through the Pit League */
  league?: LeagueState;
  /** a human's battle rewards + league prizes today (UTC day) — capped like on NEAR */
  purseDay?: { day: number; amount: number };
  /** a human's realised trading profit today — capped like on NEAR */
  gainDay?: { day: number; amount: number };
  credits: number;
  team: string[]; // uid robot uids — the deck that goes into battle (for the player = the active deck from decks)
  /** Player: 5 named decks; a robot can stand in one deck only. activeDeck — the one that goes into battle. */
  decks?: Deck[];
  activeDeck?: number;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface Deck {
  name: string;
  uids: string[];
}
export const DECK_COUNT = 5;

export interface Broker {
  id: string;
  name: string;
  tagline: string;
  style: BrokerStyle;
  credits: number;
  closed: boolean;
  perceived: Record<string, number>; // relevance as the broker sees it
  shares: Record<string, number>; // owner -> shares
  dayStartCredits: number;
  /** equity at the start of the day — the day's profit is measured from it */
  dayStartEquity?: number;
  investedToday: number;
  lastDividend: number;
  /** profit over the last days (up to 7), CR */
  profitLog?: number[];
  /** dividends per share over the last days (up to 7), CR */
  divPerShareLog?: number[];
  /** total dividends received by each owner */
  paidTotal?: Record<string, number>;
  /** how many robots of each model were bought from the Factory today (expensive ones are capped) */
  restockedToday?: Record<string, number>;
  /** the broker's latest decision by its LLM mind (shared world, engine/brokerAi.ts) */
  ai?: {
    at: number;
    spread: number;
    react: number;
    targetStock: number;
    focus: string[];
    dump: string[];
    remark: string;
    model: string;
    chatId?: string;
  };
}

export type OwnedRobot = Robot & { owner: string; loaner?: boolean; /** NEP-245 token id of this robot on NEAR, once it is on-chain */ chainId?: string };

export interface WorldEvent {
  tick: number;
  day: number;
  kind: 'price' | 'broker' | 'match' | 'season' | 'player' | 'dividend';
  text: string;
}

export interface Snapshot {
  tick: number;
  day: number;
  hour: number;
  rel: Record<string, number>;
  price: Record<string, number>;
}

export type LedgerKind =
  | 'buy'
  | 'sell'
  | 'repair'
  | 'scrap'
  | 'invest'
  | 'divest'
  | 'dividend'
  | 'mint'
  | 'match'
  | 'reward';
export interface LedgerEntry {
  tick: number;
  kind: LedgerKind;
  from: string;
  to: string;
  uid?: string;
  amount: number;
  note?: string;
}

export interface SeasonResult {
  season: number;
  champions: { id: string; name: string; elo: number; prize: number }[];
  magnates: { id: string; name: string; worth: number; prize: number }[];
}

export interface World {
  version: 1;
  rngState: number;
  tick: number; // NPC matches played
  hour: number; // game hours passed in total
  season: number;
  robots: Record<string, OwnedRobot>;
  serial: number;
  stats: Record<string, ModelStats>;
  brokers: Broker[];
  managers: Manager[];
  history: Snapshot[];
  events: WorldEvent[];
  ledger: LedgerEntry[];
  dayStartPrice: Record<string, number>;
  reportedToday: string[];
  seasons: SeasonResult[];
  /** the player's climb through the Pit League */
  league?: LeagueState;
  /** the player's realised trading profit today (UTC day number) — capped like on NEAR */
  gainDay?: { day: number; amount: number };
  /** the player's battle rewards + league prizes today (UTC day) — capped like on NEAR */
  purseDay?: { day: number; amount: number };
  /** the last battle's reward to the player, and whether a limit cut it */
  lastPlayerReward?: { reward: number; capped: boolean };
  /** the NEAR account this world's player side was last restored from / mirrored to */
  chainAccount?: string;
  /** game hours per day / NPC matches per game hour (absent: 12 / 12 — a local world) */
  hoursPerDay?: number;
  matchesPerHour?: number;
  /** ELO and W/D/L count only ranked (online) battles — set once the old, mixed records were reset */
  rankedOnly?: boolean;
  /** the Factory is on strike (no restocking) until this game hour */
  strikeUntil?: number;
}

/** Game hours in a day: 12 in a local world (08:00–20:00); the shared world has 288 five-minute "hours", so its
 *  prices, brokers and charts move every 5 real minutes while a game day is still a real day. */
export const hoursPerDay = (w: World) => w.hoursPerDay ?? HOURS_PER_DAY;
export const matchesPerHour = (w: World) => w.matchesPerHour ?? MATCHES_PER_HOUR;
/** "HH:MM" of a game hour (local: 08:00–19:00; shared: the real time of day) */
export function clockOf(w: World, hour: number): string {
  const hpd = hoursPerDay(w);
  if (hpd === HOURS_PER_DAY) return `${String(8 + (hour % hpd)).padStart(2, '0')}:00`;
  const min = Math.round(((hour % hpd) * 1440) / hpd);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
export const dayOf = (w: World) => Math.floor(w.hour / hoursPerDay(w)) + 1;
export const dayInSeason = (w: World) => ((dayOf(w) - 1) % DAYS_PER_SEASON) + 1;

// ---------- helpers ----------

function withRng<T>(w: World, fn: (r: Rng) => T): T {
  const r = new Rng(w.rngState);
  const out = fn(r);
  w.rngState = r.state;
  return out;
}

function mint(w: World, modelId: string, owner: string): OwnedRobot {
  const uid = `${modelId}#${++w.serial}`;
  const r: OwnedRobot = { uid, modelId, durability: maxDurability(modelId), owner };
  w.robots[uid] = r;
  return r;
}

function log(w: World, kind: WorldEvent['kind'], text: string) {
  w.events.push({ tick: w.tick, day: dayOf(w), kind, text });
  if (w.events.length > 400) w.events.splice(0, w.events.length - 400);
}

function ledger(w: World, e: Omit<LedgerEntry, 'tick'>) {
  w.ledger.push({ tick: w.tick, ...e });
  if (w.ledger.length > 3000) w.ledger.splice(0, w.ledger.length - 3000);
}

export const getManager = (w: World, id: string) => {
  const m = w.managers.find((x) => x.id === id);
  if (!m) throw new Error(`No manager ${id}`);
  return m;
};
export const getBroker = (w: World, id: string) => {
  const b = w.brokers.find((x) => x.id === id);
  if (!b) throw new Error(`No broker ${id}`);
  return b;
};

export const robotsOf = (w: World, owner: string) => Object.values(w.robots).filter((r) => r.owner === owner);

export const teamOf = (w: World, m: Manager): OwnedRobot[] =>
  m.team.map((u) => w.robots[u]).filter((r) => r && r.owner === m.id);

// ---------- relevance and prices ----------

export function pickCounts(w: World): Record<string, number> {
  const c: Record<string, number> = Object.fromEntries(MODELS.map((x) => [x.id, 0]));
  for (const m of w.managers) for (const r of teamOf(w, m)) c[r.modelId]++;
  return c;
}

export function actualRelevance(w: World, counts = pickCounts(w)): Record<string, number> {
  const max = Math.max(...Object.values(counts));
  return Object.fromEntries(MODELS.map((x) => [x.id, relevance(w.stats[x.id], counts[x.id], max)]));
}

/** Working (not broken) robots of a model in a broker's stock. */
/**
 * Each broker trades its own segment: Kessler Corp — mid and expensive robots (energy 3–6), Magpie — everything,
 * the Junkman — cheap robots (energy 1–3) plus scrap of any model.
 */
export const BROKER_TAGLINE: Record<string, string> = {
  kessler: 'Conservative megacorp. Mid and expensive robots only (energy 3–6). Pricey, steady, never broke.',
  soroka: 'Black market. Every model, cheap and quick to catch the hype — and always one raid from ruin.',
  scrap: 'Scrap dealer. Cheap robots only (energy 1–3) — and buys broken robots of any model for parts.',
};
export const BROKER_RANGE: Record<string, [number, number]> = { kessler: [3, 6], scrap: [1, 3] };
export const carries = (b: Broker, modelId: string) => {
  const c = model(modelId).cost;
  return c >= (b.style.minCost ?? 1) && c <= (b.style.maxCost ?? 6);
};
export const rangeLabel = (b: Broker) =>
  b.style.minCost || b.style.maxCost ? `energy ${b.style.minCost ?? 1}–${b.style.maxCost ?? 6} robots` : 'every robot';

export const brokerStock = (w: World, b: Broker, modelId: string) =>
  robotsOf(w, b.id).filter((r) => r.modelId === modelId && r.durability > 0);

export const brokerFair = (w: World, b: Broker, modelId: string) =>
  fairPrice(modelId, b.perceived[modelId], brokerStock(w, b, modelId).length, b.style);

export interface Quote {
  brokerId: string;
  modelId: string;
  ask: number;
  stock: number;
  explanation: string;
}

export function quote(w: World, b: Broker, modelId: string, rel = actualRelevance(w)): Quote {
  const stock = brokerStock(w, b, modelId).length;
  const ask = askPrice(brokerFair(w, b, modelId), b.style);
  return {
    brokerId: b.id,
    modelId,
    ask,
    stock,
    explanation: explainPrice({
      brokerName: b.name,
      modelId,
      ask,
      perceived: b.perceived[modelId],
      actual: rel[modelId],
      winRate: winRate(w.stats[modelId]),
      stock,
      style: b.style,
    }),
  };
}

/** Average fair price across open brokers — for charts and asset values. */
export function refPrice(w: World, modelId: string): number {
  const open = w.brokers.filter((b) => !b.closed && carries(b, modelId));
  const list = open.length ? open : w.brokers.filter((b) => carries(b, modelId));
  return list.reduce((s, b) => s + brokerFair(w, b, modelId), 0) / list.length;
}

/** The model's stock is already twice the target — the broker stops buying it (otherwise it overstocks and sells at a loss) */
const overstocked = (w: World, b: Broker, modelId: string) => brokerStock(w, b, modelId).length >= b.style.targetStock * 2;

export function bestBid(w: World, r: OwnedRobot): { broker: Broker; price: number } | null {
  if (r.loaner) return null; // the Arena's written-off loaners are not bought
  let best: { broker: Broker; price: number } | null = null;
  for (const b of w.brokers) {
    if (b.closed) continue;
    const fair = brokerFair(w, b, r.modelId);
    let price: number;
    if (r.durability <= 0) {
      if (!b.style.scrapper) continue;
      // the scrap yard is full — no new scrap (the scrap dealer used to pay for scrap it then melted anyway)
      if (robotsOf(w, b.id).filter((x) => x.durability <= 0).length >= SCRAP_YARD_CAP) continue;
      price = scrapPrice(fair);
    } else {
      if (!carries(b, r.modelId) || overstocked(w, b, r.modelId)) continue;
      price = bidPrice(fair, b.style, r) * (b.style.scrapper ? SCRAPPER_WORKING_BID : 1);
    }
    price = Math.round(price);
    // buying a robot, the broker never dips below its reserve — otherwise it goes broke on other people's sell-offs
    if (price > b.credits - BANKRUPT_BELOW - 100 * RESERVE) continue;
    if (!best || price > best.price) best = { broker: b, price };
  }
  return best;
}

/** Stock is valued cautiously — at 70% of the base price (it still has to be sold). */
const STOCK_BOOK = 0.7;
/** The scrap dealer buys working robots reluctantly — at a discount (its business is broken ones). */
const SCRAPPER_WORKING_BID = 0.8;

/** A broker's equity: cash + a cautious value of the stock. Share price and profit are computed from it. */
export function brokerEquity(w: World, b: Broker): number {
  const stockValue = robotsOf(w, b.id).reduce(
    (s, r) => s + model(r.modelId).basePrice * (0.5 + 0.5 * durFrac(r)),
    0,
  );
  return b.credits + stockValue * STOCK_BOOK;
}

export const totalShares = (b: Broker) => Object.values(b.shares).reduce((s, x) => s + x, 0);

export function sharePrice(w: World, b: Broker): number {
  return Math.max(0.1, brokerEquity(w, b) / Math.max(1, totalShares(b)));
}

/**
 * Expected income per day per 100 CR invested — the average over the last days
 * ((dividends per share / current share price). A forecast from the past, not a promise.
 */
export function expectedDailyPer100(w: World, b: Broker): number {
  const log = b.divPerShareLog ?? [];
  if (!log.length) return 0;
  const avg = log.slice(-3).reduce((s, x) => s + x, 0) / Math.min(3, log.length);
  return (avg / sharePrice(w, b)) * 100;
}

export function netWorth(w: World, m: Manager): number {
  let v = m.credits;
  for (const r of robotsOf(w, m.id)) v += bestBid(w, r)?.price ?? 0;
  for (const b of w.brokers) v += (b.shares[m.id] ?? 0) * sharePrice(w, b);
  return Math.round(v);
}

// ---------- actions (shared by the player and NPCs) ----------

export function buy(w: World, managerId: string, brokerId: string, modelId: string): string | null {
  const m = getManager(w, managerId);
  const b = getBroker(w, brokerId);
  if (b.closed) return `${b.name} is closed`;
  const stock = brokerStock(w, b, modelId).sort((x, y) => y.durability - x.durability);
  if (!stock.length) return `${b.name} has no ${model(modelId).name} in stock`;
  const price = askPrice(brokerFair(w, b, modelId), b.style);
  if (m.credits < price) return `Not enough credits: need ${price} CR`;
  const r = stock[0];
  m.credits -= price;
  b.credits += price;
  r.owner = m.id;
  r.paid = price;
  if (isHuman(m)) {
    r.chainId = undefined; // a fresh token is minted for it on-chain
    r.vet = undefined; // …with a fresh battle record
  }
  ledger(w, { kind: 'buy', from: m.id, to: b.id, uid: r.uid, amount: price });
  if (m.id === PLAYER_ID) {
    log(w, 'player', `You bought ${model(modelId).name} from ${b.name} for ${price} CR`);
    r.chainId = undefined; // a fresh token is minted for it on-chain
    r.vet = undefined; // …with a fresh battle record
    playerHooks.buy?.(r, price, b.id);
  }
  shareOp(managerId, 'buy', [brokerId, modelId]);
  return null;
}

export function sell(w: World, managerId: string, uid: string, brokerId?: string): string | null {
  const m = getManager(w, managerId);
  const r = w.robots[uid];
  if (!r || r.owner !== m.id) return 'This is not your robot';
  if (r.loaner) return 'An Arena loaner robot cannot be sold';
  let deal: { broker: Broker; price: number } | null;
  if (brokerId) {
    const b = getBroker(w, brokerId);
    if (b.closed) return `${b.name} is closed`;
    const fair = brokerFair(w, b, r.modelId);
    if (r.durability <= 0 && !b.style.scrapper) return `${b.name} doesn't take broken robots`;
    if (r.durability > 0 && !carries(b, r.modelId)) return `${b.name} only trades ${rangeLabel(b)}`;
    if (r.durability > 0 && overstocked(w, b, r.modelId)) return `${b.name} already has too many of these`;
    const price = r.durability <= 0 ? scrapPrice(fair) : bidPrice(fair, b.style, r);
    if (price > b.credits) return `${b.name} can't afford it`;
    deal = { broker: b, price };
  } else deal = bestBid(w, r);
  if (!deal) return 'Nobody wants to buy this robot';
  if (isHuman(m)) {
    // the daily trading-profit cap (the same limit the NEAR contract enforces)
    const gain = Math.max(0, deal.price - (r.paid ?? model(r.modelId).basePrice));
    const day = Math.floor(Date.now() / 86_400_000);
    const prev = m.gainDay ?? (m.id === PLAYER_ID ? w.gainDay : undefined);
    const g = prev?.day === day ? prev : { day, amount: 0 };
    if (g.amount + gain > DAILY_GAIN_MAX)
      return `Daily trading profit limit: ${DAILY_GAIN_MAX} CR a day (${g.amount} used) — sell it tomorrow`;
    m.gainDay = { day, amount: g.amount + gain };
  }
  m.credits += deal.price;
  deal.broker.credits -= deal.price;
  r.owner = deal.broker.id;
  m.team = m.team.filter((x) => x !== uid);
  syncDecks(w, m);
  ledger(w, { kind: r.durability <= 0 ? 'scrap' : 'sell', from: deal.broker.id, to: m.id, uid, amount: deal.price });
  if (m.id === PLAYER_ID) {
    log(w, 'player', `You sold ${model(r.modelId).name} to ${deal.broker.name} for ${deal.price} CR`);
    playerHooks.sell?.(r, deal.price, deal.broker.id);
  }
  if (isHuman(m)) r.chainId = undefined; // the token is burned on-chain; the broker's copy is off-chain stock
  shareOp(managerId, 'sell', [uid, brokerId]);
  return null;
}

/** Repair price at the cheapest open broker. */
export function repairQuote(w: World, r: Robot): { broker: Broker; cost: number } | null {
  let best: { broker: Broker; cost: number } | null = null;
  for (const b of w.brokers) {
    if (b.closed) continue;
    const cost = repairCost(brokerFair(w, b, r.modelId), r);
    if (!best || cost < best.cost) best = { broker: b, cost };
  }
  return best;
}

export function repair(w: World, managerId: string, uid: string): string | null {
  const m = getManager(w, managerId);
  const r = w.robots[uid];
  if (!r || r.owner !== m.id) return 'This is not your robot';
  if (r.durability >= maxDurability(r.modelId)) return 'The robot is already in full shape';
  const q = repairQuote(w, r);
  if (!q) return 'All workshops are closed';
  if (m.credits < q.cost) return `Not enough credits: repair costs ${q.cost} CR`;
  m.credits -= q.cost; // credits are burned — an economy sink
  r.durability = maxDurability(r.modelId);
  ledger(w, { kind: 'repair', from: m.id, to: 'burn', uid, amount: q.cost });
  if (m.id === PLAYER_ID) playerHooks.repair?.(r, q.cost);
  if (m.id === PLAYER_ID) log(w, 'player', `You repaired ${model(r.modelId).name} for ${q.cost} CR`);
  shareOp(managerId, 'repair', [uid]);
  return null;
}

export function invest(w: World, managerId: string, brokerId: string, amount: number): string | null {
  const m = getManager(w, managerId);
  const b = getBroker(w, brokerId);
  amount = Math.floor(amount);
  if (amount < 50) return 'Minimum investment is 50 CR';
  if (m.credits < amount) return 'Not enough credits';
  const price = sharePrice(w, b);
  const shares = amount / price;
  m.credits -= amount;
  b.credits += amount;
  b.investedToday += amount;
  b.shares[m.id] = (b.shares[m.id] ?? 0) + shares;
  ledger(w, { kind: 'invest', from: m.id, to: b.id, amount });
  const total = Object.values(b.shares).reduce((s, x) => s + x, 0);
  const pct = ((b.shares[m.id] / total) * 100).toFixed(1);
  if (m.id === PLAYER_ID) log(w, 'player', `You invested ${amount} CR in ${b.name}. Your share: ${pct}%`);
  else log(w, 'broker', `${m.name} invested ${amount} CR in ${b.name}`);
  if (b.closed && b.credits >= REOPEN_AT) {
    b.closed = false;
    log(w, 'broker', `${b.name} reopened thanks to investors`);
  }
  shareOp(managerId, 'invest', [brokerId, amount]);
  return null;
}

/** How much a broker can pay out for shares right now (without nearing bankruptcy). */
export const brokerCashForBuyback = (b: Broker) => Math.max(0, Math.floor(b.credits - BANKRUPT_BELOW - 100));

/** A broker's profit since the start of the day (equity growth, not counting new investments). */
export const brokerProfitToday = (w: World, b: Broker) =>
  brokerEquity(w, b) - (b.dayStartEquity ?? brokerEquity(w, b)) - b.investedToday;

/**
 * Sell your shares back to the broker at the current share price (fraction — what part of your shares, 0..1).
 * The broker pays from free cash; if that's not enough it buys back as much as it can.
 */
export function divest(w: World, managerId: string, brokerId: string, fraction = 1): string | null {
  const m = getManager(w, managerId);
  const b = getBroker(w, brokerId);
  const own = b.shares[m.id] ?? 0;
  if (own <= 0) return `You have no shares in ${b.name}`;
  const price = sharePrice(w, b);
  let shares = own * Math.min(1, Math.max(0, fraction));
  const cash = brokerCashForBuyback(b);
  if (cash < 1) return `${b.name} has no free cash to buy shares back right now`;
  shares = Math.min(shares, cash / price);
  const amount = Math.floor(shares * price);
  if (amount < 1) return 'Nothing to sell';
  b.shares[m.id] = own - shares;
  if (b.shares[m.id] < 1e-6) delete b.shares[m.id];
  b.credits -= amount;
  b.investedToday -= amount; // withdrawing money is not the broker's loss
  m.credits += amount;
  ledger(w, { kind: 'divest', from: b.id, to: m.id, amount });
  if (m.id === PLAYER_ID) log(w, 'player', `You sold shares of ${b.name} for ${amount} CR`);
  shareOp(managerId, 'divest', [brokerId, fraction]);
  return null;
}

export const LOANER_MAX_CREDITS = 40;
export const LOANER_DURABILITY = 5;

const LOANER_MODELS = ['spark', 'scout', 'bolt', 'ram', 'welder'];

/** Can the player claim the Arena's handout: no deck can be built and there is almost no money. */
export function canClaimLoaner(w: World, managerId: string): boolean {
  const m = getManager(w, managerId);
  if (m.credits >= LOANER_MAX_CREDITS) return false;
  if (buildTeam(robotsOf(w, m.id), () => 0)) return false;
  return LOANER_MODELS.some((x) => countOwned(w, m, x) < MAX_SAME_MODEL);
}

/** Arena handout: a free written-off robot (durability 5). Returns an error or null. */
export function claimLoaner(w: World, managerId: string): string | null {
  if (!canClaimLoaner(w, managerId)) return 'Only managers with an incomplete team and under 40 CR get a loaner';
  const m = getManager(w, managerId);
  const id = LOANER_MODELS.find((x) => countOwned(w, m, x) < MAX_SAME_MODEL)!;
  const r = mint(w, id, m.id);
  r.durability = Math.min(LOANER_DURABILITY, maxDurability(id));
  r.loaner = true;
  ledger(w, { kind: 'mint', from: 'arena', to: m.id, uid: r.uid, amount: 0, note: 'loaner' });
  if (m.id === PLAYER_ID) log(w, 'player', `The Arena gave you a loaner robot: ${model(id).name}`);
  shareOp(managerId, 'claimLoaner', []);
  return null;
}

/** Recycle a broken robot for free when nobody buys it. */
export function recycle(w: World, managerId: string, uid: string): string | null {
  const r = w.robots[uid];
  if (!r || r.owner !== managerId) return 'This is not your robot';
  if (r.durability > 0) return 'Only a broken robot can be recycled';
  delete w.robots[uid];
  const m = getManager(w, managerId);
  m.team = m.team.filter((x) => x !== uid);
  syncDecks(w, m);
  if (managerId === PLAYER_ID) log(w, 'player', `You recycled ${model(r.modelId).name}`);
  shareOp(managerId, 'recycle', [uid]);
  return null;
}

// ---------- the player's decks ----------

/** Make sure the manager has DECK_COUNT decks (old saves: the current team becomes deck 1). */
export function ensureDecks(m: Manager): Deck[] {
  if (!m.decks) {
    m.decks = Array.from({ length: DECK_COUNT }, (_, i) => ({ name: `Team ${i + 1}`, uids: i === 0 ? [...m.team] : [] }));
    m.activeDeck = 0;
  }
  while (m.decks.length < DECK_COUNT) m.decks.push({ name: `Team ${m.decks.length + 1}`, uids: [] });
  // the default names used to be "Deck N" — rename those (custom names stay)
  m.decks.forEach((d, i) => {
    if (d.name === `Deck ${i + 1}`) d.name = `Team ${i + 1}`;
  });
  return m.decks;
}

/** After m.team changed (sold, recycled, broke in battle): mirror it into the active deck, drop robots we lost. */
function syncDecks(w: World, m: Manager) {
  if (!m.decks) return;
  m.decks[m.activeDeck ?? 0].uids = [...m.team];
  for (const d of m.decks) d.uids = d.uids.filter((u) => w.robots[u]?.owner === m.id);
}

/** The player's side as recorded on NEAR (robot tokens, credits, league) — see restorePlayerFromChain. */
export interface ChainPlayer {
  credits: number;
  robots: { tokenId: string; modelId: string; durability: number; battles?: number; wins?: number }[];
  league?: { div: number; beaten: string[]; crowns: number };
}

/**
 * Logging in to a NEAR account on a new browser (or after "start over"): the player's progress comes back from the
 * chain — every robot token with its durability and battle record, the credits and the league progress. The world
 * around (NPC teams, brokers, prices) is this browser's own simulation. A world already tied to this account only
 * links its robots to their tokens.
 */
export function restorePlayerFromChain(w: World, accountId: string, chain: ChainPlayer, managerId = PLAYER_ID) {
  const me = getManager(w, managerId);
  for (const r of robotsOf(w, managerId)) if (!r.loaner) delete w.robots[r.uid];
  for (const t of chain.robots) {
    if (!MODELS.some((x) => x.id === t.modelId)) continue;
    const r = mint(w, t.modelId, managerId);
    r.durability = Math.max(0, Math.min(t.durability, maxDurability(t.modelId)));
    r.chainId = t.tokenId;
    if (t.battles) r.vet = { b: t.battles, w: t.wins ?? 0 };
  }
  me.credits = chain.credits;
  if (chain.league) {
    const byName = (n: string) => w.managers.find((m) => m.name === n)?.id;
    me.league = {
      div: Math.max(0, Math.min(DIVISIONS.length - 1, chain.league.div)),
      beaten: chain.league.beaten.map(byName).filter((x): x is string => !!x),
      crowns: chain.league.crowns,
    };
  }
  // a fresh battle deck from the restored robots (the strongest that fit the limit), the other teams empty
  const team = buildTeam(robotsOf(w, managerId), (r) => model(r.modelId).cost * 10 + durFrac(r));
  me.team = team ? team.map((r) => r.uid) : [];
  me.decks = undefined;
  ensureDecks(me);
  if (managerId === PLAYER_ID) {
    w.chainAccount = accountId;
    w.league = me.league;
    log(w, 'player', `Restored from NEAR (${accountId}): ${chain.robots.length} robots, ${chain.credits} CR`);
  }
}

/** Shared world: a logged-in player joins (their robots and credits come from the chain — restorePlayerFromChain). */
export function addHuman(w: World, accountId: string, name: string): Manager {
  const existing = w.managers.find((m) => m.id === accountId);
  if (existing) return existing;
  const m: Manager = { id: accountId, name, human: true, strategy: 'player', careful: 0.5, credits: 0, team: [], elo: 1000, wins: 0, losses: 0, draws: 0 };
  w.managers.push(m);
  ensureDecks(m);
  log(w, 'season', `${name} joined the Arena`);
  return m;
}

/** Which deck a robot stands in (or -1). */
export const deckOfRobot = (m: Manager, uid: string) => (m.decks ?? []).findIndex((d) => d.uids.includes(uid));

/** Save the contents of deck idx (may be incomplete while it is being built). A robot can be in one deck only. */
export function setDeck(w: World, managerId: string, idx: number, uids: string[]): string | null {
  const m = getManager(w, managerId);
  const decks = ensureDecks(m);
  const team = uids.map((u) => w.robots[u]);
  if (team.some((r) => !r || r.owner !== m.id)) return 'The deck has a robot you do not own';
  const other = uids.find((u) => {
    const d = deckOfRobot(m, u);
    return d >= 0 && d !== idx;
  });
  if (other) return `${model(w.robots[other].modelId).name} is already in ${decks[deckOfRobot(m, other)].name}`;
  const err = partialTeamError(team);
  if (err) return err;
  decks[idx].uids = [...uids];
  if (idx === (m.activeDeck ?? 0)) m.team = [...uids];
  shareOp(managerId, 'setDeck', [idx, uids]);
  return null;
}

/** Choose the deck that goes into battle. */
export function selectDeck(w: World, managerId: string, idx: number): string | null {
  const m = getManager(w, managerId);
  const decks = ensureDecks(m);
  if (!decks[idx]) return 'No such deck';
  m.activeDeck = idx;
  m.team = [...decks[idx].uids];
  shareOp(managerId, 'selectDeck', [idx]);
  return null;
}

export function renameDeck(w: World, managerId: string, idx: number, name: string): string | null {
  const m = getManager(w, managerId);
  const decks = ensureDecks(m);
  const n = name.trim().slice(0, 24);
  if (!n) return 'The name cannot be empty';
  decks[idx].name = n;
  shareOp(managerId, 'renameDeck', [idx, name]);
  return null;
}

export function setTeam(w: World, managerId: string, uids: string[]): string | null {
  const m = getManager(w, managerId);
  const team = uids.map((u) => w.robots[u]);
  if (team.some((r) => !r || r.owner !== m.id)) return 'The team has a robot you do not own';
  // A deck may be stored incomplete: the player fills it slot by slot. The Arena checks it before a battle.
  const err = partialTeamError(team);
  if (err) return err;
  m.team = [...uids];
  shareOp(managerId, 'setTeam', [uids]);
  return null;
}

// ---------- matches ----------

const BANKRUPT_BELOW = 60;
/** Which part of a broker's daily profit is paid as dividends (split by shares) */
export const DIVIDEND_SHARE = 0.8;
const SCRAP_YARD_CAP = 12;
/** how much cash a broker keeps aside (1 = careful; lower = it trades closer to the edge and can go broke) */
const RESERVE = 0.3;
/** the scrap dealer refurbishes at most this many robots an hour, paying this share of a normal repair */
const JUNK_REPAIRS_PER_HOUR = 1;
/** the Factory pays for parts of scrap the Junkman doesn't refurbish, × the scrap price it paid */
const JUNK_PARTS = 1.15;
const JUNK_REPAIR_COST = 1.6;
const REOPEN_AT = 250;

function elo(a: Manager, b: Manager, score: number) {
  const ea = 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
  const k = 24;
  a.elo = Math.round(a.elo + k * (score - ea));
  b.elo = Math.round(b.elo + k * (1 - score - (1 - ea)));
}

/** Applies a battle result to the world: wear, model statistics, rewards, rating. */
/** Both sides' team value at base prices — the battle purse is computed from it. */
export function sideTeamValues(st: BattleState): [number, number] {
  const v: [number, number] = [0, 0];
  for (const [uid, side] of Object.entries(st.sideOf)) v[side] += model(st.modelOf[uid]).basePrice;
  return v;
}

/**
 * How a battle counts:
 *  - 'ranked' — ELO and W/D/L (the Ratings): online battles against another player's deck, and the bots' own matches;
 *  - 'league' — the Arena's Pit League (PvE): rewards, wear, veterans and league progress, but no ELO or W/D/L.
 * In a ranked battle against a player's deck the other player isn't there (their deck is played by the AI): their
 * robots don't wear and they earn nothing, but the result moves both ELOs.
 */
export type MatchMode = 'ranked' | 'league';

export function applyMatch(w: World, aId: string, bId: string, st: BattleState, mode: MatchMode = 'ranked') {
  const a = getManager(w, aId);
  const b = getManager(w, bId);
  const sides: [Manager, Manager] = [a, b];
  const ghost = mode === 'ranked' && isHuman(a) && isHuman(b); // b's deck was played by the AI
  // team value at base prices — the battle purse comes from it
  const teamValue = sideTeamValues(st);
  for (let s = 0; s < 2; s++) {
    const res = st.winner === null ? 0.5 : st.winner === s ? 1 : 0;
    const m = sides[s];
    if (ghost && s === 1) {
      // the absent player: only their record and ELO move
      if (res === 1) m.wins++;
      else if (res === 0) m.losses++;
      else m.draws++;
      continue;
    }
    for (const uid of Object.keys(st.wear)) {
      const r = w.robots[uid];
      if (!r || r.owner !== m.id || !st.wear[uid].fielded) continue;
      r.durability = Math.max(0, r.durability - wearLoss(st, uid, isHuman(m)));
      // veteran record: a win counts for every robot that fought
      const rankBefore = vetRank(r);
      // your robots count at most VET_WINS_PER_DAY wins a day toward the rank (as on NEAR)
      const day = Math.floor(Date.now() / 86_400_000);
      const today = r.vet?.d === day ? (r.vet.t ?? 0) : 0;
      const counts = res === 1 && (!isHuman(m) || today < VET_WINS_PER_DAY);
      r.vet = {
        b: (r.vet?.b ?? 0) + 1,
        w: (r.vet?.w ?? 0) + (counts ? 1 : 0),
        ...(isHuman(m) ? { d: day, t: today + (counts ? 1 : 0) } : {}),
      };
      const rank = vetRank(r);
      if (m.id === PLAYER_ID && rank > rankBefore)
        log(w, 'player', `${model(r.modelId).name} is now ${VET_NAME[rank]} ${vetStars(rank)}`);
      const ms = w.stats[r.modelId];
      ms.recent.push(res);
      if (ms.recent.length > ECON.recentWindow) ms.recent.shift();
      ms.games++;
      if (res === 1) ms.wins++;
    }
    let reward: number;
    if (isHuman(m)) {
      // the same bounds the NEAR contract applies: ≤ 25% of your working robots' base value, and the daily purse
      const full = playerReward(teamValue[s], teamValue[1 - s], res, sides[1 - s]);
      const owned = robotsOf(w, m.id)
        .filter((r) => r.durability > 0 && !r.loaner)
        .reduce((x, r) => x + model(r.modelId).basePrice, 0);
      reward = takePurse(w, m, Math.min(full, Math.floor(owned * 0.25)));
      if (m.id === PLAYER_ID) w.lastPlayerReward = { reward, capped: reward < full };
    } else reward = battleReward(teamValue[s], teamValue[1 - s], res, ECON.purseRate);
    m.credits += reward;
    if (m.id === PLAYER_ID) playerHooks.match?.(st, sides[1 - s].id, res === 1 ? 1 : res === 0 ? 0 : 2, reward);
    ledger(w, { kind: 'reward', from: 'arena', to: m.id, amount: reward });
    if (mode === 'ranked') {
      if (res === 1) m.wins++;
      else if (res === 0) m.losses++;
      else m.draws++;
    }
  }
  if (mode === 'ranked') elo(a, b, st.winner === null ? 0.5 : st.winner === 0 ? 1 : 0);
  ledger(w, {
    kind: 'match',
    from: a.id,
    to: b.id,
    amount: 0,
    note: st.winner === null ? 'draw' : st.winner === 0 ? a.id : b.id,
  });
  // Broken written-off Arena robots go to the scrap heap
  for (const uid of Object.keys(st.wear)) {
    const r = w.robots[uid];
    if (r?.loaner && r.durability <= 0) delete w.robots[uid];
  }
  // Broken robots drop out of the deck
  for (const m of sides) {
    m.team = m.team.filter((u) => (w.robots[u]?.durability ?? 0) > 0);
    syncDecks(w, m);
  }
  if (isHuman(a) || isHuman(b)) {
    const me = isHuman(a) ? 0 : 1;
    const opp = sides[1 - me];
    const txt = st.winner === null ? 'draw' : st.winner === me ? 'win' : 'loss';
    if (sides[me].id === PLAYER_ID) log(w, 'match', `${mode === 'ranked' ? 'Online battle' : 'Battle'} vs ${opp.name}: ${txt}`);
    if (mode === 'league' && st.winner === me) leagueWin(w, sides[me], opp);
  }
  if (a.id === PLAYER_ID) shareOp(PLAYER_ID, 'match', [b.id, battleLogOf(st), mode]);
}

/** Is this manager's battle deck still exactly the starter deck everyone gets? */
export function isStarterDeck(w: World, m: Manager): boolean {
  const deck = teamOf(w, m).map((r) => r.modelId).sort();
  const start = [...STARTER_TEAM].sort();
  return deck.length === start.length && deck.every((id, i) => id === start[i]);
}

/**
 * Online (ranked) opponent: another player's battle deck, played by the AI under their name. Players come first —
 * nearest by ELO; a bot deck only about one battle in ten, or when there's nobody else.
 */
export function pickPvpOpponent(w: World, exclude?: string, managerId = PLAYER_ID): Manager {
  const me = getManager(w, managerId);
  const near = (pool: Manager[]) =>
    [...pool].sort((x, y) => Math.abs(x.elo - me.elo) - Math.abs(y.elo - me.elo)).slice(0, 3);
  // players who never touched the starter deck (signed up and left) are skipped — otherwise newcomers would keep
  // meeting the same starter deck
  const players = w.managers.filter(
    (m) => isHuman(m) && m.id !== me.id && m.id !== exclude && !teamError(teamOf(w, m)) && !isStarterDeck(w, m),
  );
  const bots = w.managers.filter((m) => !isHuman(m) && m.id !== exclude && !teamError(teamOf(w, m)));
  const pool = players.length && Math.random() >= 0.1 ? near(players) : near(bots.length ? bots : players);
  return pool[Math.floor(Math.random() * pool.length)] ?? me;
}

// ---------- the Pit League ----------

/** The player's purse: the usual one × the opponent's league multiplier (the chain caps a reward at 400 CR). */
export function playerReward(mine: number, theirs: number, res: number, opp: Manager): number {
  return Math.min(400, Math.round(battleReward(mine, theirs, res, ECON.playerPurseRate) * DIVISIONS[opp.div ?? 0].purse));
}

/**
 * The daily purse: battle rewards + league prizes a player can receive per day (UTC) — the NEAR contract caps the
 * same (DAILY_PURSE_MAX), because results are reported by the client. An honest player rarely reaches it.
 */
export const DAILY_PURSE_MAX = 3000;
const purseOf = (w: World, m: Manager) => m.purseDay ?? (m.id === PLAYER_ID ? w.purseDay : undefined);
export function purseLeft(w: World, managerId = PLAYER_ID): number {
  const day = Math.floor(Date.now() / 86_400_000);
  const p = purseOf(w, getManager(w, managerId));
  return DAILY_PURSE_MAX - (p?.day === day ? p.amount : 0);
}
function takePurse(w: World, m: Manager, amount: number): number {
  const day = Math.floor(Date.now() / 86_400_000);
  const p = purseOf(w, m);
  const used = p?.day === day ? p.amount : 0;
  const pay = Math.max(0, Math.min(amount, DAILY_PURSE_MAX - used));
  m.purseDay = { day, amount: used + pay };
  return pay;
}

/** A human's league progress (older saves kept the local player's on the world). */
export function leagueOf(w: World, managerId = PLAYER_ID): LeagueState {
  const m = getManager(w, managerId);
  m.league ??= (managerId === PLAYER_ID ? w.league : undefined) ?? { div: 0, beaten: [], crowns: 0 };
  if (managerId === PLAYER_ID) w.league = m.league;
  return m.league;
}
/** The bot teams of a division (humans climb the league, they don't sit in it). */
export const divisionTeams = (w: World, div: number) => w.managers.filter((m) => !isHuman(m) && (m.div ?? 0) === div);

/** A win over a team of your division counts toward the climb; beat all of them to move up. */
function leagueWin(w: World, me: Manager, opp: Manager) {
  const L = leagueOf(w, me.id);
  if ((opp.div ?? 0) !== L.div || L.beaten.includes(opp.id)) return;
  L.beaten.push(opp.id);
  const teams = divisionTeams(w, L.div);
  if (!teams.every((t) => L.beaten.includes(t.id))) return;
  const d = DIVISIONS[L.div];
  const prize = takePurse(w, me, divisionPrize(L.div, L.crowns));
  me.credits += prize;
  ledger(w, { kind: 'reward', from: 'arena', to: me.id, amount: prize, note: `${d.name} won` });
  if (L.div < DIVISIONS.length - 1) {
    L.div++;
    const who = me.id === PLAYER_ID ? 'You' : me.name;
    log(w, 'season', `${who} won the ${d.name} (+${prize} CR) and ${me.id === PLAYER_ID ? 'move' : 'moves'} up to the ${DIVISIONS[L.div].name}!`);
  } else {
    L.crowns++;
    const who = me.id === PLAYER_ID ? 'You' : me.name;
    log(w, 'season', `${L.crowns > 1 ? `${who}: crown defended` : `${who} beat the whole Apex League: ${KING_TITLE}!`} +${prize} CR.`);
  }
  L.beaten = [];
}

// ---------- NPC behaviour ----------

/** Old saves (before the league): put the NPC teams into their divisions; the player starts at the bottom. */
export function migrateLeague(w: World) {
  NPC_SETUP.forEach((x, i) => {
    const m = w.managers.find((mm) => mm.id === `npc${i + 1}`);
    if (!m || m.div !== undefined) return;
    Object.assign(m, { div: x.div, focus: x.focus, focus2: x.focus2 });
  });
  leagueOf(w);
}

const power = (modelId: string) => {
  const md = model(modelId);
  return md.atk + md.hp + (md.ability ? 2 : 0);
};

function teamValue(w: World, m: Manager, rel: Record<string, number>) {
  const base = strategyValue(w, m, rel);
  // An NPC builds its deck around its class(es). Low leagues play one class strictly (basic robots fill the gaps);
  // upper leagues mix two classes that work together (e.g. Armor guards + Repair medics).
  const div = m.div ?? 0;
  return (r: Robot) => {
    const c = classOf(r.modelId);
    const own = c === m.focus || (div >= 2 && c === m.focus2);
    const k = own ? (div <= 1 ? 4 : 3) : c === 'none' ? (div <= 1 ? 0.6 : 0.4) : div <= 1 ? 0.1 : 0.3;
    // the Apex League fields its strongest robots first
    return (base(r) + (div >= 3 ? model(r.modelId).cost * 6 : 0)) * k;
  };
}

function strategyValue(w: World, m: Manager, rel: Record<string, number>) {
  return (r: Robot) => {
    const md = model(r.modelId);
    switch (m.strategy) {
      case 'hype':
        return rel[r.modelId] + md.cost * 4;
      case 'contrarian':
        return winRate(w.stats[r.modelId]) * 100 + md.cost * 4;
      case 'thrifty':
        return power(r.modelId) + r.durability * 0.5;
      default:
        return power(r.modelId) + md.cost;
    }
  };
}

function cheapestOffer(w: World, modelId: string): { broker: Broker; price: number } | null {
  let best: { broker: Broker; price: number } | null = null;
  for (const b of w.brokers) {
    if (b.closed || !brokerStock(w, b, modelId).length) continue;
    const price = askPrice(brokerFair(w, b, modelId), b.style);
    if (!best || price < best.price) best = { broker: b, price };
  }
  return best;
}

function countOwned(w: World, m: Manager, modelId: string) {
  return robotsOf(w, m.id).filter((r) => r.modelId === modelId && r.durability > 0).length;
}

/** An NPC manager's turn between battles: repairs, selling scrap, buying by strategy, building the team. */
export function npcManage(w: World, m: Manager, rng: Rng) {
  const rel = actualRelevance(w);
  const owned = () => robotsOf(w, m.id);

  // 1. Broken and worn robots
  for (const r of owned()) {
    if (durFrac(r) > 0.3) continue;
    const q = repairQuote(w, r);
    const worth = refPrice(w, r.modelId);
    const wantsRepair =
      m.strategy === 'thrifty' ? true : m.strategy === 'hype' ? rel[r.modelId] > 55 : power(r.modelId) / worth > 0.12;
    if (q && wantsRepair && m.credits >= q.cost + 60) repair(w, m.id, r.uid);
    else if (r.durability <= 0 && sell(w, m.id, r.uid)) recycle(w, m.id, r.uid);
  }

  // Thrifty NPCs with money repair worn robots in advance
  if (m.strategy === 'thrifty' && m.credits > 250) {
    for (const r of owned()) if (durFrac(r) <= 0.6 && m.credits > 200) repair(w, m.id, r.uid);
  }

  // 2a. Top up robots of their own class(es) (want at least 8 working; combo teams 10)
  const cap = npcDeckCost(m);
  const myClasses = [m.focus, (m.div ?? 0) >= 2 ? m.focus2 : undefined].filter(Boolean) as RobotClass[];
  const focusModels = MODELS.filter((x) => myClasses.includes(classOf(x.id)) && x.cost <= Math.ceil(cap / 6));
  const focusOwned = owned().filter((r) => r.durability > 0 && myClasses.includes(classOf(r.modelId))).length;
  if (m.focus && focusOwned < (myClasses.length > 1 ? 10 : 8) && m.credits > 160) {
    const options = focusModels
      .filter((x) => countOwned(w, m, x.id) < MAX_SAME_MODEL)
      .map((x) => ({ x, offer: cheapestOffer(w, x.id) }))
      .filter((o) => o.offer && m.credits - o.offer.price >= 100)
      .sort((p, q) =>
        m.strategy === 'hype'
          ? rel[q.x.id] - rel[p.x.id]
          : m.strategy === 'contrarian'
            ? winRate(w.stats[q.x.id]) / q.offer!.price - winRate(w.stats[p.x.id]) / p.offer!.price
            : p.offer!.price - q.offer!.price,
      );
    if (options.length) buy(w, m.id, options[0].offer!.broker.id, options[0].x.id);
  }

  // 2b. A deal by strategy (not every time; the rich always trade). More often within their own class.
  // low leagues buy only their own class; combo teams mostly their two classes
  const universe = m.focus && rng.next() < ((m.div ?? 0) <= 1 ? 1 : 0.8) ? focusModels : MODELS;
  if (m.credits > 400 || rng.next() < 0.35) {
    if (m.strategy === 'hype') {
      const top = [...universe].sort((x, y) => rel[y.id] - rel[x.id]).slice(0, 4);
      const target = top.find((x) => countOwned(w, m, x.id) < MAX_SAME_MODEL);
      const offer = target && cheapestOffer(w, target.id);
      if (target && offer && m.credits - offer.price >= 80) buy(w, m.id, offer.broker.id, target.id);
    } else if (m.strategy === 'contrarian') {
      // Sell what everyone overrates…
      for (const r of owned()) {
        if (r.durability > 0 && rel[r.modelId] > 62 && !m.team.includes(r.uid) && rng.next() < 0.5) sell(w, m.id, r.uid);
      }
      // ……and buy the most underrated: wins often but costs less than its base price
      const underrated = (id: string, price: number) => winRate(w.stats[id]) / (price / model(id).basePrice);
      const ranked = universe.map((x) => ({ x, offer: cheapestOffer(w, x.id) }))
        .filter((o) => o.offer && countOwned(w, m, o.x.id) < MAX_SAME_MODEL && o.x.cost >= 2)
        .sort((p, q) => underrated(q.x.id, q.offer!.price) - underrated(p.x.id, p.offer!.price));
      const pick = ranked[0];
      if (pick && m.credits - pick.offer!.price >= 60) buy(w, m.id, pick.offer!.broker.id, pick.x.id);
    }
  }

  // 3. Build the team; if that fails, buy cheap robots
  let hasTeam = false;
  for (let guard = 0; guard < 12; guard++) {
    const team = buildTeam(owned(), teamValue(w, m, rel), cap);
    if (team) {
      m.team = team.map((r) => r.uid);
      hasTeam = true;
      break;
    }
    const working = owned().filter((r) => r.durability > 0);
    const mostExpensive = [...working].sort((x, y) => model(y.modelId).cost - model(x.modelId).cost)[0];
    // Enough robots, but they don't fit the limit — sell the most expensive one
    if (working.length >= TEAM_MIN) {
      if (!mostExpensive || sell(w, m.id, mostExpensive.uid)) break;
      continue;
    }
    // Too few robots — buy the cheapest
    // low leagues stay one-class: only their class or basic robots
    const cheap = MODELS.filter(
      (x) =>
        x.cost <= 3 &&
        countOwned(w, m, x.id) < MAX_SAME_MODEL &&
        ((m.div ?? 0) >= 2 || myClasses.includes(classOf(x.id)) || classOf(x.id) === 'none'),
    )
      .map((x) => ({ x, offer: cheapestOffer(w, x.id) }))
      .filter((o) => o.offer && o.offer.price <= m.credits)
      .sort(
        (p, q) =>
          Number(myClasses.includes(classOf(q.x.id))) - Number(myClasses.includes(classOf(p.x.id))) ||
          model(p.x.id).cost - model(q.x.id).cost ||
          p.offer!.price - q.offer!.price,
      );
    if (cheap.length) {
      buy(w, m.id, cheap[0].offer!.broker.id, cheap[0].x.id);
      continue;
    }
    // Totally broke: sell an expensive robot to buy cheap ones
    if (mostExpensive && model(mostExpensive.modelId).cost > 2 && !sell(w, m.id, mostExpensive.uid)) continue;
    // Nothing helped — the Arena's handout
    if (claimLoaner(w, m.id)) break;
  }

  // 3b. Upgrade: a rich NPC buys a more expensive robot (of its class if possible) instead of the cheapest one
  // in its team. The money goes to a broker, who restocks from the Factory — so extra credits leave the economy,
  // and expensive robots get demand.
  if (hasTeam && m.credits > 450 && rng.next() < 0.6) {
    const team = owned().filter((r) => m.team.includes(r.uid));
    const cheapest = [...team].sort((x, y) => model(x.modelId).cost - model(y.modelId).cost)[0];
    const room = cap - teamEnergy(team);
    if (cheapest) {
      // only an upgrade that still fits the league's deck limit
      const cands = MODELS.filter(
        (x) =>
          x.cost > model(cheapest.modelId).cost &&
          x.cost - model(cheapest.modelId).cost <= room &&
          countOwned(w, m, x.id) < MAX_SAME_MODEL,
      )
        .map((x) => ({ x, offer: cheapestOffer(w, x.id) }))
        .filter((o) => o.offer && m.credits - o.offer.price >= 150)
        .sort(
          (p, q) =>
            Number(myClasses.includes(classOf(q.x.id))) - Number(myClasses.includes(classOf(p.x.id))) ||
            q.x.cost - p.x.cost,
        );
      if (cands.length) buy(w, m.id, cands[0].offer!.broker.id, cands[0].x.id);
    }
  }

  // 4. Don't hoard: more than 4 spare working robots — sell the worst
  const extra = owned().filter((r) => r.durability > 0 && !m.team.includes(r.uid));
  if (hasTeam && extra.length > 4) {
    const val = teamValue(w, m, rel);
    extra.sort((x, y) => val(x) - val(y));
    for (const r of extra.slice(0, extra.length - 4)) sell(w, m.id, r.uid);
  }

  // 4b. The league keeps its teams in shape: a deck far below the division's level gets sponsor robots
  leagueSponsor(w, m, myClasses, rel);

  // 5. Sometimes NPCs invest in a broker in trouble
  if (m.credits > 500 && rng.next() < 0.05) {
    const poor = w.brokers.filter((b) => b.credits < 300).sort((x, y) => x.credits - y.credits)[0];
    if (poor) invest(w, m.id, poor.id, 150);
  }
}

/**
 * League sponsorship: if an NPC's deck is broken or much cheaper than its division's limit (it lost too often and
 * sold its robots), the league lends it robots of its classes. Sponsor robots are loaners — they can't be sold and
 * are scrapped when broken — so they never reach the market; they only keep each division at its level.
 */
function leagueSponsor(w: World, m: Manager, classes: RobotClass[], rel: Record<string, number>) {
  const cap = npcDeckCost(m);
  const cur = teamOf(w, m);
  if (!teamError(cur) && teamEnergy(cur) >= cap - 6) return;
  const own = robotsOf(w, m.id).filter((r) => r.durability > 0);
  const virtual: Robot[] = [];
  for (const x of MODELS) {
    if (!classes.includes(classOf(x.id)) && classOf(x.id) !== 'none') continue;
    for (let i = countOwned(w, m, x.id); i < MAX_SAME_MODEL; i++)
      virtual.push({ uid: `sponsor:${x.id}:${i}`, modelId: x.id, durability: maxDurability(x.id) });
  }
  const val = teamValue(w, m, rel);
  // the team's own robots first, then sponsor robots; the deck is filled up to the league's limit
  const team = buildTeam([...own, ...virtual], (r) => val(r) * (r.uid.startsWith('sponsor:') ? 0.9 : 1) + model(r.modelId).cost, cap);
  if (!team) return;
  m.team = team.map((r) => {
    if (!r.uid.startsWith('sponsor:')) return r.uid;
    const nr = mint(w, r.modelId, m.id);
    nr.loaner = true;
    ledger(w, { kind: 'mint', from: 'league', to: m.id, uid: nr.uid, amount: 0, note: 'league sponsor robot' });
    return nr.uid;
  });
}

// ---------- brokers: hour and day ----------

function brokerHour(w: World, rel: Record<string, number>) {
  for (const b of w.brokers) {
    // with shorter game hours (shared world) each update moves less, so a broker reacts at the same speed per day
    const scale = HOURS_PER_DAY / hoursPerDay(w);
    const style = scale === 1 ? b.style : { ...b.style, react: 1 - Math.pow(1 - b.style.react, scale) };
    for (const x of MODELS) b.perceived[x.id] = updatePerceived(b.perceived[x.id], rel[x.id], style);
    if (b.closed) continue;
    // The scrap dealer repairs broken robots and puts them up for sale
    if (b.style.scrapper) {
      // scrap of models it doesn't trade is stripped for parts (melted) — it only refurbishes cheap robots
      for (const r of robotsOf(w, b.id)) {
        if (r.durability > 0 || carries(b, r.modelId)) continue;
        // parts go to the Factory: a little more than the scrap price it paid
        const parts = Math.round(scrapPrice(brokerFair(w, b, r.modelId)) * JUNK_PARTS);
        b.credits += parts;
        ledger(w, { kind: 'scrap', from: 'factory', to: b.id, uid: r.uid, amount: parts, note: 'parts' });
        delete w.robots[r.uid];
      }
      const broken = robotsOf(w, b.id).filter((r) => r.durability <= 0);
      // Extra scrap is melted down — the robot leaves the world
      for (const r of broken.splice(0, Math.max(0, broken.length - SCRAP_YARD_CAP))) delete w.robots[r.uid];
      // Refurbishing: a few a day, only models it is short of, at a real workshop's cost — otherwise cheap scrap
      // turned into cheap stock made it the cheapest seller of everything and it got rich off everyone.
      let fixed = 0;
      for (const r of broken) {
        // the same pace per day in a world with shorter game hours
        if (fixed >= JUNK_REPAIRS_PER_HOUR || w.hour % Math.max(1, Math.round(hoursPerDay(w) / HOURS_PER_DAY)) !== 0) break;
        if (brokerStock(w, b, r.modelId).length >= b.style.targetStock + 1) continue;
        const cost = Math.round(repairCost(brokerFair(w, b, r.modelId), r) * JUNK_REPAIR_COST);
        fixed++;
        if (b.credits - cost < BANKRUPT_BELOW + 40) break;
        b.credits -= cost;
        r.durability = maxDurability(r.modelId);
        ledger(w, { kind: 'repair', from: b.id, to: 'burn', uid: r.uid, amount: cost });
      }
    }
    // Restocking from the Factory. The Factory makes expensive models slowly: at most 1 a day (energy 5–6)
    // and 2 a day (energy 4) per broker — they run short, and the price jumps on the shortage.
    for (const x of MODELS) {
      if ((w.strikeUntil ?? 0) > w.hour) break; // Factory strike: nothing to restock
      if (!carries(b, x.id)) continue;
      const stock = brokerStock(w, b, x.id).length;
      // the broker's mind (shared world) can stock up on some models and stop restocking others
      if (b.ai?.dump.includes(x.id)) continue;
      if (stock >= b.style.targetStock + (b.ai?.focus.includes(x.id) ? 1 : 0)) continue;
      const cap = x.cost >= 5 ? 1 : x.cost === 4 ? 2 : Infinity;
      if ((b.restockedToday?.[x.id] ?? 0) >= cap) continue;
      // cash reserve after restocking: an expensive model needs a bigger reserve, otherwise a small broker goes broke
      if (b.credits - x.basePrice < BANKRUPT_BELOW + Math.max(100, x.basePrice * 0.8) * RESERVE) continue;
      // A broker doesn't stock what it would have to sell below cost: such a robot disappears from stock,
      // the shortage raises the price, and once restocking pays again the broker buys it.
      if (askPrice(brokerFair(w, b, x.id), b.style) < x.basePrice) continue;
      // the money goes to the Factory — a sink (the black market gets a smuggler's discount)
      const factoryPrice = Math.round(x.basePrice * (b.id === 'soroka' ? 0.96 : 1));
      b.credits -= factoryPrice;
      b.restockedToday = { ...(b.restockedToday ?? {}), [x.id]: (b.restockedToday?.[x.id] ?? 0) + 1 };
      const r = mint(w, x.id, b.id);
      ledger(w, { kind: 'mint', from: b.id, to: 'factory', uid: r.uid, amount: factoryPrice });
    }
    if (b.credits < BANKRUPT_BELOW) {
      b.closed = true;
      log(w, 'broker', `${b.name} went bankrupt and closed shop. Invest to reopen it.`);
    }
  }
}

function brokerDayEnd(w: World) {
  for (const b of w.brokers) {
    // Profit = equity growth over the day (not just cash: buying stock isn't a loss)
    const profit = brokerEquity(w, b) - (b.dayStartEquity ?? brokerEquity(w, b)) - b.investedToday;
    b.lastDividend = 0;
    const total = Object.values(b.shares).reduce((s, x) => s + x, 0);
    b.profitLog = [...(b.profitLog ?? []), Math.round(profit)].slice(-7);
    const perShare =
      profit > 0 && !b.closed ? Math.min(profit * DIVIDEND_SHARE, Math.max(0, b.credits - BANKRUPT_BELOW - 200)) / total : 0;
    b.divPerShareLog = [...(b.divPerShareLog ?? []), perShare].slice(-7);
    if (profit > 0 && !b.closed) {
      // dividends must not ruin the broker: pay only from free cash
      const pool = Math.min(profit * DIVIDEND_SHARE, Math.max(0, b.credits - BANKRUPT_BELOW - 200));
      for (const [owner, sh] of Object.entries(b.shares)) {
        if (owner === HOUSE) continue;
        const pay = Math.floor((pool * sh) / total);
        if (pay <= 0) continue;
        const m = w.managers.find((x) => x.id === owner);
        if (!m) continue;
        m.credits += pay;
        b.credits -= pay;
        b.lastDividend += pay;
        b.paidTotal = { ...(b.paidTotal ?? {}), [owner]: (b.paidTotal?.[owner] ?? 0) + pay };
        ledger(w, { kind: 'dividend', from: b.id, to: owner, amount: pay });
        if (owner === PLAYER_ID) log(w, 'dividend', `${b.name} paid you ${pay} CR in dividends`);
      }
    }
    b.dayStartCredits = b.credits;
    b.dayStartEquity = brokerEquity(w, b);
    b.investedToday = 0;
    b.restockedToday = {};
  }
}

// ---------- time ----------

function snapshot(w: World, rel: Record<string, number>) {
  const price = Object.fromEntries(MODELS.map((x) => [x.id, Math.round(refPrice(w, x.id))]));
  w.history.push({ tick: w.tick, day: dayOf(w), hour: w.hour, rel: { ...rel }, price });
  // the whole history is kept (Analytics shows the last 7 days, or any season): hourly points for the last
  // 14 days, older days compacted to their last hour — about 1 KB a day, so years fit in the save
  const cutoff = dayOf(w) - 14;
  if (w.history.length && w.history[0].day < cutoff && w.history.length > 14 * hoursPerDay(w)) {
    w.history = w.history.filter((h, i, all) => h.day >= cutoff || all[i + 1]?.day !== h.day);
  }
  for (const x of MODELS) {
    const start = w.dayStartPrice[x.id];
    if (!start) continue;
    const ch = (price[x.id] - start) / start;
    const key = `${x.id}:${ch > 0 ? 'up' : 'down'}`;
    if (Math.abs(ch) >= 0.3 && !w.reportedToday.includes(key)) {
      w.reportedToday.push(key);
      log(
        w,
        'price',
        `${x.name} ${ch > 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(ch * 100))}% today (${price[x.id]} CR)`,
      );
    }
  }
}

function seasonEnd(w: World) {
  const champs = [...w.managers].sort((a, b) => b.elo - a.elo).slice(0, 3);
  const mags = w.managers
    .map((m) => ({ m, worth: netWorth(w, m) }))
    .sort((a, b) => b.worth - a.worth)
    .slice(0, 3);
  const prizes = [300, 200, 100];
  // the online ladder pays more: 600 / 350 / 200 for the top 3 ELO at the season's end
  const champPrizes = [600, 350, 200];
  const res: SeasonResult = {
    season: w.season,
    champions: champs.map((m, i) => ({ id: m.id, name: m.name, elo: m.elo, prize: champPrizes[i] })),
    magnates: mags.map((x, i) => ({ id: x.m.id, name: x.m.name, worth: x.worth, prize: prizes[i] })),
  };
  for (const c of res.champions) getManager(w, c.id).credits += c.prize;
  for (const c of res.magnates) getManager(w, c.id).credits += c.prize;
  w.seasons.push(res);
  log(
    w,
    'season',
    `Season ${w.season} is over. Champion: ${res.champions[0].name}. Magnate: ${res.magnates[0].name}.`,
  );
  // The meta restarts: relevance drifts toward 50, the battle history gets shorter
  for (const b of w.brokers) for (const x of MODELS) b.perceived[x.id] += (50 - b.perceived[x.id]) * 0.3;
  for (const x of MODELS) w.stats[x.id].recent = w.stats[x.id].recent.slice(-Math.floor(ECON.recentWindow / 2));
  w.season++;
}

// ---------- broker risk: upkeep and market events ----------

/** Daily upkeep (rent, staff, bribes): a broker that doesn't trade enough bleeds money and can go bankrupt. */
export const BROKER_UPKEEP: Record<string, number> = { kessler: 70, soroka: 50, scrap: 45 };
/** Chance per day of a market event. */
const EVENT_CHANCE = 0.5;

function brokerUpkeep(w: World) {
  for (const b of w.brokers) {
    if (b.closed) continue;
    const fee = BROKER_UPKEEP[b.id] ?? 50;
    b.credits -= fee;
    ledger(w, { kind: 'repair', from: b.id, to: 'burn', amount: fee, note: 'upkeep' });
    // can't cover tomorrow's upkeep on top of the minimum reserve → the creditors close it
    if (b.credits < BANKRUPT_BELOW + fee) {
      b.closed = true;
      log(w, 'broker', `${b.name} couldn't pay its upkeep and went bankrupt. Invest to reopen it.`);
    }
  }
}

/**
 * Market events: one a day at most, at random. Each hits a different business, so which broker ends a season on
 * top depends on the luck of the season and on the meta — not on who it is. The richest broker draws the taxman.
 */
function marketEvent(w: World, r: Rng) {
  if (r.next() >= EVENT_CHANCE) return;
  const open = w.brokers.filter((b) => !b.closed);
  if (!open.length) return;
  const byId = (id: string) => open.find((b) => b.id === id);
  // every broker has a bad day and a lucky one: audit / contract (Kessler), raid / shipment (Magpie),
  // inspection / riot (Junkman); recall, strike and hype hit whoever holds the wrong stock
  const kind = r.pick(['audit', 'contract', 'raid', 'shipment', 'inspection', 'riot', 'recall', 'strike', 'hype']);
  switch (kind) {
    case 'audit': {
      // the richer, the likelier
      const total = open.reduce((s, b) => s + Math.max(1, b.credits), 0);
      let x = r.next() * total;
      const b = open.find((bb) => (x -= Math.max(1, bb.credits)) <= 0) ?? open[0];
      const fine = Math.round(b.credits * 0.35);
      b.credits -= fine;
      ledger(w, { kind: 'repair', from: b.id, to: 'burn', amount: fine, note: 'tax audit' });
      log(w, 'broker', `📋 Tax audit at ${b.name}: fined ${fine} CR (35% of its cash).`);
      break;
    }
    case 'recall': {
      const x = r.pick(MODELS.filter((m) => m.cost >= 2));
      let lost = 0;
      for (const b of w.brokers)
        for (const rb of brokerStock(w, b, x.id)) {
          delete w.robots[rb.uid];
          lost++;
        }
      log(w, 'broker', `⚠ Factory recall: every ${x.name} in brokers' stock is defective and recalled (${lost} robots). Shortage ahead.`);
      break;
    }
    case 'strike':
      w.strikeUntil = w.hour + hoursPerDay(w) * 2;
      log(w, 'broker', `✊ Factory strike: no new robots for 2 days. Brokers with full stock will cash in.`);
      break;
    case 'raid': {
      const b = byId('soroka');
      if (!b) return;
      const stock = robotsOf(w, b.id);
      const taken = stock.filter(() => r.next() < 0.25);
      for (const rb of taken) delete w.robots[rb.uid];
      log(w, 'broker', `🚨 Police raid on the black market: ${b.name} loses ${taken.length} robots to confiscation.`);
      break;
    }
    case 'contract': {
      const b = byId('kessler');
      if (!b) return;
      const pay = 250 + Math.round(r.next() * 250);
      b.credits += pay;
      ledger(w, { kind: 'reward', from: 'arena', to: b.id, amount: pay, note: 'security contract' });
      log(w, 'broker', `🤝 ${b.name} lands a security contract with the Arena: +${pay} CR.`);
      break;
    }
    case 'shipment': {
      const b = byId('soroka');
      if (!b) return;
      const got = Array.from({ length: 3 + Math.floor(r.next() * 3) }, () => mint(w, r.pick(MODELS).id, b.id));
      log(w, 'broker', `📦 A smuggled shipment reaches ${b.name}: ${got.length} robots for free.`);
      break;
    }
    case 'inspection': {
      const b = byId('scrap');
      if (!b) return;
      const scrap = robotsOf(w, b.id).filter((x) => x.durability <= 0);
      for (const rb of scrap) delete w.robots[rb.uid];
      const fine = Math.round(b.credits * 0.15);
      b.credits -= fine;
      ledger(w, { kind: 'repair', from: b.id, to: 'burn', amount: fine, note: 'inspection' });
      log(w, 'broker', `☣ Environmental inspection at ${b.name}: the scrap yard is cleared and fined ${fine} CR.`);
      break;
    }
    case 'riot': {
      for (const m of w.managers) {
        if (isHuman(m)) continue;
        for (const rb of robotsOf(w, m.id)) rb.durability = Math.max(0, rb.durability - 2);
      }
      log(w, 'broker', `🔥 Riot in the Pit: every NPC team's robots took a beating. Repairs and scrap are in demand.`);
      break;
    }
    case 'hype': {
      const x = r.pick(MODELS);
      for (const b of w.brokers) b.perceived[x.id] = Math.min(100, b.perceived[x.id] + 30);
      log(w, 'broker', `📈 Hype: a streamer swears by ${x.name}. Brokers mark it up — until the battles say otherwise.`);
      break;
    }
  }
}

function endHour(w: World) {
  const rel = actualRelevance(w);
  brokerHour(w, rel);
  w.hour++;
  snapshot(w, rel);
  if (w.hour % hoursPerDay(w) === 0) {
    brokerUpkeep(w);
    withRng(w, (r) => marketEvent(w, r));
    brokerDayEnd(w);
    // league money: NPC teams get their division's daily stipend
    for (const m of w.managers) {
      if (isHuman(m)) continue;
      // only a team that is short of money gets it (up to 400 CR), so the league doesn't inflate the economy
      const pay = Math.min(DIVISIONS[m.div ?? 0].stipend, Math.max(0, 400 - m.credits));
      if (pay <= 0) continue;
      m.credits += pay;
      ledger(w, { kind: 'reward', from: 'league', to: m.id, amount: pay });
    }
    w.dayStartPrice = Object.fromEntries(MODELS.map((x) => [x.id, Math.round(refPrice(w, x.id))]));
    w.reportedToday = [];
    if ((w.hour / hoursPerDay(w)) % DAYS_PER_SEASON === 0) seasonEnd(w);
  }
}

/** Matchmaking by rating: a random one of the 4 closest by ELO. */
export function findOpponent(pool: Manager[], me: Manager, r: Rng): Manager {
  const near = pool
    .filter((x) => x.id !== me.id)
    .sort((x, y) => Math.abs(x.elo - me.elo) - Math.abs(y.elo - me.elo))
    .slice(0, 4);
  return r.pick(near);
}

/** The player meets teams of their own division — first the ones not beaten yet on this climb. */
export function pickOpponentForPlayer(w: World, exclude?: string, managerId = PLAYER_ID): Manager {
  const L = leagueOf(w, managerId);
  const teams = divisionTeams(w, L.div);
  const fresh = teams.filter((m) => !L.beaten.includes(m.id) && m.id !== exclude);
  const pool = fresh.length ? fresh : teams.filter((m) => m.id !== exclude);
  return withRng(w, (r) => r.pick(pool.length ? pool : teams));
}

/** One match between two NPC teams. */
export function playNpcMatch(w: World) {
  const npcs = w.managers.filter((m) => !isHuman(m));
  // NPCs play inside their league (a Scrap team would never face the Apex)
  const [a, b] = withRng(w, (r) => {
    const a = r.pick(npcs);
    return [a, findOpponent(npcs.filter((x) => (x.div ?? 0) === (a.div ?? 0)), a, r)];
  });
  for (const m of [a, b]) {
    if (teamError(teamOf(w, m))) withRng(w, (r) => npcManage(w, m, r));
  }
  const ta = teamOf(w, a);
  const tb = teamOf(w, b);
  if (!teamError(ta) && !teamError(tb)) {
    const seed = withRng(w, (r) => r.int(2 ** 31));
    const st = simulateBattle(ta, tb, seed, [{ careful: a.careful }, { careful: b.careful }]);
    applyMatch(w, a.id, b.id, st);
  }
  withRng(w, (r) => {
    npcManage(w, a, r);
    npcManage(w, b, r);
  });
  w.tick++;
  if (w.tick % matchesPerHour(w) === 0) endHour(w);
}

/** Run N game hours. */
export function advanceHours(w: World, hours: number) {
  for (let i = 0; i < hours * matchesPerHour(w); i++) playNpcMatch(w);
}

// ---------- creating the world ----------


export const STARTER_TEAM = ['spark', 'scout', 'bolt', 'ram', 'welder', 'volt', 'wall', 'dozer', 'drone', 'cracker', 'dash', 'plate'];

export function createWorld(seed: number, playerName = 'You', warmupHours = HOURS_PER_DAY): World {
  const w: World = {
    version: 1,
    rngState: seed >>> 0,
    tick: 0,
    hour: 0,
    season: 1,
    robots: {},
    serial: 0,
    stats: Object.fromEntries(MODELS.map((x) => [x.id, { recent: [], games: 0, wins: 0 }])),
    brokers: [],
    managers: [],
    history: [],
    events: [],
    ledger: [],
    dayStartPrice: {},
    reportedToday: [],
    seasons: [],
  };
  const mkBroker = (id: string, name: string, tagline: string, credits: number, style: BrokerStyle): Broker => ({
    id,
    name,
    tagline,
    style,
    credits,
    closed: false,
    perceived: Object.fromEntries(MODELS.map((x) => [x.id, 50])),
    shares: { [HOUSE]: 1000 },
    dayStartCredits: credits,
    investedToday: 0,
    lastDividend: 0,
  });
  w.brokers.push(
    mkBroker('kessler', 'Kessler Corp', BROKER_TAGLINE.kessler, 3000, {
      spread: 0.15,
      targetStock: 3,
      minCost: 3,
      maxCost: 6,
      react: 0.15,
      scrapper: false,
    }),
    mkBroker('soroka', 'Magpie', BROKER_TAGLINE.soroka, 1200, {
      spread: 0.08,
      targetStock: 2,
      react: 0.6,
      scrapper: false,
    }),
    mkBroker('scrap', 'Junkman', BROKER_TAGLINE.scrap, 1300, {
      spread: 0.1,
      targetStock: 1,
      minCost: 1,
      maxCost: 3,
      react: 0.35,
      scrapper: true,
    }),
  );
  for (const b of w.brokers)
    for (const x of MODELS) if (carries(b, x.id)) for (let i = 0; i < b.style.targetStock; i++) mint(w, x.id, b.id);

  withRng(w, (rng) => {
    NPC_SETUP.forEach(({ name, strategy, div, focus, focus2 }, i) => {
      const m: Manager = {
        id: `npc${i + 1}`,
        name,
        strategy,
        focus,
        focus2,
        div,
        careful: strategy === 'thrifty' ? 0.8 : strategy === 'hype' ? 0.2 : 0.5,
        credits: 300,
        team: [],
        elo: 1000,
        wins: 0,
        losses: 0,
        draws: 0,
      };
      w.managers.push(m);
      let team: Robot[] | null = null;
      while (!team) {
        const classes = div >= 2 && focus2 ? [focus, focus2] : [focus];
        const own = MODELS.filter((x) => classes.includes(classOf(x.id)));
        const basic = MODELS.filter((x) => classOf(x.id) === 'none');
        const pool = Array.from({ length: 22 }, (_, j) => mint(w, rng.pick(j < 14 ? own : basic).id, m.id));
        const value = teamValue(w, m, Object.fromEntries(MODELS.map((x) => [x.id, 50])));
        team = buildTeam(pool, (r) => value(r) + rng.next(), DIVISIONS[div].cap);
        if (!team) for (const r of pool) delete w.robots[r.uid];
        else for (const r of pool) if (!team.includes(r)) delete w.robots[r.uid];
      }
      m.team = team.map((r) => r.uid);
    });
  });

  const player: Manager = {
    id: PLAYER_ID,
    name: playerName,
    strategy: 'player',
    careful: 0.5,
    credits: 1000,
    team: [],
    elo: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
  };
  w.managers.push(player);
  player.team = STARTER_TEAM.map((id) => mint(w, id, PLAYER_ID).uid);
  ensureDecks(player);

  // Warm-up: the world lives a day before the player arrives, so prices already have a history
  advanceHours(w, warmupHours);
  w.events = [];
  w.seasons = [];
  w.hour = 0;
  w.tick = 0;
  w.history = [];
  w.dayStartPrice = Object.fromEntries(MODELS.map((x) => [x.id, Math.round(refPrice(w, x.id))]));
  for (const b of w.brokers) {
    b.dayStartCredits = b.credits;
    b.dayStartEquity = brokerEquity(w, b);
    b.investedToday = 0;
  }
  w.league = { div: 0, beaten: [], crowns: 0 };
  for (const m of w.managers) {
    m.elo = 1000;
    m.wins = m.losses = m.draws = 0;
  }
  snapshot(w, actualRelevance(w));
  log(w, 'season', 'Season 1 has begun. The Arena is open.');
  return w;
}

/**
 * The shared world (logged-in players, run by the game's server): the same world, without the local player —
 * humans join with addHuman. Starts after a day of warm-up so prices already have a history.
 */
export function createSharedWorld(seed: number): World {
  const w = createWorld(seed, 'server');
  // 5-minute game hours, one NPC match each: the market moves every 5 minutes, a game day is a real day
  w.hoursPerDay = 288;
  w.matchesPerHour = 1;
  for (const r of robotsOf(w, PLAYER_ID)) delete w.robots[r.uid];
  w.managers = w.managers.filter((m) => m.id !== PLAYER_ID);
  w.league = undefined;
  w.events = [];
  log(w, 'season', 'The shared Arena is open. Season 1 has begun.');
  return w;
}

