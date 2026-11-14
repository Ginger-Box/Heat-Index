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

### Progression: the Pit League and veterans (Nov 13, late night)
- Playtest note: the battles felt good but nothing pulled the player forward. Added two progression systems.
- **The Pit League**: the 12 NPC teams split into 4 divisions. Lower leagues play one class with cheap decks and a
  sloppy AI; upper leagues play two-class combos at a higher deck cost with a sharper AI (Apex: Charge + Armor,
  Shock + Armor, and the boss — Armor guards + Repair medics, the hardest wall to break). Beat every team of your
  division to move up; purse ×1 → ×2 and a prize per division; the Apex makes you King of the Pit (defending the
  crown pays less, so it can't be farmed). NPCs play inside their league and get a daily league stipend.
- The first runs showed the NPC economy could starve a team (Apex decks fell to 13–18 energy, a Scrap team dropped
  to 5 robots). Fix: a league "sponsor" lends a team loaner robots of its classes when its deck falls far below the
  division's limit — loaners can't be sold and are scrapped when broken, so the market isn't flooded.
- `scripts/league.ts`, a perfect-play AI with the starter deck (cost 23) vs each division after 3 and 7 days:
  Scrap 92–100%, Chrome 75–98%, Neon 52–93%, Apex 30–70%; the Armor + Repair boss is the hardest (28–53%).
  A human plays worse than this AI, so the lower leagues are a comfortable start and the Apex is a real wall.
- **Veterans**: every robot keeps battles / wins; 3 / 8 / 15 wins → ★ / ★★ / ★★★. Brokers bid +15 / 35 / 60%,
  Elite and Legend get +1 / +2 HP in battle. Stars on the cards, the record in the card tooltip, rank-ups in the
  battle result.
- **Contract v0.4**: `record_battle` keeps each robot token's record (battles, wins, rank) and emits a `veteran`
  event on a rank-up; `sell_robot`'s price cap is raised only by the rank recorded on-chain; `mt_token` /
  `mt_tokens_for_owner` return the record. 11 unit tests. Upgraded in place with a state migration; checked live with
  the bot players (records appear on their tokens).

### Closing the arbitrage (Nov 14, night)
- The jury session found two holes after the league update. (1) Prices and wins are reported by the client, so a
  cheater could buy a robot at the market's floor (0.3 × base) and sell it at the ceiling (2.4 × base, ×1.6 for a
  Legend after 15 fake wins in 7.5 minutes) — a Titan bought for 168 sold for ~2150. (2) League prizes were paid only
  in the browser, so game credits and chain credits drifted apart after the first division.
- **Contract v0.5**:
  - every robot token remembers what its owner paid (starters: base price); a sale may be at most 2.5 × that
    (× the on-chain veteran bonus);
  - an account's realised trading profit (sale − purchase) is capped at 1500 CR a day;
  - at most 6 wins a day count toward a robot's rank (a Legend takes 3 days);
  - a battle may list at most 15 robots;
  - the **Pit League runs on-chain**: the contract knows the 12 teams and their divisions, counts recorded wins,
    mints the division prize and moves the player up — the same rules as the game, so credits stay equal.
  - 15 unit tests (one per hole). Live: a Spark bought for 9 CR can't be resold for 60; 22 CR (2.5×) goes through.
- **The game mirrors the same rules**, so an honest player never sends a transaction the chain would reject:
  brokers never bid above 2.5 × the purchase price (for everyone, NPCs included), the player's daily trading profit
  is capped with a clear message, a bought robot starts a fresh battle record (it is a fresh token on-chain).
- Economy check after the league (`scripts/economy.ts`, 7 days): NPC teams were getting rich (avg 300 → 1600 CR) —
  the upper leagues' costlier decks make bigger battle purses. NPC purse rate 2.5% → 1.5%, and the league stipend
  now only tops up a team below 400 CR: NPC money now grows slowly (avg ~290 → 570–710 CR over a week).

### Broker balance: the Junkman (Nov 14)
- Playtests showed the scrap dealer always far ahead. `scripts/brokers.ts` (4 worlds × 7 days, equity change):
  Kessler −168, Magpie −1143, **Junkman +14 559**. Cause: it bought scrap at 15% of the price, refurbished up to 4 an
  hour at 60% of a normal repair, and the big refurbished stock pushed its prices to the floor — so it became the
  cheapest seller of everything (150 sales a week) on a cost basis of ~33%.
