# HEAT INDEX — game client

An underground cyberpunk robot arena where **the economy is the gameplay**: robots wear out in battle,
their prices follow how well they perform, and AI brokers trade them with a delay you can profit from.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

```bash
npm run build      # production build into dist/
npm run balance    # robot win rates over thousands of simulated battles
npm run economy    # one simulated week of the economy
npx tsx scripts/classes.ts 150   # class vs class balance matrix
npx tsx scripts/tune.ts          # auto-tuner for class stats
```

## Where things are

- `src/engine/` — rules, pure TypeScript: `battle.ts` (combat «Overheat»), `ai.ts`, `robots.ts`,
  `pricing.ts` (all pricing in one readable file), `world.ts` (brokers, NPC teams, time).
- `src/screens/` — Arena, Hangar, Market, Brokers, Analytics, Ratings.
- `src/ui/` — shared components, card drag & drop, cursor and screen effects, boot screen, pixel robot generator.
- History: `../DEVLOG.md`. Sound credits: `SOUNDS.md`.

## Credits

- Sound effects by Kenney (www.kenney.nl), CC0. Ambient drone synthesized in-game with the Web Audio API.
- Built with AI pair-programming (Claude Code) — see `../DEVLOG.md`.
