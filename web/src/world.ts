// The shared world: one HEAT INDEX world for every logged-in player, run by this Durable Object with the game's own
// engine (app/src/engine). Real time: one NPC match every 10 minutes, so a game day is a real day and a season is
// 7 real days; no pause, no fast-forward. 12 bot teams (the Pit League), the 3 brokers, prices, investments and
// leaderboards are the same for everyone.
//
// Players: a logged-in player proves they control a NEAR account (a signature by a key on that account), joins
// with the robots and credits the chain says they own, and then every move they make in the game is sent here as
// (operation, args) and replayed on this world with their account as the manager. A battle only counts if its
// action log replays (engine/replay.ts) to the result they reported.

import { DurableObject } from 'cloudflare:workers';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Account, JsonRpcProvider, baseDecode } from 'near-api-js';
import {
  hoursPerDay,
  matchesPerHour,
  addHuman,
  forfeitRanked,
  pickPvpOpponent,
  teamOf,
  applyMatch,
  buy,
  claimLoaner,
  createSharedWorld,
  divest,
  getManager,
  invest,
  isHuman,
  playNpcMatch,
  recycle,
  renameDeck,
  repair,
  restorePlayerFromChain,
  robotsOf,
  selectDeck,
  sell,
  setDeck,
  setTeam,
  type World,
} from '../../app/src/engine/world';
import { battleLogOf, logText, replayBattle, sha256Hex, type BattleLog } from '../../app/src/engine/replay';
import { applyAction, createBattle, type Action, type BattleEvent, type BattleState } from '../../app/src/engine/battle';
import { planTurn } from '../../app/src/engine/ai';
import { redactBattle, redactEvents } from '../../app/src/engine/hidden';
import { applyPolicy, brokerPrompt, fallBackToRules, parsePolicy } from '../../app/src/engine/brokerAi';
import { teamError } from '../../app/src/engine/team';
import { vetRank } from '../../app/src/engine/veteran';

interface Env {
  OWNER_SECRET: string;
  /** a function-call key of the contract account limited to buy/sell/repair/record_battle `_for` — the server
   *  records every trade and battle on-chain after checking it */
  SERVER_KEY?: string;
  /** battle action logs (public, by SHA-256) */
  BATTLES: KVNamespace;
  /** NEAR AI Cloud API keys — the brokers' minds (absent: rule-based brokers); the second is a fallback */
  NEARAI_KEY?: string;
  NEARAI_KEY_2?: string;
}

interface PvpSession {
  st: BattleState;
  oppId: string;
  startedAt: number;
}
/** an online battle left this long counts as a loss */
const PVP_ABANDON_MS = 30 * 60_000;

/** the cheapest DeepSeek on NEAR AI Cloud, verifiable (runs in a TEE); called without reasoning */
const BROKER_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
/** each broker thinks once a real hour (12 five-minute game hours) — cheap and still lively */
const MIND_EVERY_HOURS = 12;

const CONTRACT_ID = 'heat-index-game.testnet';
const RPC_URL = 'https://test.rpc.fastnear.com';
/** real milliseconds per NPC match: a game day is a real day (shared world: 288 five-minute hours, 1 match each) */
const msPerMatch = (w: World) => 86_400_000 / (hoursPerDay(w) * matchesPerHour(w));
const TICK_MS = 60_000;
const CHUNK = 1_000_000; // storage values are split into ~1 MB pieces
const TOKEN_TTL_MS = 12 * 3600_000;

const rpc = async (method: string, params: unknown) => {
  const r = (await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((x) => x.json())) as { result?: any; error?: any };
  if (r.error) throw new Error(JSON.stringify(r.error).slice(0, 200));
  return r.result;
};
const view = async <T>(method: string, args: unknown): Promise<T> => {
  const res = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: CONTRACT_ID,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result))) as T;
};