- Now it refurbishes 1 robot an hour, only models it is short of, at 1.5× a normal repair (a real workshop's cost).
  After: Kessler +355, Magpie +130, Junkman +663 — all three in the black, none closes; NPC cash grows slowly
  (avg ~310 → ~550 over a week); the league's division strengths unchanged.

### Broker risk: upkeep, market events, real bankruptcies (Nov 14)
- Playtest note on the previous fix: now every broker slowly earns, none can fail, and the Junkman still always wins —
  investing in brokers has no risk and no decision. `scripts/brokers.ts` (12 worlds × 14 days) confirmed it: the
  Junkman was the best broker in 12 of 12 worlds, 0 bankruptcies.
- **Daily upkeep** (Kessler 70, Magpie 50, Junkman 55 CR): a broker that can't cover it goes bankrupt and closes until
  investors reopen it. Brokers keep a thinner cash reserve, so they trade closer to the edge.
- **Market events** (one a day with 50% chance), each hitting a different business: tax audit (−35% of cash, the
  richest broker is the likeliest target), Arena security contract (Kessler +250…500), police raid (Magpie loses a
  quarter of its stock), smuggled shipment (Magpie gets 3–5 free robots), environmental inspection (the Junkman's
  yard cleared and fined), riot in the Pit (every NPC robot −2 durability: scrap and repairs in demand), Factory
  recall of a model, Factory strike (no restocking for 2 days), streamer hype on a model. Shown as "Market news" on
  the Brokers screen.
- The black market gets a smuggler's discount at the Factory (90% of the base price) — without it Magpie, the
  fastest-reacting broker, lost money on average.
- Result over 12 worlds × 14 days: best broker — Magpie 6, Kessler 4, Junkman 2; a bankruptcy in 4 of 12 worlds
  (Magpie 2, Junkman 2, all reopened by investors); Kessler never failed. So: Kessler is the safe, slow stake, Magpie
  the gamble, the Junkman in between — and who wins a season depends on its meta and its news.

### Broker segments (Nov 14)
- Each broker now trades its own segment: **Kessler Corp** — mid and expensive robots (energy 3–6), **Magpie** — every
  model, **the Junkman** — cheap robots (energy 1–3) plus scrap of any model; scrap it doesn't refurbish is stripped
  for parts (the Factory pays a little over the scrap price). Market rows say "doesn't trade" for a broker outside
  its segment; the Brokers screen shows the segment and the daily upkeep. Old saves are migrated.
- Rebalanced on 36 worlds × 14 days (three seed sets, so it isn't tuned to one world): best broker — Kessler 11,
  Junkman 15, Magpie 10; bankruptcies only for Magpie (6 of 36 worlds) — the black market that trades everything is
  the one that gambles. Magpie's smuggler discount at the Factory is now 4% (was 10%), the Junkman's upkeep 45 CR.

### Security audit and fixes (Nov 14)
- A separate session ran a security audit with Cloudflare's `security-audit` skill (contract, NEAR client, dev
  relayer, git history, dependencies): 2 high, 2 medium, 4 low, no secrets in the repo or its history.
- **Contract v0.6** (state migration, 20 unit tests):
  - *H1* — the account factory could be called by anyone, draining 0.15 NEAR per call and blocking email sign-ups:
    now only the game's relayer (the contract account itself) may create accounts. Checked live: a call from
    another account is rejected.
  - *H2* — battle rewards and league prizes had no daily limit (a scripted client could mint ~500k CR a day): a
    daily purse of 3000 CR per account for rewards + prizes (over it, the payout is cut, the battle still counts);
    the reward cap counts only working robots.
  - *M1* — sybil accounts could feed one account: credits are no longer transferable, robots go only to registered
    players, direct registrations are rate-limited (60 an hour).
  - *L2/L4* — a sale must pay at least 1 CR; a robot can be listed only once in a battle; free-text fields are cut
    to 64 characters in events.
- **The game mirrors the purse cap** (the reward shows "capped · N CR left today"), and the reward is bounded by a
  quarter of your working robots' value, as on-chain.
- **Dev relayer** (*M2*): accepts only same-origin JSON requests, so a web page open in the same browser can't make it
  create accounts or unlink a login.
- The contract account has a single full-access key (the old public sponsor key was already removed).
- Dependencies: removed the unused `vitest` (both critical advisories), `npm audit fix` for dev tooling; left: 7
  moderate / 14 low in dev tools and `elliptic` inside the NEAR SDKs (no upstream fix).
- Not done before the deadline: a running per-account robot value (L1), revoking the game key on sign-out, a CSP.

### Public site on Cloudflare Workers + email login with Privy (Nov 14)
- The public site moved to Cloudflare Workers static assets (`web/`, deployed with the `cf` CLI):
  https://heat-index-web.ginger-box.workers.dev. The app stays on Vite 6; `web/` holds only the deploy project.
- Email login on the public site: NEAR Auth needs per-project credentials for a custom domain, and its application
  form is closed; the shared testnet app accepts only localhost. Workaround, after looking at how another entry
  (Bluffalo) does it: **Privy** (email + 6-digit code, headless `@privy-io/js-sdk-core`, our own form, loaded
  lazily) and a **Worker route** `/api/privy/login` that verifies the Privy token with Privy's public JWKS, derives
  the player's owner key from the Privy user id (HMAC with a server secret, nothing stored), and either creates
  `<name>.heat-index-game.testnet` through the contract's factory or adds the browser's new game key to the
  existing account. The Worker signs with a new function-call key of the contract account limited to
  `create_player_account` (3 NEAR gas allowance); secrets live outside the repo and go up with `--secrets-file`.
  Custodial by design — stated in the README.

### Progress comes back from NEAR (Nov 14)
- Playtest: signing in with the same email again started a fresh game — the NEAR account was the same
  (`ginger-3…` got a second game key), but the game's progress lives in the browser, so "start over" or another
  device lost it. Now a login restores the player from the chain whenever the local world isn't tied to that account
  yet: every robot token (model, durability, veteran record), the credits and the league progress (`league_of`); a
  battle deck is rebuilt from the restored robots. Checked against `bot-alpha`: 19 robots, 364 CR, 8 veterans and its
  league progress came back.
- Login screen copy: "Sign in / sign up with email", and a line that returning players get their progress back.

### One account per player: linking logins and merging duplicates (Nov 14)
- While logins were tied to a browser, the author ended up with four game accounts (`ginger`, `ginger-2`, `pilot`
  from NEAR Auth on localhost, `ginger-3` from the public site's email login). NEAR accounts can't be renamed and the
  game contract has no keys on player accounts, so the merge needs the owner's own signature:
  - a one-off localhost tool (`?link-account=ginger&from=ginger-3`, `app/src/ui/LinkAccount.tsx`) signs ONE
    transaction with the player's NEAR Auth key: AddKey(the email login's key → `ginger`). NEAR Auth signing =
    Auth0 approval window → the fast-auth contract's `sign` (sent by the dev relayer with 1 yoctoNEAR — the MPC
    signer requires it; without it the call silently returns null) → MPC signature → the transaction is sent.
    Browsers only open the approval window straight from a click, so the transaction is prepared beforehand.
  - contract (owner-only, no state change): `link_owner_key` points a login at an existing account (it can't give
    access — the key must already be on that account), `merge_players` moves robot tokens, credits, stats and the
    further league progress (NEP-245 `mt_transfer` events, memo "account merge"). 22 unit tests.
  - Result: `ginger` holds 50 robots and 3109 CR; both email logins (Privy on the site, NEAR Auth on localhost)
    open `ginger`.

