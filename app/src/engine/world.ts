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
} = {};
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
  /** league division 0…3 (NPCs; the player's is in World.league) */
  div?: number;
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
}

export const dayOf = (w: World) => Math.floor(w.hour / HOURS_PER_DAY) + 1;
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
  const open = w.brokers.filter((b) => !b.closed);
  const list = open.length ? open : w.brokers;
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
      if (overstocked(w, b, r.modelId)) continue;
      price = bidPrice(fair, b.style, r) * (b.style.scrapper ? SCRAPPER_WORKING_BID : 1);
    }
    price = Math.round(price);
    // buying a robot, the broker never dips below its reserve — otherwise it goes broke on other people's sell-offs
    if (price > b.credits - BANKRUPT_BELOW - 100) continue;
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
  ledger(w, { kind: 'buy', from: m.id, to: b.id, uid: r.uid, amount: price });
  if (m.id === PLAYER_ID) {
    log(w, 'player', `You bought ${model(modelId).name} from ${b.name} for ${price} CR`);
    r.chainId = undefined; // a fresh token is minted for it on-chain
    r.vet = undefined; // …with a fresh battle record
    playerHooks.buy?.(r, price, b.id);
  }
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
    if (r.durability > 0 && overstocked(w, b, r.modelId)) return `${b.name} already has too many of these`;
    const price = r.durability <= 0 ? scrapPrice(fair) : bidPrice(fair, b.style, r);
    if (price > b.credits) return `${b.name} can't afford it`;
    deal = { broker: b, price };
  } else deal = bestBid(w, r);
  if (!deal) return 'Nobody wants to buy this robot';
  if (m.id === PLAYER_ID) {
    // the daily trading-profit cap (the same limit the NEAR contract enforces)
    const gain = Math.max(0, deal.price - (r.paid ?? model(r.modelId).basePrice));
    const day = Math.floor(Date.now() / 86_400_000);
    const g = w.gainDay?.day === day ? w.gainDay : { day, amount: 0 };
    if (g.amount + gain > DAILY_GAIN_MAX)
      return `Daily trading profit limit: ${DAILY_GAIN_MAX} CR a day (${g.amount} used) — sell it tomorrow`;
    w.gainDay = { day, amount: g.amount + gain };
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
    r.chainId = undefined; // the token is burned on-chain; the broker's copy is off-chain stock
  }
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
  return null;
}

/** Choose the deck that goes into battle. */
export function selectDeck(w: World, managerId: string, idx: number): string | null {
  const m = getManager(w, managerId);
  const decks = ensureDecks(m);
  if (!decks[idx]) return 'No such deck';
  m.activeDeck = idx;
  m.team = [...decks[idx].uids];
  return null;
}

export function renameDeck(w: World, managerId: string, idx: number, name: string): string | null {
  const m = getManager(w, managerId);
  const decks = ensureDecks(m);
  const n = name.trim().slice(0, 24);
  if (!n) return 'The name cannot be empty';
  decks[idx].name = n;
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
  return null;
}

// ---------- matches ----------

const BANKRUPT_BELOW = 60;
/** Which part of a broker's daily profit is paid as dividends (split by shares) */
export const DIVIDEND_SHARE = 0.8;
const SCRAP_YARD_CAP = 12;
/** the scrap dealer refurbishes at most this many robots an hour, paying this share of a normal repair */
const JUNK_REPAIRS_PER_HOUR = 1;
const JUNK_REPAIR_COST = 1.5;
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