async function hmacHex(secret: string, text: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The game developer's own accounts: tagged DEV in the Ratings and left out of the season prizes. */
const DEV_ACCOUNTS = ['ginger.heat-index-game.testnet'];
function markDevs(w: World) {
  for (const m of w.managers) if (DEV_ACCOUNTS.includes(m.id)) m.dev = true;
}

export class SharedWorld extends DurableObject<Env> {
  private w: World | null = null;
  private startMs = 0;
  private version = 0;
  private cache: { version: number; text: string } | null = null;
  private lastBattle = new Map<string, number>();
  private dirty = false;

  /** load the world (or create it on the very first request) */
  private async world(): Promise<World> {
    if (this.w) return this.w;
    const meta = (await this.ctx.storage.get<{ startMs: number; chunks: number; version: number }>('meta')) ?? null;
    if (meta) {
      const parts = await this.ctx.storage.get<string>(Array.from({ length: meta.chunks }, (_, i) => `w${i}`));
      this.w = JSON.parse(Array.from({ length: meta.chunks }, (_, i) => parts.get(`w${i}`) ?? '').join('')) as World;
      this.startMs = meta.startMs;
      this.version = meta.version;
    }
    // a world from before the 5-minute clock (or none yet): start a fresh shared world
    if (!this.w?.hoursPerDay) {
      this.w = createSharedWorld(Date.now() % 2 ** 31);
      this.startMs = Date.now();
      this.version = (meta?.version ?? 0) + 1;
      this.dirty = true;
      await this.save();
    }
    // the Ratings now count online battles only: players' old records (league battles included) start over once
    if (this.w && !this.w.rankedOnly) {
      for (const m of this.w.managers) if (isHuman(m)) Object.assign(m, { elo: 1000, wins: 0, losses: 0, draws: 0 });
      this.w.rankedOnly = true;
      this.dirty = true;
      await this.save();
    }
    if (this.w) markDevs(this.w);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    return this.w;
  }

  private async save() {
    if (!this.w || !this.dirty) return;
    this.version++;
    const text = JSON.stringify(this.w);
    const chunks = Math.max(1, Math.ceil(text.length / CHUNK));
    const entries: Record<string, unknown> = { meta: { startMs: this.startMs, chunks, version: this.version } };
    for (let i = 0; i < chunks; i++) entries[`w${i}`] = text.slice(i * CHUNK, (i + 1) * CHUNK);
    await this.ctx.storage.put(entries);
    this.cache = null; // the public copy (decks stripped) is rebuilt on the next state request
    this.dirty = false;
  }

  /** the clock: catch up on the NPC matches that are due (real time) */
  async alarm() {
    const w = await this.world();
    const due = Math.floor((Date.now() - this.startMs) / msPerMatch(w));
    for (let n = 0; w.tick < due && n < 30; n++) {
      playNpcMatch(w);
      this.dirty = true;
    }
    await this.brokerMinds(w);
    await this.sweepPvp(w);
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.endsWith('/auth')) return await this.auth(req);
      if (url.pathname.endsWith('/state')) return await this.state(req);
      if (url.pathname.endsWith('/op')) return await this.op(req);
      if (url.pathname.endsWith('/pvp/start')) return await this.pvpStart(req);
      if (url.pathname.endsWith('/pvp/act')) return await this.pvpAct(req);
      if (url.pathname.endsWith('/public')) return await this.publicState();
      if (url.pathname.endsWith('/think')) {
        const ok = (req.headers.get('authorization') ?? '') === `Bearer ${await hmacHex(this.env.OWNER_SECRET, 'think')}`;
        return ok ? await this.think() : json({ error: 'Forbidden' }, 403);
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message.slice(0, 300) : 'error' }, 500);
    }
  }

  // ---------- the brokers' minds (NEAR AI Cloud) ----------

  private tried = new Map<string, number>();
  private mindError = '';

  /** once a game hour, each open broker asks its model for a policy (clamped to its bounds: engine/brokerAi.ts) */
  private async brokerMinds(w: World) {
    const keys = [this.env.NEARAI_KEY, this.env.NEARAI_KEY_2].filter(Boolean) as string[];
    if (!keys.length) return;
    const due = w.brokers.filter(
      (b) => !b.closed && (b.ai?.at ?? -Infinity) <= w.hour - MIND_EVERY_HOURS && (this.tried.get(b.id) ?? -Infinity) <= w.hour - MIND_EVERY_HOURS,
    );
    await Promise.all(
      due.map(async (b) => {
        this.tried.set(b.id, w.hour);
        try {
          const body = JSON.stringify({
            model: BROKER_MODEL,
            messages: brokerPrompt(w, b),
            temperature: 0.7,
            max_tokens: 250,
            // no reasoning: a short JSON answer is all we need (and it's the cheapest call)
            chat_template_kwargs: { thinking: false, enable_thinking: false },
          });
          let out: { id?: string; choices?: { message?: { content?: string } }[] } | null = null;
          for (const key of keys) {
            // the second key is a fallback (rate limit, empty balance, an outage)
            const res = await fetch('https://cloud-api.near.ai/v1/chat/completions', {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body,
              signal: AbortSignal.timeout(30_000),
            });
            if (res.ok) {
              out = await res.json();
              break;
            }
            this.mindError = `${res.status} ${(await res.text()).slice(0, 160)}`;
          }
          if (!out) {
            // no key works (no credits, revoked, an outage): the broker trades by its rules until the AI answers
            fallBackToRules(w, b);
            this.dirty = true;
            return;
          }
          const text = (out.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
          const p = parsePolicy(b, text);
          if (!p) {
            this.mindError = `unparsable answer: ${text.slice(0, 160)}`;
            if (!b.ai || w.hour - b.ai.at >= 2 * MIND_EVERY_HOURS) {
              fallBackToRules(w, b);
              this.dirty = true;
            }
          }
          if (p) {
            applyPolicy(w, b, p, { model: BROKER_MODEL, chatId: out.id });
            this.dirty = true;
          }
        } catch (e) {
          // the model is unreachable (timeout, network): a fresh policy is kept, a stale one gives way to the rules
          this.mindError = e instanceof Error ? e.message : String(e);
          if (!b.ai || w.hour - b.ai.at >= 2 * MIND_EVERY_HOURS) {
            fallBackToRules(w, b);
            this.dirty = true;
          }
        }
      }),
    );
  }

  /** debug/demo: run the brokers' minds now (owner token required) */
  async think(): Promise<Response> {
    const w = await this.world();
    this.tried.clear();
    for (const b of w.brokers) if (b.ai) b.ai.at = -Infinity;
    await this.brokerMinds(w);
    await this.save();
    return json({
      keys: [!!this.env.NEARAI_KEY, !!this.env.NEARAI_KEY_2],
      lastError: this.mindError || null,
      brokers: w.brokers.map((b) => ({ id: b.id, ai: b.ai ?? null, style: b.style })),
    });
  }

  // ---------- players ----------

  /**
   * Login: { accountId, publicKey, ts, signature } — the signature (by a key of that account: the game key) over
   * "heat-index-world:<accountId>:<ts>". Returns a session token; joins the player on their first visit.
   */
  private async auth(req: Request) {
    const { accountId, publicKey, ts, signature, name } = (await req.json()) as Record<string, string>;
    if (!/^[a-z0-9_.-]{2,64}$/.test(accountId ?? '')) return json({ error: 'Bad account' }, 400);
    // the testnet demo bots (bot-*.heat-index-game.testnet) are scripts, not players
    if (/^bot-[a-z]+\.heat-index-game\.testnet$/.test(accountId)) return json({ error: 'Demo bots do not join the shared world' }, 403);
    if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return json({ error: 'The login request expired' }, 400);
    const pub = baseDecode(String(publicKey).replace(/^ed25519:/, ''));
    const sig = Uint8Array.from(atob(String(signature)), (c) => c.charCodeAt(0));
    const msg = new TextEncoder().encode(`heat-index-world:${accountId}:${ts}`);
    if (!ed25519.verify(sig, msg, pub)) return json({ error: 'Bad signature' }, 401);
    // the key must be an access key of that account
    try {
      await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
    } catch {
      return json({ error: 'That key is not on the account' }, 401);
    }
    const w = await this.world();
    if (!w.managers.some((m) => m.id === accountId)) {
      // first visit: the player's robots, credits and league come from the chain, not from the browser
      const tokens = await view<any[]>('mt_tokens_for_owner', { account_id: accountId, limit: 200 });
      const credits = Number(await view<string>('mt_balance_of', { account_id: accountId, token_id: 'cr' }));
      const league = await view<{ div: number; beaten: string[]; crowns: number }>('league_of', { account_id: accountId });
      const nm = String(name || accountId.split('.')[0]).slice(0, 24);
      addHuman(w, accountId, nm);
      markDevs(w);
      restorePlayerFromChain(
        w,
        accountId,
        {
          credits,
          league,
          robots: tokens.map((t) => ({
            tokenId: t.token_id,
            modelId: t.metadata.model_id,
            durability: t.metadata.durability,
            battles: t.record?.battles,
            wins: t.record?.wins,
          })),
        },
        accountId,
      );
      this.dirty = true;
      await this.save();
    }
    const exp = Date.now() + TOKEN_TTL_MS;
    const token = `${accountId}.${exp}.${await hmacHex(this.env.OWNER_SECRET, `world:${accountId}:${exp}`)}`;
    return json({ token });
  }

  private async player(req: Request): Promise<string | null> {
    const t = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const i = t.lastIndexOf('.');
    const j = t.lastIndexOf('.', i - 1);
    if (i < 0 || j < 0) return null;
    const accountId = t.slice(0, j);
    const exp = Number(t.slice(j + 1, i));
    if (!(exp > Date.now())) return null;
    return (await hmacHex(this.env.OWNER_SECRET, `world:${accountId}:${exp}`)) === t.slice(i + 1) ? accountId : null;
  }

  /** the world as this player sees it: their manager and robots under the id "player" (the game's local id) */
  private async state(req: Request) {
    const me = await this.player(req);
    if (!me) return json({ error: 'Please log in again' }, 401);
    const w = await this.world();
    // the world was restarted since this login: the client logs in again and rejoins from the chain
    if (!w.managers.some((m) => m.id === me)) return json({ error: 'Please log in again' }, 401);
    if (!this.cache || this.cache.version !== this.version) {
      // players' battle decks are secret (Online opponents are found blind): the shared copy has none of them
      const pub = JSON.parse(JSON.stringify(w)) as World;
      for (const m of pub.managers) if (isHuman(m)) Object.assign(m, { team: [], decks: undefined, activeDeck: undefined });
      this.cache = { version: this.version, text: JSON.stringify(pub) };
    }
    const since = Number(new URL(req.url).searchParams.get('since') ?? -1);
    if (since === this.version) return new Response(null, { status: 204 });
    const text = this.cache.text.split(JSON.stringify(me)).join('"player"');
    const mine = getManager(w, me);
    const own = JSON.stringify({ team: mine.team, decks: mine.decks, activeDeck: mine.activeDeck }).split(JSON.stringify(me)).join('"player"');
    return new Response(`{"version":${this.version},"startMs":${this.startMs},"me":${own},"world":${text}}`, {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** leaderboards without logging in */
  private async publicState() {
    const w = await this.world();
    return json({
      version: this.version,
      managers: w.managers.map((m) => ({ id: m.id, name: m.name, human: isHuman(m), dev: !!m.dev, elo: m.elo, wins: m.wins, losses: m.losses, credits: m.credits })),
      // the brokers' minds, publicly: the latest policy each LLM chose, the model, and the NEAR AI chat id
      brokerModel: BROKER_MODEL,
      brokers: w.brokers.map((b) => ({ id: b.id, name: b.name, closed: b.closed, credits: Math.round(b.credits), style: b.style, ai: b.ai ?? null })),
      clock: { hour: w.hour, day: Math.floor(w.hour / hoursPerDay(w)) + 1, season: w.season },
    });
  }

  private async op(req: Request) {
    const me = await this.player(req);
    if (!me) return json({ error: 'Please log in again' }, 401);
    const { name, args } = (await req.json()) as { name: string; args: unknown[] };
    const w = await this.world();
    if (!w.managers.some((m) => m.id === me)) return json({ error: 'Not in the world yet' }, 400);
    const a = args as any[];
    let err: string | null;
    // the move is applied, then recorded on NEAR; if the chain refuses it, the world goes back to before the move
    const before = JSON.stringify(w);
    const ledgerFrom = w.ledger.length;
    const mine0 = new Map(robotsOf(w, me).map((r) => [r.uid, { ...r }]));
    switch (name) {
      case 'buy':
        err = buy(w, me, a[0], a[1]);
        break;
      case 'sell':
        err = sell(w, me, a[0], a[1] ?? undefined);
        break;
      case 'repair':
        err = repair(w, me, a[0]);
        break;
      case 'invest':
        err = invest(w, me, a[0], Number(a[1]));
        break;
      case 'divest':
        err = divest(w, me, a[0], Number(a[1] ?? 1));
        break;
      case 'claimLoaner':
        err = claimLoaner(w, me);
        break;
      case 'recycle':
        err = recycle(w, me, a[0]);
        break;
      case 'setDeck':
        err = setDeck(w, me, Number(a[0]), a[1]);
        break;
      case 'selectDeck':
        err = selectDeck(w, me, Number(a[0]));
        break;
      case 'renameDeck':
        err = renameDeck(w, me, Number(a[0]), String(a[1]));
        break;
      case 'setTeam':
        err = setTeam(w, me, a[0]);
        break;
      case 'match':
        // online (ranked) battles run on the server (pvpStart / pvpAct) — the browser never sees the hidden cards
        err = a[2] === 'ranked' ? 'Online battles run on the server' : this.match(w, me, String(a[0]), a[1] as BattleLog, 'league');
        break;
      default:
        return json({ error: `Unknown move ${name}` }, 400);
    }
    let tx: { label: string; hash?: string } | null = null;
    if (!err) {
      try {
        tx = await this.mirror(w, me, name, a, ledgerFrom, mine0);
      } catch (e) {
        this.w = JSON.parse(before) as World;
        return json({ error: `NEAR refused the move: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, version: this.version });
      }
      this.dirty = true;
      await this.save();
    }
    return json({ error: err, version: this.version, tx });
  }

  // ---------- online battles, run by the server (hidden information never reaches the browser) ----------

  private async session(me: string): Promise<PvpSession | null> {
    return (await this.ctx.storage.get<PvpSession>(`pvp:${me}`)) ?? null;
  }

  /** an online battle started and never finished counts as a loss */
  private async forfeit(w: World, me: string, s: PvpSession) {
    if (w.managers.some((m) => m.id === me)) forfeitRanked(w, me, s.oppId);
    await this.ctx.storage.delete(`pvp:${me}`);
    this.dirty = true;
  }

  private async sweepPvp(w: World) {
    const all = await this.ctx.storage.list<PvpSession>({ prefix: 'pvp:' });
    for (const [key, s] of all) if (Date.now() - s.startedAt > PVP_ABANDON_MS) await this.forfeit(w, key.slice(4), s);
  }

  /** "Find opponent": the server picks the opponent and the seed, deals, and sends the player's view only */
  private async pvpStart(req: Request) {
    const me = await this.player(req);
    if (!me) return json({ error: 'Please log in again' }, 401);
    const w = await this.world();
    if (!w.managers.some((m) => m.id === me)) return json({ error: 'Please log in again' }, 401);
    const old = await this.session(me);
    if (old) await this.forfeit(w, me, old);
    const mine = teamOf(w, getManager(w, me));
    const err = teamError(mine);
    if (err) return json({ error: `Battle deck not ready: ${err}` });
    const opp = pickPvpOpponent(w, undefined, me);
    if (!opp || opp.id === me) return json({ error: 'No opponent available right now' });
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 2 ** 31;
    const st = createBattle(mine, teamOf(w, opp), seed);
    const s: PvpSession = { st, oppId: opp.id, startedAt: Date.now() };
    await this.ctx.storage.put(`pvp:${me}`, s);
    if (this.dirty) await this.save();
    return json({ view: redactBattle(st), oppId: opp.id, opp: { name: opp.name, elo: opp.elo, human: isHuman(opp) }, version: this.version });
  }

  /**
   * One of the player's moves. The server applies it to the full state; after END TURN it plays the opponent's
   * whole turn with the AI. The answer is the list of steps to animate (redacted views), and the result at the end.
   */
  private async pvpAct(req: Request) {
    const me = await this.player(req);
    if (!me) return json({ error: 'Please log in again' }, 401);
    const { action } = (await req.json()) as { action: Action };
    const w = await this.world();
    const s = await this.session(me);
    if (!s) return json({ error: 'No online battle in progress' });
    const st = s.st;
    if (st.winner !== undefined || st.active !== 0) return json({ error: 'Not your turn' });
    const steps: { action: Action; ev: BattleEvent[]; view: BattleState }[] = [];
    const step = (a: Action): string | null => {
      const ev: BattleEvent[] = [];
      const e = applyAction(st, a, ev);
      if (!e) steps.push({ action: a, ev: redactEvents(ev), view: redactBattle(st) });
      return e;
    };
    const err = step(action);
    if (err) return json({ error: err });
    if (action.t === 'end' && st.winner === undefined && st.active === 1) {
      // the opponent's turn: their deck played by the AI, sharp (few random moves)
      const opp = getManager(w, s.oppId);
      const dur: Record<string, number> = {};
      for (const uid of Object.keys(st.modelOf)) dur[uid] = w.robots[uid]?.durability ?? 1;
      for (const a of planTurn(st, 1, { careful: opp.careful, sloppy: 0.08 }, dur)) {
        if (st.winner !== undefined || st.active !== 1) break;
        step(a);
      }
      if (st.winner === undefined && st.active === 1) step({ t: 'end' });
    }
    let result: { reward: number; tx: { label: string; hash?: string } | null; txError?: string } | null = null;
    if (st.winner !== undefined) {
      // the battle is over: it counts (ELO, W/D/L, wear, reward) and is recorded on NEAR with its log
      const ledgerFrom = w.ledger.length;
      const mine0 = new Map(robotsOf(w, me).map((r) => [r.uid, { ...r }]));
      applyMatch(w, me, s.oppId, st, 'ranked');
      const reward = w.ledger.slice(ledgerFrom).filter((x) => x.kind === 'reward' && x.to === me && !x.note).reduce((t, x) => t + x.amount, 0);
      let tx: { label: string; hash?: string } | null = null;
      let txError: string | undefined;
      try {
        tx = await this.mirror(w, me, 'match', [s.oppId, battleLogOf(st), 'ranked'], ledgerFrom, mine0);
      } catch (e) {
        txError = e instanceof Error ? e.message.slice(0, 200) : String(e);
      }
      await this.ctx.storage.delete(`pvp:${me}`);
      this.lastBattle.set(me, Date.now());
      this.dirty = true;
      await this.save();
      result = { reward, tx, txError };
    } else await this.ctx.storage.put(`pvp:${me}`, s);
    return json({ steps, result, version: this.version });
  }

  // ---------- recording moves on NEAR (the server is the only writer: contract *_for methods) ----------

  private chainQueue: Promise<unknown> = Promise.resolve();

  /** one transaction at a time (one key, ordered nonces) */
  private chainCall(method: string, args: Record<string, unknown>): Promise<{ hash: string; value: unknown }> {
    const run = async () => {
      if (!this.env.SERVER_KEY) throw new Error('the server has no NEAR key');
      const acc = new Account(CONTRACT_ID, new JsonRpcProvider({ url: RPC_URL }), this.env.SERVER_KEY as `ed25519:${string}`);
      const r = await acc.callFunctionRaw({ contractId: CONTRACT_ID, methodName: method, args, gas: 60_000_000_000_000n });
      const st = r.status as { SuccessValue?: string; Failure?: unknown };
      if (st && typeof st === 'object' && 'Failure' in st) throw new Error(JSON.stringify(st.Failure).slice(0, 200));
      const raw = st?.SuccessValue ? atob(st.SuccessValue) : '';
      return { hash: r.transaction.hash as string, value: raw ? JSON.parse(raw) : null };
    };
    const p = this.chainQueue.then(run, run);
    this.chainQueue = p.catch(() => {});
    return p;
  }

  /** what a move changed for this player → the matching contract call */
  private async mirror(w: World, me: string, name: string, a: any[], ledgerFrom: number, mine0: Map<string, any>) {
    const newLedger = w.ledger.slice(ledgerFrom);
    const robotName = (id: string) => id[0].toUpperCase() + id.slice(1);
    if (name === 'buy') {
      const e = newLedger.find((x) => x.kind === 'buy' && x.from === me);
      const r = e?.uid ? w.robots[e.uid] : undefined;
      if (!e || !r) return null;
      const out = await this.chainCall('buy_robot_for', {
        player: me,
        model_id: r.modelId,
        price: String(e.amount),
        durability: Math.max(1, Math.min(16, r.durability)),
        broker: e.to,
      });
      r.chainId = String(out.value);
      return { label: `Buy ${robotName(r.modelId)} · ${e.amount} CR`, hash: out.hash };
    }
    if (name === 'sell') {
      const before = mine0.get(String(a[0]));
      const e = newLedger.find((x) => (x.kind === 'sell' || x.kind === 'scrap') && x.to === me);
      if (!before?.chainId || !e) return null;
      const out = await this.chainCall('sell_robot_for', { player: me, token_id: before.chainId, price: String(e.amount), broker: e.from });
      return { label: `Sell ${robotName(before.modelId)} · ${e.amount} CR`, hash: out.hash };
    }
    if (name === 'repair') {
      const before = mine0.get(String(a[0]));
      const r = w.robots[String(a[0])];
      const e = newLedger.find((x) => x.kind === 'repair' && x.from === me);
      if (!before?.chainId || !r || !e) return null;
      const out = await this.chainCall('repair_robot_for', {
        player: me,
        token_id: before.chainId,
        cost: String(e.amount),
        durability: Math.min(16, r.durability),
      });
      return { label: `Repair ${robotName(r.modelId)} · ${e.amount} CR`, hash: out.hash };
    }
    if (name === 'match') {
      const log = a[1] as BattleLog;
      const text = logText(log);
      const replay = await sha256Hex(text);
      await this.env.BATTLES.put(replay, text); // the public log behind the on-chain hash
      const reward = newLedger.filter((x) => x.kind === 'reward' && x.to === me && !x.note).reduce((s, x) => s + x.amount, 0);
      const wear = log.input.a
        .filter((r) => mine0.get(r.uid)?.chainId)
        .map((r) => ({ token_id: mine0.get(r.uid).chainId, durability: Math.min(16, w.robots[r.uid]?.durability ?? 0) }));
      const opp = w.managers.find((m) => m.id === String(a[0]));
      const res = replayBattle(log).st.winner;
      const result = res === null ? 2 : res === 0 ? 1 : 0;
      const out = await this.chainCall('record_battle_for', {
        player: me,
        // online battles are marked so the contract never counts them toward the league
        opponent: a[2] === 'ranked' ? `online:${opp?.name ?? String(a[0])}`.slice(0, 64) : (opp?.name ?? String(a[0])),
        result,
        reward: String(reward),
        seed: log.input.seed >>> 0,
        wear,
        replay,
      });
      return {
        label: `${a[2] === 'ranked' ? 'Online battle' : 'Battle'} vs ${opp?.name}: ${['loss', 'win', 'draw'][result]} · +${reward} CR`,
        hash: out.hash,
      };
    }
    return null;
  }

  /** a battle counts only if its log replays: the player's deck is theirs, every move is legal, the result is real */
  /**
   * A battle counts only if its log replays. 'league': against a bot team (PvE). 'ranked' (Online): against another
   * player's deck played by the AI, or a bot — the opponent's robots in the log must be theirs.
   */
  private match(w: World, me: string, oppId: string, log: BattleLog, mode: 'ranked' | 'league'): string | null {
    const now = Date.now();
    if (now - (this.lastBattle.get(me) ?? 0) < 30_000) return 'One battle per 30 seconds';
    const opp = w.managers.find((m) => m.id === oppId);
    if (!opp || opp.id === me) return 'No such opponent';
    if (mode === 'league' && isHuman(opp)) return 'League battles are against the bot teams';
    if (mode === 'ranked' && isHuman(opp)) {
      // a player's deck: every robot of side B must be theirs and working
      for (const r of log?.input?.b ?? []) {
        const own = w.robots[r.uid];
        if (!own || own.owner !== opp.id || own.durability <= 0 || own.modelId !== r.modelId) return "That isn't the opponent's deck";
      }
    }
    if (!log?.input?.a?.length) return 'No battle log';
    const mine = new Map(robotsOf(w, me).map((r) => [r.uid, r]));
    for (const r of log.input.a) {
      const own = mine.get(r.uid);
      if (!own || own.durability <= 0 || own.modelId !== r.modelId) return 'That deck is not yours';
      if ((r.vw ?? 0) !== (own.vet?.w ?? 0) || vetRank({ vet: { b: 0, w: r.vw ?? 0 } }) !== vetRank(own)) return 'Veteran records do not match';
      if ((r.dur ?? 0) !== own.durability) return 'Durability does not match';
    }
    if (teamError(log.input.a.map((r) => mine.get(r.uid)!))) return 'Not a legal deck';
    const { st, error } = replayBattle(log);
    if (error) return `The battle does not replay: ${error}`;
    applyMatch(w, me, oppId, st, mode);
    this.lastBattle.set(me, now);
    getManager(w, me); // (keeps the manager hot)
    return null;
  }
}
