// Faces and voices of the three brokers (LLM-run on NEAR AI in the shared world, rule-based for guests): a hand-drawn pixel portrait, a title, a one-line bio, and a live remark
// that reacts to the market (their profit, their cash, the robots they misprice, the player's stake).

import { memo, type ReactElement } from 'react';
import { MODELS, model } from '../engine/robots';
import { HOUSE, PLAYER_ID, actualRelevance, brokerProfitToday, robotsOf, type Broker, type World } from '../engine/world';

interface Persona {
  person: string;
  title: string;
  bio: string;
  color: string;
  art: string[];
  pal: Record<string, string>;
}

// pixel portraits: one character per pixel, '.' is empty; letters map to the palette below
export const PERSONAS: Record<string, Persona> = {
  kessler: {
    person: 'Director Vance Kessler',
    title: 'Kessler Corp · megacorp',
    bio: 'Has never lost a quarter. Never trusts a trend. Never touches cheap junk.',
    color: '#00f0ff',
    art: [
      '......kkkkkkkk......',
      '.....kSSSSSSSSk.....',
      '....kSssssssssdk....',
      '....kSssssssssdk....',
      '....kvvvvvvvvvvk....',
      '....kvWvvvvvvWvk....',
      '....kSssssssssdk....',
      '....kssskkkkssdk....',
      '.....kssssssssk.....',
      '......kddddddk......',
      '...kkkkbbbbbbkkkk...',
      '..kbbbbwwttwwbbbbk..',
      '.kbbbbbbwttwbbbbbbk.',
      '.kbbgbbbbttbbbbbbbk.',
      '.kbbbbbbbttbbbbbbbk.',
      '.kbbbbbbbbbbbbbbbbk.',
    ],
    pal: { k: '#0b0012', S: '#d8e2ff', s: '#8fa3c7', d: '#4a5878', v: '#00f0ff', W: '#ffffff', b: '#1b2033', w: '#e8ecff', t: '#00b8d4', g: '#ffe600' },
  },
  soroka: {
    person: 'Magpie',
    title: 'Black market · dealer',
    bio: 'Smells hype a day early. Sells you anything — an hour later.',
    color: '#ff2a8a',
    art: [
      '.......kkkkkk.......',
      '.....kkHHHHHHkk.....',
      '....kHHhhhhhhHHk....',
      '...kHhhffffffhhHk...',
      '...kHhffffffffhhk...',
      '...khgggfffgggfhk...',
      '...khgGgfffgGgfhk...',
      '...khgggfffgggfhk...',
      '...khhffffffffhhk...',
      '...khhmmmmmmmmhhk...',
      '....khmmmmmmmmhk....',
      '...kkhhmmmmmmhhkk...',
      '..kccchhhhhhhhccck..',
      '.kcccccchhhhcccccck.',
      '.kccwcccccccccccccck',
      '.kcccccccccccccccck.',
    ],
    pal: { k: '#0b0012', H: '#7a2a80', h: '#3a1440', f: '#160c1f', g: '#ff2a8a', G: '#ffffff', m: '#2a2a3a', c: '#241433', w: '#ffe600' },
  },
  scrap: {
    person: 'Old Rust',
    title: 'Junkman · scrap dealer',
    bio: 'Buys whatever is broken. Fixes the cheap stuff, strips the rest.',
    color: '#ff8a00',
    art: [
      '....kkkkkkkkkkkk....',
      '...kYYYYYYYYYYYYk...',
      '...kyyyykkkkyyyyk...',
      '...kyyyykggkyyyyk...',
      '....kkkkkkkkkkkk....',
      '.....keeeeeeeek.....',
      '.....keokeekoek.....',
      '.....keeeeeeeek.....',
      '.....krreeeerrk.....',
      '.....krrrrrrrrk.....',
      '......krrrrrrk......',
      '....kkjjrrrrjjkk....',
      '...kjjjjjjjjjjjjk...',
      '..kjjpjjjjjjjjjpjk..',
      '..kjjjjjjjjjjjjjjjk.',
      '..kjjjjjjjjjjjjjjjk.',
    ],
    pal: { k: '#0b0012', Y: '#f0a040', y: '#c8781e', g: '#39ff14', e: '#b98466', o: '#ff8a00', r: '#9a9a9a', j: '#4a3a2a', p: '#8a6a3a' },
  },
};

