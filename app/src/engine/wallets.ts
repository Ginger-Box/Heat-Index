// The world's own NEAR accounts: every broker and every Pit League team has one (contract: adopt_world_wallet).
import { NPC_SETUP } from './league';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const WALLET_SUFFIX = '.heat-index-game.testnet';
/** broker id → its display name (as in createWorld) */
const BROKERS: [string, string][] = [
  ['kessler', 'Kessler Corp'],
  ['soroka', 'Magpie'],
  ['scrap', 'Junkman'],
];
export const WORLD_WALLETS: { kind: 'broker' | 'npc'; key: string; name: string; account: string }[] = [
  ...BROKERS.map(([id, name]) => ({ kind: 'broker' as const, key: id, name, account: `broker-${slug(name)}${WALLET_SUFFIX}` })),
  ...NPC_SETUP.map((n) => ({ kind: 'npc' as const, key: n.name, name: n.name, account: `npc-${slug(n.name)}${WALLET_SUFFIX}` })),
];
/** a broker's NEAR account, by broker id */
export const brokerAccount = (brokerId: string) => WORLD_WALLETS.find((x) => x.kind === 'broker' && x.key === brokerId)?.account;
/** an NPC team's NEAR account, by team name */
export const npcAccount = (name: string) => WORLD_WALLETS.find((x) => x.kind === 'npc' && x.key === name)?.account;
