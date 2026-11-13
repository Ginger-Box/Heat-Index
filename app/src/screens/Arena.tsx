import { useEffect, useRef, useState } from 'react';
import { sfx } from '../audio';
import { planTurn } from '../engine/ai';
import {
  BOARD_SLOTS,
  CORE_HP,
  MAX_TURNS,
  applyAction,
  attackTargets,
  createBattle,
  deployTargets,
  heatCap,
  isGuard,
  wearLoss,
  type Action,
  type BattleEvent,
  type BattleState,
  type Target,
  type Unit,
} from '../engine/battle';
import { ECON } from '../engine/pricing';
import { CLASS_HELP, CLASS_ICON, CLASS_LABEL, model } from '../engine/robots';
import { teamError } from '../engine/team';
import {
  PLAYER_ID,
  STRATEGY_LABEL,
  applyMatch,
  getManager,
  pickOpponentForPlayer,
  teamOf,
  type World,
} from '../engine/world';
import { act } from '../store';
import { DurBar, Glitch, RobotCard } from '../ui/common';
import { useCardDrag } from '../ui/drag';

interface Fight {
  oppId: string;
  st: BattleState;
  durBefore: Record<string, number>;
  eloBefore: number;
}

interface Float {
  id: number;
  key: string; // uid of a robot or core-0 / core-1
  text: string;
  kind: 'dmg' | 'heal' | 'block' | 'heat' | 'cool';
}

const coreKey = (side: number) => `core-${side}`;
const keyOf = (side: number, to: string | 'core') => (to === 'core' ? coreKey(side) : to);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describe(e: BattleEvent, st: BattleState, names: [string, string]): string | null {
  const nm = (uid: string) => model(st.modelOf[uid]).name;
  switch (e.t) {
    case 'turn':
      return `— ${names[e.side]}: turn ${e.turn} —`;
    case 'deploy':
      return `${names[e.side]} deploys ${nm(e.uid)}`;
    case 'attack':
      return e.to === 'core'
        ? `${nm(e.from)} hits the Core −${e.dmg}`
        : `${nm(e.from)} → ${nm(e.to)}: −${e.dmg}${e.counter ? `, takes −${e.counter} back` : ''}`;
    case 'vent':
      return `${nm(e.uid)} cools down (−${e.cooled} heat)`;
    case 'overheat':
      return `🔥 ${nm(e.uid)} overheated — skips a turn`;
    case 'repair':
      return e.amount ? `🔧 ${nm(e.from)} repairs ${e.target === 'core' ? 'the Core' : nm(e.target)} +${e.amount}` : null;
    case 'shock':
      return `🌩️ ${nm(e.from)} shocks ${nm(e.target)}`;
    case 'destroyed':
      return `💀 ${nm(e.uid)} destroyed`;
    case 'blast':
      return `💥 ${nm(e.from)} explodes: ${e.n} damage to every enemy robot`;
    case 'end':
      return e.winner === null ? 'Draw!' : `Winner: ${names[e.winner]}`;
    default:
      return null;
  }
}

/** Heat pips under a robot: how close it is to overheating. */
function HeatBar({ u }: { u: Unit }) {
  const cap = heatCap(u.modelId);
  return (
    <div className="heat" title={`Heat ${u.heat}/${cap}. Every attack +2; at ${cap} the robot overheats and skips a turn.`}>
      {Array.from({ length: cap }, (_, i) => (
        <i key={i} className={i < u.heat ? (u.heat >= cap - 2 ? 'hot' : 'warm') : ''} />
      ))}
    </div>
  );
}

