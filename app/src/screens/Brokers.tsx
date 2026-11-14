import { useState } from 'react';
import {
  DIVIDEND_SHARE,
  HOUSE,
  PLAYER_ID,
  brokerCashForBuyback,
  brokerProfitToday,
  divest,
  expectedDailyPer100,
  getManager,
  invest,
  robotsOf,
  sharePrice,
  totalShares,
  type Broker,
  type World,
} from '../engine/world';
import { sfx } from '../audio';
import { act } from '../store';
import { Cr, Glitch, Tip } from '../ui/common';
import { BrokerPortrait, PERSONAS, brokerQuote } from '../ui/brokerPersona';

/** How risky a broker is, judging by its recent days. */
function profile(b: Broker): { label: string; cls: string; hint: string } {
  if (b.closed) return { label: 'Closed', cls: 'down', hint: 'Bankrupt. Invest to reopen it (it needs 250 CR in cash).' };
  if (b.credits < 300) return { label: 'Near bankruptcy', cls: 'down', hint: 'Low on cash — risky, but stakes are cheap.' };
  const log = b.profitLog ?? [];
  if (log.length < 2) return { label: 'New', cls: 'muted', hint: 'Not enough history yet.' };
  const mean = log.reduce((s, x) => s + x, 0) / log.length;
  const sd = Math.sqrt(log.reduce((s, x) => s + (x - mean) ** 2, 0) / log.length);
  const losses = log.filter((x) => x < 0).length;
  if (mean > 0 && losses === 0 && sd < mean * 0.6)
    return { label: 'Steady', cls: 'up', hint: 'Profitable every day with small swings.' };
  if (mean > 0) return { label: 'Volatile', cls: 'warn', hint: 'Profitable on average, but some days are bad.' };
  return { label: 'Losing money', cls: 'down', hint: 'Lost money on average lately — no dividends.' };
}

const react = (r: number) =>
  r < 0.3
    ? { label: '🐢 Slow prices', hint: 'Notices meta shifts late. Buy robots that just started winning here — before it raises prices.' }
    : r >= 0.5
      ? { label: '⚡ Fast prices', hint: 'Reacts fast — prices already follow the meta. Good place to sell robots that just got popular.' }
      : { label: '〰 Medium prices', hint: 'Reacts to meta shifts at a medium speed.' };