### Verifiable battles, tests, CI (Nov 14)
- Jury feedback: battles are computed in the client with no verifier; no engine tests; CI tests nothing.
- **Battle replays**: the engine records every accepted action of both sides plus the battle's input (seed, both
  decks in order, veteran HP bonuses, durability before). The game publishes the log at the Worker
  (`/api/battles/<sha256>`, Cloudflare KV, content-addressed) and `record_battle` gets the hash (`replay`, contract
  v0.7; the transaction keeps its place in the queue while the log uploads). `npm run verify-battle <tx>` reads the
  event from testnet, checks the hash, replays the log (illegal moves fail) and compares the result and each robot's
  wear — checked on a live bot battle: 34 actions, win and 5 wear values match.
- **Tests**: 16 engine tests (battle rules, determinism, replays and tamper detection, prices inside the contract's
  ranges, the game's constants = the contract's (parsed from `lib.rs`), a simulated week, league, veterans, daily
  caps, restore from chain); 22 contract tests. **`npm run verify`** checks 8 README claims against testnet and the
  live site. **CI** (`ci.yml`) runs all of it on every push; the failing GitHub Pages workflow is gone.
- "AI brokers" → "algorithmic brokers": they are rule-based, there is no LLM. Phones get a "open on a computer" stub.

### The shared world (Nov 14)
- Jury: the "real economy" was single-player — brokers, NPC teams and prices lived in each browser. Now logged-in
  players share one world on a Durable Object (`web/src/world.ts`) running the game's engine: real-time clock (an NPC
  match every 10 min → a game day = a real day, a 7-day season), the 12 bot teams, the brokers, prices, investments
  and leaderboards are common. Guests keep the local world with pause and fast-forward.
