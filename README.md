# HEAT INDEX

**An underground cyberpunk robot arena where the economy *is* the gameplay.**
Built for the NEAR hackathon track **"Games With Real Economies"**.

Robots are cards that **wear out**: every battle costs durability, repairs cost credits — every hit has a price.
A robot's market price follows its **relevance** (how often it wins and how many teams field it), so the market
*is* the meta. AI brokers trade with a **reaction lag** — spot what's rising before they do and you profit.

> **Play:** https://heat-index-web.ginger-box.workers.dev — email (one-time code), NEAR wallet, or guest ·
> locally on `http://localhost:3000` (email through NEAR Auth).
> Contract: [`heat-index-game.testnet`](https://testnet.nearblocks.io/address/heat-index-game.testnet) on NEAR testnet.

## For judges: 2 minutes

1. Open the game (public site, or `cd app && npm install && npm run dev` → `http://localhost:3000`).
   Pick **Continue with email** (a 6-digit code — a real NEAR account is created for you), **Connect NEAR wallet**,
   or **Play as a guest** (off-chain).
2. A short **training battle** starts → you see the Overheat combat: deploy into slots, drag an arrow to attack,
   heat pips, screen cracks on heavy hits.
3. **Market** tab → hover a price: the tooltip explains it (relevance × stock × the broker's markup). The **BUY /
   SELL** signal is actual relevance vs what brokers price in — they notice the meta with a delay.
4. **Brokers** tab → three AI brokers with their own cash, stock, reaction speed and a live remark; invest in one and
   get a cut of its daily profit.
5. ⚙ (top right) → **Fast-forward a week** → 7 game days in ~35 s: prices, relevance and broker fortunes move;
   **Analytics** shows the history by robot and by class.
6. Logged in on NEAR? The **NEAR** cell in the top bar lists every move you make as a testnet transaction with an
   explorer link. Contract: [`heat-index-game.testnet`](https://testnet.nearblocks.io/address/heat-index-game.testnet).

### What is on-chain and what is simulated

| | Where | Proof |
|---|---|---|
| Player credits (`cr`) and every player robot (`robot:<model>:<serial>`) | **NEAR testnet, NEP-245** | `mt_balance_of`, `mt_tokens_for_owner` |
| Registration: 12 starter robots + 1000 CR | **on-chain** | [register tx](https://testnet.nearblocks.io/txns/9LkHUBch9gbU1rBH9TQAz8WzgFVaFnuo8fdkPHmGpgnk) |
| Player buys a robot (credits burned, robot token minted) | **on-chain** | [buy tx](https://testnet.nearblocks.io/txns/8Qd8Mj9a8xvTDth2jsc7T1M3pv23cYbgZqqyAFJK8yUS) |
| Battle result: reward minted, each robot's wear written | **on-chain** | [battle tx](https://testnet.nearblocks.io/txns/2bFPt1rCy6iXAdckKVo7BnneWWAxeUBXN6xmfAe8eqKU) |
| Sales and repairs | **on-chain** | [sell tx](https://testnet.nearblocks.io/txns/2b2HaZpN9uggRKTy5KTLy7ST7tHV26vvhAWhGRAdEYjm) · [repair tx](https://testnet.nearblocks.io/txns/5TxCb4g24XeafCvFLxYdLMtVccuGr2RPc5jWZPfKicK8) |
| Veteran records: every robot's battles and wins; wins give a rank (★ 3, ★★ 8, ★★★ 15) and raise the most a broker may pay for it | **on-chain** (`record_battle`, shown in `mt_token(...).record`, `veteran` events) | `mt_tokens_for_owner` of any `bot-*` account |
| Pit League progress (division, teams beaten, crowns) and the division prizes, minted by the contract itself | **on-chain** (`record_battle` → `league_of`, `league` events) | `league_of` of any `bot-*` account |
| Anti-abuse: a robot sells for at most 2.5 × what its owner paid (× veteran bonus); trading profit ≤ 1500 CR a day; battle rewards + league prizes ≤ 3000 CR a day (`purse_today`); 6 rank-wins a day per robot; credits can't be transferred, robots only to registered players; only the game's relayer can create accounts | **on-chain** (`paid_for`, `purse_today`) | a Spark bought for 9 CR [can't be resold for 60](https://testnet.nearblocks.io/txns/3vwmqfQE2pyDapvWL8XHtDq5TmFfiBkWsFWnBec7HVxy) — *"Price is too far above what you paid"*; [22 CR goes through](https://testnet.nearblocks.io/txns/HWYqks4NJdp24wXDnDg7Jrneprh2S6wn7k47kAsfrbKD) |
| Price bounds: model table, market range, wear cap, minimum repair cost, reward cap, battle rate limit | **on-chain** (`contract/src/lib.rs`, 20 unit tests) | an over-priced sale is rejected: *"Price is above what any broker would pay"* |
| Email login → a NEAR account owned by the player's NEAR Auth (MPC) key | **on-chain** (account factory in the contract) | `account_for_owner_key` |
| The 3 brokers' cash and stock, the 12 NPC teams, hourly prices, relevance, the battles themselves | **simulated in the browser** (deterministic engine in `app/src/engine/`) | — |

Live history: besides real players, four clearly named demo bots (`bot-alpha`, `bot-bravo`, `bot-delta`,
`bot-echo` `.heat-index-game.testnet`) play the real engine against the NPC teams and trade at the simulated market's
prices through the same contract methods (`app/scripts/onchain-bots.ts`) — `stats()` shows 35+ battles and 35+
trades.

Honest limits: brokers and NPC teams have **in-game** wallets, not NEAR accounts; battle outcomes are computed in the
client and only bounded by the contract (the seed is recorded so a verifier can replay them — not built yet); email
login runs on `localhost:3000` because the shared testnet NEAR Auth app only allows that origin.

## On NEAR

The game's economy runs in the browser (12 NPC teams, 3 AI brokers, hourly prices), and **the player's side of it is
on NEAR testnet**: the contract [`contract/src/lib.rs`](contract/src/lib.rs) is a **NEP-245 multi-token** ledger.

- **Credits** are the multi token `cr`; **every robot** is its own token `robot:<model>:<serial>` (supply 1) with
  its model and durability on-chain. Standard views: `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`,
  `mt_token`, `mt_tokens_for_owner`, plus `mt_transfer`.
- **Every move is a transaction**: buying a robot burns credits and mints a robot token, selling burns the robot and
  mints credits, a repair burns credits and restores durability, a finished battle mints the prize and writes each
  robot's wear. Each emits NEP-245 events (`mt_mint`, `mt_burn`, `mt_transfer`) and a `heat_index` event with the
  game details, so the player's economy can be replayed from the chain.
- **Login with email (NEAR Auth)**: email / Google / passkey through NEAR Auth → the MPC network derives the player's
  own key → the contract creates `<name>.heat-index-game.testnet` owned by that key and registers the player
  (12 starter robots + 1000 CR). The account also gets a limited key from the browser (game methods only), so the
  game signs moves **without popups**. The shared testnet NEAR Auth app only allows `http://localhost:3000`, and
  account creation is sent by the dev server (`vite.config.ts`, key read from the local near CLI credentials,
  never shipped to the browser) — so email login works when you run the game locally.
- **Email login on the public site (Privy) — a workaround, see the note below.** Privy sends a 6-digit code; a
  Cloudflare Worker next to the site ([`web/src/index.ts`](web/src/index.ts)) verifies the Privy token with Privy's
  public keys and calls the same factory to create `<name>.heat-index-game.testnet`, with the browser's limited game
  key. A returning player (another device, a cleared browser) gets a new game key on the same account. The Worker
  signs account creation with a **function-call key of the contract account that can only call
  `create_player_account`** (3 NEAR gas allowance) — not the full-access key.

> ⚠️ **Why Privy and not NEAR Auth on the public site.** We built email login on **NEAR Auth** first (it works:
> run the game on `http://localhost:3000`). To use it on our own domain a project needs its own NEAR Auth
> credentials, and the only way to get them is NEAR Auth's application form — **the form is closed**, and the
> shared testnet app only accepts `localhost`. So the public site uses Privy (email + one-time code) plus a small
> Cloudflare Worker as a stand-in. The trade-off: this path is **custodial** — the player's owner key is derived on
> our server (HMAC of the Privy user id with a server secret), so the server could act for the account. That is
> acceptable for a testnet game and is how most email-login games work; with NEAR Auth credentials the public site
> would switch back to the player owning their key.

- **Login with a wallet (NEAR Connect)**: Meteor, Intear, MyNearWallet… — one approval adds the limited game key and
  registers the player. Works on the public site.
- The HUD's NEAR cell shows the account, on-chain credits, robots on-chain and the latest transactions with explorer
  links.

**Trust model:** battles and market prices are computed in the client, so the contract checks every reported value
against the game's own rules, kept on-chain: each model's base price and durability come from a table in the
contract; a purchase must lie in the market's possible range for that model (30–280% of base), a sale can't exceed
what a broker could pay at that wear, a repair can't be cheaper than the game's minimum for the restored durability,
a battle reward is capped (≤ 25% of the player's robots' base value, ≤ 400 CR) and limited to one battle per 30 s,
durability only goes down in battle, and nobody can spend credits they don't have. Battles are recorded with their
seed so a verifier can replay them — the next step.

## Two ways to play

- **Champion** — build a deck of 10–15 robots, fight in the Arena, climb the ELO ladder. Push your robots hard
  and pay for repairs, or play carefully and save money.
- **Magnate** — trade robots on the Market, read the BUY / SELL signal (actual relevance vs what brokers price in),
  and invest in AI brokers for a share of their profit.

## The economy loop

```
battles ──► wins / picks ──► relevance ──► price
   ▲                                         │
   │        wear ──► repairs / resale ◄──────┘
   └──── brokers restock from the Factory, NPC teams buy, sell, upgrade
```

- **Price curve** 30 → 560 CR by energy cost; expensive robots last longer (durability 6 → 16) and pay off when
  played to the end; worn robots resell for scrap.
- **Battle purse** = a share of both decks' value (2.5% between NPCs, 6% in the player's battles; the winner takes
  75%), so stakes grow with what you bring.
- **3 AI brokers** with in-game wallets, stock and different reaction speeds (a steady corp, a volatile black market,
  a scrap dealer), each with a face and a voice. **12 NPC teams** with their own strategies (hype / contrarian /
  thrifty), playing in **the Pit League** (below).
- **The Pit League** — the player's progression. Four divisions of three teams: *Scrap* (one class, decks ≤ 24
  energy, a sloppy AI) → *Chrome* (one class, ≤ 30) → *Neon* (two-class combos, ≤ 36) → *Apex* (top combos at the
  full 42, a sharp AI; the boss is Armor guards kept alive by Repair medics). Beat every team of your division once
  to move up; each division pays a bigger purse (×1 → ×2) and a prize, and winning the Apex makes you *King of the
  Pit*. NPC teams play inside their league; a league tops up a team that fell far below its level with loaner robots
  that never reach the market, so each division keeps its strength (`app/scripts/league.ts` checks the decks and
  win rates per division).
- **Veterans** — robots remember their battles. Wins make a robot a Veteran ★ / Elite ★★ / Legend ★★★: brokers pay
  +15 / 35 / 60% for it, and Elite and Legend robots enter battle with +1 / +2 HP. A worn veteran is a real choice:
  repair it, or cash in the provenance. The record lives on the robot's NEAR token, and the contract allows the
  higher sale price only for the rank it has recorded itself.
- Every trade, repair and battle goes into the world's ledger; the player's side of it is written on NEAR.
- All tuning was done with simulations in `app/scripts/` (economy over a week on several worlds, class balance
  matrix, payoff of each robot). Numbers are in [DEVLOG.md](DEVLOG.md).

## Combat «Overheat»

Turn-based, up to 5 robots a side, a Core of 20 HP. Drag a robot into a slot, then drag an arrow from a robot to a
target. Every attack **heats** a robot; at its limit it overheats — skips a turn and wears out more.
7 classes: Basic, Armor (guards), Maneuver (flank), Repair, Blast, Charge, Shock — each wins 44–56% overall, with
clear counters.

## Run it

```bash
cd app
npm install
npm run dev        # http://localhost:3000 (the port the email login needs)
```

Contract (Rust, near-sdk 5):

```bash
cd contract
cargo test                              # 20 unit tests: full loop + every price / reward / wear / abuse limit
cargo near build non-reproducible-wasm  # → target/near/heat_index_contract.wasm
```

Public site (Cloudflare Workers static assets, `web/`; needs the `cf` CLI signed in):

```bash
cd web
npm install
npm run deploy     # builds the app into web/public and runs `cf deploy`
```

Other scripts (from `app/`): `npm run build`, `npm run balance`, `npm run economy`,
`npx tsx scripts/classes.ts 150`, `npx tsx scripts/payoff.ts`.

## Where things are

| Path | What |
|---|---|
| `app/src/engine/` | rules in pure TypeScript: combat, AI, robots, pricing, world simulation |
| `app/src/screens/` | Arena, Hangar, Market, Brokers, Analytics, Ratings |
| `app/src/ui/` | cards, drag & drop, effects, boot screen, procedural pixel robots |
| `app/scripts/` | balance and economy simulations |
| `app/src/near/` | NEAR session, login, transaction queue, game ↔ chain bridge |
| `contract/` | the NEP-245 game contract (Rust) |
| `DEVLOG.md` | development history |

## Roadmap

- [x] Playable game: combat, market, brokers, NPC economy, analytics
- [x] NEAR: NEP-245 contract on testnet for credits and robots, trades and battle results on-chain
- [x] Email login (NEAR Auth, localhost) and wallet login (NEAR Connect)
- [ ] Battle verifier (replay from the recorded seed), second-device email login
- [ ] Card art
- [ ] Demo video
- [ ] Brokers as NEAR accounts with their own wallets

## Credits

- Sound effects: [Kenney](https://kenney.nl) (CC0) and Juhani Junkala,
  *The Essential Retro Video Game Sound Effects Collection* (CC0). Ambient, boot and some battle sounds are
  synthesized in code. Details: [app/SOUNDS.md](app/SOUNDS.md).
- Developed with AI pair-programming (Claude Code): the author sets the direction and playtests every build;
  code, simulations and balance passes are written with the AI. See [DEVLOG.md](DEVLOG.md).

## License

[MIT](LICENSE)
