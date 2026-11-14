// Links a local world's robots to the player's NEP-245 tokens after a login. Moves themselves are recorded on NEAR
// by the shared world's server (web/src/world.ts), not from the browser.

import { PLAYER_ID, restorePlayerFromChain } from '../engine/world';
import { act, getWorld, isShared } from '../store';
import { chainCredits, chainRobots, chainSession, view } from './chain';


/**
 * After a login: if this world isn't tied to the account yet (a new browser, or after "start over"), restore the
 * player from the chain — robots with durability and battle records, credits, league progress. Otherwise give
 * every chain robot token a matching local robot (same model, not linked yet).
 */
export async function linkRobots() {
  const s = chainSession();
  if (!s || isShared()) return; // the shared world's server restores players from the chain itself
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

/**
 * Trades and battles are no longer sent from the browser: a logged-in player plays the shared world, whose server
 * checks every move (prices from its brokers, battles replayed from their logs) and records it on NEAR itself
 * (contract `*_for` methods, web/src/world.ts). The browser key can only `register`.
 */
export function installBridge() {
  /* nothing to install: see web/src/world.ts → mirror() */
}