- Engine: humans are no longer one hard-coded "player" — `isHuman(m)`, and the league, the daily purse, the trading
  profit cap live on each manager; `addHuman`, `createSharedWorld`; every move of the local player is also emitted
  as (operation, args) (`playerHooks.op`).
- Server: login = a signature by a key of the NEAR account (checked against the chain) → a session token; joining
  restores the player from the chain; moves are replayed on the shared world; a battle must replay from its log
  (deck owned, durability and veteran records as on the server, every move legal), one per 30 s. Clients get the
  world with their manager under the local id, every 10 s and after each move. Checked with `bot-bravo` over HTTP:
  joined with its 20 robots / 819 CR from the chain, a battle replayed and counted, the leaderboard shows 12 BOTs.
- Ratings mark BOT / PLAYER / YOU; brokers list their investors; a "● SHARED WORLD" tag with the days left.

### Brokers with an LLM mind on NEAR AI Cloud (Nov 14)
- The jury flagged "AI brokers" with no AI. Now, in the shared world, once a game hour each open broker sends a
  brief of its market to `Qwen/Qwen3.8-27B` on NEAR AI Cloud (verifiable, TEE) and gets a policy back — markup,
  reaction speed, stock level, models to stock up on / dump, a remark in character. `engine/brokerAi.ts` builds the
  prompt and clamps the answer to each broker's own bounds (Kessler stays slow and pricey, Magpie fast and cheap),
  so the model steers but can't break the economy; restocking follows its focus/dump. The Brokers screen shows the
  current decision and the model; the broker's live remark is the model's line. Guests keep the rule-based brokers
  (no API key in the browser). The API key is a Worker secret built from a local file at deploy time.
- Analytics: the last 7 days by default, any season or all of it; the whole history is kept.

### A livelier shared world (Nov 14)
- Playtest: in the shared world "time doesn't move" — prices and charts changed only once a game hour (2 real hours).
  Now its game hours are 5 minutes (288 a day, one NPC match each): prices, brokers and Analytics move every
  5 minutes, a game day is still a real day and a season 7 real days; brokers' reaction speed and the Junkman's
  refurbishing are scaled so the economy runs at the same pace per day. The clock shows the real time of day.
- Brokers' model: `deepseek-ai/DeepSeek-V4.1-Flash-1017` (the cheapest DeepSeek on NEAR AI Cloud, verifiable/TEE),
  no reasoning, max 250 tokens, once a real hour per broker; a second API key is a fallback.
- The shared world restarted on the new clock; demo bot accounts can't join as players. A client whose session
  points to a restarted world logs in again by itself (rejoins from the chain).
- UI: Market news is a fixed scrolling box; broker faces blink on their own random rhythm; the SHARED WORLD tag has
  a blinking LED; in the shared world Reset becomes "Log out" and says it only affects you.

