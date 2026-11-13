import { useState } from 'react';
import { CLASSES, TEAM_ENERGY_CAP, TEAM_MIN, TEAM_SIZE, classOf, maxDurability, model } from '../engine/robots';
import { buildTeam, teamEnergy, teamError } from '../engine/team';
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
  setTeam,
  teamOf,
  type OwnedRobot,
  type World,
} from '../engine/world';
import { sfx } from '../audio';
import { act } from '../store';
import { Cr, RobotCard } from '../ui/common';
import { useCardDrag } from '../ui/drag';

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

  const team = teamOf(w, me);
  const teamUids = team.map((r) => r.uid);
  const energy = teamEnergy(team);
  const ready = !teamError(team);

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
    .filter((r) => !teamUids.includes(r.uid))
    .sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      const c = typeof ka === 'string' ? ka.localeCompare(kb as string, 'en') : ka - (kb as number);
      return (sort.desc ? -c : c) || model(a.modelId).name.localeCompare(model(b.modelId).name, 'en');
    });

  // Любое изменение состава сразу сохраняется в мир — отдельной кнопки «Сохранить» нет.
  const save = (uids: string[]) => {
    const err = act((w) => setTeam(w, PLAYER_ID, uids));
    setMsg(err);
    return !err;
  };
  const run = (fn: (w: World) => string | null) => setMsg(act(fn));

  const remove = (uid: string) => save(teamUids.filter((u) => u !== uid));
  /** Положить робота в слот idx (или в первый свободный). Занятый слот — замена; робот из другого слота — обмен местами. */
  const place = (uid: string, idx?: number): boolean => {
    const next = [...teamUids];
    const from = next.indexOf(uid);
    if (idx === undefined || idx >= next.length) {
      if (from >= 0) return false; // уже в команде
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

  // Перетаскивание: на слот — поставить/заменить/поменять местами, в Ангар — убрать из команды
  const drag = useCardDrag((uid, target) => {
    if (target?.startsWith('slot-')) return place(uid, Number(target.slice(5)));
    if (target === 'pool') return teamUids.includes(uid) ? remove(uid) : 'cancel';
    return 'cancel';
  });

  const auto = () => {
    const t = buildTeam(robotsOf(w, PLAYER_ID), (r) => {
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
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Team</h2>
          <div className="row">
            <span>
              Deck <b className={team.length < TEAM_MIN ? 'down' : ''}>{team.length}</b> ({TEAM_MIN}–{TEAM_SIZE})
            </span>
            <span>
              Energy <b className={energy > TEAM_ENERGY_CAP ? 'down' : ''}>{energy}</b>/{TEAM_ENERGY_CAP}
            </span>
            <span className={ready ? 'up' : 'muted'}>{ready ? '✓ ready to fight' : 'not ready to fight'}</span>
            <button onClick={auto}>Auto-build</button>
            <button onClick={() => save([])} disabled={!team.length}>
              Clear
            </button>
          </div>
        </div>
        {msg && (
          <div className="error" style={{ marginTop: 8 }}>
            {msg}
          </div>
        )}
        <div className="slots">
          {Array.from({ length: TEAM_SIZE }, (_, i) => {
            const r = team[i];
            const card = r && (
              <RobotCard
                modelId={r.modelId}
                durability={r.durability}
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
        <small className="muted">
          Drag robots between the Hangar and the slots (drop on a taken slot to swap), or just click them. Changes save
          instantly.
          A deck is {TEAM_MIN}–{TEAM_SIZE} robots, {TEAM_ENERGY_CAP} energy at most, at most 2 of the same model.
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
          {pool.length === 0 && <span className="muted">All robots are in the team. Buy more on the Market.</span>}
          {pool.map((r) => {
            const bid = bestBid(w, r);
            const card = (
              <RobotCard
                modelId={r.modelId}
                durability={r.durability}
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