/** Profit by day: green bars up, red down. */
function ProfitBars({ data }: { data: number[] }) {
  const w = 154;
  const h = 46;
  if (!data.length) return <div className="muted">No full days yet</div>;
  const max = Math.max(1, ...data.map(Math.abs));
  const bw = w / 7;
  const mid = h / 2;
  return (
    <svg width={w} height={h} className="profit-bars" shapeRendering="crispEdges">
      <line x1={0} x2={w} y1={mid} y2={mid} stroke="#3b3156" />
      {data.map((v, i) => {
        const bh = Math.max(1, (Math.abs(v) / max) * (mid - 2));
        return (
          <rect
            key={i}
            x={i * bw + 2}
            width={bw - 4}
            y={v >= 0 ? mid - bh : mid}
            height={bh}
            fill={v >= 0 ? 'var(--green)' : 'var(--red)'}
          >
            <title>{`${v >= 0 ? '+' : ''}${v} CR`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

const BANNER: Record<string, string> = {
  kessler: 'KESSLER CORP · INVESTOR RELATIONS',
  soroka: 'NO RECEIPTS · CASH ONLY',
  scrap: '⚠ SCRAP YARD · MIND THE EDGES',
};

/** The latest market events and broker news (bankruptcies, investments, audits, raids…). */
function MarketNews({ w }: { w: World }) {
  const news = w.events.filter((e) => e.kind === 'broker').slice(-5).reverse();
  if (!news.length) return null;
  return (
    <div className="market-news">
      <b>Market news</b>
      {news.map((e, i) => (
        <div key={`${e.tick}-${i}`} className={/bankrupt/.test(e.text) ? 'down' : /reopened|contract|shipment/.test(e.text) ? 'up' : ''}>
          <span className="muted">Day {e.day} · </span>
          {e.text}
        </div>
      ))}
    </div>
  );
}

export function Brokers({ w }: { w: World }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const me = getManager(w, PLAYER_ID);

  const run = (fn: (w: World) => string | null, sound: 'ui-buy' | 'ui-sell') => {
    const err = act(fn);
    if (!err) sfx(sound);
    setMsg(err);
  };

  return (
    <div className="grid">
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Brokers</h2>
          <div className="info-wrap">
            <button className={`info-btn ${help ? 'on' : ''}`} onClick={() => setHelp(!help)} title="How brokers work">
              i
            </button>
            {help && (
              <div className="info-pop">
                <b>How brokers work</b>
                <ul>
                  <li>Brokers are the only shops: you buy robots from them and sell robots to them.</li>
                  <li>
                    Each sets its own prices from the <b>relevance it sees</b> — and each notices changes at a different
                    speed. That is why the same robot costs differently at different brokers.
                  </li>
                  <li>
                    Buy a <b>stake</b> and you own part of the broker. At the end of every game day{' '}
                    {Math.round(DIVIDEND_SHARE * 100)}% of its profit is paid to the owners, by stake size.
                  </li>
                  <li>
                    The stake price follows the broker's capital (cash + its stock). You can sell your stake back at any
                    time at the current price — if the broker has free cash.
                  </li>
                  <li>
                    Every broker pays a <b>daily upkeep</b>. If it can't cover it, it goes bankrupt and closes — your
                    stake stops paying until investors bring it back to life.
                  </li>
                  <li>
                    <b>Market news</b> hits each business differently: audits, raids, inspections, Factory strikes,
                    recalls, riots, hype. Kessler is steady, Magpie is a gamble, the Junkman lives off broken robots —
                    who ends the season on top is never fixed.
                  </li>
                  <li>Stakes count toward your net worth — the Magnates ranking.</li>
                </ul>
              </div>
            )}
          </div>
        </div>
        <p className="muted" style={{ margin: '10px 0 0' }}>
          Own a piece of a broker — get a cut of its profit every day.
        </p>
        {msg && <div className="error">{msg}</div>}
        <MarketNews w={w} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        {w.brokers.map((b) => {
          const total = totalShares(b);
          const mine = b.shares[PLAYER_ID] ?? 0;
          const pct = (mine / total) * 100;
          const outside = ((total - (b.shares[HOUSE] ?? 0)) / total) * 100;
          const sp = sharePrice(w, b);
          const worth = mine * sp;
          const stock = robotsOf(w, b.id).filter((r) => r.durability > 0).length;
          const per100 = expectedDailyPer100(w, b);
          const p = profile(b);
          const today = Math.round(brokerProfitToday(w, b));
          const paid = b.paidTotal?.[PLAYER_ID] ?? 0;
          const canSell = Math.min(Math.floor(worth), brokerCashForBuyback(b));
          return (
            <div key={b.id} className={`panel broker-card persona-${b.id} ${b.closed ? 'closed' : ''}`}>
              {/* each broker's window is dressed like its owner (index.css · broker personas) */}
              <div className="broker-banner">
                <span>{BANNER[b.id] ?? b.name}</span>
              </div>
              {/* face, name, bio and a live remark in its own voice */}
              <div className="broker-head">
                <BrokerPortrait id={b.id} />
                <div className="broker-id">
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <h3 style={{ margin: 0 }} title={b.tagline}>
                      {b.name}
                    </h3>
                    <span className={`tag ${p.cls}`} title={p.hint}>
                      {p.label}
                    </span>
                  </div>
                  <div className="broker-person">{PERSONAS[b.id]?.person}</div>
                  <div className="muted broker-bio">{PERSONAS[b.id]?.bio ?? b.tagline}</div>
                </div>
              </div>
              <div className="broker-quote" key={brokerQuote(w, b)} style={{ ['--bc' as string]: PERSONAS[b.id]?.color }}>
                “{brokerQuote(w, b)}”
              </div>

              <div className="yield-box" title="Average of the last 3 days — a forecast, not a promise">
                <span className="muted">Invest 100 CR →</span>
                {b.divPerShareLog?.length ? (
                  <>
                    <b>
                      ≈ <Glitch text={per100.toFixed(1)} /> CR
                    </b>
                    <span className="muted">per day</span>
                  </>
                ) : (
                  <span className="muted">no data yet — after the first full day</span>
                )}
              </div>

              <div className="row" style={{ alignItems: 'flex-end', margin: '12px 0', gap: 16 }}>
                <div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    Profit, last 7 days
                  </div>
                  <ProfitBars data={b.profitLog ?? []} />
                </div>
                <div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    Today so far
                  </div>
                  <b className={today >= 0 ? 'up' : 'down'}>
                    <Glitch text={`${today >= 0 ? '+' : ''}${today} CR`} />
                  </b>
                </div>
              </div>

              <div className="broker-badges">
                <Tip text={react(b.style.react).hint}>
                  <span className="tag">{react(b.style.react).label}</span>
                </Tip>
                <Tip text="How much the broker adds on top of the fair price when it sells to you.">
                  <span className="tag">Markup {Math.round(b.style.spread * 100)}%</span>
                </Tip>
                <Tip text="Free cash. Below 60 CR the broker goes bankrupt.">
                  <span className="tag">
                    💰 <Cr v={b.credits} />
                  </span>
                </Tip>
                <Tip text={`Robots for sale.${b.style.scrapper ? ' Also buys broken robots for scrap.' : ''}`}>
                  <span className="tag">
                    📦 {stock}
                    {b.style.scrapper ? ' · ♻' : ''}
                  </span>
                </Tip>
                <Tip text={`Investors own ${outside.toFixed(0)}% of this broker. One stake unit costs ${sp.toFixed(2)} CR.`}>
                  <span className="tag">👥 {outside.toFixed(0)}%</span>
                </Tip>
              </div>

              <div className={`my-stake ${mine > 0 ? 'has' : ''}`}>
                {mine > 0 ? (
                  <div className="stake-grid">
                    <div>
                      <span className="muted">your stake</span>
                      <b>{pct.toFixed(1)}%</b>
                    </div>
                    <div>
                      <span className="muted">worth</span>
                      <Cr v={worth} />
                    </div>
                    <div>
                      <span className="muted">paid you</span>
                      <Cr v={paid} />
                    </div>
                  </div>
                ) : (
                  <span className="muted">No stake yet</span>
                )}
              </div>

              <div className="row" style={{ marginTop: 10, gap: 4 }}>
                <span className="muted">Invest:</span>
                {[50, 100, 250].map((x) => (
                  <button
                    key={x}
                    className="small"
                    data-sfx="none"
                    disabled={me.credits < x}
                    onClick={() => run((w) => invest(w, PLAYER_ID, b.id, x), 'ui-buy')}
                  >
                    {x} CR
                  </button>
                ))}
                {mine > 0 && (
                  <button
                    className="small danger"
                    data-sfx="none"
                    disabled={canSell < 1}
                    title={canSell < Math.floor(worth) ? 'The broker can only buy back part of it right now' : undefined}
                    onClick={() => run((w) => divest(w, PLAYER_ID, b.id, 1), 'ui-sell')}
                  >
                    Sell stake · <Cr v={canSell} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
