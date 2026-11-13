# HEAT INDEX (formerly NEON PIT) — development log

A reconstructed history of how the game was built, written from the working sessions.
The project was not under version control until Nov 13, 2026, so intermediate code states are not preserved —
this log describes them instead. From the "git" entry onwards, the commit history is the real one.

**How it was built.** The game is developed in AI pair-programming sessions with Claude Code: the author sets the
direction, plays every build and gives feedback; the code, balance scripts and simulations are written by the AI.
All numbers quoted below come from the simulation scripts in `app/scripts/`.

---

## Nov 12, 2026 (work started 06:15 UTC)

### Concept
- Track: **Games With Real Economies** ("the economy is the gameplay").
- Started from "a card game in the spirit of Hearthstone" and moved away from it on purpose.
- Setting: an underground cyberpunk robot arena. Cards are **robots that wear out**: every battle costs durability,
  repairs cost credits — every hit has a price.
- A robot's price follows its **relevance** (how much it wins + how many teams pick it), so the market *is* the meta.
- Two ways to play: **Champion** (fight, climb ELO) and **Magnate** (trade robots, invest in AI brokers).

### First playable build
- Vite + React + TypeScript, everything simulated in the browser (the chain comes later).
- Engine: seeded RNG, 16 robot models, a 3-lane battle with secret simultaneous deployment, team rules
  (8 robots, 24 energy, max 2 of a model).
- `pricing.ts` — all pricing in one readable file with in-game explanations ("why does this cost this much").
- World simulation: 3 AI brokers with wallets, stock and different reaction speeds; 12 NPC teams with
  strategies (hype / contrarian / thrifty); a ledger of every trade, ready to be written on-chain.
- Week fast-forward for judges: 7 game days in ~35 seconds.
- Problems found by simulation and fixed:
  - battles always went the full length → smaller Core + a "pierce" rule;
  - a free "loaner robot" could be sold — robots inflated to 6000+ and brokers went bankrupt → loaners can't be sold;
  - broken robots piled up at the scrap dealer → scrap yard cap + recycling;
  - inflation → lower rewards;
  - four rich NPCs won 95% of fights → ELO matchmaking.

### Feedback round 1
- Step-by-step battle animations (strikes, damage numbers, deaths, blasts); the player chooses the repair target.
- Hangar rebuilt: 8 team slots + a sortable pool; fixed a bug where team changes were never saved.
- **7 classes × 4 robots = 28 robots**, two new abilities (Charge, Shock). Class balance tuned with
  `scripts/classes.ts`: every class wins 47–56%.
- Each NPC plays through its own class — the meta has camps.
- A smarter opponent AI (move search + playouts): beats the simple AI 88% of the time.

### Look and feel
- Pixel + neon "junk cyberpunk" style: pixel fonts with Cyrillic, metal panels, CRT scanlines, Bayer dithering.
- Whole UI translated to English.
- Glitch animation whenever a number changes; buttons flash like CRT phosphor.
- Sound: CC0 effects by Kenney + an ambient drone synthesized in code; volume slider; UI scales to the screen.

