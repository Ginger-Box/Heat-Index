import { bindings, defineConfig } from "cf/config";

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
      RELAYER_KEY: bindings.secret(),
      OWNER_SECRET: bindings.secret(),
    },
    observability: { enabled: true },
  },
});
