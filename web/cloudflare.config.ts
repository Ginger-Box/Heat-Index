import { bindings, defineConfig, exports } from "cf/config";

// The public HEAT INDEX site: the game's static build (public/) plus a small Worker for the email login
// (src/index.ts, only /api/* reaches it). Secrets RELAYER_KEY and OWNER_SECRET are uploaded with `cf deploy
// --secrets-file`; they are never in the repo.
export default defineConfig({
  worker: {
    name: "heat-index-web",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-11-13",
    compatibilityFlags: ["nodejs_compat"],
    assets: { runWorkerFirst: ["/api/*"] },
    env: {
      // public: Privy app ids are shown to every visitor anyway
      PRIVY_APP_ID: bindings.text("cmwfvxb4s018e0hkzqvudzfpb"),
      // the shared world for logged-in players (src/world.ts)
      WORLD: bindings.durableObject({ worker: "heat-index-web", exportName: "SharedWorld" }),
      // battle replays (action logs by SHA-256) — provisioned by `cf deploy`
      BATTLES: bindings.kv(),
      RELAYER_KEY: bindings.secret(),
      // the shared world's key: records trades and replayed battles on-chain (*_for methods only)
      SERVER_KEY: bindings.secret(),
      OWNER_SECRET: bindings.secret(),
      // NEAR AI Cloud keys for the brokers' minds (the second one is a fallback)
      NEARAI_KEY: bindings.secret(),
      NEARAI_KEY_2: bindings.secret(),
      // each broker's key limited to record_broker_decision: the broker signs its own TEE-verified AI decisions
      BROKER_KEYS: bindings.secret(),
      // each bot team's key limited to npc_*: the team signs its own moves
      NPC_KEYS: bindings.secret(),
    },
    exports: { SharedWorld: exports.durableObject({ storage: "sqlite" }) },
    observability: { enabled: true },
  },
});