export function Arena({ w }: { w: World }) {
  const me = getManager(w, PLAYER_ID);
  const [oppId, setOppId] = useState(() => pickOpponentForPlayer(w).id);
  const [fight, setFight] = useState<Fight | null>(null);
  const [view, setView] = useState<BattleState | null>(null); // what is drawn (during animations may differ from fight.st)
  const [sel, setSel] = useState<string | null>(null); // my robot chosen to attack
  const [handSel, setHandSel] = useState<string | null>(null);
  const [deploying, setDeploying] = useState<{ uid: string; targets: Target[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState('');
  const [fx, setFx] = useState<Record<string, string>>({});
  const [floats, setFloats] = useState<Float[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<null | {
    st: BattleState;
    oppName: string;
    durBefore: Record<string, number>;
    eloBefore: number;
  }>(null);
  const alive = useRef(true);
  const fid = useRef(0);
  const fightRef = useRef<Fight | null>(null);
  fightRef.current = fight;
  const dropRef = useRef<(uid: string, target: string | null) => boolean | 'cancel'>(() => 'cancel');
  const drag = useCardDrag((uid, target) => dropRef.current(uid, target));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const myTeam = teamOf(w, me);
  const teamErr = teamError(myTeam);
  const opp = getManager(w, oppId);

  // ---------- lobby ----------
  if (!fight) {
    return (
      <div className="grid">
        {result && <ResultPanel w={w} {...result} onClose={() => setResult(null)} />}
        <div className="panel">
          <h2>Arena</h2>
          <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
            <div>
              <h3>Opponent</h3>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{opp.name}</div>
              <div className="muted">
                ELO {opp.elo} · {STRATEGY_LABEL[opp.strategy]}
              </div>
              {opp.focus && (
                <div style={{ marginTop: 6 }} title={CLASS_HELP[opp.focus]}>
                  Plays the class:{' '}
                  <b style={{ color: 'var(--cyan)' }}>
                    {CLASS_ICON[opp.focus]} {CLASS_LABEL[opp.focus]}
                  </b>
                </div>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                <button onClick={() => setOppId(pickOpponentForPlayer(w).id)}>Another opponent</button>
                <button
                  className="primary"
                  disabled={!!teamErr || !!teamError(teamOf(w, opp))}
                  onClick={() => {
                    const seed = (w.tick * 7919 + w.hour * 104729 + Date.now()) % 2 ** 31;
                    const st = createBattle(myTeam, teamOf(w, opp), seed);
                    const durBefore = Object.fromEntries(myTeam.map((r) => [r.uid, r.durability]));
                    setFight({ oppId, st, durBefore, eloBefore: me.elo });
                    setView(st);
                    setCaption('Your turn');
                    setResult(null);
                    setSel(null);
                    setHandSel(null);
                    setFloats([]);
                    setFx({});
                  }}
                >
                  ⚔ Fight
                </button>
              </div>
              {teamErr && <div className="error">Team not ready: {teamErr}. Go to the Hangar.</div>}
            </div>
            <div style={{ flex: 1 }}>
              <h3>Your team</h3>
              <div className="row" style={{ gap: 14 }}>
                {myTeam.map((r) => (
                  <RobotCard key={r.uid} modelId={r.modelId} durability={r.durability} />
                ))}
              </div>
            </div>
          </div>
          <details style={{ marginTop: 14 }}>
            <summary>Battle rules</summary>
            <ul className="muted" style={{ paddingLeft: 18 }}>
              <li>Turns alternate. Each side has a Core of {CORE_HP} HP and up to {BOARD_SLOTS} robots on the board.</li>
              <li>Deploy robots from your hand for energy, then choose who attacks whom. The target strikes back.</li>
              <li>
                Every attack heats a robot up. At its limit it <b>overheats</b>: skips your next turn and wears out more.
                Instead of attacking you can cool it down.
              </li>
              <li>🛡 Armor robots are guards — hit them first. 💨 Maneuver robots ignore guards.</li>
              <li>Wear costs money: damaged −1, destroyed −2, overheated −1 more (at most −2).</li>
              <li>After {MAX_TURNS} turns each the bigger Core wins.</li>
            </ul>
          </details>
        </div>
      </div>
    );
  }

  // ---------- battle ----------
  const st = fight.st;
  const v = view ?? st;
  const mine = v.sides[0];
  const theirs = v.sides[1];
  const myTurn = st.active === 0 && st.winner === undefined && !busy;
  const names: [string, string] = ['You', opp.name];
  const selUnit = sel ? st.sides[0].board.find((u) => u.uid === sel) : undefined;
  const legal = new Set<string>(selUnit && myTurn ? attackTargets(st, 0, selUnit).map((t) => keyOf(1, t)) : []);
  const deployKeys = new Set(deploying ? deploying.targets.map((t) => ('core' in t ? coreKey(t.side) : t.uid)) : []);
  const dur = Object.fromEntries(Object.entries(w.robots).map(([u, r]) => [u, r.durability]));

  const addFloats = (list: Omit<Float, 'id'>[]) =>
    setFloats((f) => [...f.slice(-24), ...list.map((x) => ({ ...x, id: ++fid.current }))]);
  const flash = (map: Record<string, string>, ms: number) => {
    setFx((f) => ({ ...f, ...map }));
    setTimeout(
      () =>
        setFx((f) => {
          const n = { ...f };
          for (const k of Object.keys(map)) if (n[k] === map[k]) delete n[k];
          return n;
        }),
      ms,
    );
  };

  /** Lunge of the attacker toward its target (Web Animations, in place). */
  const lunge = (fromUid: string, toKey: string) => {
    const a = document.querySelector(`[data-unit="${fromUid}"] .card`) as HTMLElement | null;
    const b = document.querySelector(`[data-unit="${toKey}"]`) as HTMLElement | null;
    if (!a || !b) return;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const s = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const dx = ((rb.left + rb.width / 2 - (ra.left + ra.width / 2)) * 0.62) / s;
    const dy = ((rb.top + rb.height / 2 - (ra.top + ra.height / 2)) * 0.62) / s;
    a.animate(
      [
        { transform: 'none' },
        { transform: `translate(${dx}px, ${dy}px) scale(1.08)`, offset: 0.45 },
        { transform: 'none' },
      ],
      { duration: 420, easing: 'cubic-bezier(.3,.7,.4,1)' },
    );
  };

  const finish = async (final: BattleState) => {
    setCaption(final.winner === null ? 'Draw!' : final.winner === 0 ? '🏆 Victory!' : 'Defeat');
    sfx(final.winner === 0 ? 'victory' : 'defeat');
    await sleep(1400);
    if (!alive.current) return;
    const f = fightRef.current!;
    act((w) => applyMatch(w, PLAYER_ID, f.oppId, final));
    setResult({ st: final, oppName: opp.name, durBefore: f.durBefore, eloBefore: f.eloBefore });
    setFight(null);
    setView(null);
    setBusy(false);
    setOppId(pickOpponentForPlayer(w).id);
  };

  /** Plays one action with animations and sounds, then commits it. Returns the new state. */
  const runAction = async (a: Action): Promise<BattleState> => {
    const before = fightRef.current!.st;
    const after = structuredClone(before);
    const ev: BattleEvent[] = [];
    const err = applyAction(after, a, ev);
    if (err) {
      setMsg(err);
      sfx('ui-error');
      return before;
    }
    after.history = [...before.history, ...ev];
    const side = before.active;

    // keep destroyed robots on screen for a moment so they can "die" visibly
    const withDying = structuredClone(after);
    for (const e of ev)
      if (e.t === 'destroyed') {
        const old = before.sides[e.side].board.find((u) => u.uid === e.uid);
        if (old && !withDying.sides[e.side].board.some((u) => u.uid === e.uid)) {
          const idx = before.sides[e.side].board.findIndex((u) => u.uid === e.uid);
          withDying.sides[e.side].board.splice(Math.max(0, idx), 0, { ...old, hp: 0 });
        }
      }

    const attack = ev.find((e) => e.t === 'attack') as Extract<BattleEvent, { t: 'attack' }> | undefined;
    if (attack) {
      lunge(attack.from, keyOf(1 - side, attack.to));
      await sleep(190);
      setView(withDying);
      const fl: Omit<Float, 'id'>[] = [];
      const tk = keyOf(1 - side, attack.to);
      fl.push(attack.dmg > 0 ? { key: tk, text: `−${attack.dmg}`, kind: 'dmg' } : { key: tk, text: '🛡 0', kind: 'block' });
      if (attack.counter > 0) fl.push({ key: attack.from, text: `−${attack.counter}`, kind: 'dmg' });
      const hurt: Record<string, string> = {};
      if (attack.dmg > 0) hurt[tk] = 'fx-hurt';
      if (attack.counter > 0) hurt[attack.from] = 'fx-hurt';
      flash(hurt, 500);
      addFloats(fl);
      sfx(attack.to === 'core' ? 'core-hit' : attack.dmg > 0 ? 'hit' : 'block');
    } else setView(withDying);

    for (const e of ev) {
      if (e.t === 'deploy') {
        flash({ [e.uid]: 'fx-pop' }, 450);
        sfx('card-drop', { volume: e.side === 0 ? 1 : 0.7 });
      } else if (e.t === 'repair' && e.amount) {
        const k = e.target === 'core' ? coreKey(e.side) : e.target;
        addFloats([{ key: k, text: `+${e.amount}`, kind: 'heal' }]);
        flash({ [k]: 'fx-heal' }, 800);
        sfx('repair', { volume: 0.7 });
      } else if (e.t === 'shock') {
        flash({ [e.from]: 'fx-zap', [e.target]: 'fx-hurt' }, 600);
        addFloats([{ key: e.target, text: '💫 stunned', kind: 'block' }]);
        sfx('shock');
      } else if (e.t === 'vent') {
        addFloats([{ key: e.uid, text: `❄ −${e.cooled}`, kind: 'cool' }]);
        flash({ [e.uid]: 'fx-cool' }, 700);
        sfx('deploy', { volume: 0.6 });
      } else if (e.t === 'overheat') {
        addFloats([{ key: e.uid, text: 'OVERHEAT', kind: 'heat' }]);
        flash({ [e.uid]: 'fx-overheat' }, 900);
        sfx('glitch', { volume: 3 });
      }
    }
    const deaths = ev.filter((e) => e.t === 'destroyed') as Extract<BattleEvent, { t: 'destroyed' }>[];
    const blasts = ev.filter((e) => e.t === 'blast') as Extract<BattleEvent, { t: 'blast' }>[];
    if (deaths.length) {
      await sleep(attack ? 260 : 120);
      flash(Object.fromEntries(deaths.map((d) => [d.uid, 'fx-dying'])), 700);
      sfx('destroy');
      for (const b of blasts) {
        addFloats(b.hits.map((h) => ({ key: h.uid, text: `−${h.dmg}`, kind: 'dmg' as const })));
        flash(Object.fromEntries(b.hits.map((h) => [h.uid, 'fx-hurt'])), 500);
        sfx('blast');
      }
      await sleep(620);
    } else if (attack) await sleep(260);
    if (!alive.current) return after;
    setView(after);
    const f = { ...fightRef.current!, st: after };
    fightRef.current = f;
    setFight(f);
    if (after.winner !== undefined) await finish(after);
    return after;
  };

  const enemyTurn = async () => {
    setCaption(`${opp.name} is thinking…`);
    await sleep(500);
    let cur = fightRef.current!.st;
    const plan = planTurn(cur, 1, { careful: opp.careful }, dur);
    for (const a of plan) {
      if (!alive.current || cur.winner !== undefined) return;
      const uid = a.t === 'deploy' ? a.uid : a.t === 'attack' ? a.from : a.t === 'vent' ? a.uid : null;
      const name = uid ? model(cur.modelOf[uid]).name : '';
      setCaption(a.t === 'deploy' ? `${opp.name} deploys ${name}` : a.t === 'attack' ? `${name} attacks` : `${name} cools down`);
      cur = await runAction(a);
      await sleep(380);
    }
    if (!alive.current || cur.winner !== undefined) return;
    cur = await runAction({ t: 'end' });
    if (cur.winner !== undefined) return;
    setCaption('Your turn');
    setBusy(false);
  };

  const doAction = async (a: Action) => {
    if (busy) return;
    setMsg(null);
    setBusy(true);
    const after = await runAction(a);
    if (after.winner !== undefined || !alive.current) return;
    setBusy(false);
  };

  const endMyTurn = async () => {
    if (!myTurn) return;
    setSel(null);
    setHandSel(null);
    setDeploying(null);
    setBusy(true);
    const after = await runAction({ t: 'end' });
    if (after.winner !== undefined) return;
    await enemyTurn();
  };

  // Deploy: robots with Repair/Shock ask for a target if there is a choice
  const startDeploy = (uid: string): boolean => {
    if (!myTurn) return false;
    const md = model(st.modelOf[uid]);
    if (md.cost > st.sides[0].energy || st.sides[0].board.length >= BOARD_SLOTS) return false;
    const targets = deployTargets(st, 0, md.id);
    setHandSel(null);
    if (targets.length > 1) {
      setDeploying({ uid, targets });
      setCaption(md.ability?.kind === 'repair' ? `${md.name}: pick what to repair` : `${md.name}: pick an enemy to stun`);
      return true;
    }
    void doAction({ t: 'deploy', uid, target: targets[0] });
    return true;
  };
  dropRef.current = (uid, target) => (target === 'my-board' ? startDeploy(uid) : 'cancel');

  const pickDeployTarget = (match: (t: Target) => boolean) => {
    const t = deploying?.targets.find(match);
    if (!deploying || !t) return;
    const d = deploying;
    setDeploying(null);
    setCaption('Your turn');
    void doAction({ t: 'deploy', uid: d.uid, target: t });
  };

  const clickUnit = (side: number, uid: string) => {
    if (!myTurn) return;
    if (deploying) return pickDeployTarget((x) => !('core' in x) && x.uid === uid);
    if (side === 0) {
      const u = st.sides[0].board.find((x) => x.uid === uid);
      if (u?.ready) setSel(sel === uid ? null : uid);
      return;
    }
    if (sel && legal.has(uid)) {
      const from = sel;
      setSel(null);
      void doAction({ t: 'attack', from, to: uid });
    }
  };
  const clickCore = (side: number) => {
    if (!myTurn) return;
    if (deploying) return pickDeployTarget((x) => 'core' in x && x.side === side);
    if (side === 1 && sel && legal.has(coreKey(1))) {
      const from = sel;
      setSel(null);
      void doAction({ t: 'attack', from, to: 'core' });
    }
  };

  const floatsOf = (key: string) =>
    floats
      .filter((f) => f.key === key)
      .slice(-3)
      .map((f, i) => (
        <span key={f.id} className={`float ${f.kind}`} style={{ marginLeft: i * 22 }}>
          {f.text}
        </span>
      ));

  const renderCore = (side: number) => {
    const key = coreKey(side);
    const core = Math.max(0, v.sides[side].core);
    const targetable = legal.has(key) || deployKeys.has(key);
    return (
      <div
        data-unit={key}
        className={`core ${fx[key] ?? ''} ${targetable ? 'targetable' : ''}`}
        style={{ borderColor: side === 0 ? 'var(--cyan)' : 'var(--magenta)' }}
        onClick={() => clickCore(side)}
      >
        <div className="muted">{side === 0 ? 'You' : opp.name}</div>
        <b>
          <Glitch text={core} />
        </b>
        <div className="bar">
          <i
            style={{
              width: `${(core / CORE_HP) * 100}%`,
              background: core <= 6 ? 'var(--red)' : side === 0 ? 'var(--cyan)' : 'var(--magenta)',
            }}
          />
        </div>
        <small className="muted">Core{side === 1 ? ` · ✋${theirs.hand.length}` : ''}</small>
        {floatsOf(key)}
      </div>
    );
  };

  const renderBoard = (side: number) => {
    const sd = v.sides[side];
    const slots = Array.from({ length: BOARD_SLOTS }, (_, i) => sd.board[i]);
    const dropping = side === 0 && myTurn && (handSel || drag.dragging) && sd.board.length < BOARD_SLOTS;
    return (
      <div
        className={`board-row ${dropping ? 'can-drop' : ''} ${side === 0 && drag.over === 'my-board' ? 'drop-over' : ''}`}
        data-drop={side === 0 ? 'my-board' : undefined}
        onClick={() => {
          if (side === 0 && handSel && myTurn) startDeploy(handSel);
        }}
      >
        {slots.map((u, i) =>
          u ? (
            <div
              key={u.uid}
              data-unit={u.uid}
              data-drag-id={u.uid}
              className={[
                'unit',
                fx[u.uid] ?? '',
                u.offline ? 'offline' : '',
                side === 0 && myTurn && u.ready ? 'ready' : '',
                sel === u.uid ? 'selected-unit' : '',
                legal.has(u.uid) || deployKeys.has(u.uid) ? 'targetable' : '',
              ].join(' ')}
              onClick={(e) => {
                e.stopPropagation();
                clickUnit(side, u.uid);
              }}
            >
              {isGuard(u) && (
                <span className="guard-badge" title="Guard: enemies must attack it first">
                  🛡
                </span>
              )}
              {u.offline && <span className="offline-badge">OFFLINE</span>}
              <RobotCard modelId={u.modelId} hp={Math.max(0, u.hp)} />
              <HeatBar u={u} />
              {floatsOf(u.uid)}
            </div>
          ) : (
            <div key={`empty-${i}`} className="unit empty">
              <span className="muted">{dropping ? 'drop here' : ''}</span>
            </div>
          ),
        )}
      </div>
    );
  };

  const hint = deploying
    ? caption
    : !myTurn
      ? caption
      : selUnit
        ? `${model(selUnit.modelId).name}: pick a target`
        : handSel
          ? 'Click the board to deploy'
          : 'Deploy robots, then attack: click your robot → click a target';

  return (
    <div className="grid">
      <div className="panel arena2">
        <div className="battle-bar">
          <h2 style={{ margin: 0 }}>
            Turn {Math.max(st.sides[0].turns, 1)}/{MAX_TURNS}
          </h2>
          <span className="pips" title={`Energy: ${st.sides[0].energy}`}>
            {Array.from({ length: Math.min(6, st.sides[0].turns + 1) }, (_, i) => (
              <span key={i} className={i < st.sides[0].energy ? '' : 'off'}>
                ⚡
              </span>
            ))}
          </span>
          <div className="caption">{hint}</div>
          <button className="primary" disabled={!myTurn} onClick={endMyTurn}>
            End turn ▶
          </button>
        </div>
        {msg && <div className="error">{msg}</div>}

        <div className="field">
          <div className="side-line">
            {renderCore(1)}
            {renderBoard(1)}
          </div>
          <div className="mid-line" />
          <div className="side-line">
            {renderCore(0)}
            {renderBoard(0)}
          </div>
        </div>

        <div className="action-bar">
          {selUnit && myTurn && (
            <>
              <span>
                <b>{model(selUnit.modelId).name}</b> · heat {selUnit.heat}/{heatCap(selUnit.modelId)}
              </span>
              <button
                disabled={selUnit.heat === 0}
                onClick={() => {
                  const uid = selUnit.uid;
                  setSel(null);
                  void doAction({ t: 'vent', uid });
                }}
              >
                ❄ Cool down (−3 heat)
              </button>
              <button onClick={() => setSel(null)}>Cancel</button>
            </>
          )}
          {deploying && (
            <button
              onClick={() => {
                setDeploying(null);
                setCaption('Your turn');
              }}
            >
              Cancel deploy
            </button>
          )}
        </div>

        <div className="hand">
          {mine.hand.map((uid) => {
            const md = model(st.modelOf[uid]);
            const can = myTurn && md.cost <= st.sides[0].energy && st.sides[0].board.length < BOARD_SLOTS;
            const card = (
              <RobotCard
                modelId={md.id}
                durability={w.robots[uid]?.durability}
                selected={handSel === uid}
                className={can ? '' : 'dim'}
                onClick={can ? () => setHandSel(handSel === uid ? null : uid) : undefined}
              />
            );
            const h = drag.handle(uid, () => card, can);
            return (
              <div key={h.key} {...h.props}>
                {card}
              </div>
            );
          })}
          {mine.hand.length === 0 && <span className="muted">Hand is empty</span>}
        </div>
        {drag.ghost}
      </div>

      {st.history.length > 0 && (
        <details className="panel">
          <summary>Battle log</summary>
          <div className="round-log" style={{ marginTop: 8 }}>
            {st.history
              .map((e) => describe(e, st, names))
              .filter(Boolean)
              .slice(-60)
              .map((t, j) => (
                <div key={j} className={t!.startsWith('—') ? '' : 'muted'}>
                  {t}
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ResultPanel({
  w,
  st,
  oppName,
  durBefore,
  eloBefore,
  onClose,
}: {
  w: World;
  st: BattleState;
  oppName: string;
  durBefore: Record<string, number>;
  eloBefore: number;
  onClose: () => void;
}) {
  const me = getManager(w, PLAYER_ID);
  const res = st.winner === null ? 'Draw' : st.winner === 0 ? 'Victory!' : 'Defeat';
  const reward = st.winner === null ? ECON.rewardDraw : st.winner === 0 ? ECON.rewardWin : ECON.rewardLoss;
  const uids = Object.keys(durBefore);
  return (
    <div className="panel" style={{ borderColor: st.winner === 0 ? 'var(--green)' : 'var(--line)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          {res} <span className="muted">vs {oppName}</span>
        </h2>
        <button onClick={onClose}>Close</button>
      </div>
      <p>
        Core: {st.sides[0].core} : {st.sides[1].core} · Reward <span className="cr">+{reward} CR</span> · ELO {eloBefore} →{' '}
        <b>{me.elo}</b>
      </p>
      <h3>Robot wear</h3>
      <div className="row" style={{ gap: 18 }}>
        {uids.map((u) => {
          const loss = wearLoss(st, u);
          const before = durBefore[u];
          const now = w.robots[u]?.durability ?? 0;
          return (
            <div key={u} style={{ width: 130 }}>
              <b>{model(st.modelOf[u]).name}</b>
              <DurBar value={now} />
              <small className={loss ? 'down' : 'muted'}>
                {before} → {now} {loss ? `(−${loss})` : '(no loss)'}
                {st.wear[u]?.overheated ? ' 🔥' : ''}
              </small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
