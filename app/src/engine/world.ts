// Мир NEON PIT: брокеры, менеджеры (NPC и игрок), роботы, статистика, сезон.
// Состояние — обычный сериализуемый объект: его можно хранить в браузере, на сервере
// и сверять с записями в блокчейне (ledger).

import './ai'; // registers the battle AI used by simulateBattle
import { simulateBattle, wearLoss, type BattleState } from './battle';
import {
  ECON,
  askPrice,
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
import { CLASSES, MAX_DURABILITY, MAX_SAME_MODEL, MODELS, classOf, model, type Robot, type RobotClass } from './robots';
import { buildTeam, partialTeamError, teamError } from './team';

export const PLAYER_ID = 'player';
export const HOUSE = 'house'; // основатели брокера
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
  careful: number; // стиль боя AI
  focus?: RobotClass; // класс роботов, через который играет NPC (у игрока нет)
  credits: number;
  team: string[]; // uid роботов
  elo: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface Broker {
  id: string;
  name: string;
  tagline: string;
  style: BrokerStyle;
  credits: number;
  closed: boolean;
  perceived: Record<string, number>; // актуальность глазами брокера
  shares: Record<string, number>; // владелец -> доли
  dayStartCredits: number;
  /** капитал на начало дня — прибыль дня считается от него */
  dayStartEquity?: number;
  investedToday: number;
  lastDividend: number;
  /** прибыль за последние дни (до 7), CR */
  profitLog?: number[];
  /** дивиденды на одну долю за последние дни (до 7), CR */
  divPerShareLog?: number[];
  /** сколько дивидендов всего получил каждый владелец */
  paidTotal?: Record<string, number>;
}

export type OwnedRobot = Robot & { owner: string; loaner?: boolean };

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
  tick: number; // сыграно матчей NPC
  hour: number; // всего прошло игровых часов
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
}

export const dayOf = (w: World) => Math.floor(w.hour / HOURS_PER_DAY) + 1;
export const dayInSeason = (w: World) => ((dayOf(w) - 1) % DAYS_PER_SEASON) + 1;

// ---------- служебное ----------

function withRng<T>(w: World, fn: (r: Rng) => T): T {
  const r = new Rng(w.rngState);
  const out = fn(r);
  w.rngState = r.state;
  return out;
}

