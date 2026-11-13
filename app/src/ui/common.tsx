import { useEffect, useRef, useState, type ReactNode } from 'react';
import { sfx } from '../audio';
import { AttackIcon, EnergyIcon, HpIcon } from './icons';
import { RobotSprite } from './robotArt';
import { ABILITY_HELP, ABILITY_LABEL, CLASS_HELP, CLASS_ICON, CLASS_LABEL, MAX_DURABILITY, abilityHasN, classOf, model } from '../engine/robots';

// Цвет рамки по стоимости в энергии (заглушка вместо арта)
export const COST_COLOR = ['#8a8fbf', '#9aa3c7', '#3bff9a', '#22e3ff', '#a66bff', '#ff2bd6', '#f7f33b'];


export function durColor(d: number) {
  return d <= 0 ? '#555' : d <= 3 ? 'var(--red)' : d <= 6 ? 'var(--yellow)' : 'var(--green)';
}

export function DurBar({ value, max = MAX_DURABILITY }: { value: number; max?: number }) {
  return (
    <div className="dur" title={`Durability ${value}/${max}`}>
      <i style={{ width: `${(Math.max(0, value) / max) * 100}%`, background: durColor(value) }} />
    </div>
  );
}

export function RobotCard(props: {
  modelId: string;
  durability?: number;
  hp?: number; // текущее HP в бою
  selected?: boolean;
  onClick?: () => void;
  footer?: ReactNode;
  badge?: ReactNode;
  className?: string;
}) {
  const md = model(props.modelId);
  const broken = props.durability !== undefined && props.durability <= 0;
  const ab = md.ability;
  const [tip, setTip] = useState<{ below: boolean; shift: number }>({ below: false, shift: 0 });
  /** Перед показом подсказки проверяем, есть ли для неё место; если нет — открываем снизу или сдвигаем внутрь экрана. */
  const placeTip = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.currentTarget.closest('.card-peek')) return; // в превью рынка подсказка всегда справа
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
      className={`card ${props.onClick ? 'clickable' : ''} ${props.selected ? 'selected' : ''} ${broken ? 'broken' : ''} ${tip.below ? 'tip-below' : ''} ${props.className ?? ''}`}
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
        {props.durability !== undefined && (
          <div className="muted" style={{ marginTop: 6 }}>
            Durability {props.durability}/{MAX_DURABILITY}: −1 when damaged, −2 when destroyed in battle.
          </div>
        )}
      </div>
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
      {props.durability !== undefined && <DurBar value={props.durability} />}
      {props.footer}
    </div>
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

/** Метка класса: иконка + название. */
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
 * Значение с глитч-эффектом: когда текст меняется, символы на ~0,3 с превращаются в шум,
 * картинка расслаивается на голубой и розовый, потом слева направо проявляется новое значение.
 * Шум рисуется поверх «невидимого» нового значения, поэтому ширина и высота элемента
 * не скачут — таблицы и строки не дёргаются.
 */
export function Glitch({
  text,
  className,
  volume = 0,
}: {
  text: string | number;
  className?: string;
  /** громкость глич-звука (0 — без звука; по умолчанию звучат только кредиты игрока) */
  volume?: number;
}) {
  const value = String(text);
  const [noise, setNoise] = useState<string | null>(null);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    if (volume > 0) sfx('glitch', { volume });
    const FRAMES = 9;
    let frame = 0;
    const scramble = (reveal: number) =>
      [...value]
        .map((ch, i) => (i < reveal || ch === ' ' ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
        .join('');
    setNoise(scramble(0));
    const id = setInterval(() => {
      frame++;
      if (frame >= FRAMES) {
        clearInterval(id);
        setNoise(null);
        return;
      }
      setNoise(scramble(Math.floor((frame / FRAMES) * (value.length + 1))));
    }, 34);
    return () => {
      clearInterval(id);
      setNoise(null);
    };
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  if (noise === null) return <span className={`glitch ${className ?? ''}`}>{value}</span>;
  return (
    <span className={`glitch on ${className ?? ''}`} data-text={noise}>
      <span className="g-size" aria-hidden>
        {value}
      </span>
      <span className="g-live">{noise}</span>
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

/** Мини-график без библиотек. */
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

/** Линейный график нескольких серий. */
export function LineChart({
  series,
  height = 260,
  yLabel,
}: {
  series: { name: string; color: string; data: number[] }[];
  height?: number;
  yLabel?: string;
}) {
  const width = 800;
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const all = series.flatMap((s) => s.data);
  if (!all.length) return <div className="muted">No data yet</div>;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const n = Math.max(...series.map((s) => s.data.length));
  const x = (i: number) => pad.l + (i / Math.max(1, n - 1)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (height - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + span * f);
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
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
        {series.map((s) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={s.color}
            strokeLinejoin="miter"
            style={{ filter: `drop-shadow(0 0 3px ${s.color})` }}
            strokeWidth="2"
            points={s.data.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
          />
        ))}
      </svg>
      <div className="row" style={{ fontSize: 13 }}>
        {series.map((s) => (
          <span key={s.name}>
            <span style={{ color: s.color }}>■</span> {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
