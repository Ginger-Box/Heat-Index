import { useState } from 'react';
import { CLASSES, CLASS_LABEL, MODELS, classOf, type RobotClass } from '../engine/robots';
import { DAYS_PER_SEASON, type World } from '../engine/world';
import { LINE_COLORS, LineChart } from '../ui/common';

// a fixed colour per class, so a class keeps its colour whatever is shown
const CLASS_COLOR: Record<RobotClass, string> = {
  none: '#9aa3c7',
  armor: '#ffe600',
  maneuver: '#00f0ff',
  repair: '#39ff14',
  blast: '#ff8a00',
  charge: '#ff2a8a',
  shock: '#b46bff',
};

export function Analytics({ w }: { w: World }) {
  const [metric, setMetric] = useState<'price' | 'rel'>('rel');
  const [mode, setMode] = useState<'models' | 'classes'>('models');
  const [hl, setHl] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // which stretch to show: the rolling last 7 days (default), one season, or everything (all is kept)
  const [period, setPeriod] = useState<'week' | 'all' | number>('week');
  const seasonOf = (day: number) => Math.floor((day - 1) / DAYS_PER_SEASON) + 1;
  const seasons = [...new Set(w.history.map((h) => seasonOf(h.day)))];
  const lastDay = w.history[w.history.length - 1]?.day ?? 1;
  const hist = w.history.filter((h) =>
    period === 'all' ? true : period === 'week' ? h.day > lastDay - DAYS_PER_SEASON : seasonOf(h.day) === period,
  );
  // By default — the 6 models with the biggest swing
  const swing = (id: string) => {
    const xs = hist.map((h) => (metric === 'price' ? h.price[id] / MODELS.find((m) => m.id === id)!.basePrice : h.rel[id]));
    return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  };
  const [picked, setPicked] = useState<string[] | null>(null);
  const shown = picked ?? [...MODELS].sort((a, b) => swing(b.id) - swing(a.id)).slice(0, 6).map((m) => m.id);
  const toggle = (id: string) =>
    setPicked((p) => {
      const cur = p ?? shown;
      return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-8);
    });

  const [hiddenCls, setHiddenCls] = useState<RobotClass[]>([]);
  // Class lines: relevance = average relevance of the class's robots; price = average price as % of base price
  // (raw prices would let the most expensive robot drown out the rest)
  const classSeries = CLASSES.filter((c) => !hiddenCls.includes(c)).map((c) => {
    const ms = MODELS.filter((m) => classOf(m.id) === c);
    return {
      name: CLASS_LABEL[c],
      color: CLASS_COLOR[c],
      data: hist.map((h) =>
        Math.round(
          ms.reduce((s, m) => s + (metric === 'price' ? (h.price[m.id] / m.basePrice) * 100 : h.rel[m.id]), 0) / ms.length,
        ),
      ),
    };
  });

  const modelSeries = shown.map((id, i) => ({
    name: MODELS.find((m) => m.id === id)!.name,
    color: LINE_COLORS[i % LINE_COLORS.length],
    data: hist.map((h) => (metric === 'price' ? h.price[id] : h.rel[id])),
  }));

  const hint =
    mode === 'classes'
      ? metric === 'rel'
        ? 'Average relevance of each class, 0–100.'
        : 'Average price of each class as % of its base price (100 = list price).'
      : metric === 'rel'
        ? 'Relevance 0–100.'
        : 'Average fair price across brokers, CR.';

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Analytics</h2>
        <div className="row">
          <button data-sfx="toggle" className={`small ${mode === 'models' ? 'primary' : ''}`} onClick={() => setMode('models')}>
            Models
          </button>
          <button data-sfx="toggle" className={`small ${mode === 'classes' ? 'primary' : ''}`} onClick={() => setMode('classes')}>
            Classes
          </button>
          <span style={{ width: 12 }} />
          <button className={`small ${metric === 'rel' ? 'primary' : ''}`} onClick={() => setMetric('rel')}>
            Relevance
          </button>
          <button className={`small ${metric === 'price' ? 'primary' : ''}`} onClick={() => setMetric('price')}>
            Price
          </button>
        </div>
      </div>
      <div className="row period-row">
        <span className="muted">Period:</span>
        <button data-sfx="toggle" className={`small ${period === 'week' ? 'primary' : ''}`} onClick={() => setPeriod('week')}>
          Last 7 days
        </button>
        {seasons.map((n) => (
          <button key={n} data-sfx="toggle" className={`small ${period === n ? 'primary' : ''}`} onClick={() => setPeriod(n)}>
            Season {n}
          </button>
        ))}
        {seasons.length > 1 && (
          <button data-sfx="toggle" className={`small ${period === 'all' ? 'primary' : ''}`} onClick={() => setPeriod('all')}>
            All
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Each point is one game hour (older than two weeks: one per day). {hint} Hover a line or a name below to highlight it, click the chart to pin.
        {mode === 'models' ? ' Pick models below (up to 8).' : ''}
      </p>
      <LineChart
        series={mode === 'classes' ? classSeries : modelSeries}
        labels={hist.map(
          (h) => `S${seasonOf(h.day)} · day ${((h.day - 1) % DAYS_PER_SEASON) + 1} · ${String(8 + (h.hour % 12)).padStart(2, '0')}:00`,
        )}
        highlight={hl}
      />
      {mode === 'models' && (
        <input
          className="pick-search"
          placeholder="Search a robot or class…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      <div className="pick-row" onMouseLeave={() => setHl(null)}>
        {mode === 'models'
          ? MODELS.filter((m) => {
              const s = q.trim().toLowerCase();
              return !s || m.name.toLowerCase().includes(s) || CLASS_LABEL[classOf(m.id)].toLowerCase().includes(s);
            }).map((m) => {
              const i = shown.indexOf(m.id);
              return (
                <button
                  key={m.id}
                  data-sfx="toggle"
                  className={`pick ${i >= 0 ? 'primary' : ''}`}
                  style={i >= 0 ? { boxShadow: `inset 0 -3px 0 ${LINE_COLORS[i % LINE_COLORS.length]}` } : undefined}
                  onMouseEnter={() => setHl(m.name)}
                  onClick={() => toggle(m.id)}
                >
                  {m.name}
                </button>
              );
            })
          : CLASSES.map((c) => {
              const on = !hiddenCls.includes(c);
              return (
                <button
                  key={c}
                  data-sfx="toggle"
                  className={`pick ${on ? 'primary' : ''}`}
                  style={on ? { boxShadow: `inset 0 -3px 0 ${CLASS_COLOR[c]}` } : undefined}
                  onMouseEnter={() => setHl(CLASS_LABEL[c])}
                  onClick={() => setHiddenCls((h) => (on ? [...h, c] : h.filter((x) => x !== c)))}
                >
                  {CLASS_LABEL[c]}
                </button>
              );
            })}
      </div>
    </div>
  );
}
