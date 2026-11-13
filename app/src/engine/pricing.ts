// PRICES. All broker pricing logic lives in this one file (the track asks for readable pricing rules).
// The price explanation (explainPrice) is shown in a tooltip in the game.

import { VET_PRICE, vetRank } from './veteran';
import { durFrac, model, type Robot } from './robots';

// ---------- economy parameters ----------
export const ECON = {
  recentWindow: 50, // how many recent battles relevance is computed from
  minGamesForFullTrust: 10, // until there are this many battles, relevance is pulled toward 50
  winWeight: 70, // weight of the win rate in relevance
  pickWeight: 30, // weight of popularity
  stockFactorMin: 0.6,
  stockFactorMax: 1.6,
  repairShare: 0.3, // full repair = 30% of the fair price (expensive robots pay off if you play and repair them)
  scrapShare: 0.15, // selling a broken robot for parts = 15%; a worn-out robot at a broker is worth about the same
  // Battle purse = purseRate × (both teams' value at base prices).
  // The winner takes winShare, a draw gives drawShare to each, the loser gets lossShare.
  purseRate: 0.015,
  // the human player's battles pay more (Arena prize money for challengers) — so a few wins buy a good robot
  playerPurseRate: 0.06,
  winShare: 0.75,
  drawShare: 0.5,
  lossShare: 0.25,
};

export interface ModelStats {
  recent: number[]; // 1 — 1 — win, 0.5 — draw, 0 — loss (the model's recent battles)
  games: number;
  wins: number;
}

export interface BrokerStyle {
  spread: number; // the broker's markup / discount
  targetStock: number; // how many robots of each model the broker wants to keep
  react: number; // 0..1 — how fast the broker notices a change in relevance
  scrapper: boolean; // buys broken robots
}

// ---------- relevance ----------

/** A model's win rate over recent battles (0..1). With few battles it stays close to 0.5. */
export function winRate(s: ModelStats): number {
  if (!s.recent.length) return 0.5;
  const raw = s.recent.reduce((a, b) => a + b, 0) / s.recent.length;
  const trust = Math.min(1, s.recent.length / ECON.minGamesForFullTrust);
  return 0.5 + (raw - 0.5) * trust;
}

/**
 * A model's relevance, 0..100:
 *   70 × win_rate + 30 × pick_rate
 * pick_rate — how many teams picked this model, relative to the most popular one.
 */
export function relevance(s: ModelStats, pickCount: number, maxPickCount: number): number {
  const pick = maxPickCount > 0 ? pickCount / maxPickCount : 0.5;
  return ECON.winWeight * winRate(s) + ECON.pickWeight * pick;
}

// ---------- price ----------

/** Stock multiplier: little in stock — dearer, a lot — cheaper. */
export function stockFactor(stock: number, target: number): number {
  const f = target / Math.max(stock, 0.5);
  return Math.min(ECON.stockFactorMax, Math.max(ECON.stockFactorMin, f));
}

/**
 * A broker's fair price:
 *   base × (0.5 + relevance/100) × stock_multiplier
 * `perceived` — `perceived` — relevance as the broker sees it (it notices changes with a delay).
 */
export function fairPrice(modelId: string, perceived: number, stock: number, style: BrokerStyle): number {
  return model(modelId).basePrice * (0.5 + perceived / 100) * stockFactor(stock, style.targetStock);
}

/**
 * What a robot is worth given its wear (a share of the price of a new one).
 * The curve is convex: a fresh robot barely loses value, a worn-out one is almost scrap
 * ((at near-zero durability — exactly the scrap price). So it pays to play a robot to the end
 * rather than sell it "on its last legs".
 */
export const durabilityFactor = (r: Robot) => ECON.scrapShare + (1 - ECON.scrapShare) * Math.pow(durFrac(r), 1.6);

/** A broker sells at the fair price + markup. */
export const askPrice = (fair: number, style: BrokerStyle) => Math.round(fair * (1 + style.spread));

/** A broker buys a working robot: fair price − discount, adjusted for durability. */
export const bidPrice = (fair: number, style: BrokerStyle, r: Robot) =>
  Math.min(
    Math.round(fair * (1 - style.spread) * durabilityFactor(r) * VET_PRICE[vetRank(r)]),
    gainCap(r),
  );

/**
 * Anti-arbitrage (the NEAR contract checks the same): nobody pays more than GAIN_MAX × what the owner paid for a
 * robot (× its veteran bonus); a starter counts as bought at its base price. The market's range is 0.3…2.4 × base,
 * so only a buy at the very bottom resold at the very top hits it.
 */
export const GAIN_MAX = 2.5;
export const gainCap = (r: Robot) =>
  Math.floor((r.paid ?? model(r.modelId).basePrice) * GAIN_MAX * VET_PRICE[vetRank(r)]);
/** A player's realised trading profit (sale − purchase price) is capped per day (UTC). */
export const DAILY_GAIN_MAX = 1500;

/** Only the scrap dealer takes a broken robot. */
export const scrapPrice = (fair: number) => Math.max(1, Math.round(fair * ECON.scrapShare));

/** Repair to full durability, in proportion to the missing durability. */
export const repairCost = (fair: number, r: Robot) =>
  Math.max(1, Math.round(fair * ECON.repairShare * (1 - durFrac(r))));

/** A broker notices the new relevance with a delay: it moves toward it by the share `react`. */
/** The battle purse and a side's share (res: 1 win, 0.5 draw, 0 loss). */
export function battleReward(teamValueA: number, teamValueB: number, res: number, rate = ECON.purseRate): number {
  const purse = rate * (teamValueA + teamValueB);
  const share = res === 1 ? ECON.winShare : res === 0.5 ? ECON.drawShare : ECON.lossShare;
  return Math.round(purse * share);
}

export const updatePerceived = (prev: number, actual: number, style: BrokerStyle) =>
  prev + (actual - prev) * style.react;

// ---------- the price explanation for the tooltip ----------

export function explainPrice(p: {
  brokerName: string;
  modelId: string;
  ask: number;
  perceived: number;
  actual: number;
  winRate: number;
  stock: number;
  style: BrokerStyle;
}): string {
  const md = model(p.modelId);
  const parts: string[] = [];
  const base = md.basePrice;
  const diff = Math.round(((p.ask - base) / base) * 100);
  parts.push(`${md.name}: ${p.ask} CR (base ${base}, ${diff >= 0 ? '+' : ''}${diff}%).`);
  parts.push(
    `Wins ${Math.round(p.winRate * 100)}% of recent battles, relevance ${Math.round(p.actual)}/100.`,
  );
  if (Math.abs(p.perceived - p.actual) >= 5) {
    parts.push(
      p.perceived < p.actual
        ? `${p.brokerName} hasn't noticed the rise yet — still sees relevance ${Math.round(p.perceived)}.`
        : `${p.brokerName} hasn't noticed the drop yet — still sees relevance ${Math.round(p.perceived)}.`,
    );
  }
  const sf = stockFactor(p.stock, p.style.targetStock);
  if (sf > 1.05) parts.push(`${p.stock} in stock (I usually keep ${p.style.targetStock}) — shortage, price is up.`);
  else if (sf < 0.95) parts.push(`${p.stock} in stock (usually ${p.style.targetStock}) — surplus, price is down.`);
  parts.push(`My markup: ${Math.round(p.style.spread * 100)}%.`);
  return parts.join(' ');
}
