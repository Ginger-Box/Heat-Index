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
import { baseDecode } from 'near-api-js';
import {
  addHuman,
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
import { replayBattle, type BattleLog } from '../../app/src/engine/replay';
import { teamError } from '../../app/src/engine/team';
import { vetRank } from '../../app/src/engine/veteran';

interface Env {
  OWNER_SECRET: string;
}

const CONTRACT_ID = 'heat-index-game.testnet';
const RPC_URL = 'https://test.rpc.fastnear.com';
const MATCH_EVERY_MS = 10 * 60_000; // one NPC match / 10 min → 12 per game hour → a game day = a real day
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
    } else {
      this.w = createSharedWorld(Date.now() % 2 ** 31);
      this.startMs = Date.now();
      this.dirty = true;
      await this.save();
    }
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
    this.cache = { version: this.version, text };
    this.dirty = false;
  }

  /** the clock: catch up on the NPC matches that are due (real time) */
  async alarm() {
    const w = await this.world();
    const due = Math.floor((Date.now() - this.startMs) / MATCH_EVERY_MS);
    for (let n = 0; w.tick < due && n < 30; n++) {
      playNpcMatch(w);
      this.dirty = true;
    }
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.endsWith('/auth')) return await this.auth(req);
      if (url.pathname.endsWith('/state')) return await this.state(req);
      if (url.pathname.endsWith('/op')) return await this.op(req);
      if (url.pathname.endsWith('/public')) return await this.publicState();
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message.slice(0, 300) : 'error' }, 500);
    }
  }

  // ---------- players ----------

  /**
   * Login: { accountId, publicKey, ts, signature } — the signature (by a key of that account: the game key) over
   * "heat-index-world:<accountId>:<ts>". Returns a session token; joins the player on their first visit.
   */
  private async auth(req: Request) {
    const { accountId, publicKey, ts, signature, name } = (await req.json()) as Record<string, string>;
    if (!/^[a-z0-9_.-]{2,64}$/.test(accountId ?? '')) return json({ error: 'Bad account' }, 400);
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
    if (!this.cache || this.cache.version !== this.version) this.cache = { version: this.version, text: JSON.stringify(w) };
    const since = Number(new URL(req.url).searchParams.get('since') ?? -1);
    if (since === this.version) return new Response(null, { status: 204 });
    const text = this.cache.text.split(JSON.stringify(me)).join('"player"');
    return new Response(`{"version":${this.version},"startMs":${this.startMs},"world":${text}}`, {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** leaderboards without logging in */
  private async publicState() {
    const w = await this.world();
    return json({
      version: this.version,
      managers: w.managers.map((m) => ({ id: m.id, name: m.name, human: isHuman(m), elo: m.elo, wins: m.wins, losses: m.losses, credits: m.credits })),
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
        err = this.match(w, me, String(a[0]), a[1] as BattleLog);
        break;
      default:
        return json({ error: `Unknown move ${name}` }, 400);
    }
    if (!err) {
      this.dirty = true;
      await this.save();
    }
    return json({ error: err, version: this.version });
  }

  /** a battle counts only if its log replays: the player's deck is theirs, every move is legal, the result is real */
  private match(w: World, me: string, oppId: string, log: BattleLog): string | null {
    const now = Date.now();
    if (now - (this.lastBattle.get(me) ?? 0) < 30_000) return 'One battle per 30 seconds';
    const opp = w.managers.find((m) => m.id === oppId);
    if (!opp || isHuman(opp)) return 'Battles are against the bot teams';
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
    applyMatch(w, me, oppId, st);
    this.lastBattle.set(me, now);
    getManager(w, me); // (keeps the manager hot)
    return null;
  }
}