### Review fixes: the server is the only writer (Nov 14)
- A review found that a browser key could call `record_battle` with no battle (empty wear, no replay — 180 CR a
  call) and `buy_robot` at the market's floor then resell at 2.5× (+252 CR a cycle), because the contract trusted
  client-reported results and prices. Fix, contract v0.8: trades and battles are recorded only through
  `buy_robot_for` / `sell_robot_for` / `repair_robot_for` / `record_battle_for`, callable only by the contract
  account; the shared world's server signs them with a key limited to those methods, after pricing the trade from
  its brokers or replaying the battle. `record_battle_for` requires the replay hash and, for a win, the robots that
  fought; new accounts' browser keys can only `register`. Both exploits are now unit tests that fail. Checked live:
  a bot battle recorded through `record_battle_for` verifies with `npm run verify-battle`.
- The world server mirrors each move on-chain before saving it; if the chain refuses, the world rolls back.
- `promise_result` → `promise_result_checked`; more contract tests (transfers, login links, server-only moves) — 29.
- Lint: 0 errors (typed RPC JSON in the scripts, an unused variable, a comma expression); CI now runs lint and builds
  the contract for wasm32. `npm run verify` checks the new key layout and that the AI brokers' decisions are public
  (`/api/world/public`). README corrected (model name, test counts, verifier status, hybrid-economy limits).

### Hangar lag (Nov 14)
- With 50 robots the Hangar made the cursor lag: every robot sprite was an inline SVG with hundreds of pixel rects,
  a drop-shadow filter and effect layers flipping 3–6 times a second (re-rasterised every frame), and every card
  carried several pixel icons as SVG rects too. Sprites are now three cached images per model (body + two effect
  frames that only toggle opacity — GPU-composited), and icons are one element with a cached CSS mask in the text
  colour. A guest Hangar (12 robots): 3981 → 640 DOM nodes, 3341 → 2 SVG rects, no long tasks.
- README: the roadmap section removed.

### Online: ranked battles against players' decks (Nov 14)
- A new **Online** tab: ranked battles against another player's battle deck from the shared world, played by the AI
  under their name (asynchronous PvP); players first, nearest by ELO, a bot deck only ~1 battle in 10 or when no
  one else is around. The **Arena** tab is now the Pit League only (PvE).
- `applyMatch(…, mode)`: 'ranked' moves ELO and W/D/L (online battles and the bots' own matches); 'league' pays,
  wears, counts veterans and league progress, but leaves the ratings alone. In a ranked battle against a player's
  deck the absent player's robots don't wear and they earn nothing; their record and ELO move. The server checks
  that side B's robots really are the opponent's, replays the battle, and records it on-chain as `online:<name>` so
  the contract never counts it toward the league. The players' old mixed records were reset once.
- Season prizes for the top 3 ELO: 300/200/100 → 600/350/200 CR. 19 engine tests.

### Online: blind matchmaking (Nov 14)
- The Online tab no longer shows the opponent: "Find opponent" searches and the battle starts at once — the
  opponent and their deck are revealed only on the battlefield, so nobody can prepare a counter-deck.
- Matchmaking skips players whose battle deck is still the untouched starter deck (signed up and left), so
  newcomers don't keep meeting the same starter deck; with no one else left, a bot deck is the opponent.

### Online: server-run battles, no hidden information in the browser (Nov 14)
- Logged-in online battles now run in the shared world's Durable Object (`/api/world/pvp/start`, `/pvp/act`): the
  server chooses the opponent, draws a crypto-random seed, checks every move, and plays the opponent's turns with the
  battle AI. The browser gets redacted views — the opponent's hand and deck become `?h0…`/`?d0…` placeholders,
  their models, wear and HP bonuses are removed, the seed, RNG state, input and log are dropped, and the opponent's
  draws arrive without a uid. A test plays 20 AI battles and checks that no view or event names a hidden robot.
- The shared world state no longer contains other players' battle decks (`team`/`decks` are stripped; your own come
  in a separate `me` field). The client can't send a ranked 'match' op any more — only the server ends online battles.
- Rage-quit closed: starting a new search or 30 minutes without a move forfeits the open battle (a loss, ELO moves).
- Guests (no login) keep local battles against bot decks.

### The world's own NEAR wallets + TEE-verified broker decisions (Nov 14)
- Contract (code upgrade, new data under raw storage keys — no migration): `adopt_world_wallet`, `sync_world_credits`,
  `drop_world_robot`, `set_tee_signers`, `record_broker_decision` (+ views `world_wallet`, `broker_decision`,
  `tee_signers`). near-sdk's `unstable` feature for `env::ecrecover`.