export function applyMatch(w: World, aId: string, bId: string, st: BattleState) {
  const a = getManager(w, aId);
  const b = getManager(w, bId);
  const sides: [Manager, Manager] = [a, b];
  // team value at base prices — the battle purse comes from it
  const teamValue = sideTeamValues(st);
  for (let s = 0; s < 2; s++) {
    const res = st.winner === null ? 0.5 : st.winner === s ? 1 : 0;
    const m = sides[s];
    for (const uid of Object.keys(st.wear)) {
      const r = w.robots[uid];
      if (!r || r.owner !== m.id || !st.wear[uid].fielded) continue;
      r.durability = Math.max(0, r.durability - wearLoss(st, uid, m.id === PLAYER_ID));
      // veteran record: a win counts for every robot that fought
      const rankBefore = vetRank(r);
      // your robots count at most VET_WINS_PER_DAY wins a day toward the rank (as on NEAR)
      const day = Math.floor(Date.now() / 86_400_000);
      const today = r.vet?.d === day ? (r.vet.t ?? 0) : 0;
      const counts = res === 1 && (m.id !== PLAYER_ID || today < VET_WINS_PER_DAY);
      r.vet = {
        b: (r.vet?.b ?? 0) + 1,
        w: (r.vet?.w ?? 0) + (counts ? 1 : 0),
        ...(m.id === PLAYER_ID ? { d: day, t: today + (counts ? 1 : 0) } : {}),
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
    const reward =
      m.id === PLAYER_ID
        ? playerReward(teamValue[s], teamValue[1 - s], res, sides[1 - s])
        : battleReward(teamValue[s], teamValue[1 - s], res, ECON.purseRate);
    m.credits += reward;
    if (m.id === PLAYER_ID) playerHooks.match?.(st, sides[1 - s].id, res === 1 ? 1 : res === 0 ? 0 : 2, reward);
    ledger(w, { kind: 'reward', from: 'arena', to: m.id, amount: reward });
    if (res === 1) m.wins++;
    else if (res === 0) m.losses++;
    else m.draws++;
  }
  elo(a, b, st.winner === null ? 0.5 : st.winner === 0 ? 1 : 0);
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
  if (a.id === PLAYER_ID || b.id === PLAYER_ID) {
    const me = a.id === PLAYER_ID ? 0 : 1;
    const opp = sides[1 - me];
    const txt = st.winner === null ? 'draw' : st.winner === me ? 'win' : 'loss';
    log(w, 'match', `Battle vs ${opp.name}: ${txt}`);
    if (st.winner === me) leagueWin(w, opp);
  }
}

// ---------- the Pit League ----------

/** The player's purse: the usual one × the opponent's league multiplier (the chain caps a reward at 400 CR). */
export function playerReward(mine: number, theirs: number, res: number, opp: Manager): number {
  return Math.min(400, Math.round(battleReward(mine, theirs, res, ECON.playerPurseRate) * DIVISIONS[opp.div ?? 0].purse));
}

export const leagueOf = (w: World): LeagueState => (w.league ??= { div: 0, beaten: [], crowns: 0 });
export const divisionTeams = (w: World, div: number) => w.managers.filter((m) => m.id !== PLAYER_ID && (m.div ?? 0) === div);

/** A win over a team of your division counts toward the climb; beat all of them to move up. */
function leagueWin(w: World, opp: Manager) {
  const L = leagueOf(w);
  if ((opp.div ?? 0) !== L.div || L.beaten.includes(opp.id)) return;
  L.beaten.push(opp.id);
  const teams = divisionTeams(w, L.div);
  if (!teams.every((t) => L.beaten.includes(t.id))) return;
  const d = DIVISIONS[L.div];
  const prize = divisionPrize(L.div, L.crowns);
  getManager(w, PLAYER_ID).credits += prize;
  ledger(w, { kind: 'reward', from: 'arena', to: PLAYER_ID, amount: prize, note: `${d.name} won` });
  if (L.div < DIVISIONS.length - 1) {
    L.div++;
    log(w, 'season', `You won the ${d.name} (+${prize} CR) and move up to the ${DIVISIONS[L.div].name}!`);
  } else {
    L.crowns++;
    log(w, 'season', `${L.crowns > 1 ? 'Crown defended' : `You beat the whole Apex League: ${KING_TITLE}!`} +${prize} CR.`);
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
    for (const x of MODELS) b.perceived[x.id] = updatePerceived(b.perceived[x.id], rel[x.id], b.style);
    if (b.closed) continue;
    // The scrap dealer repairs broken robots and puts them up for sale
    if (b.style.scrapper) {
      const broken = robotsOf(w, b.id).filter((r) => r.durability <= 0);
      // Extra scrap is melted down — the robot leaves the world
      for (const r of broken.splice(0, Math.max(0, broken.length - SCRAP_YARD_CAP))) delete w.robots[r.uid];
      // Refurbishing: a few a day, only models it is short of, at a real workshop's cost — otherwise cheap scrap
      // turned into cheap stock made it the cheapest seller of everything and it got rich off everyone.
      let fixed = 0;
      for (const r of broken) {
        if (fixed >= JUNK_REPAIRS_PER_HOUR) break;
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
      const stock = brokerStock(w, b, x.id).length;
      if (stock >= b.style.targetStock) continue;
      const cap = x.cost >= 5 ? 1 : x.cost === 4 ? 2 : Infinity;
      if ((b.restockedToday?.[x.id] ?? 0) >= cap) continue;
      // cash reserve after restocking: an expensive model needs a bigger reserve, otherwise a small broker goes broke
      if (b.credits - x.basePrice < BANKRUPT_BELOW + Math.max(100, x.basePrice * 0.8)) continue;
      // A broker doesn't stock what it would have to sell below cost: such a robot disappears from stock,
      // the shortage raises the price, and once restocking pays again the broker buys it.
      if (askPrice(brokerFair(w, b, x.id), b.style) < x.basePrice) continue;
      b.credits -= x.basePrice; // the money goes to the Factory — a sink
      b.restockedToday = { ...(b.restockedToday ?? {}), [x.id]: (b.restockedToday?.[x.id] ?? 0) + 1 };
      const r = mint(w, x.id, b.id);
      ledger(w, { kind: 'mint', from: b.id, to: 'factory', uid: r.uid, amount: x.basePrice });
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
  if (w.history.length > 400) w.history.splice(0, w.history.length - 400);
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
  const res: SeasonResult = {
    season: w.season,
    champions: champs.map((m, i) => ({ id: m.id, name: m.name, elo: m.elo, prize: prizes[i] })),
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

function endHour(w: World) {
  const rel = actualRelevance(w);
  brokerHour(w, rel);
  w.hour++;
  snapshot(w, rel);
  if (w.hour % HOURS_PER_DAY === 0) {
    brokerDayEnd(w);
    // league money: NPC teams get their division's daily stipend
    for (const m of w.managers) {
      if (m.id === PLAYER_ID) continue;
      // only a team that is short of money gets it (up to 400 CR), so the league doesn't inflate the economy
      const pay = Math.min(DIVISIONS[m.div ?? 0].stipend, Math.max(0, 400 - m.credits));
      if (pay <= 0) continue;
      m.credits += pay;
      ledger(w, { kind: 'reward', from: 'league', to: m.id, amount: pay });
    }
    w.dayStartPrice = Object.fromEntries(MODELS.map((x) => [x.id, Math.round(refPrice(w, x.id))]));
    w.reportedToday = [];
    if ((w.hour / HOURS_PER_DAY) % DAYS_PER_SEASON === 0) seasonEnd(w);
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
export function pickOpponentForPlayer(w: World, exclude?: string): Manager {
  const L = leagueOf(w);
  const teams = divisionTeams(w, L.div);
  const fresh = teams.filter((m) => !L.beaten.includes(m.id) && m.id !== exclude);
  const pool = fresh.length ? fresh : teams.filter((m) => m.id !== exclude);
  return withRng(w, (r) => r.pick(pool.length ? pool : teams));
}

/** One match between two NPC teams. */
export function playNpcMatch(w: World) {
  const npcs = w.managers.filter((m) => m.id !== PLAYER_ID);
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
  if (w.tick % MATCHES_PER_HOUR === 0) endHour(w);
}

/** Run N game hours. */
export function advanceHours(w: World, hours: number) {
  for (let i = 0; i < hours * MATCHES_PER_HOUR; i++) playNpcMatch(w);
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
    mkBroker('kessler', 'Kessler Corp', 'Conservative megacorp. Pricey, but always in stock.', 3000, {
      spread: 0.15,
      targetStock: 3,
      react: 0.15,
      scrapper: false,
    }),
    mkBroker('soroka', 'Magpie', 'Black market. Cheap, quick to catch the hype, short on stock.', 1200, {
      spread: 0.08,
      targetStock: 2,
      react: 0.6,
      scrapper: false,
    }),
    mkBroker('scrap', 'Junkman', 'Scrap dealer. Buys broken robots, fixes and resells them.', 1300, {
      spread: 0.1,
      targetStock: 1,
      react: 0.35,
      scrapper: true,
    }),
  );
  for (const b of w.brokers) for (const x of MODELS) for (let i = 0; i < b.style.targetStock; i++) mint(w, x.id, b.id);

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
