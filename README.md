# HEAT INDEX

**An underground cyberpunk robot arena where the economy *is* the gameplay.**
Built for the NEAR hackathon track **"Games With Real Economies"**.

Robots are cards that **wear out**: every battle costs durability, repairs cost credits — every hit has a price.
A robot's market price follows its **relevance** (how often it wins and how many teams field it), so the market
*is* the meta. AI brokers trade with a **reaction lag** — spot what's rising before they do and you profit.

> **Play:** https://ginger-box.github.io/Heat-Index/ (wallet login) · locally on `http://localhost:3000` (email login).
> Contract: [`heat-index-game.testnet`](https://testnet.nearblocks.io/address/heat-index-game.testnet) on NEAR testnet.

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
- **Login with a wallet (NEAR Connect)**: Meteor, Intear, MyNearWallet… — one approval adds the limited game key and
  registers the player. Works on the public site.
- The HUD's NEAR cell shows the account, on-chain credits, robots on-chain and the latest transactions with explorer
  links.

**Trust model (hackathon):** battles and prices are computed in the client, so the contract accepts results within
sanity limits (bounded rewards and prices, robots must belong to the caller, durability can only go down in a battle,
no overspending). Battles are recorded with their seed so a verifier can replay them — the next step.

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
- **Battle purse** = 2% of both decks' value (winner takes 75%), so stakes grow with what you bring.
- **3 AI brokers** with wallets, stock and different reaction speeds (a steady corp, a volatile black market,
  a scrap dealer). **12 NPC teams**, each focused on a class, with their own strategies (hype / contrarian / thrifty).
- Every trade, repair and battle result goes into a ledger — the part that will be written on-chain.
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
cargo test                              # unit tests: full loop, overspending, wear
cargo near build non-reproducible-wasm  # → target/near/heat_index_contract.wasm
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
| `DESIGN.md` | game design (Russian) |
| `DEVLOG.md` | development history |

## Roadmap

- [x] Playable game: combat, market, brokers, NPC economy, analytics
- [x] NEAR: NEP-245 contract on testnet for credits and robots, trades and battle results on-chain
- [x] Email login (NEAR Auth, localhost) and wallet login (NEAR Connect)
- [ ] Battle verifier (replay from the recorded seed), second-device email login
- [ ] Card art
- [ ] Demo video

## Credits

- Sound effects: [Kenney](https://kenney.nl) (CC0) and Juhani Junkala,
  *The Essential Retro Video Game Sound Effects Collection* (CC0). Ambient, boot and some battle sounds are
  synthesized in code. Details: [app/SOUNDS.md](app/SOUNDS.md).
- Developed with AI pair-programming (Claude Code): the author sets the direction and playtests every build;
  code, simulations and balance passes are written with the AI. See [DEVLOG.md](DEVLOG.md).

## License

[MIT](LICENSE)