- 15 accounts: `broker-kessler-corp`, `broker-magpie`, `broker-junkman` and `npc-<team>` for the 12 Pit League teams.
  The world server adopted them with their real credits and robots (113 team robots minted as tokens) and now
  mirrors every bot buy / sell / repair / battle (with the public replay log) onto the team's account; credits are
  synced hourly (stipends, upkeep, dividends happen in the simulation). Engine: `worldHooks` (npcBuy/npcSell/
  npcRepair/npcMatch).
- Each broker signs its own AI decision with a key limited to `record_broker_decision`. The contract checks that
  NEAR AI's signed text names the exact response (SHA-256), recovers the EIP-191 signer with `ecrecover` and
  requires the attested TEE address of the model (from NEAR AI's attestation report). Test with a real NEAR AI
  response + signature. `npm run verify` has two new claims (15 wallets, 3 TEE-verified decisions).

### Security pass after the second independent review (Nov 14)
- Contract v0.9 (code upgrade, no migration): online battles are opened on-chain (`open_battle_for`) and dealt from
  a seed the contract draws from `env::random_seed`; `record_battle_for` refuses an `online:` battle without its
  ticket or with another seed. Robots moved by `mt_transfer` / new `mt_batch_transfer` get a 1 CR purchase basis
  (no sybil funnelling of starters). Header comment rewritten (it still described the old client-reported trust
  model); `Cargo.toml` version 0.9.0. 32 tests.
- The world server's key was replaced by one that can also open battles (unlimited allowance); the two older server
  keys were deleted from the contract account (now: 1 full-access, relayer, world server). Brokers' decision keys
  rotated (Kessler keeps its first key: its full-access key wasn't saved by an interrupted setup run).
- Site security headers (`app/public/_headers`): CSP frame-ancestors/base-uri/object-src/form-action,
  X-Frame-Options, nosniff, referrer and permissions policies, COOP allowing wallet popups.
- Already fixed from the first review: `record_battle` without a battle, the buy-low/sell-high loop, README drift,
  lint in CI, public AI decisions; from this one: broker/NPC NEAR accounts and TEE-verified decisions (above).

### The contract replays battles; self-custody for email accounts (Nov 14)
- `contract/src/battle.rs`: the «Overheat» rules ported 1:1 to Rust (mulberry32 deal, stable-sort tie breaks, the
  float scoring of automatic repair/shock targets, veteran HP). `record_verified_battle_for(player, side, opponent,
  reward, log)` replays the log, refuses illegal moves / unfinished battles, decides the result and the wear from
  the on-chain durability, checks every robot in the log is the player's token of that model (and its veteran rank),
  and stores the log's SHA-256. The server records players' and bots' battles through it (300 Tgas; the old path is
  only a fallback if the replay can't run). Differential test: 37 battles from the TS engine
  (`app/scripts/export-battles.ts` → `contract/fixtures/battles.json`), same winners and wear. 33 contract tests.
- Self-custody: Settings → *Own your account* (email accounts on the public site). The browser makes a full-access
  key and shows it (download / "I saved it"), then `/api/privy/custody` adds it and deletes the server-derived key in
  one transaction. Email login then answers that the account is self-custodied (sign in with a wallet).
- Server key rotated again (+ `record_verified_battle_for`), the previous one deleted.

### Player market, no unverified battles (Nov 14)
- Contract: `list_robot_for` / `unlist_robot_for` / `buy_listing_for` / `listings` — escrowed listings at the owner's
  price, buyer → seller credits with a 5% burned fee; price ≤ the broker wear cap and 2.5× the seller's purchase
  basis, the seller's profit in the daily cap. 34 tests. Engine: `listRobot` / `unlistRobot` / `buyListing`,
  `npcShopMarket` (a bot team buys a listing that beats the brokers by 15%+), mirrored on the bots' accounts.
  UI: Market → *Player market*, Hangar → *List*.
- The server records battles only with `record_verified_battle_for` (fallback removed); the server key was rotated
  without `record_battle_for`, and `npm run verify` checks no key has it. New claim: the on-chain TEE signer is the
  one in NEAR AI's public attestation report.

## Next
- Card art.
- README for judges, demo video.
