import { useEffect, useRef, useState } from 'react';
import { MODELS } from '../engine/robots';
import { DAYS_PER_SEASON, HOURS_PER_DAY, advanceHours, dayOf, refPrice, type World } from '../engine/world';
import { actBackground, getWorld } from '../store';
import { Cr, Delta, LINE_COLORS, LineChart } from './common';

const TOTAL_HOURS = HOURS_PER_DAY * DAYS_PER_SEASON;
const MS_PER_HOUR = 380; // ≈ 32 секунды на неделю + время расчёта

export function FastForward({ onClose }: { onClose: () => void }) {
  const w0 = getWorld()!;
  const start = useRef({
    hour: w0.hour,
    histLen: w0.history.length,
    eventsLen: w0.events.length,
    price: Object.fromEntries(MODELS.map((m) => [m.id, refPrice(w0, m.id)])),
    seasons: w0.seasons.length,
  });
  const [done, setDone] = useState(0);
  const [finished, setFinished] = useState(false);
  const skip = useRef(false);

  useEffect(() => {
    let alive = true;
    let h = 0;
    const step = () => {
      if (!alive) return;
      if (skip.current) {
        actBackground((w) => advanceHours(w, TOTAL_HOURS - h));
        h = TOTAL_HOURS;
      } else {
        actBackground((w) => advanceHours(w, 1));
        h++;
      }
      setDone(h);
      if (h >= TOTAL_HOURS) setFinished(true);
      else setTimeout(step, MS_PER_HOUR);
    };
    const t = setTimeout(step, 100);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  const w = getWorld() as World;
  const hist = w.history.slice(Math.max(0, start.current.histLen - 1));
  const change = MODELS.map((m) => ({
    m,
    now: refPrice(w, m.id),
    ch: ((refPrice(w, m.id) - start.current.price[m.id]) / start.current.price[m.id]) * 100,
  })).sort((a, b) => b.ch - a.ch);
  const movers = [...change].sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch)).slice(0, 6);
  const events = w.events.slice(start.current.eventsLen).filter((e) => e.kind !== 'match');
  const newSeason = w.seasons.length > start.current.seasons ? w.seasons[w.seasons.length - 1] : null;

  return (
    <div className="overlay">
      <div className="panel grid">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>⏩ Week fast-forward</h2>
          <div className="row">
            <span>
              Day {dayOf(w)} · {done}/{TOTAL_HOURS} h · {w.tick} battles
            </span>
            {!finished ? (
              <button onClick={() => (skip.current = true)}>Skip animation</button>
            ) : (
              <button className="primary" onClick={onClose}>
                Done
              </button>
            )}
          </div>
        </div>
        <div className="progress">
          <i style={{ width: `${(done / TOTAL_HOURS) * 100}%` }} />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          12 NPC teams fight and trade with AI brokers. Prices use the same formulas as in normal play (file{' '}
          <code>pricing.ts</code>). The six robots with the biggest price change:
        </p>
        <LineChart
          height={240}
          series={movers.map((x, i) => ({
            name: x.m.name,
            color: LINE_COLORS[i],
            data: hist.map((h) => h.price[x.m.id]),
          }))}
        />
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
          <div>
            <h3>Risers / fallers</h3>
            <table>
              <tbody>
                {[...change.slice(0, 4), ...change.slice(-4)].map((x) => (
                  <tr key={x.m.id}>
                    <td>{x.m.name}</td>
                    <td>
                      <Cr v={x.now} />
                    </td>
                    <td>
                      <Delta v={x.ch} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3>Events</h3>
            <div className="feed" style={{ maxHeight: 260 }}>
              {[...events].reverse().slice(0, 30).map((e, i) => (
                <div key={i}>
                  <span className="muted">d{e.day}</span> {e.text}
                </div>
              ))}
              {!events.length && <span className="muted">All quiet so far…</span>}
            </div>
          </div>
        </div>
        {newSeason && (
          <div className="panel" style={{ borderColor: 'var(--yellow)' }}>
            <h3>Season {newSeason.season} results</h3>
            <div>⚔️ Champions: {newSeason.champions.map((c) => `${c.name} (${c.elo})`).join(', ')}</div>
            <div>💰 Magnates: {newSeason.magnates.map((c) => `${c.name} (${c.worth} CR)`).join(', ')}</div>
          </div>
        )}
      </div>
    </div>
  );
}
