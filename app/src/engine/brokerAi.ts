// Brokers with an LLM mind (NEAR AI Cloud, a verifiable model running in a TEE), inside hard rules.
//
// Once a game hour (shared world only — the server calls the model; guests' worlds keep the rule-based brokers),
// each broker gets a brief of its own market — cash, upkeep, its segment, relevance vs what it prices in, stock,
// recent news — and answers with a policy: its markup, how fast it reacts to the meta, how many of each robot to
// keep, which models to stock up on or dump, and a one-line remark in character. The game clamps every number to
// the broker's own bounds (a corp can't turn into a black market), so the model shapes each broker's strategy but
// can't break the economy. Pure code: building the prompt and applying the answer; the HTTP call lives in the
// server (web/src/world.ts).

import { MODELS, model } from './robots';
import { actualRelevance, brokerStock, carries, hoursPerDay, quote, robotsOf, type Broker, type World } from './world';

export interface BrokerPolicy {
  spread: number;
  react: number;
  targetStock: number;
  focus: string[];
  dump: string[];
  remark: string;
}

/** What each broker's mind may set — its character stays (Kessler slow and pricey, Magpie fast and cheap…). */
export const POLICY_BOUNDS: Record<string, { spread: [number, number]; react: [number, number]; stock: [number, number] }> = {
  kessler: { spread: [0.1, 0.2], react: [0.05, 0.3], stock: [2, 4] },
  soroka: { spread: [0.05, 0.12], react: [0.4, 0.8], stock: [1, 3] },
  scrap: { spread: [0.08, 0.15], react: [0.2, 0.5], stock: [1, 2] },
};

const PERSONA: Record<string, string> = {
  kessler:
    'You are Director Vance Kessler of Kessler Corp, a conservative megacorp. You trade only mid and expensive robots (energy 3-6). You hate volatility, keep full stock, charge a premium and never chase hype.',
  soroka:
    'You are Magpie, a black-market dealer. You trade every robot model, react fast to the meta, keep thin stock and low markups, and you are always one police raid from ruin.',
  scrap:
    'You are Old Rust, the Junkman. You trade cheap robots only (energy 1-3) and buy broken robots of any model for parts. You live off wear: riots and long seasons are good for you.',
};

const clamp = (x: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));

/** The chat messages for one broker's decision. */
export function brokerPrompt(w: World, b: Broker): { role: 'system' | 'user'; content: string }[] {
  const rel = actualRelevance(w);
  const bounds = POLICY_BOUNDS[b.id];
  const rows = MODELS.filter((m) => carries(b, m.id)).map((m) => ({
    id: m.id,
    cost: m.cost,
    base: m.basePrice,
    actualRelevance: Math.round(rel[m.id]),
    yourPricedRelevance: Math.round(b.perceived[m.id]),
    stock: brokerStock(w, b, m.id).length,
    ask: quote(w, b, m.id, rel).ask,
  }));
  const news = w.events.filter((e) => e.kind === 'broker' || e.kind === 'price').slice(-6).map((e) => e.text);
  const brief = {
    you: { cash: Math.round(b.credits), closed: b.closed, scrapInYard: robotsOf(w, b.id).filter((r) => r.durability <= 0).length },
    current: { spread: b.style.spread, react: b.style.react, targetStock: b.style.targetStock },
    profitLastDays: b.profitLog ?? [],
    market: rows,
    news,
  };
  return [
    {
      role: 'system',
      content: `${PERSONA[b.id] ?? 'You are a robot broker.'}
You run your shop in HEAT INDEX, a robot-arena economy. Relevance (0-100) is how often a model wins and is played; prices follow what YOU believe its relevance is (yourPricedRelevance), and you update that belief at speed "react". Buying a robot from the Factory costs its base price. Every day you pay upkeep; if you can't, you go bankrupt.
Decide your policy for the next hour. Answer with JSON only:
{"spread": number ${bounds.spread[0]}-${bounds.spread[1]}, "react": number ${bounds.react[0]}-${bounds.react[1]}, "targetStock": integer ${bounds.stock[0]}-${bounds.stock[1]}, "focus": [up to 3 model ids to stock more of], "dump": [up to 3 model ids to stop restocking], "remark": "one short line to customers, in character, max 120 characters"}`,
    },
    { role: 'user', content: JSON.stringify(brief) },
  ];
}

/** Parse and clamp a model answer into a policy (null if it isn't usable JSON). */
export function parsePolicy(b: Broker, text: string): BrokerPolicy | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const bounds = POLICY_BOUNDS[b.id];
  if (!bounds) return null;
  const ids = (x: unknown) =>
    (Array.isArray(x) ? x : []).map(String).filter((id) => MODELS.some((mm) => mm.id === id) && carries(b, id)).slice(0, 3);
  return {
    spread: Math.round(clamp(Number(raw.spread), bounds.spread) * 1000) / 1000,
    react: Math.round(clamp(Number(raw.react), bounds.react) * 1000) / 1000,
    targetStock: Math.round(clamp(Number(raw.targetStock), bounds.stock)),
    focus: ids(raw.focus),
    dump: ids(raw.dump),
    remark: String(raw.remark ?? '').replace(/\s+/g, ' ').slice(0, 140),
  };
}