### Market and brokers
- Smooth card drag & drop with landing / return animations.
- Market rebuilt: class overview tiles, search, filters, sortable columns, explorer-style row selection,
  card preview on hover, and a **BUY / SELL signal**: actual relevance vs what brokers price in
  (brokers react with a delay — that's where the profit is).
- Investing in brokers barely paid (0.5–1%/day). Causes found and fixed:
  - profit was counted in cash only, so restocking looked like a loss → now counted on capital;
  - the scrap dealer bought 169 broken robots a day but could repair 52 and melted the rest → it stops buying
    when the yard is full;
  - invested money could never be taken out → stakes can be sold back.
  - Result: ~1.3%/day (steady corp), ~2% (volatile black market), ~7% (scrap dealer).
- Brokers screen redesigned: "invest 100 CR → ≈ X CR/day", 7-day profit chart, plain-language tags.

### Combat rework — «Overheat»
- The lane battle had too few decisions. Replaced with turn-based combat: up to 4 robots a side, you pick
  who attacks whom, the target strikes back.
- **Heat:** every attack heats a robot; at its limit it overheats — skips a turn and wears out more.
  Push hard and pay for repairs, or cool down and save money.
- Classes reworked for the new combat (guards, flankers, repair cools, shock overheats enemies).
- First balance pass was far off (Armor 85%, Repair 18%). Three rules changed and an auto-tuner written
  (`scripts/tune.ts`): now every class wins 47–55% with clear counters
  (Maneuver beats Armor 83%, Armor beats Shock 85%).
- The new combat wore robots out less and NPC money grew 6× a week → new wear rule (every robot that fights −1)
  and lower rewards; the economy is stable again.

### Polish
- City Feed moved to its own tab.
- Custom animated cursor (states: EXEC / GRAB / HOLD / LOCK / SEL / SCAN), "tube" glow under it,
  CRT-style tab switch, old-TV boot screen.
- Cards got pixel robots from a procedural generator (class-specific parts, size by cost) — placeholders until
  real art.

## Nov 13, 2026 (UTC)

- Market polish: even columns, broker-view marker on the relevance bar, aligned offer buttons, tooltip clipping fixes.
- Click effect: a narrow "signal tear" glitch with needle-shaped slices.
- **git**: repository created; the existing code committed in logical parts. Real history starts here.

### Economy v4 (Nov 13)
- Requested: robots shouldn't all cost about the same, saving up should matter, expensive robots should last longer
  and pay off when played, and it should be better to play a worn robot to the end than to sell it.
- Prices now follow a curve (30 → 560 CR), durability grows with cost (6 → 16), battle rewards are a purse of 3% of
  both teams' value (winner takes 75%), repairs cost 30%, and a worn robot's resale value falls to scrap value.
- First try (purse 8%) inflated NPC money ×6 a week — NPCs fight ~170 battles a week each. Tuned with
  `scripts/economy.ts` and the new `scripts/payoff.ts`; added two money sinks found along the way: rich NPCs upgrade
  their teams, and brokers keep a cash reserve and stop buying models they are overstocked on (the small broker kept
  going bankrupt from buying up everyone's used robots).
- Result: stable money supply over a simulated week on 3 worlds; expensive robots pay back ×1.1–1.9 for an average
  player, cheap ones are consumables.

### Feel pass (Nov 13)
- Click effect back to the needle "signal tear", shorter and sharper; number glitches fixed (a re-render could cut them off).
- The neon tube under the header replaced by a market ticker: the day's biggest price moves and broker headlines.
- Market sounds: filters click like a casino chip with a light metal tap, row select got a metallic ring,
  box / Shift selection ticks like a ratchet, rising in pitch with every row.
- Boot screen: starts right away, a quiet fax/modem handshake while it "dials the market", soft power-on,
  and a BIOS-style "PRESS ANY BUTTON TO CONTINUE" at the end (browsers only allow sound after the first press).
- Analytics: hovering a name highlights its line; a Classes mode with class averages.
- **Arena redesigned** as a card table: opponent on top, your hand fanned at the bottom, turn/energy/End turn on the
  right. Cards are dragged into a chosen slot; attacks are aimed with an arrow (red), Repair and Shock robots ask for
  a target with a green / violet arrow; the opponent's attacks are announced with an arrow too.
  Sparks scale with damage (1 — a puff, 10 — a shower of metal), Core hits add a shockwave, screen shake and a
  sub-bass thump; separate sounds for swings, light/medium/heavy hits, deploys, venting steam, overheat alarms,
  welding repairs, turn start and card draw.

### Feedback round (Nov 13, evening)
- Decks are now **10–15 robots** (energy limit 42) and the board has **5 slots**. Bigger decks mean bigger battle
  purses, so the purse went 3% → 2% of both teams' value; a simulated week is calmer than before (NPC money ×3.4
  instead of ×5), classes win 43–57%.
- Hits scale to the real attack range (up to 5): 1–2 — sparks; 3–4 — a slash, ring and shake; 5 — hit-stop,
  a heavy slash, double shockwave, white flash, RGB split of the table and a huge damage number.
- New 8-bit sounds from Juhani Junkala's CC0 collection for hits, robot deaths, Core hits and the end of a battle;
  victory and defeat melodies are synthesized chiptune, kept quiet.
- Defeat: your Core cracks and a glitch spreads from it over the whole screen; victory: confetti cannons from both
  sides. Then a full-screen VICTORY / DEFEAT with the rewards and wear.
- Robot sprites redrawn in action poses with class looks (medics carry a red cross, Shock robots throw animated
  lightning, flames, fuses, steam, shield glints); Analytics got bigger model buttons and a search; the piercing
  whine at the start of the boot screen is gone.

### Decks and polish (Nov 13, night)
- **Five named decks**: edit one at a time in the Hangar (the pool shows robots that stand in no deck), pick the
  battle deck in the Arena, rename inline. Deck grids are 3 rows of 5.
- Ability texts rewritten for the current combat (they still described the old lane battle). Checked by simulation
  that guards hold: every Core hit through a guard in 300 battles came from a Maneuver flanker — now the battle says
  "FLANK" when that happens and marks a guarded Core.
- Defeat: a clean pixel wave pours out of the Core, covers the screen and cuts to black, then DEFEAT (the overlay
  used to sit under the glitch canvas). Victory: confetti pours from two corner cannons with popper and paper sounds.
- Typing sound in text fields; a cyber "crunch" for row selection; the cool-down button is labelled.

### Tutorial and demo balance (Nov 13–14)
- **First launch tutorial**: a short scripted training battle (your Bolt / Dash / Spark vs a weak bot with a cracked
  Core) with step-by-step hints — Cores, deploying and energy, attack and HP, ending the turn, aiming, heat and
  cooling, abilities on hover — then a tour of the tabs with a spotlight and an arrow. City Feed tab removed.
- Heavy hits (4+) crack the screen glass at the point of impact (more and longer cracks the bigger the hit) with a
  glass-break sound; 1–3 stay as sparks.
- Demo balance (the author lost three battles in a row and could not afford a replacement): Arena opponents play a
  random reasonable move ~1 time in 5 (`sloppy` in `ai.ts`), NPC decks are capped at 28 deck cost, the player's
  battles pay a 6% purse, the player's robots wear only when destroyed or overheated, start with 1000 CR.
  Simulated: a perfectly played starter deck wins 68% against NPC decks; NPC money over a week ×1.4 (stable).
- Market: tighter columns, 2× card preview; a static "market today" line replaced the scrolling ticker;
  Reset uses an in-app confirmation (the browser dialog was blocked in the embedded browser).

### Meta and robot balance check (Nov 13)
- New `app/scripts/meta.ts`: runs a week on 3 worlds and prints the daily top robots and class averages. The meta does
  move — the leading class changed 3–4 times a week, half of the top-10 rotates — but Shock sat at the bottom.
- Robot balance by an A/B test (the same deck with and without a robot, 300 battles each): Titan was +11% — its
  armor 2 shut out most attacks while it guarded the Core → armor 1, 3/6. Expensive robots arrive late (6 energy on
  turn 5) and needed better stats: Ark 5/9 repair 5, Apocalypse 8/9 blast 4, Shrapnel 5/7, Bull 4/5;
  Welder 2/3, Plate 1/2, Dozer 5/6, Tesla-9 3/6, Medic-X 4/5, Hammer 4/3, Hound 4/5.
  Classes now win 44–56% (Charge was 67%, Maneuver 34% midway through the tuning).
- HUD got status LEDs, scanlines, a light sweep and pixel corner brackets.

### NEAR (Nov 13, evening)
- **Contract** `heat-index-game.testnet` (Rust, near-sdk 5.30): credits and robots as NEP-245 multi tokens,
  `register`, `buy_robot`, `sell_robot`, `repair_robot`, `record_battle`, NEP-245 views and events; unit tests for
  the full loop, overspending and "a battle can't heal". Upgraded once in place with a state migration.
- **Account factory for email login**: NEAR Auth (email / Google / passkey, MPC-derived key) → the contract creates
  `<name>.heat-index-game.testnet` with that key as the owner and a limited in-browser game key, and registers the
  player in its callback. First version used a public function-call "sponsor" key embedded in the client; replaced
  before shipping by a dev-server endpoint that reads the key from the local near CLI credentials (no keys in the
  repo or the bundle). The shared testnet NEAR Auth app only accepts `http://localhost:3000` → dev port moved to 3000.
- **Wallet login** via NEAR Connect (the wallet selector is deprecated).
- **Bridge**: engine hooks for the player's buy / sell / repair / battle → a transaction queue signed with the game
  key; robots are linked to their token ids. Checked end to end on testnet: account creation, starter robots linked,
  a purchase and a battle recorded, on-chain credits equal to the game's.
- GitHub Pages workflow for the public build.

### Judge-readiness pass (Nov 13, night)
- An impartial review of the track (a separate "jury" session, 111 entries) found the blocking issues: the repo was
  private, the public demo returned 404, no submission yet — and a real hole: the contract trusted client-reported
  prices and rewards with near-useless limits.
- **Contract v0.3**: the model table (base price, max durability) lives on-chain; a purchase must be within the
  market's possible range for the model, a sale can't exceed what a broker could pay at that wear, a repair can't be
  cheaper than the game's minimum, a battle reward is capped (≤ 25% of the player's robots' value, ≤ 400 CR) and
  limited to one per 30 s; unknown models are rejected. 9 unit tests (one per hole). Upgraded in place with a state
  migration; an over-priced sale on testnet is now rejected.
- README: a 2-minute path for judges and an honest "on-chain vs simulated" table with transaction links.
- `app/scripts/onchain-bots.ts`: clearly named bot players (`bot-*.heat-index-game.testnet`) play the real engine
  against the NPC teams and trade at the simulated market's prices, through the same contract methods as the game.
- Brokers got faces (pixel portraits, names, bios, live remarks) and windows dressed like their owners; the training
  battle now starts right after the first login.

## Next
- Card art.
- README for judges, demo video.
