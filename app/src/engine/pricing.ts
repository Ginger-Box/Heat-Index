// ЦЕНЫ. Вся логика цен брокеров — в этом одном файле (требование трека: «readable pricing rules»).
// Формулы описаны в DESIGN.md, раздел 7. Объяснение цены (explainPrice) показывается в подсказке.

import { durFrac, model, type Robot } from './robots';

// ---------- параметры экономики ----------
export const ECON = {
  recentWindow: 50, // по скольким последним боям считаем актуальность
  minGamesForFullTrust: 10, // пока боёв меньше — актуальность тянется к 50
  winWeight: 70, // вклад доли побед в актуальность
  pickWeight: 30, // вклад популярности
  stockFactorMin: 0.6,
  stockFactorMax: 1.6,
  repairShare: 0.3, // полный ремонт = 30% справедливой цены (дорогие роботы окупаются, если их играть и чинить)
  scrapShare: 0.15, // сдать сломанного на запчасти = 15%; изношенный робот у брокера стоит почти столько же
  // Призовой фонд боя = purseRate × (стоимость обеих команд по базовым ценам).
  // Победитель забирает winShare, ничья — drawShare каждому, проигравший — lossShare.
  purseRate: 0.02,
  winShare: 0.75,
  drawShare: 0.5,
  lossShare: 0.25,
};

export interface ModelStats {
  recent: number[]; // 1 — победа, 0.5 — ничья, 0 — поражение (последние бои модели)
  games: number;
  wins: number;
}

export interface BrokerStyle {
  spread: number; // наценка/скидка брокера
  targetStock: number; // сколько роботов каждой модели брокер хочет держать
  react: number; // 0..1 — как быстро брокер замечает изменение актуальности
  scrapper: boolean; // покупает сломанных роботов
}

// ---------- актуальность ----------

/** Доля побед модели за последние бои (0..1). Пока боёв мало — ближе к 0.5. */
export function winRate(s: ModelStats): number {
  if (!s.recent.length) return 0.5;
  const raw = s.recent.reduce((a, b) => a + b, 0) / s.recent.length;
  const trust = Math.min(1, s.recent.length / ECON.minGamesForFullTrust);
  return 0.5 + (raw - 0.5) * trust;
}

/**
 * Актуальность модели 0..100:
 *   70 × доля_побед + 30 × доля_выбора
 * доля_выбора — сколько команд взяли эту модель, относительно самой популярной.
 */
export function relevance(s: ModelStats, pickCount: number, maxPickCount: number): number {
  const pick = maxPickCount > 0 ? pickCount / maxPickCount : 0.5;
  return ECON.winWeight * winRate(s) + ECON.pickWeight * pick;
}

// ---------- цена ----------

/** Множитель запаса: мало на складе — дороже, много — дешевле. */
export function stockFactor(stock: number, target: number): number {
  const f = target / Math.max(stock, 0.5);
  return Math.min(ECON.stockFactorMax, Math.max(ECON.stockFactorMin, f));
}

/**
 * Справедливая цена у брокера:
 *   базовая × (0.5 + актуальность/100) × множитель_запаса
 * `perceived` — актуальность, какой её видит брокер (он замечает изменения с задержкой).
 */
export function fairPrice(modelId: string, perceived: number, stock: number, style: BrokerStyle): number {
  return model(modelId).basePrice * (0.5 + perceived / 100) * stockFactor(stock, style.targetStock);
}

/**
 * Сколько стоит робот с учётом износа (доля от цены целого).
 * Кривая выпуклая: свежий робот почти не теряет в цене, изношенный — почти металлолом
 * (при прочности около нуля — ровно цена лома). Поэтому выгоднее доиграть робота до конца,
 * чем продавать его «на последнем издыхании».
 */
export const durabilityFactor = (r: Robot) => ECON.scrapShare + (1 - ECON.scrapShare) * Math.pow(durFrac(r), 1.6);

/** Брокер продаёт по справедливой цене + наценка. */
export const askPrice = (fair: number, style: BrokerStyle) => Math.round(fair * (1 + style.spread));

/** Брокер покупает целого робота: справедливая − скидка, с поправкой на прочность. */
export const bidPrice = (fair: number, style: BrokerStyle, r: Robot) =>
  Math.round(fair * (1 - style.spread) * durabilityFactor(r));

/** Сломанного робота берёт только скупщик лома. */
export const scrapPrice = (fair: number) => Math.max(1, Math.round(fair * ECON.scrapShare));

/** Ремонт до полной прочности, пропорционально недостающей прочности. */
export const repairCost = (fair: number, r: Robot) =>
  Math.max(1, Math.round(fair * ECON.repairShare * (1 - durFrac(r))));

/** Брокер замечает новую актуальность не сразу: сдвигается к ней на долю `react`. */
/** Призовой фонд боя и доля стороны (res: 1 победа, 0.5 ничья, 0 поражение). */
export function battleReward(teamValueA: number, teamValueB: number, res: number): number {
  const purse = ECON.purseRate * (teamValueA + teamValueB);
  const share = res === 1 ? ECON.winShare : res === 0.5 ? ECON.drawShare : ECON.lossShare;
  return Math.round(purse * share);
}

export const updatePerceived = (prev: number, actual: number, style: BrokerStyle) =>
  prev + (actual - prev) * style.react;

// ---------- объяснение цены для подсказки ----------

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