function mint(w: World, modelId: string, owner: string): OwnedRobot {
  const uid = `${modelId}#${++w.serial}`;
  const r: OwnedRobot = { uid, modelId, durability: MAX_DURABILITY, owner };
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

// ---------- актуальность и цены ----------

export function pickCounts(w: World): Record<string, number> {
  const c: Record<string, number> = Object.fromEntries(MODELS.map((x) => [x.id, 0]));
  for (const m of w.managers) for (const r of teamOf(w, m)) c[r.modelId]++;
  return c;
}

export function actualRelevance(w: World, counts = pickCounts(w)): Record<string, number> {
  const max = Math.max(...Object.values(counts));
  return Object.fromEntries(MODELS.map((x) => [x.id, relevance(w.stats[x.id], counts[x.id], max)]));
}

/** Рабочие (не сломанные) роботы модели на складе брокера. */
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

/** Средняя справедливая цена по открытым брокерам — для графиков и оценки активов. */
export function refPrice(w: World, modelId: string): number {
  const open = w.brokers.filter((b) => !b.closed);
  const list = open.length ? open : w.brokers;
  return list.reduce((s, b) => s + brokerFair(w, b, modelId), 0) / list.length;
}

export function bestBid(w: World, r: OwnedRobot): { broker: Broker; price: number } | null {
  if (r.loaner) return null; // списанных роботов Арены не покупают
  let best: { broker: Broker; price: number } | null = null;
  for (const b of w.brokers) {
    if (b.closed) continue;
    const fair = brokerFair(w, b, r.modelId);
    let price: number;
    if (r.durability <= 0) {
      if (!b.style.scrapper) continue;
      // двор с ломом полон — новый лом не берём (раньше скупщик платил за лом, который потом всё равно переплавлял)
      if (robotsOf(w, b.id).filter((x) => x.durability <= 0).length >= SCRAP_YARD_CAP) continue;
      price = scrapPrice(fair);
    } else price = bidPrice(fair, b.style, r) * (b.style.scrapper ? SCRAPPER_WORKING_BID : 1);
    price = Math.round(price);
    if (price > b.credits) continue;
    if (!best || price > best.price) best = { broker: b, price };
  }
  return best;
}

/** Склад учитывается осторожно — по 70% базовой цены (его ещё надо продать). */
const STOCK_BOOK = 0.7;
/** Скупщик лома берёт рабочих роботов неохотно — со скидкой (его дело — сломанные). */
const SCRAPPER_WORKING_BID = 0.8;

/** Капитал брокера: деньги + осторожная оценка склада. От него считаются цена доли и прибыль. */
export function brokerEquity(w: World, b: Broker): number {
  const stockValue = robotsOf(w, b.id).reduce(
    (s, r) => s + model(r.modelId).basePrice * (0.5 + 0.5 * (r.durability / MAX_DURABILITY)),
    0,
  );
  return b.credits + stockValue * STOCK_BOOK;
}

export const totalShares = (b: Broker) => Object.values(b.shares).reduce((s, x) => s + x, 0);

export function sharePrice(w: World, b: Broker): number {
  return Math.max(0.1, brokerEquity(w, b) / Math.max(1, totalShares(b)));
}

/**
 * Ожидаемый доход в день на 100 вложенных CR — среднее по последним дням
 * (дивиденды на долю / текущая цена доли). Это прогноз по прошлому, а не обещание.
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

// ---------- действия (общие для игрока и NPC) ----------

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
  ledger(w, { kind: 'buy', from: m.id, to: b.id, uid: r.uid, amount: price });
  if (m.id === PLAYER_ID) log(w, 'player', `You bought ${model(modelId).name} from ${b.name} for ${price} CR`);
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
    const price = r.durability <= 0 ? scrapPrice(fair) : bidPrice(fair, b.style, r);
    if (price > b.credits) return `${b.name} can't afford it`;
    deal = { broker: b, price };
  } else deal = bestBid(w, r);
  if (!deal) return 'Nobody wants to buy this robot';
  m.credits += deal.price;
  deal.broker.credits -= deal.price;
  r.owner = deal.broker.id;
  m.team = m.team.filter((x) => x !== uid);
  ledger(w, { kind: r.durability <= 0 ? 'scrap' : 'sell', from: deal.broker.id, to: m.id, uid, amount: deal.price });
  if (m.id === PLAYER_ID)
    log(w, 'player', `You sold ${model(r.modelId).name} to ${deal.broker.name} for ${deal.price} CR`);
  return null;
}

/** Цена ремонта у самого дешёвого открытого брокера. */
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
  if (r.durability >= MAX_DURABILITY) return 'The robot is already in full shape';
  const q = repairQuote(w, r);
  if (!q) return 'All workshops are closed';
  if (m.credits < q.cost) return `Not enough credits: repair costs ${q.cost} CR`;
  m.credits -= q.cost; // кредиты сгорают — сток экономики
  r.durability = MAX_DURABILITY;
  ledger(w, { kind: 'repair', from: m.id, to: 'burn', uid, amount: q.cost });
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

/** Сколько брокер может выплатить за доли прямо сейчас (не опускаясь к банкротству). */
export const brokerCashForBuyback = (b: Broker) => Math.max(0, Math.floor(b.credits - BANKRUPT_BELOW - 100));

/** Прибыль брокера с начала дня (рост капитала без учёта новых вложений). */
export const brokerProfitToday = (w: World, b: Broker) =>
  brokerEquity(w, b) - (b.dayStartEquity ?? brokerEquity(w, b)) - b.investedToday;

/**
 * Продать свои доли брокеру по текущей цене доли (fraction — какую часть своих долей, 0..1).
 * Брокер платит из свободных денег; если их не хватает — выкупает столько, сколько может.
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
  b.investedToday -= amount; // вывод денег — не убыток брокера
  m.credits += amount;
  ledger(w, { kind: 'divest', from: b.id, to: m.id, amount });
  if (m.id === PLAYER_ID) log(w, 'player', `You sold shares of ${b.name} for ${amount} CR`);
  return null;
}

export const LOANER_MAX_CREDITS = 40;
export const LOANER_DURABILITY = 5;

const LOANER_MODELS = ['spark', 'scout', 'bolt', 'ram', 'welder'];

/** Можно ли получить пособие Арены: команда не собирается, а денег почти нет. */
export function canClaimLoaner(w: World, managerId: string): boolean {
  const m = getManager(w, managerId);
  if (m.credits >= LOANER_MAX_CREDITS) return false;
  if (buildTeam(robotsOf(w, m.id), () => 0)) return false;
  return LOANER_MODELS.some((x) => countOwned(w, m, x) < MAX_SAME_MODEL);
}

/** Пособие Арены: бесплатный списанный робот (прочность 5). Возвращает ошибку или null. */
export function claimLoaner(w: World, managerId: string): string | null {
  if (!canClaimLoaner(w, managerId)) return 'Only managers with an incomplete team and under 40 CR get a loaner';
  const m = getManager(w, managerId);
  const id = LOANER_MODELS.find((x) => countOwned(w, m, x) < MAX_SAME_MODEL)!;
  const r = mint(w, id, m.id);
  r.durability = LOANER_DURABILITY;
  r.loaner = true;
  ledger(w, { kind: 'mint', from: 'arena', to: m.id, uid: r.uid, amount: 0, note: 'loaner' });
  if (m.id === PLAYER_ID) log(w, 'player', `The Arena gave you a loaner robot: ${model(id).name}`);
  return null;
}

/** Утилизация сломанного робота бесплатно, если продать некому. */
export function recycle(w: World, managerId: string, uid: string): string | null {
  const r = w.robots[uid];
  if (!r || r.owner !== managerId) return 'This is not your robot';
  if (r.durability > 0) return 'Only a broken robot can be recycled';
  delete w.robots[uid];
  const m = getManager(w, managerId);
  m.team = m.team.filter((x) => x !== uid);
  if (managerId === PLAYER_ID) log(w, 'player', `You recycled ${model(r.modelId).name}`);
  return null;
}

export function setTeam(w: World, managerId: string, uids: string[]): string | null {
  const m = getManager(w, managerId);
  const team = uids.map((u) => w.robots[u]);
  if (team.some((r) => !r || r.owner !== m.id)) return 'The team has a robot you do not own';
  // Команду можно хранить неполной: игрок собирает её по слоту. Полноту проверяет Арена перед боем.
  const err = partialTeamError(team);
  if (err) return err;
  m.team = [...uids];
  return null;
}

// ---------- матчи ----------

const BANKRUPT_BELOW = 60;
/** Какая часть дневной прибыли брокера идёт на дивиденды (делится по долям) */
export const DIVIDEND_SHARE = 0.8;
const SCRAP_YARD_CAP = 12;
const REOPEN_AT = 250;

function elo(a: Manager, b: Manager, score: number) {
  const ea = 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
  const k = 24;
  a.elo = Math.round(a.elo + k * (score - ea));
  b.elo = Math.round(b.elo + k * (1 - score - (1 - ea)));
}

/** Применяет итог боя к миру: износ, статистика моделей, награды, рейтинг. */
export function applyMatch(w: World, aId: string, bId: string, st: BattleState) {
  const a = getManager(w, aId);
  const b = getManager(w, bId);
  const sides: [Manager, Manager] = [a, b];
  for (let s = 0; s < 2; s++) {
    const res = st.winner === null ? 0.5 : st.winner === s ? 1 : 0;
    const m = sides[s];
    for (const uid of Object.keys(st.wear)) {
      const r = w.robots[uid];
      if (!r || r.owner !== m.id || !st.wear[uid].fielded) continue;
      r.durability = Math.max(0, r.durability - wearLoss(st, uid));
      const ms = w.stats[r.modelId];
      ms.recent.push(res);
      if (ms.recent.length > ECON.recentWindow) ms.recent.shift();
      ms.games++;
      if (res === 1) ms.wins++;
    }
    const reward = res === 1 ? ECON.rewardWin : res === 0.5 ? ECON.rewardDraw : ECON.rewardLoss;
    m.credits += reward;
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
  // Сломанные списанные роботы Арены отправляются в утиль
  for (const uid of Object.keys(st.wear)) {
    const r = w.robots[uid];
    if (r?.loaner && r.durability <= 0) delete w.robots[uid];
  }
  // Сломанные роботы выпадают из команды
  for (const m of sides) m.team = m.team.filter((u) => (w.robots[u]?.durability ?? 0) > 0);
  if (a.id === PLAYER_ID || b.id === PLAYER_ID) {
    const me = a.id === PLAYER_ID ? 0 : 1;
    const opp = sides[1 - me];
    const txt = st.winner === null ? 'draw' : st.winner === me ? 'win' : 'loss';
    log(w, 'match', `Battle vs ${opp.name}: ${txt}`);
  }
}

// ---------- поведение NPC ----------

const power = (modelId: string) => {
  const md = model(modelId);
  return md.atk + md.hp + (md.ability ? 2 : 0);
};

function teamValue(w: World, m: Manager, rel: Record<string, number>) {
  const base = strategyValue(w, m, rel);
  // Свой класс — в приоритете: NPC собирает команду вокруг него
  return (r: Robot) => base(r) * (m.focus && classOf(r.modelId) === m.focus ? 2 : 1);
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

/** Ход менеджера-NPC между боями: ремонт, продажа лома, покупки по стратегии, сборка команды. */
export function npcManage(w: World, m: Manager, rng: Rng) {
  const rel = actualRelevance(w);
  const owned = () => robotsOf(w, m.id);

  // 1. Сломанные и изношенные
  for (const r of owned()) {
    if (r.durability > 3) continue;
    const q = repairQuote(w, r);
    const worth = refPrice(w, r.modelId);
    const wantsRepair =
      m.strategy === 'thrifty' ? true : m.strategy === 'hype' ? rel[r.modelId] > 55 : power(r.modelId) / worth > 0.12;
    if (q && wantsRepair && m.credits >= q.cost + 60) repair(w, m.id, r.uid);
    else if (r.durability <= 0 && sell(w, m.id, r.uid)) recycle(w, m.id, r.uid);
  }

  // Экономные с деньгами заранее чинят изношенных
  if (m.strategy === 'thrifty' && m.credits > 250) {
    for (const r of owned()) if (r.durability <= 6 && m.credits > 200) repair(w, m.id, r.uid);
  }

  // 2а. Добрать роботов своего класса (хотим не меньше 6 рабочих)
  const focusModels = m.focus ? MODELS.filter((x) => classOf(x.id) === m.focus) : [];
  const focusOwned = owned().filter((r) => r.durability > 0 && classOf(r.modelId) === m.focus).length;
  if (m.focus && focusOwned < 6 && m.credits > 160) {
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

  // 2б. Сделка по стратегии (не каждый раз; богатые торгуют всегда). Чаще — внутри своего класса.
  const universe = m.focus && rng.next() < 0.6 ? focusModels : MODELS;
  if (m.credits > 400 || rng.next() < 0.35) {
    if (m.strategy === 'hype') {
      const top = [...universe].sort((x, y) => rel[y.id] - rel[x.id]).slice(0, 4);
      const target = top.find((x) => countOwned(w, m, x.id) < MAX_SAME_MODEL);
      const offer = target && cheapestOffer(w, target.id);
      if (target && offer && m.credits - offer.price >= 80) buy(w, m.id, offer.broker.id, target.id);
    } else if (m.strategy === 'contrarian') {
      // Продать то, что все переоценили…
      for (const r of owned()) {
        if (r.durability > 0 && rel[r.modelId] > 62 && rng.next() < 0.5) sell(w, m.id, r.uid);
      }
      // …и купить самое недооценённое: побеждает часто, а стоит дешевле базовой цены
      const underrated = (id: string, price: number) => winRate(w.stats[id]) / (price / model(id).basePrice);
      const ranked = universe.map((x) => ({ x, offer: cheapestOffer(w, x.id) }))
        .filter((o) => o.offer && countOwned(w, m, o.x.id) < MAX_SAME_MODEL && o.x.cost >= 2)
        .sort((p, q) => underrated(q.x.id, q.offer!.price) - underrated(p.x.id, p.offer!.price));
      const pick = ranked[0];
      if (pick && m.credits - pick.offer!.price >= 60) buy(w, m.id, pick.offer!.broker.id, pick.x.id);
    }
  }

  // 3. Собрать команду; если не получается — докупить дешёвых роботов
  let hasTeam = false;
  for (let guard = 0; guard < 12; guard++) {
    const team = buildTeam(owned(), teamValue(w, m, rel));
    if (team) {
      m.team = team.map((r) => r.uid);
      hasTeam = true;
      break;
    }
    const working = owned().filter((r) => r.durability > 0);
    const mostExpensive = [...working].sort((x, y) => model(y.modelId).cost - model(x.modelId).cost)[0];
    // Роботов хватает, но не влезают в лимит — продаём самого дорогого
    if (working.length >= 8) {
      if (!mostExpensive || sell(w, m.id, mostExpensive.uid)) break;
      continue;
    }
    // Роботов мало — докупаем самых дешёвых
    const cheap = MODELS.filter((x) => x.cost <= 3 && countOwned(w, m, x.id) < MAX_SAME_MODEL)
      .map((x) => ({ x, offer: cheapestOffer(w, x.id) }))
      .filter((o) => o.offer && o.offer.price <= m.credits)
      .sort(
        (p, q) =>
          Number(classOf(q.x.id) === m.focus) - Number(classOf(p.x.id) === m.focus) ||
          model(p.x.id).cost - model(q.x.id).cost ||
          p.offer!.price - q.offer!.price,
      );
    if (cheap.length) {
      buy(w, m.id, cheap[0].offer!.broker.id, cheap[0].x.id);
      continue;
    }
    // Совсем на мели: продать дорогого робота, чтобы купить дешёвых
    if (mostExpensive && model(mostExpensive.modelId).cost > 2 && !sell(w, m.id, mostExpensive.uid)) continue;
    // Ничего не помогло — пособие Арены
    if (claimLoaner(w, m.id)) break;
  }

  // 4. Не копить лишнее: больше 12 рабочих роботов — продать худших
  const extra = owned().filter((r) => r.durability > 0 && !m.team.includes(r.uid));
  if (hasTeam && extra.length > 4) {
    const val = teamValue(w, m, rel);
    extra.sort((x, y) => val(x) - val(y));
    for (const r of extra.slice(0, extra.length - 4)) sell(w, m.id, r.uid);
  }

  // 5. Иногда NPC вкладываются в брокера в беде
  if (m.credits > 500 && rng.next() < 0.05) {
    const poor = w.brokers.filter((b) => b.credits < 300).sort((x, y) => x.credits - y.credits)[0];
    if (poor) invest(w, m.id, poor.id, 150);
  }
}

// ---------- брокеры: час и день ----------

function brokerHour(w: World, rel: Record<string, number>) {
  for (const b of w.brokers) {
    for (const x of MODELS) b.perceived[x.id] = updatePerceived(b.perceived[x.id], rel[x.id], b.style);
    if (b.closed) continue;
    // Скупщик лома чинит сломанных и выставляет на продажу
    if (b.style.scrapper) {
      const broken = robotsOf(w, b.id).filter((r) => r.durability <= 0);
      // Лишний лом переплавляется — робот исчезает из мира
      for (const r of broken.splice(0, Math.max(0, broken.length - SCRAP_YARD_CAP))) delete w.robots[r.uid];
      for (const r of broken.slice(0, 4)) {
        const cost = Math.round(repairCost(brokerFair(w, b, r.modelId), r) * 0.6);
        if (b.credits - cost < BANKRUPT_BELOW + 40) break;
        b.credits -= cost;
        r.durability = MAX_DURABILITY;
        ledger(w, { kind: 'repair', from: b.id, to: 'burn', uid: r.uid, amount: cost });
      }
    }
    // Дозакупка на Фабрике
    for (const x of MODELS) {
      const stock = brokerStock(w, b, x.id).length;
      if (stock >= b.style.targetStock) continue;
      if (b.credits - x.basePrice < BANKRUPT_BELOW + 100) continue;
      // Брокер не завозит то, что придётся продать дешевле закупки: такой робот пропадает со склада,
      // дефицит поднимает цену, и когда завоз снова окупается — брокер его закупает.
      if (askPrice(brokerFair(w, b, x.id), b.style) < x.basePrice) continue;
      b.credits -= x.basePrice; // деньги уходят Фабрике — сток
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
    // Прибыль — рост капитала за день (а не только денег: закупка склада — не убыток)
    const profit = brokerEquity(w, b) - (b.dayStartEquity ?? brokerEquity(w, b)) - b.investedToday;
    b.lastDividend = 0;
    const total = Object.values(b.shares).reduce((s, x) => s + x, 0);
    b.profitLog = [...(b.profitLog ?? []), Math.round(profit)].slice(-7);
    const perShare =
      profit > 0 && !b.closed ? Math.min(profit * DIVIDEND_SHARE, Math.max(0, b.credits - BANKRUPT_BELOW - 200)) / total : 0;
    b.divPerShareLog = [...(b.divPerShareLog ?? []), perShare].slice(-7);
    if (profit > 0 && !b.closed) {
      // дивиденды не должны разорять брокера: платим только из свободных денег
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
  }
}

// ---------- время ----------

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
  // Мета перезапускается: актуальность сдвигается к 50, история боёв укорачивается
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
    w.dayStartPrice = Object.fromEntries(MODELS.map((x) => [x.id, Math.round(refPrice(w, x.id))]));
    w.reportedToday = [];
    if ((w.hour / HOURS_PER_DAY) % DAYS_PER_SEASON === 0) seasonEnd(w);
  }
}

/** Подбор соперника по рейтингу: случайный из 4 ближайших по ELO. */
export function findOpponent(pool: Manager[], me: Manager, r: Rng): Manager {
  const near = pool
    .filter((x) => x.id !== me.id)
    .sort((x, y) => Math.abs(x.elo - me.elo) - Math.abs(y.elo - me.elo))
    .slice(0, 4);
  return r.pick(near);
}

export function pickOpponentForPlayer(w: World): Manager {
  const npcs = w.managers.filter((m) => m.id !== PLAYER_ID);
  return withRng(w, (r) => findOpponent(npcs, getManager(w, PLAYER_ID), r));
}

/** Один матч двух NPC-команд. */
export function playNpcMatch(w: World) {
  const npcs = w.managers.filter((m) => m.id !== PLAYER_ID);
  const [a, b] = withRng(w, (r) => {
    const a = r.pick(npcs);
    return [a, findOpponent(npcs, a, r)];
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

/** Прокрутить N игровых часов. */
export function advanceHours(w: World, hours: number) {
  for (let i = 0; i < hours * MATCHES_PER_HOUR; i++) playNpcMatch(w);
}

// ---------- создание мира ----------

const NPC_TEAMS: [string, Strategy][] = [
  ['Rusty Dogs', 'hype'],
  ['Neon-17', 'contrarian'],
  ['Syndicate Zero', 'hype'],
  ['Steel Rats', 'thrifty'],
  ['Night Shift', 'contrarian'],
  ['Glitch', 'hype'],
  ['Protocol Omega', 'thrifty'],
  ['Chrome Hawks', 'contrarian'],
  ['Short Circuit', 'thrifty'],
  ['Byte Gang', 'hype'],
  ['Sector 9', 'contrarian'],
  ['Dead Pixel', 'thrifty'],
];

export const STARTER_TEAM = ['spark', 'scout', 'bolt', 'ram', 'welder', 'volt', 'wall', 'dozer'];

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
    NPC_TEAMS.forEach(([name, strategy], i) => {
      const focus = CLASSES[i % CLASSES.length];
      const m: Manager = {
        id: `npc${i + 1}`,
        name,
        strategy,
        focus,
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
        const own = MODELS.filter((x) => classOf(x.id) === focus);
        const pool = Array.from({ length: 14 }, (_, j) => mint(w, rng.pick(j < 8 ? own : MODELS).id, m.id));
        team = buildTeam(pool, (r) => rng.next() + (classOf(r.modelId) === focus ? 1 : 0));
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
    credits: 500,
    team: [],
    elo: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
  };
  w.managers.push(player);
  player.team = STARTER_TEAM.map((id) => mint(w, id, PLAYER_ID).uid);

  // Разогрев: мир живёт день до прихода игрока, чтобы у цен уже была история
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
  for (const m of w.managers) {
    m.elo = 1000;
    m.wins = m.losses = m.draws = 0;
  }
  snapshot(w, actualRelevance(w));
  log(w, 'season', 'Season 1 has begun. The Arena is open.');
  return w;
}
