// Mirrors the human player's moves on NEAR: the engine calls playerHooks (engine/world.ts), the bridge turns
// them into contract calls signed with the browser's game key (near/chain.ts), and links the game's robots to
// their NEP-245 token ids (OwnedRobot.chainId).

import { PLAYER_ID, playerHooks, restorePlayerFromChain } from '../engine/world';
import { model } from '../engine/robots';
import { act, getWorld } from '../store';
import { chainCall, chainCredits, chainRobots, chainSession, view } from './chain';
import { PUBLIC_ORIGIN } from './config';
import { battleLogOf, logText, sha256Hex } from '../engine/replay';
import type { BattleState } from '../engine/battle';

/** Stores the battle's action log at the public site's Worker; returns its SHA-256 (what goes on-chain). */
async function publishBattle(st: BattleState): Promise<string | undefined> {
  const log = battleLogOf(st);
  if (!log) return undefined;
  const text = logText(log);
  const hash = await sha256Hex(text);
  const res = await fetch(`${PUBLIC_ORIGIN}/api/battles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
  return res.ok ? hash : undefined;
}

const MAX_DUR = 16; // the contract's durability cap
const clampDur = (d: number) => Math.max(0, Math.min(MAX_DUR, Math.round(d)));

/**
 * After a login: if this world isn't tied to the account yet (a new browser, or after "start over"), restore the
 * player from the chain — robots with durability and battle records, credits, league progress. Otherwise give
 * every chain robot token a matching local robot (same model, not linked yet).
 */
export async function linkRobots() {
  const s = chainSession();
  if (!s) return;
  const tokens = await chainRobots(s.accountId);
  if (getWorld()?.chainAccount !== s.accountId) {
    const [credits, league] = await Promise.all([
      chainCredits(s.accountId),
      view<{ div: number; beaten: string[]; crowns: number }>('league_of', { account_id: s.accountId }).catch(() => undefined),
    ]);
    // nothing on-chain yet (registration still in flight): keep the local starter deck
    if (!tokens.length && !credits) return;
    act((w) =>
      restorePlayerFromChain(w, s.accountId, {
        credits,
        league,
        robots: tokens.map((t) => ({
          tokenId: t.token_id,
          modelId: t.metadata.model_id,
          durability: t.metadata.durability,
          battles: t.record?.battles,
          wins: t.record?.wins,
        })),
      }),
    );
    return;
  }
  act((w) => {
    const linked = new Set(Object.values(w.robots).map((r) => r.chainId).filter(Boolean));
    for (const t of tokens) {
      if (linked.has(t.token_id)) continue;
      const r = Object.values(w.robots)
        .filter((x) => x.owner === PLAYER_ID && !x.chainId && !x.loaner && x.modelId === t.metadata.model_id)
        .sort((a, b) => b.durability - a.durability)[0];
      if (r) {
        r.chainId = t.token_id;
        linked.add(t.token_id);
      }
    }
  });
}

export function installBridge() {
  playerHooks.buy = (r, price, brokerId) => {
    if (!chainSession()) return;
    const uid = r.uid;
    void chainCall<string>(`Buy ${model(r.modelId).name} · ${price} CR`, 'buy_robot', {
      model_id: r.modelId,
      price: String(price),
      durability: Math.max(1, clampDur(r.durability)),
      broker: brokerId,
    }).then((tokenId) => {
      if (!tokenId) return;
      act((w) => {
        const rr = w.robots[uid];
        if (rr && rr.owner === PLAYER_ID) rr.chainId = tokenId;
      });
    });
  };
  playerHooks.sell = (r, price, brokerId) => {
    if (!chainSession() || !r.chainId) return;
    void chainCall(`Sell ${model(r.modelId).name} · ${price} CR`, 'sell_robot', {
      token_id: r.chainId,
      price: String(price),
      broker: brokerId,
    });
  };
  playerHooks.repair = (r, cost) => {
    if (!chainSession() || !r.chainId) return;
    void chainCall(`Repair ${model(r.modelId).name} · ${cost} CR`, 'repair_robot', {
      token_id: r.chainId,
      cost: String(cost),
      durability: clampDur(r.durability),
    });
  };
  playerHooks.match = (st, opponentId, result, reward) => {
    if (!chainSession()) return;
    const w = getWorld();
    if (!w) return;
    const wear = Object.keys(st.wear)
      .filter((uid) => st.wear[uid].fielded && w.robots[uid]?.owner === PLAYER_ID && w.robots[uid]?.chainId)
      .map((uid) => ({ token_id: w.robots[uid].chainId!, durability: clampDur(w.robots[uid].durability) }));
    const opp = w.managers.find((m) => m.id === opponentId)?.name ?? opponentId;
    // publish the battle's action log; its hash goes on-chain, so anyone can replay and check the record.
    // The call takes its place in the queue now (order of moves), the args wait for the upload.
    const args = publishBattle(st)
      .catch(() => undefined)
      .then((replay) => ({ opponent: opp, result, reward: String(reward), seed: (st.input?.seed ?? st.rngState) >>> 0, wear, replay }));
    void chainCall(`Battle vs ${opp}: ${result === 1 ? 'win' : result === 0 ? 'loss' : 'draw'} · +${reward} CR`, 'record_battle', args);
  };
}
