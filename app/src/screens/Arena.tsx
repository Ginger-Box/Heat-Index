// Arena: the lobby (pick an opponent) and the battle screen «Overheat».
// Battle layout, top to bottom: the opponent (Core, hand, deck) → their 4 slots → the centre line → your 4 slots →
// your Core and hand. The right column holds the turn, energy, End turn and a short log.
// Controls: drag a card from the hand into a slot; drag an arrow from your robot to a target to attack
// (or click the robot, then the target). Repair/Shock robots ask for a target with a green/violet arrow.
// Effects (sparks, shockwaves, shake, aiming arrow) are in ui/battleFx.ts, sounds in audio.ts.

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { battleSynth, sfx } from '../audio';
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
import { battleReward } from '../engine/pricing';
import { CLASS_HELP, CLASS_ICON, CLASS_LABEL, maxDurability, model } from '../engine/robots';
import { teamError } from '../engine/team';
import {
  PLAYER_ID,
  STRATEGY_LABEL,
  applyMatch,
  getManager,
  pickOpponentForPlayer,
  sideTeamValues,
  teamOf,
  type World,
} from '../engine/world';
import { act } from '../store';
import { centerOf, createAim, flashScreen, ring, shake, sparks, type Aim, type AimKind } from '../ui/battleFx';
import { DurBar, Glitch, RobotCard } from '../ui/common';
import { useCardDrag } from '../ui/drag';
import { EnergyIcon } from '../ui/icons';

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
  size?: number;
}

interface AimState {
  aim: Aim;
  kind: AimKind;
  legal: Set<string>;
  sticky: boolean; // click mode: the arrow follows the cursor until the next click
  startX: number;
  startY: number;
  moved: boolean;
  hover: string | null;
  onPick: (key: string) => void;
  onCancel: () => void;
}

const coreKey = (side: number) => `core-${side}`;
const keyOf = (side: number, to: string | 'core') => (to === 'core' ? coreKey(side) : to);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unitEl = (key: string) => document.querySelector(`[data-unit="${CSS.escape(key)}"]`);

function describe(e: BattleEvent, st: BattleState, names: [string, string]): string | null {
  const nm = (uid: string) => model(st.modelOf[uid]).name;
  switch (e.t) {
    case 'turn':
      return `— ${names[e.side]}: turn ${e.turn} —`;
    case 'deploy':
      return `${names[e.side]} ${e.side === 0 ? 'deploy' : 'deploys'} ${nm(e.uid)}`;
    case 'attack':
      return e.to === 'core'
        ? `${nm(e.from)} hits the Core −${e.dmg}`
        : `${nm(e.from)} → ${nm(e.to)}: −${e.dmg}${e.counter ? `, takes −${e.counter} back` : ''}`;
    case 'vent':
      return `${nm(e.uid)} cools down (−${e.cooled} heat)`;
    case 'overheat':
      return `${nm(e.uid)} overheated — skips a turn`;
    case 'repair':
      return e.amount ? `${nm(e.from)} repairs ${e.target === 'core' ? 'the Core' : nm(e.target)} +${e.amount}` : null;
    case 'shock':
      return `${nm(e.from)} shocks ${nm(e.target)}`;
    case 'destroyed':
      return `${nm(e.uid)} destroyed`;
    case 'blast':
      return `${nm(e.from)} explodes: ${e.n} damage to every enemy robot`;
    case 'end':
      return e.winner === null ? 'Draw!' : `Winner: ${names[e.winner]}`;
    default:
      return null;
  }
}

