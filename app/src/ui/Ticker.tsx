// Market ticker under the top bar: an LED stock-exchange strip with the biggest price moves of the day
// and the latest market/broker headlines. The content is rebuilt once per game hour (not on every trade),
// so the strip scrolls smoothly; hover pauses it.

import { useMemo } from 'react';
import { MODELS } from '../engine/robots';
import { refPrice, type World } from '../engine/world';

export function Ticker({ w }: { w: World }) {
  const items = useMemo(() => {
    const moves = MODELS.map((m) => {
      const price = Math.round(refPrice(w, m.id));
      const start = w.dayStartPrice[m.id] ?? price;
      return { m, price, ch: start ? ((price - start) / start) * 100 : 0 };
    })
      .sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch))
      .slice(0, 12);
    const news = w.events
      .filter((e) => e.kind === 'price' || e.kind === 'broker')
      .slice(-4)
      .reverse()
      .map((e) => e.text.toUpperCase());
    return { moves, news };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.hour, w.season]);

  const run = (key: string) => (
    <div className="ticker-run" key={key} aria-hidden={key === 'b'}>
      {items.moves.map(({ m, price, ch }, i) => {
        const r = Math.round(ch);
        return (
          <span className="ticker-item" key={m.id}>
            <b>{m.name.toUpperCase()}</b>
            <span>{price} CR</span>
            <span className={r > 0 ? 'up' : r < 0 ? 'down' : ''}>
              {r > 0 ? '▲' : r < 0 ? '▼' : '•'} {Math.abs(r)}%
            </span>
            {i === 5 && items.news[0] && <span className="sep">◆</span>}
            {i === 5 && items.news[0] && <span className="ticker-item news">{items.news[0]}</span>}
          </span>
        );
      })}
      {items.news.slice(1).map((t, i) => (
        <span className="ticker-item news" key={i}>
          <span className="sep">◆</span> {t}
        </span>
      ))}
    </div>
  );

  // two identical runs side by side, shifted by -50% → a seamless loop (fixed duration so updates never jump)
  return (
    <div className="ticker" title="Market ticker — today's biggest price moves">
      <div className="ticker-track">
        {run('a')}
        {run('b')}
      </div>
    </div>
  );
}
