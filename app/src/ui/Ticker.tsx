// Market pulse under the top bar: one quiet, static line — the two biggest risers and the two biggest fallers
// of the day. No scrolling and no frame, so it doesn't compete with the screen; it refreshes once per game hour
// (the numbers glitch when they change).

import { useMemo } from 'react';
import { MODELS } from '../engine/robots';
import { refPrice, type World } from '../engine/world';
import { Glitch } from './common';

export function Ticker({ w }: { w: World }) {
  const { up, down } = useMemo(() => {
    const moves = MODELS.map((m) => {
      const price = Math.round(refPrice(w, m.id));
      const start = w.dayStartPrice[m.id] ?? price;
      return { m, price, ch: start ? Math.round(((price - start) / start) * 100) : 0 };
    });
    const sorted = [...moves].sort((a, b) => b.ch - a.ch);
    return { up: sorted.filter((x) => x.ch > 0).slice(0, 2), down: sorted.filter((x) => x.ch < 0).slice(-2).reverse() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.hour, w.season]);
  const item = (x: (typeof up)[number]) => (
    <span className="pulse-item" key={x.m.id}>
      {x.m.name} <Glitch text={`${x.price} CR`} />{' '}
      <b className={x.ch > 0 ? 'up' : 'down'}>
        <Glitch text={`${x.ch > 0 ? '▲' : '▼'}${Math.abs(x.ch)}%`} />
      </b>
    </span>
  );
  return (
    <div className="pulse" title="Today's biggest price moves on the Market">
      <span className="pulse-label">MARKET TODAY</span>
      {up.map(item)}
      {down.map(item)}
      {!up.length && !down.length && <span className="pulse-item">quiet so far</span>}
    </div>
  );
}
