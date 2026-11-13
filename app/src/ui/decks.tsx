// Shared deck header for the Hangar and the Arena: a collapsible row with the deck's name (renamable inline),
// how many robots / how much energy it holds, whether it can fight, and a "battle deck" mark.

import { useState, type ReactNode } from 'react';
import { TEAM_ENERGY_CAP, TEAM_MAX, TEAM_MIN } from '../engine/robots';
import { teamEnergy, teamError } from '../engine/team';
import type { Deck, World } from '../engine/world';
import { deckSound, sfx } from '../audio';

export function DeckRow(props: {
  w: World;
  deck: Deck;
  open: boolean;
  battle: boolean; // this deck goes into battle
  onToggle: () => void;
  onRename: (name: string) => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { w, deck } = props;
  const [edit, setEdit] = useState<string | null>(null);
  const robots = deck.uids.map((u) => w.robots[u]).filter(Boolean);
  const energy = teamEnergy(robots);
  const err = teamError(robots);
  const commit = () => {
    if (edit !== null && edit.trim() && edit.trim() !== deck.name) props.onRename(edit);
    setEdit(null);
  };
  return (
    <div className={`deck-row ${props.open ? 'open' : ''} ${props.battle ? 'battle' : ''}`}>
      <div
        className="deck-head"
        onClick={() => {
          if (edit === null) {
            deckSound(!props.open, robots.length);
            props.onToggle();
          }
        }}
      >
        <span className="deck-caret">{props.open ? '▼' : '▶'}</span>
        {edit !== null ? (
          <input
            className="deck-name-input"
            autoFocus
            maxLength={24}
            value={edit}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEdit(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEdit(null);
            }}
          />
        ) : (
          <b className="deck-name">{deck.name}</b>
        )}
        <button
          className="small deck-rename"
          title="Rename"
          data-sfx="none"
          onClick={(e) => {
            e.stopPropagation();
            sfx('ui-click');
            setEdit(deck.name);
          }}
        >
          ✎
        </button>
        {props.battle && <span className="tag deck-battle">BATTLE TEAM</span>}
        <span className="deck-stats muted">
          {robots.length ? `${robots.length} robots · deck cost ${energy}/${TEAM_ENERGY_CAP}` : 'empty'}
        </span>
        <span className={`deck-state ${err ? 'muted' : 'up'}`} title={err ?? undefined}>
          {err ? (robots.length < TEAM_MIN ? `needs ${TEAM_MIN}–${TEAM_MAX}` : 'not ready') : '✓ ready'}
        </span>
        <span style={{ flex: 1 }} />
        <span onClick={(e) => e.stopPropagation()} className="deck-actions">
          {props.actions}
        </span>
      </div>
      {props.open && <div className="deck-body">{props.children}</div>}
    </div>
  );
}
