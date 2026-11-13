# Sounds: sources and licenses

## Summary

- **Sound effects:** 32 files in `public/sfx/`. All of them come from five free packs by **Kenney** (kenney.nl), released under **CC0 1.0 (Creative Commons Zero)**.
- **Background ambience:** not a file. It is synthesized in code (`src/audio.ts`, `startAmbience`) with the Web Audio API, so it is our own work.
- **What we may do with them:** use them in personal and commercial projects, modify them and redistribute them. Attribution is **not required**, but we credit Kenney anyway (see below).
- The original license text ships next to the sounds: `public/sfx/LICENSE-kenney.txt`.

## License

**CC0 1.0 Universal** (https://creativecommons.org/publicdomain/zero/1.0/) means the author has given up all rights to the work, as far as the law allows. The files are effectively public domain:

- no attribution required;
- commercial use is allowed (including hackathon prizes);
- changing the files is allowed (we converted them from .ogg to .mp3, mono, 96 kbps, trimmed silence and mixed several sounds into one for the card effects);
- redistribution is allowed, including inside a public repository.

The pack's own license text says: *"This content is free to use in personal, educational and commercial projects. Support us by crediting Kenney or www.kenney.nl (this is not mandatory)."*

## Source packs

| Pack | Page | Files | License |
|---|---|---|---|
| Interface Sounds | https://kenney.nl/assets/interface-sounds | 100 | CC0 |
| Sci-fi Sounds | https://kenney.nl/assets/sci-fi-sounds | 70 | CC0 |
| Impact Sounds | https://kenney.nl/assets/impact-sounds | 130 | CC0 |
| Music Jingles | https://kenney.nl/assets/music-jingles | 85 | CC0 |
| Casino Audio | https://kenney.nl/assets/casino-audio | 50 | CC0 |

Downloaded on 12.11.2026 from the official site using the "Continue without donating" button.

## What is used where

| File in the game | Original (pack) | Where it plays |
|---|---|---|
| ui-click.mp3 | select_002.ogg (Interface) | button press |
| ui-tab.mp3 | switch_002.ogg (Interface) | tab switch |
| ui-hover.mp3 | tick_002.ogg (Interface) | hovering over a button (quiet) |
| ui-error.mp3 | error_005.ogg (Interface) | any error (not enough credits, over the energy limit, etc.) — a soft low tone |
| ui-buy.mp3 | confirmation_001.ogg (Interface) | buying a robot, investing in a broker |
| ui-sell.mp3 | confirmation_002.ogg (Interface) | selling a robot |
| glitch-1…4.mp3 | glitch_001…004.ogg (Interface) | glitch on value changes, deployment reveal |
| deploy.mp3 | forceField_000.ogg (Sci-fi) | robots enter the field |
| repair.mp3 | forceField_003.ogg (Sci-fi) | Repair ability, repairing in the Hangar |
| shock-1, shock-2.mp3 | laserRetro_000, laserRetro_002.ogg (Sci-fi) | Shock ability |
| hit-1…3.mp3 | impactMetal_medium_000…002.ogg (Impact) | hit on a robot |
| core-hit-1.mp3 | impactMetal_000.ogg (Sci-fi) | hit on the Core |
| core-hit-2.mp3 | impactMetal_heavy_000.ogg (Impact) | hit on the Core |
| block.mp3 | impactTin_medium_000.ogg (Impact) | armor absorbed all damage |
| charge-1, charge-2.mp3 | impactPunch_heavy_000, 001.ogg (Impact) | Charge ability |
| destroy-1, destroy-2.mp3 | explosionCrunch_000, 002.ogg (Sci-fi) | robot destroyed |
| blast.mp3 | lowFrequency_explosion_000.ogg (Sci-fi) | Blast ability |
| victory.mp3 | jingles_NES12.ogg (Music Jingles, 8-Bit) | victory |
| defeat.mp3 | jingles_NES11.ogg (Music Jingles, 8-Bit) | defeat |
| fast-forward.mp3 | thrusterFire_000.ogg (Sci-fi) | start of the week fast-forward |
| card-pick-1, card-pick-2.mp3 | card-slide-2/3 (Casino Audio) + quiet impactGlass_light_001/003 (Impact) + glitch_002/004 (Interface), mixed | picking up a card, the card flying back |
| card-drop-1, card-drop-2.mp3 | card-place-1 (Casino Audio) + quiet impactMetal_light_002/004 (Impact) + glass_002/004 (Interface), mixed | a card landing in a slot or a lane |

The full original → file mapping is also in `public/sfx/SOURCES.txt`.

## Credits (for the README)

> Sound effects by Kenney (www.kenney.nl), CC0. Ambient drone synthesized in-game with the Web Audio API.