/** Heat pips on a robot: how close it is to overheating. */
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
  const [handSel, setHandSel] = useState<string | null>(null);
  const [pending, setPending] = useState<{ uid: string; slot: number; targets: Target[] } | null>(null);
  const [aimLegal, setAimLegal] = useState<Set<string> | null>(null);
  const [aimFrom, setAimFrom] = useState<string | null>(null);
  const [aimKind, setAimKind] = useState<AimKind>('attack');
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState('');
  const [banner, setBanner] = useState<{ text: string; kind: string; id: number } | null>(null);
  const [drawn, setDrawn] = useState<string | null>(null);
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
  const tableRef = useRef<HTMLDivElement | null>(null);
  const aimRef = useRef<AimState | null>(null);
  const dragDeploy = useRef<string | null>(null);
  const dropRef = useRef<(uid: string, target: string | null) => boolean | 'cancel'>(() => 'cancel');
  const drag = useCardDrag((uid, target) => dropRef.current(uid, target));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      aimRef.current?.aim.destroy();
      aimRef.current = null;
    };
  }, []);

  // ---------- aiming: one set of global listeners drives the arrow ----------
  useEffect(() => {
    const hoverKey = (x: number, y: number) =>
      (document.elementFromPoint(x, y)?.closest('[data-unit]') as HTMLElement | null)?.dataset.unit ?? null;
    const setHover = (a: AimState, key: string | null) => {
      if (a.hover === key) return;
      if (a.hover) unitEl(a.hover)?.classList.remove('aim-hover');
      a.hover = key;
      if (key) {
        unitEl(key)?.classList.add('aim-hover');
        sfx('lock');
      }
    };
    const move = (e: PointerEvent) => {
      const a = aimRef.current;
      if (!a) return;
      if (Math.hypot(e.clientX - a.startX, e.clientY - a.startY) > 6) a.moved = true;
      const k = hoverKey(e.clientX, e.clientY);
      const legal = k && a.legal.has(k) ? k : null;
      setHover(a, legal);
      const el = legal ? unitEl(legal) : null;
      if (el) {
        const c = centerOf(el);
        a.aim.move(c.x, c.y, true);
      } else a.aim.move(e.clientX, e.clientY, false);
    };
    const finish = (a: AimState, pick: string | null) => {
      setHover(a, null);
      a.aim.destroy();
      aimRef.current = null;
      setAimLegal(null);
      setAimFrom(null);
      if (pick) a.onPick(pick);
      else a.onCancel();
    };
    const up = (e: PointerEvent) => {
      const a = aimRef.current;
      if (!a || a.sticky) return;
      if (!a.moved) {
        a.sticky = true; // it was a click: keep aiming until the next click
        return;
      }
      const k = hoverKey(e.clientX, e.clientY);
      finish(a, k && a.legal.has(k) ? k : null);
    };
    const down = (e: PointerEvent) => {
      const a = aimRef.current;
      if (!a || !a.sticky) return;
      e.stopPropagation();
      e.preventDefault();
      const k = hoverKey(e.clientX, e.clientY);
      finish(a, e.button === 0 && k && a.legal.has(k) ? k : null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && aimRef.current) finish(aimRef.current, null);
    };
    const ctx = (e: MouseEvent) => {
      if (!aimRef.current) return;
      e.preventDefault();
      finish(aimRef.current, null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('contextmenu', ctx);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('contextmenu', ctx);
    };
  }, []);

  // (the effect lives above the lobby's early return; the function it calls is set in the battle part)
  const startPendingAim = useRef<() => void>(() => {});
  useEffect(() => {
    if (!pending) return;
    const id = requestAnimationFrame(() => startPendingAim.current());
    return () => cancelAnimationFrame(id);
  }, [pending]);

  const beginAim = (
    from: Element,
    fromKey: string,
    kind: AimKind,
    legal: Set<string>,
    o: { sticky: boolean; x: number; y: number; onPick: (k: string) => void; onCancel?: () => void },
  ) => {
    aimRef.current?.aim.destroy();
    const c = centerOf(from);
    const aim = createAim(kind, c.x, c.y);
    aim.move(o.x, o.y, false);
    aimRef.current = {
      aim,
      kind,
      legal,
      sticky: o.sticky,
      startX: o.x,
      startY: o.y,
      moved: false,
      hover: null,
      onPick: o.onPick,
      onCancel: o.onCancel ?? (() => {}),
    };
    setAimLegal(legal);
    setAimFrom(fromKey);
    setAimKind(kind);
    battleSynth('aim');
  };

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
                    setHandSel(null);
                    setPending(null);
                    setFloats([]);
                    setFx({});
                    setBanner({ text: 'YOUR TURN', kind: 'mine', id: Date.now() });
                    sfx('turn-start');
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
              <li>
                Drag robots from your hand into a slot (they cost energy), then drag an arrow from a robot to a target.
                The target strikes back.
              </li>
              <li>
                Every attack heats a robot up. At its limit it <b>overheats</b>: skips your next turn and wears out more.
                Instead of attacking you can cool it down (❄ on the robot).
              </li>
              <li>🛡 Armor robots are guards — hit them first. 💨 Maneuver robots ignore guards.</li>
              <li>Wear costs money: every robot that fought −1, destroyed −1 more, overheated −1 more.</li>
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
  const dur = Object.fromEntries(Object.entries(w.robots).map(([u, r]) => [u, r.durability]));
  const pendingKeys = new Set(pending ? pending.targets.map((t) => ('core' in t ? coreKey(t.side) : t.uid)) : []);
  const isTarget = (k: string) => !!aimLegal?.has(k) || pendingKeys.has(k);

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
  const showBanner = (text: string, kind: string) => setBanner({ text, kind, id: ++fid.current });

  /** Lunge of the attacker toward its target (Web Animations, in place). */
  const lunge = (fromUid: string, toKey: string, power: number) => {
    const a = unitEl(fromUid)?.querySelector('.card') as HTMLElement | null;
    const b = unitEl(toKey);
    if (!a || !b) return;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const s = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const dx = ((rb.left + rb.width / 2 - (ra.left + ra.width / 2)) * 0.7) / s;
    const dy = ((rb.top + rb.height / 2 - (ra.top + ra.height / 2)) * 0.7) / s;
    a.animate(
      [
        { transform: 'none', zIndex: 30 },
        { transform: `translate(${-dx * 0.08}px, ${-dy * 0.08}px) scale(1.04)`, offset: 0.25, zIndex: 30 },
        { transform: `translate(${dx}px, ${dy}px) scale(${1.1 + power * 0.08}) rotate(${dx > 0 ? 3 : -3}deg)`, offset: 0.5, zIndex: 30 },
        { transform: 'none', zIndex: 30 },
      ],
      { duration: 460, easing: 'cubic-bezier(.3,.7,.4,1)' },
    );
  };

  /** A newly deployed robot drops into its slot (when it didn't arrive by drag). */
  const dropIn = (uid: string, side: number) =>
    requestAnimationFrame(() => {
      const c = unitEl(uid)?.querySelector('.card') as HTMLElement | null;
      if (!c) return;
      c.animate(
        [
          { transform: `translateY(${side === 1 ? -70 : 70}px) scale(0.6)`, opacity: 0, filter: 'brightness(2.5)' },
          { transform: 'translateY(0) scale(1.06)', opacity: 1, offset: 0.7 },
          { transform: 'none', filter: 'none' },
        ],
        { duration: 340, easing: 'cubic-bezier(.2,.8,.3,1)' },
      );
    });

  /** Sparks + sound + shake for a hit on `key` with `dmg` damage. */
  const impact = (key: string, dmg: number, opts: { core?: boolean; shockHit?: boolean } = {}) => {
    const el = unitEl(key);
    if (!el) return;
    const c = centerOf(el);
    if (dmg <= 0) {
      sparks(c.x, c.y, 1, { kind: 'zap' });
      sfx('block');
      return;
    }
    sparks(c.x, c.y, dmg, { core: opts.core });
    if (opts.shockHit) {
      sparks(c.x, c.y, 3, { kind: 'zap' });
      sfx('shock-hit');
    }
    if (opts.core) {
      ring(c.x, c.y, 120 + dmg * 26, dmg >= 6 ? '#ff3b4e' : '#ffe600');
      shake(tableRef.current, 3 + dmg * 1.4);
      flashScreen(dmg >= 5 ? dmg * 0.03 : 0);
      sfx('core-hit', { volume: 0.6 + Math.min(1, dmg / 8) * 0.6 });
      battleSynth('thump', Math.min(1, dmg / 10));
    } else {
      sfx(dmg >= 5 ? 'hit-heavy' : dmg >= 3 ? 'hit' : 'hit-light');
      if (dmg >= 4) {
        shake(tableRef.current, dmg * 0.7);
        battleSynth('thump', Math.min(1, dmg / 12));
      }
    }
  };

  const finish = async (final: BattleState) => {
    const text = final.winner === null ? 'DRAW' : final.winner === 0 ? 'VICTORY' : 'DEFEAT';
    setCaption(final.winner === null ? 'Draw!' : final.winner === 0 ? 'Victory!' : 'Defeat');
    showBanner(text, final.winner === 0 ? 'win' : 'lose');
    sfx(final.winner === 0 ? 'victory' : 'defeat');
    await sleep(1900);
    if (!alive.current) return;
    const f = fightRef.current!;
    act((w) => applyMatch(w, PLAYER_ID, f.oppId, final));
    setResult({ st: final, oppName: opp.name, durBefore: f.durBefore, eloBefore: f.eloBefore });
    setFight(null);
    setView(null);
    setBusy(false);
    setBanner(null);
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
        if (old && !withDying.sides[e.side].board.some((u) => u.uid === e.uid))
          withDying.sides[e.side].board.push({ ...old, hp: 0 });
      }

    const attack = ev.find((e) => e.t === 'attack') as Extract<BattleEvent, { t: 'attack' }> | undefined;
    if (attack) {
      const tk = keyOf(1 - side, attack.to);
      const power = Math.min(1, attack.dmg / 8);
      // the opponent's attacks are announced with a red arrow first, so you see who hits whom
      if (side === 1) {
        const from = unitEl(attack.from);
        const to = unitEl(tk);
        if (from && to) {
          const c0 = centerOf(from);
          const c1 = centerOf(to);
          const aim = createAim('attack', c0.x, c0.y);
          const t0 = performance.now();
          await new Promise<void>((res) => {
            let done = false;
            const end = () => {
              if (done) return;
              done = true;
              aim.move(c1.x, c1.y, true);
              res();
            };
            const tick = () => {
              if (done) return;
              const k = Math.min(1, (performance.now() - t0) / 260);
              const e = 1 - (1 - k) ** 3;
              aim.move(c0.x + (c1.x - c0.x) * e, c0.y + (c1.y - c0.y) * e, k >= 1);
              if (k < 1) requestAnimationFrame(tick);
              else end();
            };
            requestAnimationFrame(tick);
            setTimeout(end, 300); // rAF stops in a background tab — never let the enemy turn hang on it
          });
          sfx('lock');
          await sleep(260);
          aim.destroy();
        }
      }
      lunge(attack.from, tk, power);
      battleSynth('whoosh', power);
      await sleep(230);
      setView(withDying);
      const shockHit = model(before.modelOf[attack.from]).ability?.kind === 'shock' && attack.to !== 'core';
      impact(tk, attack.dmg, { core: attack.to === 'core', shockHit });
      const size = (d: number) => Math.min(46, 18 + d * 3);
      const fl: Omit<Float, 'id'>[] = [
        attack.dmg > 0
          ? { key: tk, text: `−${attack.dmg}`, kind: 'dmg', size: size(attack.dmg) }
          : { key: tk, text: 'BLOCK', kind: 'block' },
      ];
      if (attack.counter > 0) fl.push({ key: attack.from, text: `−${attack.counter}`, kind: 'dmg', size: size(attack.counter) });
      const hurt: Record<string, string> = {};
      if (attack.dmg > 0) hurt[tk] = attack.to === 'core' && attack.dmg >= 5 ? 'fx-hurt-big' : 'fx-hurt';
      if (attack.counter > 0) hurt[attack.from] = 'fx-hurt';
      flash(hurt, 520);
      addFloats(fl);
      if (attack.counter > 0)
        setTimeout(() => {
          const el = unitEl(attack.from);
          if (el) {
            const c = centerOf(el);
            sparks(c.x, c.y, attack.counter);
          }
          sfx(attack.counter >= 3 ? 'hit' : 'hit-light', { volume: 0.7 });
        }, 90);
    } else setView(withDying);

    for (const e of ev) {
      if (e.t === 'deploy') {
        if (dragDeploy.current !== e.uid) dropIn(e.uid, e.side);
        dragDeploy.current = null;
        flash({ [e.uid]: 'fx-pop' }, 450);
        sfx('b-deploy', { volume: e.side === 0 ? 1 : 0.75 });
      } else if (e.t === 'repair' && e.amount) {
        const k = e.target === 'core' ? coreKey(e.side) : e.target;
        addFloats([{ key: k, text: `+${e.amount}`, kind: 'heal', size: 18 + e.amount * 2 }]);
        flash({ [k]: 'fx-heal' }, 800);
        battleSynth('weld');
        sfx('repair', { volume: 0.45 });
        requestAnimationFrame(() => {
          const el = unitEl(k);
          if (el) {
            const c = centerOf(el);
            sparks(c.x, c.y, 2 + e.amount, { kind: 'heal' });
          }
        });
      } else if (e.t === 'shock') {
        flash({ [e.from]: 'fx-zap', [e.target]: 'fx-hurt' }, 600);
        addFloats([{ key: e.target, text: 'STUNNED', kind: 'block' }]);
        sfx('shock');
        requestAnimationFrame(() => {
          const el = unitEl(e.target);
          if (el) {
            const c = centerOf(el);
            sparks(c.x, c.y, 5, { kind: 'zap' });
          }
        });
      } else if (e.t === 'vent') {
        addFloats([{ key: e.uid, text: `❄ −${e.cooled}`, kind: 'cool' }]);
        flash({ [e.uid]: 'fx-cool' }, 800);
        battleSynth('steam');
      } else if (e.t === 'overheat') {
        addFloats([{ key: e.uid, text: 'OVERHEAT', kind: 'heat' }]);
        flash({ [e.uid]: 'fx-overheat' }, 900);
        battleSynth('alarm');
      } else if (e.t === 'turn') {
        showBanner(e.side === 0 ? 'YOUR TURN' : `${opp.name.toUpperCase()}'S TURN`, e.side === 0 ? 'mine' : 'theirs');
        sfx('turn-start', { volume: e.side === 0 ? 1 : 0.5 });
      } else if (e.t === 'draw' && e.side === 0) {
        setDrawn(e.uid);
        setTimeout(() => setDrawn((d) => (d === e.uid ? null : d)), 700);
        sfx('draw', { delay: 0.25 });
      }
    }
    const deaths = ev.filter((e) => e.t === 'destroyed') as Extract<BattleEvent, { t: 'destroyed' }>[];
    const blasts = ev.filter((e) => e.t === 'blast') as Extract<BattleEvent, { t: 'blast' }>[];
    if (deaths.length) {
      await sleep(attack ? 280 : 120);
      flash(Object.fromEntries(deaths.map((d) => [d.uid, 'fx-dying'])), 700);
      sfx('destroy');
      for (const d of deaths) {
        const el = unitEl(d.uid);
        if (el) {
          const c = centerOf(el);
          sparks(c.x, c.y, 6);
        }
      }
      for (const b of blasts) {
        const el = unitEl(b.from);
        if (el) {
          const c = centerOf(el);
          ring(c.x, c.y, 260, '#ff8a00');
          sparks(c.x, c.y, 10);
        }
        shake(tableRef.current, 6 + b.n * 2);
        battleSynth('thump', 0.8);
        addFloats(b.hits.map((h) => ({ key: h.uid, text: `−${h.dmg}`, kind: 'dmg' as const, size: 18 + h.dmg * 3 })));
        flash(Object.fromEntries(b.hits.map((h) => [h.uid, 'fx-hurt'])), 500);
        for (const h of b.hits) {
          const he = unitEl(h.uid);
          if (he) {
            const c = centerOf(he);
            sparks(c.x, c.y, h.dmg);
          }
        }
        sfx('blast');
      }
      await sleep(640);
    } else if (attack) await sleep(280);
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
    await sleep(700);
    let cur = fightRef.current!.st;
    const plan = planTurn(cur, 1, { careful: opp.careful }, dur);
    for (const a of plan) {
      if (!alive.current || cur.winner !== undefined) return;
      const uid = a.t === 'deploy' ? a.uid : a.t === 'attack' ? a.from : a.t === 'vent' ? a.uid : null;
      const name = uid ? model(cur.modelOf[uid]).name : '';
      setCaption(a.t === 'deploy' ? `${opp.name} deploys ${name}` : a.t === 'attack' ? `${name} attacks` : `${name} cools down`);
      cur = await runAction(a);
      await sleep(420);
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
    sfx('end-turn');
    setHandSel(null);
    setPending(null);
    setBusy(true);
    const after = await runAction({ t: 'end' });
    if (after.winner !== undefined) return;
    await enemyTurn();
  };

  const freeSlot = (i: number) => !st.sides[0].board.some((u) => u.pos === i);

  /** Deploy into a slot. Repair/Shock robots with a choice of targets wait in the slot for an arrow. */
  const startDeploy = (uid: string, slot: number, viaDrag: boolean): boolean => {
    if (!myTurn || pending) return false;
    const md = model(st.modelOf[uid]);
    if (md.cost > st.sides[0].energy) {
      setMsg('Not enough energy');
      sfx('ui-error');
      return false;
    }
    if (!freeSlot(slot)) return false;
    const targets = deployTargets(st, 0, md.id);
    setHandSel(null);
    if (targets.length > 1) {
      setPending({ uid, slot, targets });
      setCaption(md.ability?.kind === 'repair' ? `${md.name}: drag to what to repair` : `${md.name}: pick an enemy to stun`);
      return true;
    }
    if (viaDrag) dragDeploy.current = uid;
    void doAction({ t: 'deploy', uid, target: targets[0], slot });
    return true;
  };
  dropRef.current = (uid, target) =>
    target?.startsWith('slot-') ? startDeploy(uid, Number(target.slice(5)), true) || false : 'cancel';

  // a robot waiting in its slot for a Repair/Shock target: start the arrow from it
  startPendingAim.current = () => {
    if (!pending) return;
    {
      const el = unitEl(`pending-${pending.uid}`);
      if (!el) return;
      const kind: AimKind = model(st.modelOf[pending.uid]).ability?.kind === 'repair' ? 'repair' : 'shock';
      const c = centerOf(el);
      const legal = new Set(pending.targets.map((t) => ('core' in t ? coreKey(t.side) : t.uid)));
      const p = pending;
      beginAim(el, `pending-${p.uid}`, kind, legal, {
        sticky: true,
        x: c.x,
        y: c.y - 60,
        onPick: (k) => {
          const t = p.targets.find((x) => ('core' in x ? coreKey(x.side) : x.uid) === k);
          setPending(null);
          setCaption('Your turn');
          dragDeploy.current = p.uid;
          void doAction({ t: 'deploy', uid: p.uid, target: t, slot: p.slot });
        },
        onCancel: () => {
          setPending(null);
          setCaption('Your turn');
          sfx('card-pick', { volume: 0.6 });
        },
      });
    }
  };

  const startAttackAim = (e: RPointerEvent<HTMLDivElement>, u: Unit) => {
    if (!myTurn || pending || e.button !== 0) return;
    if (!u.ready) {
      setMsg(u.offline ? 'Overheated — this robot skips the turn' : 'This robot has already acted');
      sfx('ui-error');
      return;
    }
    e.preventDefault();
    setMsg(null);
    const legal = new Set(attackTargets(st, 0, u).map((t) => keyOf(1, t)));
    beginAim(e.currentTarget, u.uid, 'attack', legal, {
      sticky: false,
      x: e.clientX,
      y: e.clientY,
      onPick: (k) => void doAction({ t: 'attack', from: u.uid, to: k === coreKey(1) ? 'core' : k }),
    });
  };

  const floatsOf = (key: string) =>
    floats
      .filter((f) => f.key === key)
      .slice(-3)
      .map((f, i) => (
        <span key={f.id} className={`float ${f.kind}`} style={{ marginLeft: i * 22, fontSize: f.size }}>
          {f.text}
        </span>
      ));

  const renderCore = (side: number) => {
    const key = coreKey(side);
    const core = Math.max(0, v.sides[side].core);
    const low = core <= 6;
    return (
      <div
        data-unit={key}
        className={`b-core side-${side} ${fx[key] ?? ''} ${isTarget(key) ? 'targetable' : ''} ${low ? 'low' : ''}`}
      >
        <div className="b-core-ring" style={{ ['--f' as string]: core / CORE_HP }}>
          <b>
            <Glitch text={core} />
          </b>
        </div>
        <div className="b-core-label">
          <span>{side === 0 ? 'YOUR CORE' : 'ENEMY CORE'}</span>
          <small>
            {core}/{CORE_HP}
          </small>
        </div>
        {floatsOf(key)}
      </div>
    );
  };

  const renderBoard = (side: number) => {
    const sd = v.sides[side];
    const canDrop = side === 0 && myTurn && !pending && (handSel || drag.dragging);
    return (
      <div className={`b-board side-${side}`}>
        {Array.from({ length: BOARD_SLOTS }, (_, i) => {
          const u = sd.board.find((x) => x.pos === i);
          if (side === 0 && pending && pending.slot === i) {
            return (
              <div key={`slot-${i}`} className="b-slot filled">
                <div className="b-unit pending" data-unit={`pending-${pending.uid}`} data-drag-id={pending.uid}>
                  <RobotCard modelId={st.modelOf[pending.uid]} token />
                </div>
              </div>
            );
          }
          if (!u) {
            // always a drop target on your turn (even a very fast drag lands); highlighted while a card is held
            const droppable = side === 0 && myTurn && !pending && freeSlot(i);
            const open = canDrop && droppable;
            return (
              <div
                key={`slot-${i}`}
                className={`b-slot empty ${open ? 'open' : ''} ${side === 0 && drag.over === `slot-${i}` ? 'over' : ''}`}
                data-drop={droppable ? `slot-${i}` : undefined}
                onClick={() => {
                  if (open && handSel) startDeploy(handSel, i, false);
                }}
              >
                <span className="b-slot-n">{i + 1}</span>
              </div>
            );
          }
          const canAct = side === 0 && myTurn && u.ready && !pending;
          return (
            <div key={`slot-${i}`} className="b-slot filled">
              <div
                data-unit={u.uid}
                data-drag-id={u.uid}
                className={[
                  'b-unit',
                  fx[u.uid] ?? '',
                  u.offline ? 'offline' : '',
                  canAct ? 'ready' : '',
                  aimFrom === u.uid ? 'aiming' : '',
                  isTarget(u.uid) ? 'targetable' : '',
                  isGuard(u) ? 'guard' : '',
                ].join(' ')}
                onPointerDown={side === 0 ? (e) => startAttackAim(e, u) : undefined}
              >
                <RobotCard modelId={u.modelId} hp={Math.max(0, u.hp)} token atkBonus={u.chargeBonus} />
                <HeatBar u={u} />
                {isGuard(u) && (
                  <span className="b-badge guard" title="Guard: enemies must attack it first">
                    GUARD
                  </span>
                )}
                {u.offline && <span className="b-badge offline">OFFLINE</span>}
                {canAct && u.heat > 0 && (
                  <button
                    className="b-vent"
                    data-sfx="none"
                    title="Cool down: −3 heat instead of attacking"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => void doAction({ t: 'vent', uid: u.uid })}
                  >
                    ❄
                  </button>
                )}
                {floatsOf(u.uid)}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const hint = pending
    ? caption
    : !myTurn
      ? caption
      : handSel
        ? 'Click a free slot to deploy'
        : 'Drag robots into slots · drag from a robot to a target to attack';
  const maxEnergy = Math.min(6, st.sides[0].turns + 1);
  const log = st.history
    .map((e) => describe(e, st, names))
    .filter(Boolean)
    .slice(-7) as string[];

  return (
    <div className="grid">
      <div className={`panel arena3 aim-${aimKind} ${myTurn ? 'my-turn' : ''}`} ref={tableRef}>
        <div className="b-table">
          {/* opponent */}
          <div className="b-top">
            {renderCore(1)}
            <div className="b-opp">
              <b>{opp.name}</b>
              <small className="muted">
                ELO {opp.elo}
                {opp.focus ? ` · ${CLASS_LABEL[opp.focus]}` : ''}
              </small>
            </div>
            <div className="b-backs" title={`${theirs.hand.length} cards in hand`}>
              {theirs.hand.map((uid, i) => (
                <i key={uid} style={{ ['--i' as string]: i - (theirs.hand.length - 1) / 2 }} />
              ))}
            </div>
            <div className="b-deck" title="Cards left in deck">
              DECK <b>{theirs.deck.length}</b>
            </div>
          </div>

          {renderBoard(1)}
          <div className="b-mid">
            <span className="b-mid-line" />
          </div>
          {renderBoard(0)}

          {/* you */}
          <div className="b-bottom">
            {renderCore(0)}
            <div className="b-hand">
              {mine.hand
                .filter((uid) => uid !== pending?.uid)
                .map((uid, i, arr) => {
                  const md = model(st.modelOf[uid]);
                  const can = myTurn && !pending && md.cost <= st.sides[0].energy && st.sides[0].board.length < BOARD_SLOTS;
                  const card = (
                    <RobotCard
                      modelId={md.id}
                      durability={w.robots[uid]?.durability}
                      selected={handSel === uid}
                      className={can ? 'playable' : 'dim'}
                      onClick={can ? () => setHandSel(handSel === uid ? null : uid) : undefined}
                    />
                  );
                  const h = drag.handle(uid, () => card, can);
                  const off = i - (arr.length - 1) / 2;
                  return (
                    <div
                      key={h.key}
                      {...h.props}
                      className={`${h.props.className} b-hand-card ${drawn === uid ? 'drawn' : ''}`}
                      style={{ ['--off' as string]: off }}
                    >
                      {card}
                    </div>
                  );
                })}
              {mine.hand.length === 0 && <span className="muted">Hand is empty</span>}
            </div>
            <div className="b-deck" title="Cards left in your deck">
              DECK <b>{mine.deck.length}</b>
            </div>
          </div>

          {banner && (
            <div key={banner.id} className={`b-banner ${banner.kind}`}>
              {banner.text}
            </div>
          )}
        </div>

        {/* right column */}
        <div className="b-side">
          <div className="b-turn">
            TURN <b>{Math.max(st.sides[0].turns, 1)}</b>/{MAX_TURNS}
          </div>
          <div className="b-energy" title={`Energy ${st.sides[0].energy}/${maxEnergy}`}>
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className={i < st.sides[0].energy ? 'on' : i < maxEnergy ? 'spent' : 'locked'}>
                <EnergyIcon />
              </span>
            ))}
            <b>
              {st.sides[0].energy}/{maxEnergy}
            </b>
          </div>
          <button className="primary b-end" data-sfx="none" disabled={!myTurn || !!pending} onClick={endMyTurn}>
            END TURN
          </button>
          <div className="b-caption">{hint}</div>
          {msg && <div className="error b-msg">{msg}</div>}
          <div className="b-log">
            {log.map((t, j) => (
              <div key={`${st.history.length}-${j}`} className={t.startsWith('—') ? 'turn' : ''} style={{ opacity: 0.4 + (j / log.length) * 0.6 }}>
                {t}
              </div>
            ))}
          </div>
        </div>
        {drag.ghost}
      </div>
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
  const values = sideTeamValues(st);
  const reward = battleReward(values[0], values[1], st.winner === null ? 0.5 : st.winner === 0 ? 1 : 0);
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
              <DurBar value={now} max={maxDurability(st.modelOf[u])} />
              <small className={loss ? 'down' : 'muted'}>
                {before} → {now} {loss ? `(−${loss})` : '(no loss)'}
                {st.wear[u]?.overheated ? ' · overheated' : ''}
              </small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