/** Pixel portrait; eye / visor pixels glow and blink (index.css · broker portraits). */
export const BrokerPortrait = memo(function BrokerPortrait({ id, size = 84 }: { id: string; size?: number }) {
  const p = PERSONAS[id];
  if (!p) return null;
  const eyes = new Set(['v', 'W', 'g', 'G', 'o']);
  const rects: ReactElement[] = [];
  p.art.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || !p.pal[ch]) continue;
      rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={p.pal[ch]} className={eyes.has(ch) ? 'bp-eye' : undefined} />);
    }
  });
  return (
    <div className="broker-portrait" style={{ ['--bc' as string]: p.color }}>
      <svg viewBox="0 0 20 16" width={size} height={(size * 16) / 20} shapeRendering="crispEdges">
        {rects}
      </svg>
    </div>
  );
});

const pick = <T,>(xs: T[], seed: number) => xs[Math.abs(seed) % xs.length];

/** The broker's live remark: what it thinks of the market right now, in its own voice. */
export function brokerQuote(w: World, b: Broker): string {
  // the broker's own words when its LLM mind spoke this game hour or the last (shared world)
  if (b.ai?.remark && w.hour - b.ai.at <= 1) return b.ai.remark;
  const seed = w.hour * 7 + b.id.length * 13;
  const rel = actualRelevance(w);
  // the robot this broker misprices the most (it sees relevance late)
  const gaps = MODELS.map((m) => ({ m, gap: rel[m.id] - b.perceived[m.id] })).sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));
  const g = gaps[0];
  const today = Math.round(brokerProfitToday(w, b));
  const mine = (b.shares[PLAYER_ID] ?? 0) > 0;
  const outsiders = Object.keys(b.shares).filter((k) => k !== HOUSE).length;
  const scrap = robotsOf(w, b.id).filter((r) => r.durability <= 0).length;
  const name = g ? model(g.m.id).name : 'that robot';

  if (b.id === 'kessler') {
    if (b.closed) return 'This is a temporary restructuring. Kessler Corp does not "go bankrupt".';
    const lines = [
      today >= 0 ? `Up ${today} CR today. As forecast.` : `Down ${-today} CR today. A rounding error.`,
      g && g.gap > 8 ? `Everyone is buying ${name}. Fads fade — my price stays where it is.` : `Our stock is full. Our prices are fair. Our patience is long.`,
      mine ? 'A shareholder! Your dividend is calculated to the third decimal.' : 'Stakes in Kessler Corp: boring, safe, profitable. Like me.',
      g && g.gap < -8 ? `${name}? Our analysts are still reviewing it.` : 'Volatility is for people without a board of directors.',
    ];
    return pick(lines, seed);
  }
  if (b.id === 'soroka') {
    if (b.closed) return '…lights are out. Bring cash and I\'ll open the back door again.';
    const lines = [
      g && g.gap > 0 ? `Psst. ${name} is about to pop. You didn't hear it from me.` : `${name} is cooling down. I'm already dumping mine.`,
      today >= 0 ? `+${today} CR today. Keep the change, choom.` : `Lost ${-today} today. The market owes me.`,
      b.credits < 400 ? 'Cash is tight. A little investment would go a long way… for both of us.' : 'Cheap stock, fast prices, no questions.',
      mine ? 'Partner! We split the loot at midnight.' : `${outsiders > 1 ? 'Some smart money is already in.' : 'Nobody owns a piece of me yet.'} Want in?`,
    ];
    return pick(lines, seed);
  }
  // Junkman
  if (b.closed) return 'Shop\'s shut. Even scrap needs someone to pay for the lights.';
  const lines = [
    scrap > 0 ? `${scrap} wrecks in the yard. By tomorrow they'll fight again.` : 'Yard\'s empty. Go break something, I\'ll buy it.',
    today >= 0 ? `+${today} CR. Rust is a renewable resource.` : `Down ${-today}. Bad day for welding.`,
    'Durability zero? That\'s not broken. That\'s "pre-owned".',
    mine ? 'You own a piece of the yard now. Mind the sharp edges.' : 'A stake in junk pays better than you\'d think.',
  ];
  return pick(lines, seed);
}
