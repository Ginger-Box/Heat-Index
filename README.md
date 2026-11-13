# HEAT INDEX

**An underground cyberpunk robot arena where the economy *is* the gameplay.**
Built for the NEAR hackathon track **"Games With Real Economies"**.

Robots are cards that **wear out**: every battle costs durability, repairs cost credits — every hit has a price.
A robot's market price follows its **relevance** (how often it wins and how many teams field it), so the market
*is* the meta. AI brokers trade with a **reaction lag** — spot what's rising before they do and you profit.

> Status: playable in the browser (everything simulated client-side). NEAR integration is in progress — see
> [Roadmap](#roadmap).

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
npm run dev        # http://localhost:5173
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
| `DESIGN.md` | game design (Russian) |
| `DEVLOG.md` | development history |

## Roadmap

- [x] Playable game: combat, market, brokers, NPC economy, analytics
- [ ] NEAR: NEP-245 contract on testnet for credits and robots, email login, trades and battle results on-chain
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
