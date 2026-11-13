// The Pit League: the 12 NPC teams play in 4 divisions. The player starts in the lowest one and climbs:
// beat every team of your division once to move up. Higher divisions have stronger, more expensive decks,
// smarter class combos and a sharper AI — and pay a bigger battle purse. Beat the Apex League to be crowned
// King of the Pit.

import type { RobotClass } from './robots';
import type { Strategy } from './world';

export interface Division {
  id: string;
  name: string;
  /** NPC deck cost limit (the player's limit is always 42) */
  cap: number;
  /** chance per move that the opponent plays a random reasonable move instead of the best one */
  sloppy: number;
  /** battle purse multiplier for the player */
  purse: number;
  /** credits for winning the division */
  prize: number;
  /** daily league money for each NPC team of the division (keeps the upper leagues' decks expensive) */
  stipend: number;
  /** how the teams of this division build decks */
  style: string;
  color: string;
}

export const DIVISIONS: Division[] = [
  { id: 'scrap', name: 'Scrap League', cap: 24, sloppy: 0.4, purse: 1, prize: 150, stipend: 40, style: 'One class, cheap decks', color: 'var(--green)' },
  { id: 'chrome', name: 'Chrome League', cap: 30, sloppy: 0.18, purse: 1.25, prize: 300, stipend: 70, style: 'One class, stronger robots', color: 'var(--cyan)' },
  { id: 'neon', name: 'Neon League', cap: 36, sloppy: 0.06, purse: 1.5, prize: 500, stipend: 140, style: 'Two-class combos', color: 'var(--magenta)' },
  { id: 'apex', name: 'Apex League', cap: 42, sloppy: 0, purse: 2, prize: 1000, stipend: 220, style: 'Top combos at full cost', color: 'var(--yellow)' },
];
export const KING_TITLE = 'King of the Pit';
/** defending the crown (every win over the whole Apex League after the first) pays less than taking it */
export const CROWN_DEFENSE_PRIZE = 300;
/** credits for winning division `div`; `crowns` = how many times the Apex League was won before */
export const divisionPrize = (div: number, crowns: number) =>
  div === DIVISIONS.length - 1 && crowns > 0 ? CROWN_DEFENSE_PRIZE : DIVISIONS[div].prize;

/** Who plays where. Ids stay npc1…npc12 (saves refer to them). */
export const NPC_SETUP: { name: string; strategy: Strategy; div: number; focus: RobotClass; focus2?: RobotClass }[] = [
  { name: 'Rusty Dogs', strategy: 'hype', div: 0, focus: 'charge' },
  { name: 'Neon-17', strategy: 'contrarian', div: 3, focus: 'charge', focus2: 'armor' },
  { name: 'Syndicate Zero', strategy: 'hype', div: 3, focus: 'shock', focus2: 'armor' },
  { name: 'Steel Rats', strategy: 'thrifty', div: 1, focus: 'armor' },
  { name: 'Night Shift', strategy: 'contrarian', div: 2, focus: 'shock', focus2: 'repair' },
  { name: 'Glitch', strategy: 'hype', div: 0, focus: 'repair' },
  // the last Apex team is the boss: guards that the medics keep patching up
  { name: 'Protocol Omega', strategy: 'thrifty', div: 3, focus: 'armor', focus2: 'repair' },
  { name: 'Chrome Hawks', strategy: 'contrarian', div: 2, focus: 'charge', focus2: 'blast' },
  { name: 'Short Circuit', strategy: 'thrifty', div: 0, focus: 'shock' },
  { name: 'Byte Gang', strategy: 'hype', div: 1, focus: 'maneuver' },
  { name: 'Sector 9', strategy: 'contrarian', div: 2, focus: 'blast', focus2: 'repair' },
  { name: 'Dead Pixel', strategy: 'thrifty', div: 1, focus: 'blast' },
];

export interface LeagueState {
  /** the player's division, 0…3 */
  div: number;
  /** NPC ids beaten in the current division (this climb) */
  beaten: string[];
  /** how many times the player won the Apex League */
  crowns: number;
}
