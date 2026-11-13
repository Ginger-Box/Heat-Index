import { VET_NAME, vetPerks, vetRank, vetStars, winsToNext, type VetRecord } from '../engine/veteran';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { sfx } from '../audio';
import { AttackIcon, EnergyIcon, HpIcon } from './icons';
import { RobotSprite } from './robotArt';
import { ABILITY_HELP, ABILITY_LABEL, CLASS_HELP, CLASS_ICON, CLASS_LABEL, abilityHasN, classOf, maxDurability, model } from '../engine/robots';

// Card frame colour by energy cost (a placeholder until card art)
export const COST_COLOR = ['#8a8fbf', '#9aa3c7', '#3bff9a', '#22e3ff', '#a66bff', '#ff2bd6', '#f7f33b'];


export function durColor(d: number, max = 10) {
  const f = d / max;
  return d <= 0 ? '#555' : f <= 0.3 ? 'var(--red)' : f <= 0.6 ? 'var(--yellow)' : 'var(--green)';
}

export function DurBar({ value, max = 10 }: { value: number; max?: number }) {
  return (
    <div className="dur" title={`Durability ${value}/${max}`}>
      <i style={{ width: `${(Math.max(0, value) / max) * 100}%`, background: durColor(value, max) }} />
    </div>
  );
}

export function RobotCard(props: {
  modelId: string;
  durability?: number;
  hp?: number; // current HP in battle
  selected?: boolean;
  onClick?: () => void;
  footer?: ReactNode;
  badge?: ReactNode;
  className?: string;
  /** compact board token: big sprite, name, attack/HP badges (the full card text stays in the hover tip) */
  token?: boolean;
  /** attack bonus shown on the token (Charge on its deploy turn) */
  atkBonus?: number;
  /** battle record — veterans show their stars */
  vet?: VetRecord;
}) {
  const rank = vetRank(props);
  const md = model(props.modelId);
  const broken = props.durability !== undefined && props.durability <= 0;
  const ab = md.ability;
  const [tip, setTip] = useState<{ below: boolean; shift: number }>({ below: false, shift: 0 });
  /** Before showing the tooltip, check there is room for it; if not, open it below or shift it inside the screen. */
  const placeTip = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.currentTarget.closest('.card-peek')) return; // in the Market preview the tooltip is always on the right
    const box = e.currentTarget.querySelector('.cardtip') as HTMLElement | null;
    if (!box) return;
    const s = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const c = e.currentTarget.getBoundingClientRect();
    const tw = box.offsetWidth * s;
    const th = box.offsetHeight * s;
    const gap = 14 * s;
    const below = c.top < th + gap && window.innerHeight - c.bottom > c.top;
    const left = c.left + c.width / 2 - tw / 2;
    const shift = left < 8 ? 8 - left : left + tw > window.innerWidth - 8 ? window.innerWidth - 8 - (left + tw) : 0;
    if (below !== tip.below || Math.abs(shift / s - tip.shift) > 1) setTip({ below, shift: shift / s });
  };
  return (
    <div
      className={`card ${props.token ? 'token' : ''} ${props.onClick ? 'clickable' : ''} ${props.selected ? 'selected' : ''} ${broken ? 'broken' : ''} ${tip.below ? 'tip-below' : ''} ${props.className ?? ''}`}
      style={{ ['--c' as string]: COST_COLOR[md.cost], ['--tip-shift' as string]: `${tip.shift}px` }}
      onClick={props.onClick}
      onMouseEnter={placeTip}
    >
      <div className="cardtip">
        <div className="tt-name">{md.name}</div>
        <div className="tt-stats">
          <span className="cr">
            <EnergyIcon /> {md.cost} energy
          </span>{' '}
          <span className="atk">
            <AttackIcon /> {md.atk} attack
          </span>{' '}
          <span className="hp">
            <HpIcon /> {md.hp} HP
          </span>
        </div>
        {ab ? (
          <div>
            <b style={{ color: 'var(--cyan)' }}>
              {CLASS_ICON[ab.kind]} {ABILITY_LABEL[ab.kind]}
              {abilityHasN(ab.kind) ? ` ${ab.n}` : ''}
            </b>
            <div>{ABILITY_HELP[ab.kind].replace('N', String(ab.n))}</div>
          </div>
        ) : (
          <div>
            <b style={{ color: 'var(--cyan)' }}>🤖 Basic</b>
            <div>No ability — just hits whoever stands across.</div>
          </div>
        )}
        <div className="muted" style={{ marginTop: 6 }}>
          {CLASS_LABEL[classOf(md.id)]} class: {CLASS_HELP[classOf(md.id)]}
        </div>
        {props.vet && (
          <div className="tt-vet" style={{ marginTop: 6 }}>
            <b className={`vet-r${rank}`}>
              {rank ? `${vetStars(rank)} ${VET_NAME[rank]}` : 'Rookie'}
            </b>{' '}
            · {props.vet.w} wins in {props.vet.b} battles
            {winsToNext(props) !== null ? ` · ${winsToNext(props)} more to ${VET_NAME[rank + 1]}` : ''}
            <div className="muted">{rank ? vetPerks(rank) : 'Wins make a veteran: brokers pay more, Elite and Legend get extra HP.'}</div>
          </div>
        )}
        {props.durability !== undefined && (
          <div className="muted" style={{ marginTop: 6 }}>
            Durability {props.durability}/{maxDurability(md.id)}: every battle −1, destroyed or overheated −1 more.
          </div>
        )}
      </div>
      {rank > 0 && (
        <div className={`vet-stars vet-r${rank}`} title={VET_NAME[rank]}>
          {vetStars(rank)}
        </div>
      )}
      {props.token ? (
        <>
          <div className="art">
            <RobotSprite modelId={md.id} size={76} />
          </div>
          <div className="name">{md.name}</div>
          <div className="tok-stats">
            <span className={`tok atk ${props.atkBonus ? 'buffed' : ''}`}>
              <AttackIcon /> {md.atk + (props.atkBonus ?? 0)}
            </span>
            <span className={`tok hp ${props.hp !== undefined && props.hp < md.hp ? 'hurt' : ''}`}>
              <HpIcon /> {props.hp ?? md.hp}
            </span>
          </div>
        </>
      ) : (
        <CardBody {...props} />
      )}
    </div>
  );
}

