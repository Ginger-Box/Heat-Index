import { useState } from 'react';
import { CLASSES, TEAM_ENERGY_CAP, TEAM_MIN, TEAM_SIZE, classOf, maxDurability, model } from '../engine/robots';
import { buildTeam } from '../engine/team';
import {
  PLAYER_ID,
  bestBid,
  canClaimLoaner,
  claimLoaner,
  getManager,
  recycle,
  repair,
  repairQuote,
  robotsOf,
  sell,
  DECK_COUNT,
  ensureDecks,
  renameDeck,
  setDeck,
  type OwnedRobot,
  type World,
} from '../engine/world';
import { sfx } from '../audio';
import { act } from '../store';
import { Cr, RobotCard } from '../ui/common';
import { useCardDrag } from '../ui/drag';
import { DeckRow } from '../ui/decks';

type SortKey = 'class' | 'cost' | 'atk' | 'hp' | 'dur' | 'price' | 'name';
const SORTS: [SortKey, string][] = [
  ['class', 'Class'],
  ['cost', 'Energy'],
  ['atk', 'Attack'],
  ['hp', 'HP'],
  ['dur', 'Durability'],
  ['price', 'Price'],
  ['name', 'Name'],
];

export function Hangar({ w }: { w: World }) {
  const me = getManager(w, PLAYER_ID);
  const [msg, setMsg] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cost', desc: true });

  const decks = ensureDecks(me);
  // the deck being edited (one at a time, can be collapsed); starts on the battle deck
  const [editIdx, setEditIdx] = useState<number | null>(me.activeDeck ?? 0);
  const cur = editIdx ?? -1;
  const team = (decks[cur]?.uids ?? []).map((u) => w.robots[u] as OwnedRobot).filter(Boolean);
  const teamUids = team.map((r) => r.uid);
  const inAnyDeck = new Set(decks.flatMap((d) => d.uids));

  const price = (r: OwnedRobot) => bestBid(w, r)?.price ?? 0;
  const keyOf = (r: OwnedRobot): number | string => {
    const md = model(r.modelId);
    switch (sort.key) {
      case 'class':
        return CLASSES.indexOf(classOf(r.modelId)) * 10 + md.cost;
      case 'cost':
        return md.cost;
      case 'atk':
        return md.atk;
      case 'hp':
        return md.hp;
      case 'dur':
        return r.durability;
      case 'price':
        return price(r);
      case 'name':
        return md.name;
    }
  };
  const pool = robotsOf(w, PLAYER_ID)
    .filter((r) => !inAnyDeck.has(r.uid)) // the Hangar shows robots that stand in no deck
    .sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      const c = typeof ka === 'string' ? ka.localeCompare(kb as string, 'en') : ka - (kb as number);
      return (sort.desc ? -c : c) || model(a.modelId).name.localeCompare(model(b.modelId).name, 'en');
    });

  // Every change to a deck is saved to the world right away — there is no separate "Save" button.
  const save = (uids: string[]) => {
    if (cur < 0) return false;
    const err = act((w) => setDeck(w, PLAYER_ID, cur, uids));
    setMsg(err);
    return !err;
  };
  const run = (fn: (w: World) => string | null) => setMsg(act(fn));

  const remove = (uid: string) => save(teamUids.filter((u) => u !== uid));
  /** Put a robot into slot idx (or the first free one). A taken slot — replace; a robot from another slot — swap. */
  const place = (uid: string, idx?: number): boolean => {
    const next = [...teamUids];
    const from = next.indexOf(uid);
    if (idx === undefined || idx >= next.length) {
      if (from >= 0) return false; // already in the deck
      if (next.length >= TEAM_SIZE) {
        sfx('ui-error');
        setMsg(`All ${TEAM_SIZE} slots are full — remove someone or drop the robot onto a taken slot`);
        return false;
      }
      next.push(uid);
    } else if (from >= 0) {
      [next[from], next[idx]] = [next[idx], next[from]];
    } else {
      next[idx] = uid;
    }
    return save(next);
  };

  // Dragging: onto a slot — place / replace / swap, into the Hangar — remove from the deck
  const drag = useCardDrag((uid, target) => {
    if (target?.startsWith('slot-')) return place(uid, Number(target.slice(5)));
    if (target === 'pool') return teamUids.includes(uid) ? remove(uid) : 'cancel';
    return 'cancel';
  });

  const auto = () => {
    // from this deck's robots + the free ones (robots in other decks stay where they are)
    const t = buildTeam(robotsOf(w, PLAYER_ID).filter((r) => teamUids.includes(r.uid) || !inAnyDeck.has(r.uid)), (r) => {
      const md = model(r.modelId);
      return md.atk + md.hp + (md.ability ? 2 : 0) + r.durability * 0.2;
    });
    if (!t) setMsg('Your robots cannot form a team. Buy more on the Market.');
    else save(t.map((r) => r.uid));
  };

  const repairBtn = (r: OwnedRobot) => {
    if (r.durability >= maxDurability(r.modelId)) return null;
    const rq = repairQuote(w, r);
    return rq ? (
      <button
        className="small"
        data-sfx="none"
        onClick={() => {
          const err = act((w) => repair(w, PLAYER_ID, r.uid));
          if (!err) sfx('repair');
          setMsg(err);
        }}
      >
        🔧 <Cr v={rq.cost} />
      </button>
    ) : null;
  };

  return (
    <div className="grid">
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Teams</h2>
          <span className="muted">Open a team to edit it · the battle team is chosen in the Arena</span>
        </div>
        {msg && (
          <div className="error" style={{ marginBottom: 8 }}>
            {msg}
          </div>
        )}
        {decks.slice(0, DECK_COUNT).map((d, di) => (
          <DeckRow
            key={di}
            w={w}
            deck={d}
            open={editIdx === di}
            battle={(me.activeDeck ?? 0) === di}
            onToggle={() => {
              setMsg(null);
              setEditIdx(editIdx === di ? null : di);
            }}
            onRename={(name) => run((w) => renameDeck(w, PLAYER_ID, di, name))}
            actions={
              editIdx === di && (
                <>
                  <button className="small" onClick={auto}>
                    Auto-build
                  </button>
                  <button className="small" onClick={() => save([])} disabled={!team.length}>
                    Clear
                  </button>
                </>
              )
            }
          >
            <div className="slots">
              {Array.from({ length: TEAM_SIZE }, (_, i) => {
                const r = team[i];
                const card = r && (
                  <RobotCard
                    modelId={r.modelId}
                    durability={r.durability}
                    vet={r.vet}
                    onClick={() => remove(r.uid)}
                    badge={<span className="muted">✕</span>}
                  />
                );
                const h = r && drag.handle(r.uid, () => card);
                return (
                  <div
                    key={i}
                    data-drop={`slot-${i}`}
                    className={`slot-cell ${r ? '' : 'empty'} ${drag.dragging && drag.over === `slot-${i}` ? 'over' : ''}`}
                  >
                    {r && h ? (
                      <>
                        <div key={h.key} {...h.props}>
                          {card}
                        </div>
                        <div className="slot-actions">{repairBtn(r)}</div>
                      </>
                    ) : (
                      <span className="muted">{i < TEAM_MIN ? `slot ${i + 1}` : `slot ${i + 1} · optional`}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </DeckRow>
        ))}
        <small className="muted">
          Drag robots between the Hangar and the slots of the open deck (drop on a taken slot to swap), or just click
          them. A robot can stand in one deck at a time. Changes save instantly.
          A deck is {TEAM_MIN}–{TEAM_SIZE} robots, total energy cost of all its robots at most {TEAM_ENERGY_CAP}, at most 2 of the same model.
        </small>
        {canClaimLoaner(w, PLAYER_ID) && (
          <div className="panel" style={{ marginTop: 10, borderColor: 'var(--yellow)' }}>
            Can't afford a team? The Arena hands out a free loaner robot (durability 5, cannot be sold).{' '}
            <button onClick={() => run((w) => claimLoaner(w, PLAYER_ID))}>Get a robot</button>
          </div>
        )}
      </div>

      <div
        data-drop="pool"
        data-drop-instant
        className={`panel ${drag.dragging && teamUids.includes(drag.dragging) && drag.over === 'pool' ? 'pool-over' : ''}`}
      >
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>
            Hangar <span className="muted">· {pool.length}</span>
          </h2>
          <div className="row" style={{ gap: 6 }}>
            <span className="muted">Sort:</span>
            {SORTS.map(([key, label]) => (
              <button
                key={key}
                className={`small ${sort.key === key ? 'primary' : ''}`}
                onClick={() =>
                  setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' && key !== 'class' }))
                }
              >
                {label}
                {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
              </button>
            ))}
          </div>
        </div>
        <div className="row" style={{ alignItems: 'stretch', gap: 18 }}>
          {pool.length === 0 && <span className="muted">All your robots are in decks. Buy more on the Market.</span>}
          {pool.map((r) => {
            const bid = bestBid(w, r);
            const card = (
              <RobotCard
                modelId={r.modelId}
                durability={r.durability}
                vet={r.vet}
                onClick={r.durability > 0 ? () => place(r.uid) : undefined}
                badge={r.loaner ? <span title="Arena loaner robot">♻</span> : null}
              />
            );
            const h = drag.handle(r.uid, () => card, r.durability > 0);
            return (
              <div key={r.uid} className="pool-item">
                <div key={h.key} {...h.props}>
                  {card}
                </div>
                <div className="row" style={{ gap: 4, justifyContent: 'center' }}>
                  {repairBtn(r)}
                  {bid ? (
                    <button
                      className="small"
                      title={`Sell to ${bid.broker.name}`}
                      data-sfx="none"
                      onClick={() => {
                        const err = act((w) => sell(w, PLAYER_ID, r.uid, bid.broker.id));
                        if (!err) sfx('ui-sell');
                        setMsg(err);
                      }}
                    >
                      Sell <Cr v={bid.price} />
                    </button>
                  ) : r.durability <= 0 ? (
                    <button className="small danger" onClick={() => run((w) => recycle(w, PLAYER_ID, r.uid))}>
                      Recycle
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {drag.ghost}
    </div>
  );
}