/** Apply a policy to the broker (the world's restocking reads focus/dump: engine/world.ts → brokerHour). */
/** The brokers' own rules (their parameters before any LLM): what they fall back to when the AI is unavailable. */
export const RULE_STYLE: Record<string, { spread: number; react: number; targetStock: number }> = {
  kessler: { spread: 0.15, react: 0.15, targetStock: 3 },
  soroka: { spread: 0.08, react: 0.6, targetStock: 2 },
  scrap: { spread: 0.1, react: 0.35, targetStock: 1 },
};

/** Life happens: while a broker's mind is out (the LLM is unreachable) the market hears a story instead, and the
 *  broker's rules bend a little with it (always inside its POLICY_BOUNDS). */
export const MOODS: Record<string, { text: string; spread?: number; react?: number; stock?: number }[]> = {
  kessler: [
    { text: "Kessler's head trader flew home — his father is in hospital. The desk follows the manual and plays it safe.", spread: 0.03, react: -0.05 },
    { text: "Kessler's board froze every strategy after a sleepless quarterly review. Nobody signs anything bold.", react: -0.1, stock: -1 },
    { text: "Kessler's CEO is on burnout leave. The interns run the floor, and prices get a little loose.", spread: -0.04, react: 0.08 },
  ],
  soroka: [
    { text: "Magpie hasn't slept in three days — she's sure a raid is coming. She hoards less and sells fast.", spread: -0.02, react: 0.15, stock: -1 },
    { text: "Magpie's little brother got mixed up with the wrong crew. She's distracted and charges more to cover his debts.", spread: 0.03, react: -0.1 },
    { text: "Magpie split up with her fence. Heartbroken, she ignores the hype for a while.", react: -0.2 },
  ],
  scrap: [
    { text: "Junkman's old dog is sick. He spends his days at the vet and leaves the yard to his nephew.", spread: 0.02, react: -0.1 },
    { text: "Junkman's back gave out hauling a Dozer chassis. He barely moves, so his prices barely move either.", react: -0.13 },
    { text: "It's the anniversary of the yard fire, and Junkman is in a dark mood: gruff, slow and pricier.", spread: 0.04, react: -0.15 },
  ],
};

/** The LLM can't be reached (keys out of credits, an outage): the broker goes back to its rules — bent by what is
 *  going on in its life — until the AI answers again. */
export function fallBackToRules(w: World, b: Broker) {
  if (!b.ai && b.mindOff !== undefined) return;
  const rule = RULE_STYLE[b.id];
  const bounds = POLICY_BOUNDS[b.id];
  const moods = MOODS[b.id] ?? [];
  // which story: changes from one outage to the next, the same for everyone in the shared world
  const mood = moods.length ? moods[[...`${b.id}:${w.hour}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % moods.length] : undefined;
  if (rule) {
    const fit = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
    Object.assign(b.style, {
      spread: bounds ? Math.round(fit(rule.spread + (mood?.spread ?? 0), bounds.spread) * 1000) / 1000 : rule.spread,
      react: bounds ? Math.round(fit(rule.react + (mood?.react ?? 0), bounds.react) * 1000) / 1000 : rule.react,
      targetStock: bounds ? fit(rule.targetStock + (mood?.stock ?? 0), bounds.stock) : rule.targetStock,
    });
  }
  b.ai = undefined;
  b.mindOff = w.hour;
  b.mood = mood?.text;
  w.events.push({ tick: w.tick, day: Math.floor(w.hour / hoursPerDay(w)) + 1, kind: 'broker', text: `⚙ ${mood?.text ?? `${b.name} trades by its rules for now.`}` });
}

export function applyPolicy(w: World, b: Broker, p: BrokerPolicy, meta: { model: string; chatId?: string }) {
  if (b.mindOff !== undefined)
    w.events.push({ tick: w.tick, day: Math.floor(w.hour / hoursPerDay(w)) + 1, kind: 'broker', text: `🧠 ${b.name} is back at the desk, clear-headed.` });
  b.mindOff = undefined;
  b.mood = undefined;
  b.style.spread = p.spread;
  b.style.react = p.react;
  b.style.targetStock = p.targetStock;
  b.ai = { at: w.hour, ...p, model: meta.model, chatId: meta.chatId };
  const names = (xs: string[]) => xs.map((id) => model(id).name).join(', ');
  if (p.focus.length || p.dump.length)
    w.events.push({
      tick: w.tick,
      day: Math.floor(w.hour / hoursPerDay(w)) + 1,
      kind: 'broker',
      text: `🧠 ${b.name}${p.focus.length ? ` stocks up on ${names(p.focus)}` : ''}${p.focus.length && p.dump.length ? ';' : ''}${p.dump.length ? ` dumps ${names(p.dump)}` : ''}.`,
    });
}