function CardBody(props: { modelId: string; durability?: number; hp?: number; footer?: ReactNode; badge?: ReactNode }) {
  const md = model(props.modelId);
  const ab = md.ability;
  return (
    <>
      <div className="cost">{md.cost}</div>
      {props.badge && <div style={{ position: 'absolute', top: 4, right: 6, fontSize: 12 }}>{props.badge}</div>}
      <div className="art">
        <RobotSprite modelId={md.id} />
      </div>
      <div className="name">{md.name}</div>
      <div className="ability">{ab ? `${ABILITY_LABEL[ab.kind]}${abilityHasN(ab.kind) ? ' ' + ab.n : ''}` : 'Basic'}</div>
      <div className="stats">
        <span className="atk">
          <AttackIcon /> {md.atk}
        </span>
        <span className="hp">
          <HpIcon /> {props.hp ?? md.hp}
          {props.hp !== undefined && props.hp < md.hp ? <small className="muted">/{md.hp}</small> : null}
        </span>
      </div>
      {props.durability !== undefined && <DurBar value={props.durability} max={maxDurability(md.id)} />}
      {props.footer}
    </>
  );
}

export function Tip({ children, text }: { children: ReactNode; text: ReactNode }) {
  return (
    <span className="tip">
      {children}
      <span className="tipbox">{text}</span>
    </span>
  );
}

/** Class tag: icon + name. */
export function ClassTag({ modelId, cls }: { modelId?: string; cls?: import('../engine/robots').RobotClass }) {
  const c = cls ?? classOf(modelId!);
  return (
    <span className="tag" title={CLASS_HELP[c]}>
      {CLASS_ICON[c]} {CLASS_LABEL[c]}
    </span>
  );
}

const GLYPHS = '#$%&@!?/\\<>[]{}=+*^~01';

/**
 * A value with a glitch effect: when the text changes, the characters turn into noise for ~0.3 s,
 * the picture splits into cyan and magenta, then the new value appears from left to right.
 * The noise is drawn over the "invisible" new value, so the element's width and height
 * don't jump — tables and rows don't twitch.
 */
