// The world's journal: every change to the shared world is one entry, applied by `applyEntry` — the same function on
// the server and in the verifier. Once an hour the server publishes a snapshot of the world and the journal that led
// to it, and writes their SHA-256 on NEAR (contract: commit_world). `npm run verify-world` takes the previous
// snapshot, replays the journal with this engine and must arrive at exactly the committed hash — so the prices,
// the brokers, the bot teams' matches and every balance can be re-derived by anyone, not just trusted.

import { applyPolicy, fallBackToRules, type BrokerPolicy } from './brokerAi';
import { replayBattle, type BattleLog } from './replay';
import {
  addHuman,
  applyMatch,
  buy,
  buyListing,
  claimLoaner,
  divest,
  forfeitRanked,
  invest,
  listRobot,
  playNpcMatch,
  recycle,
  renameDeck,
  repair,
  restorePlayerFromChain,
  selectDeck,
  sell,
  setDeck,
  setTeam,
  unlistRobot,
  type ChainPlayer,
  type World,
} from './world';

export type JournalEntry =
  | { t: 'tick'; now: number }
  | { t: 'op'; me: string; name: string; args: unknown[]; now: number }
  | { t: 'join'; accountId: string; name: string; chain: ChainPlayer; devs: string[] }
  | { t: 'dev'; ids: string[] }
  | { t: 'policy'; broker: string; p: BrokerPolicy; meta: { model: string; chatId?: string } }
  | { t: 'fallback'; broker: string }
  | { t: 'aiTx'; broker: string; tx?: string; err?: string }
  | { t: 'thinkReset' }
  | { t: 'chainId'; uid: string; id?: string }
  | { t: 'adopted'; account: string }
  | { t: 'pvp'; me: string; oppId: string; log: BattleLog; now: number }
  | { t: 'forfeit'; me: string; oppId: string; now: number };

/** runs fn with Date.now() fixed (the engine's daily caps read the date) */
function at<T>(now: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/** A player's move on the shared world (what the server accepted). Returns the engine's error, if any. */
export function applyOp(w: World, me: string, name: string, args: unknown[]): string | null {
  const a = args as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (name) {
    case 'buy':
      return buy(w, me, a[0], a[1]);
    case 'sell':
      return sell(w, me, a[0], a[1] ?? undefined);
    case 'repair':
      return repair(w, me, a[0]);
    case 'invest':
      return invest(w, me, a[0], Number(a[1]));
    case 'divest':
      return divest(w, me, a[0], Number(a[1] ?? 1));
    case 'claimLoaner':
      return claimLoaner(w, me);
    case 'recycle':
      return recycle(w, me, a[0]);
    case 'setDeck':
      return setDeck(w, me, Number(a[0]), a[1]);
    case 'selectDeck':
      return selectDeck(w, me, Number(a[0]));
    case 'renameDeck':
      return renameDeck(w, me, Number(a[0]), String(a[1]));
    case 'setTeam':
      return setTeam(w, me, a[0]);
    case 'list':
      return listRobot(w, me, String(a[0]), Number(a[1]));
    case 'unlist':
      return unlistRobot(w, me, String(a[0]));
    case 'buyListing':
      return buyListing(w, me, String(a[0]));
    case 'match': {
      const { st, error } = replayBattle(a[1] as BattleLog);
      if (error) return error;
      applyMatch(w, me, String(a[0]), st, 'league');
      return null;
    }
    default:
      return `Unknown move ${name}`;
  }
}

export function applyEntry(w: World, e: JournalEntry): string | null {
  switch (e.t) {
    case 'tick':
      at(e.now, () => playNpcMatch(w));
      return null;
    case 'op':
      return at(e.now, () => applyOp(w, e.me, e.name, e.args));
    case 'join': {
      addHuman(w, e.accountId, e.name);
      for (const m of w.managers) if (e.devs.includes(m.id)) m.dev = true;
      restorePlayerFromChain(w, e.accountId, e.chain, e.accountId);
      return null;
    }
    case 'dev':
      for (const m of w.managers) if (e.ids.includes(m.id)) m.dev = true;
      return null;
    case 'policy': {
      const b = w.brokers.find((x) => x.id === e.broker);
      if (b) applyPolicy(w, b, e.p, e.meta);
      return null;
    }
    case 'fallback': {
      const b = w.brokers.find((x) => x.id === e.broker);
      if (b) fallBackToRules(w, b);
      return null;
    }
    case 'aiTx': {
      const ai = w.brokers.find((x) => x.id === e.broker)?.ai;
      if (ai) {
        ai.tx = e.tx;
        ai.verifyError = e.err;
      }
      return null;
    }
    case 'thinkReset':
      for (const b of w.brokers) if (b.ai) b.ai.at = -Infinity;
      return null;
    case 'chainId': {
      const r = w.robots[e.uid];
      if (r) r.chainId = e.id;
      return null;
    }
    case 'adopted':
      (w.walletsAdopted ??= {})[e.account] = true;
      return null;
    case 'pvp': {
      const { st } = replayBattle(e.log);
      at(e.now, () => applyMatch(w, e.me, e.oppId, st, 'ranked'));
      return null;
    }
    case 'forfeit':
      at(e.now, () => forfeitRanked(w, e.me, e.oppId));
      return null;
  }
}

/** The world as text — what is published and hashed. Plain JSON keeps the order of keys, and the order matters: the
 *  engine walks robots in insertion order, so a snapshot must restore exactly that order. */
export const worldText = (w: World) => JSON.stringify(w);

/** Deck-only moves: they touch nothing but the player's own (secret) battle decks, so they stay out of the journal. */
export const DECK_OPS = ['setDeck', 'selectDeck', 'renameDeck', 'setTeam'];

/** What is published and committed: the world without players' battle decks (those stay secret — Online is blind). */
export function publicWorldText(w: World): string {
  const pub = JSON.parse(JSON.stringify(w)) as World;
  for (const m of pub.managers) if (m.id === 'player' || m.human) Object.assign(m, { team: [], decks: undefined, activeDeck: undefined });
  return JSON.stringify(pub);
}
