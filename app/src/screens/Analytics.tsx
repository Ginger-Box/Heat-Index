import { useState } from 'react';
import { MODELS } from '../engine/robots';
import type { World } from '../engine/world';
import { LINE_COLORS, LineChart } from '../ui/common';

export function Analytics({ w }: { w: World }) {
  const [metric, setMetric] = useState<'price' | 'rel'>('rel');
  const hist = w.history;
  // По умолчанию — 6 моделей с самым большим размахом
  const swing = (id: string) => {
    const xs = hist.map((h) => (metric === 'price' ? h.price[id] / (MODELS.find((m) => m.id === id)!.basePrice) : h.rel[id]));
    return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  };
  const [picked, setPicked] = useState<string[] | null>(null);
  const shown = picked ?? [...MODELS].sort((a, b) => swing(b.id) - swing(a.id)).slice(0, 6).map((m) => m.id);
  const toggle = (id: string) =>
    setPicked((p) => {
      const cur = p ?? shown;
      return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-8);
    });

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Analytics</h2>
        <div className="row">
          <button className={`small ${metric === 'rel' ? 'primary' : ''}`} onClick={() => setMetric('rel')}>
            Relevance
          </button>
          <button className={`small ${metric === 'price' ? 'primary' : ''}`} onClick={() => setMetric('price')}>
            Price
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Each point is one game hour. {metric === 'rel' ? 'Relevance 0–100.' : 'Average fair price across brokers, CR.'}{' '}
        Pick models below (up to 8).
      </p>
      <LineChart
        series={shown.map((id, i) => ({
          name: MODELS.find((m) => m.id === id)!.name,
          color: LINE_COLORS[i % LINE_COLORS.length],
          data: hist.map((h) => (metric === 'price' ? h.price[id] : h.rel[id])),
        }))}
      />
      <div className="row" style={{ marginTop: 12, gap: 6 }}>
        {MODELS.map((m) => (
          <button key={m.id} className={`small ${shown.includes(m.id) ? 'primary' : ''}`} onClick={() => toggle(m.id)}>
            {m.name}
          </button>
        ))}
      </div>
    </div>
  );
}