export function Glitch({
  text,
  className,
  volume = 0,
}: {
  text: string | number;
  className?: string;
  /** glitch sound volume (0 — silent; by default only the player's credits make a sound) */
  volume?: number;
}) {
  const value = String(text);
  const root = useRef<HTMLSpanElement | null>(null);
  const live = useRef<HTMLSpanElement | null>(null);
  const prev = useRef(value);
  // The noise is drawn directly in the DOM (no React re-renders) — otherwise, when many prices update at once,
  // hundreds of re-renders per second clog the main thread and the cursor starts to lag.
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    const el = root.current;
    const lv = live.current;
    if (!el || !lv) return;
    if (volume > 0) sfx('glitch', { volume });
    const FRAMES = 9;
    let frame = 0;
    const scramble = (reveal: number) =>
      [...value]
        .map((ch, i) => (i < reveal || ch === ' ' ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
        .join('');
    const paint = (t: string) => {
      lv.textContent = t;
      el.setAttribute('data-text', t);
    };
    // the "on" state is an attribute React does not manage, so a re-render can't switch the effect off mid-way;
    // removing it first + a reflow restarts the CSS animations when a new change arrives during a glitch
    el.removeAttribute('data-on');
    void el.offsetWidth;
    el.setAttribute('data-on', '');
    paint(scramble(0));
    const id = setInterval(() => {
      frame++;
      if (frame >= FRAMES) {
        clearInterval(id);
        el.removeAttribute('data-on');
        return;
      }
      paint(scramble(Math.floor((frame / FRAMES) * (value.length + 1))));
    }, 34);
    return () => {
      clearInterval(id);
      el.removeAttribute('data-on');
    };
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={root} className={`glitch ${className ?? ''}`}>
      <span className="g-size">{value}</span>
      <span className="g-live" ref={live} aria-hidden />
    </span>
  );
}

export const Cr = ({ v, volume }: { v: number; volume?: number }) => (
  <span className="cr">
    <Glitch text={`${Math.round(v)} CR`} volume={volume} />
  </span>
);

export function Delta({ v, suffix = '%' }: { v: number; suffix?: string }) {
  if (!isFinite(v)) return null;
  const r = Math.round(v);
  return (
    <span className={r > 0 ? 'up' : r < 0 ? 'down' : 'muted'}>
      <Glitch text={`${r > 0 ? '▲' : r < 0 ? '▼' : '•'} ${Math.abs(r)}${suffix}`} />
    </span>
  );
}

/** A tiny chart without libraries. */
export function Spark({ data, width = 110, height = 28, color = 'var(--cyan)' }: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * width},${height - 2 - ((v - min) / span) * (height - 4)}`)
    .join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="miter" />
    </svg>
  );
}

export const LINE_COLORS = ['#00f0ff', '#ff2a8a', '#ffe600', '#39ff14', '#ff8a00', '#b46bff', '#ff3b4e', '#9aa3c7'];

/**
 * Line chart of several series. Interactive: hovering a line highlights it and dims the rest,
 * a crosshair shows the values at that point, clicking a line or its legend item pins the highlight.
 */
export function LineChart({
  series,
  height = 260,
  yLabel,
  labels,
  highlight,
}: {
  series: { name: string; color: string; data: number[] }[];
  /** a series highlighted from outside (e.g. hovering its name in a legend below the chart) */
  highlight?: string | null;
  height?: number;
  yLabel?: string;
  /** caption for each point (e.g. "day 3 · 14:00") for the tooltip */
  labels?: string[];
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverName, setHoverName] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const width = 800;
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const all = series.flatMap((s) => s.data);
  if (!all.length) return <div className="muted">No data yet</div>;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const n = Math.max(...series.map((s) => s.data.length));
  const plotW = width - pad.l - pad.r;
  const x = (i: number) => pad.l + (i / Math.max(1, n - 1)) * plotW;
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (height - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + span * f);
  const focus = pinned ?? hoverName ?? (highlight && series.some((s) => s.name === highlight) ? highlight : null);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * width;
    const sy = ((e.clientY - r.top) / r.height) * height;
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - pad.l) / plotW) * (n - 1))));
    setHoverIdx(i);
    // the nearest line to the cursor (within ~16 px) gets highlighted
    let best: { name: string; d: number } | null = null;
    for (const s of series) {
      const v = s.data[i];
      if (v === undefined) continue;
      const d = Math.abs(y(v) - sy);
      if (!best || d < best.d) best = { name: s.name, d };
    }
    setHoverName(best && best.d < 16 ? best.name : null);
  };
  const togglePin = (name: string) => {
    sfx('ui-select');
    setPinned((p) => (p === name ? null : name));
  };

  const rows =
    hoverIdx === null
      ? []
      : series
          .filter((s) => s.data[hoverIdx] !== undefined)
          .map((s) => ({ s, v: s.data[hoverIdx] }))
          .sort((a, b) => (a.s.name === focus ? -1 : b.s.name === focus ? 1 : b.v - a.v));
  const tipLeft = hoverIdx !== null && x(hoverIdx) > width * 0.6;

  return (
    <div className="chart">
      <div className="chart-box">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: '100%', height: 'auto' }}
          onMouseMove={onMove}
          onMouseLeave={() => {
            setHoverIdx(null);
            setHoverName(null);
          }}
          onClick={() => hoverName && togglePin(hoverName)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="#3b3156" strokeDasharray="4 4" shapeRendering="crispEdges" />
              <text x={pad.l - 6} y={y(t) + 4} fill="#9389b4" fontSize="13" fontFamily="Tiny5" textAnchor="end">
                {Math.round(t)}
              </text>
            </g>
          ))}
          {yLabel && (
            <text x={pad.l} y={height - 4} fill="#9389b4" fontSize="13" fontFamily="Tiny5">
              {yLabel}
            </text>
          )}
          {hoverIdx !== null && (
            <line
              x1={x(hoverIdx)}
              x2={x(hoverIdx)}
              y1={pad.t}
              y2={height - pad.b}
              stroke="#ffe60088"
              strokeDasharray="3 3"
              shapeRendering="crispEdges"
            />
          )}
          {/* the highlighted line is drawn last, on top */}
          {[...series]
            .sort((a, b) => (a.name === focus ? 1 : b.name === focus ? -1 : 0))
            .map((s) => {
              const on = !focus || s.name === focus;
              return (
                <polyline
                  key={s.name}
                  fill="none"
                  stroke={s.color}
                  strokeLinejoin="miter"
                  className="chart-line"
                  style={{
                    opacity: on ? 1 : 0.16,
                    filter: s.name === focus ? `drop-shadow(0 0 5px ${s.color})` : on ? `drop-shadow(0 0 3px ${s.color})` : 'none',
                  }}
                  strokeWidth={s.name === focus ? 3.5 : 2}
                  points={s.data.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
                />
              );
            })}
          {hoverIdx !== null &&
            series.map((s) =>
              s.data[hoverIdx] === undefined ? null : (
                <rect
                  key={s.name}
                  x={x(hoverIdx) - (s.name === focus ? 4 : 3)}
                  y={y(s.data[hoverIdx]) - (s.name === focus ? 4 : 3)}
                  width={s.name === focus ? 8 : 6}
                  height={s.name === focus ? 8 : 6}
                  fill={s.color}
                  opacity={!focus || s.name === focus ? 1 : 0.25}
                  shapeRendering="crispEdges"
                />
              ),
            )}
        </svg>
        {hoverIdx !== null && (
          <div
            className="chart-tip"
            style={{
              left: `${(x(hoverIdx) / width) * 100}%`,
              transform: tipLeft ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
            }}
          >
            {labels?.[hoverIdx] && <div className="muted">{labels[hoverIdx]}</div>}
            {rows.map(({ s, v }) => (
              <div key={s.name} className={s.name === focus ? 'on' : focus ? 'off' : ''}>
                <span style={{ color: s.color }}>■</span> {s.name} <b>{Math.round(v)}</b>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="row chart-legend">
        {series.map((s) => (
          <button
            key={s.name}
            data-sfx="none"
            className={`legend-item ${s.name === pinned ? 'pinned' : ''} ${focus && s.name !== focus ? 'dim' : ''}`}
            onMouseEnter={() => setHoverName(s.name)}
            onMouseLeave={() => setHoverName(null)}
            onClick={() => togglePin(s.name)}
            title={s.name === pinned ? 'Click to unpin' : 'Click to pin the highlight'}
          >
            <span style={{ color: s.color }}>■</span> {s.name}
          </button>
        ))}
        {pinned && <span className="muted">· click again to unpin</span>}
      </div>
    </div>
  );
}
