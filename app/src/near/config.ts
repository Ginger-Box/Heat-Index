// NEAR testnet configuration of HEAT INDEX. No secrets here: the only server-side key (used to create player
// accounts for the email login) is read by the dev server from the local near CLI credentials — see
// vite.config.ts → nearRelayer().

export const NETWORK = 'testnet';
export const RPC_URL = 'https://rpc.testnet.near.org';
export const EXPLORER = 'https://testnet.nearblocks.io';
/** The game contract: credits and robots as NEP-245 multi tokens, trades and battles (contract/src/lib.rs). */
export const CONTRACT_ID = 'heat-index-game.testnet';

/** NEAR Auth (email / Google / passkey login) — shared testnet credentials from docs.auth.near.org. */
export const NEAR_AUTH = {
  clientId: 'np8paqIpMWmNbzT4xAvOOapZBjsOpptl',
  fastAuthContractId: 'fast-auth.testnet',
  mpcContractId: 'v1.signer-prod.testnet',
  /** the shared testnet Auth0 app only accepts this origin as a login callback */
  origin: 'http://localhost:3000',
};

/** Contract methods the in-browser game key may call (must match GAME_METHODS in the contract). */
export const GAME_METHODS = ['register', 'buy_robot', 'sell_robot', 'repair_robot', 'record_battle'];
/** How much of the account's NEAR the game key may spend on gas. */
export const GAME_KEY_ALLOWANCE = 120_000_000_000_000_000_000_000n; // 0.12 NEAR
