import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { winRate } from '../engine/pricing';
import { CLASSES, CLASS_HELP, CLASS_ICON, CLASS_LABEL, MODELS, classOf, type RobotClass } from '../engine/robots';
import { PLAYER_ID, actualRelevance, buy, getManager, quote, refPrice, robotsOf, type World } from '../engine/world';
import { crunch, sfx } from '../audio';
import { act, worldVersion } from '../store';
import { setCursorMode } from '../ui/fx';
import { COST_COLOR, ClassTag, Cr, Delta, Glitch, RobotCard, Spark, Tip } from '../ui/common';
import { AttackIcon, EnergyIcon, HpIcon } from '../ui/icons';

type SortKey = 'name' | 'class' | 'cost' | 'rel' | 'wr' | 'price' | 'change' | 'signal' | 'best' | 'owned';
type Show = 'all' | 'buy' | 'sell' | 'stock' | 'owned';

/**
 * Signal: how much the robot's actual relevance differs from what brokers price it at.
 * Brokers react with a delay — if a robot started winning but brokers haven't noticed yet, its price will rise (BUY).
 */
const SIGNAL_GAP = 3; // ~12% of robots carry a signal at any moment (checked with a one-week simulation)

export function Market({ w }: { w: World }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'class', desc: false });
  const [cls, setCls] = useState<RobotClass | 'all'>('all');
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [help, setHelp] = useState(false);

  // Esc снимает выделение и закрывает справку
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setSelected(new Set());
      setHelp(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const me = getManager(w, PLAYER_ID);
  const hist = w.history.slice(-60);
  // Цены считаются заново только когда мир изменился (а не на каждый клик по строке)
  const ver = worldVersion();
  const rows = useMemo(() => computeRows(w), [ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const classStats = useMemo(() => computeClassStats(w, rows), [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- filter and sort ----------
  const query = q.trim().toLowerCase();
  const visible = rows
    .filter((r) => cls === 'all' || r.cls === cls)
    .filter((r) => !query || r.m.name.toLowerCase().includes(query) || CLASS_LABEL[r.cls].toLowerCase().includes(query))
    .filter((r) =>
      show === 'buy'
        ? r.signal >= SIGNAL_GAP
        : show === 'sell'
          ? r.signal <= -SIGNAL_GAP
          : show === 'stock'
            ? !!r.best
            : show === 'owned'
              ? r.owned > 0
              : true,
    );
  const val = (r: Row): number | string => {
    switch (sort.key) {
      case 'name':
        return r.m.name;
      case 'class':
        return CLASSES.indexOf(r.cls) * 100 + r.m.cost;
      case 'cost':
        return r.m.cost;
      case 'rel':
        return r.rel;
      case 'wr':
        return r.wr;
      case 'price':
        return r.price;
      case 'change':
        return r.change;
      case 'signal':
        return r.signal;
      case 'best':
        return r.best?.q.ask ?? Infinity;
      case 'owned':
        return r.owned;
    }
  };
  visible.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'string' ? x.localeCompare(y as string, 'en') : (x as number) - (y as number);
    return sort.desc ? -c : c;
  });

  /**
   * Выделение строк как в проводнике: клик — одна строка, Ctrl/⌘ — добавить или убрать,
   * Shift — диапазон от последней отмеченной (с Ctrl/⌘ — добавить диапазон к выделенному).
   */
  const clickRow = (e: MouseEvent, id: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if ((e.target as HTMLElement).closest('button, input, a')) return;
    sfx('ui-select');
    const multi = e.ctrlKey || e.metaKey;
    const order = visible.map((r) => r.m.id);
    if (e.shiftKey && anchor.current && order.includes(anchor.current)) {
      // Shift-range: a quick ratchet run, one tick per row in the range
      ratchet(Math.abs(order.indexOf(anchor.current) - order.indexOf(id)) + 1);
    }
    setSelected((cur) => {
      if (e.shiftKey && anchor.current && order.includes(anchor.current)) {
        const [i, j] = [order.indexOf(anchor.current), order.indexOf(id)].sort((a, b) => a - b);
        const range = order.slice(i, j + 1);
        return new Set(multi ? [...cur, ...range] : range);
      }
      anchor.current = id;
      if (multi) {
        const n = new Set(cur);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }
      return cur.size === 1 && cur.has(id) ? new Set() : new Set([id]);
    });
  };

  // ---------- выделение рамкой: зажать ЛКМ на таблице и потянуть ----------
  // Пока тянем — рамка и подсветка строк меняются напрямую в DOM (без перерисовки рынка, поэтому плавно);
  // выделение сохраняется в состояние один раз — когда кнопку отпустили.
  const suppressClick = useRef(false);
  const startBox = (e: MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, a, .peek-name, .tip')) return;
    e.preventDefault(); // не выделять текст
    const x0 = e.clientX;
    const y0 = e.clientY;
    const base = e.ctrlKey || e.metaKey ? new Set(selected) : new Set<string>();
    let moved = false;
    let hit = new Set<string>();
    let lastCount = 0;
    const rowsEl = [...document.querySelectorAll<HTMLElement>('.market-table tbody tr[data-id]')];
    const boxEl = document.createElement('div');
    boxEl.className = 'select-box';
    let last = { x: x0, y: y0 };
    let queued = false;
    const paint = () => {
      queued = false;
      const top = Math.min(y0, last.y);
      const bottom = Math.max(y0, last.y);
      boxEl.style.transform = `translate3d(${Math.min(x0, last.x)}px, ${top}px, 0)`;
      boxEl.style.width = `${Math.abs(last.x - x0)}px`;
      boxEl.style.height = `${bottom - top}px`;
      hit = new Set();
      for (const r of rowsEl) {
        const b = r.getBoundingClientRect();
        const on = b.bottom > top && b.top < bottom;
        if (on) hit.add(r.dataset.id!);
        r.classList.toggle('box-hit', on || base.has(r.dataset.id!));
      }
      const count = new Set([...base, ...hit]).size;
      setCursorMode('scan', `SCAN ×${count}`);
      // a ratchet tick for every row the box gains or loses; the pitch follows the count
      if (count !== lastCount) {
        crunch(count);
        lastCount = count;
      }
    };
    const move = (ev: globalThis.MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!moved) {
        moved = true;
        document.body.appendChild(boxEl);
        rowsEl.forEach((r) => r.classList.add('boxing'));
      }
      last = { x: ev.clientX, y: ev.clientY };
      if (!queued) {
        queued = true;
        requestAnimationFrame(paint);
      }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!moved) return;
      boxEl.remove();
      rowsEl.forEach((r) => r.classList.remove('box-hit', 'boxing'));
      setCursorMode(null);
      setSelected(new Set([...base, ...hit]));
      suppressClick.current = true; // клик после рамки не должен сбросить выделение
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const head = (key: SortKey, label: string, tip?: string) => (
    <th
      className={`sortable ${sort.key === key ? 'sorted' : ''}`}
      title={tip}
      onClick={() => {
        sfx('ui-sort');
        setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' && key !== 'class' && key !== 'best' }));
      }}
    >
      {label}
      <span className="sort-arrow">{sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ' ↕'}</span>
    </th>
  );

  const buyFrom = (brokerId: string, modelId: string) => {
    const err = act((w) => buy(w, PLAYER_ID, brokerId, modelId));
    if (!err) sfx('ui-buy');
    setMsg(err);
  };

  const signalBadge = (r: Row) => {
    const gap = Math.round(r.signal);
    const text =
      `Actual relevance ${Math.round(r.rel)}/100, brokers price it as ${Math.round(r.perceived)}. ` +
      (gap >= SIGNAL_GAP
        ? 'It performs better than brokers think — they will catch up and the price is likely to rise.'
        : gap <= -SIGNAL_GAP
          ? 'It performs worse than brokers think — the price is likely to fall. Good time to sell.'
          : 'Brokers price it about right.');
    return (
      <Tip text={text}>
        {gap >= SIGNAL_GAP ? (
          <span className="signal buy">▲ BUY</span>
        ) : gap <= -SIGNAL_GAP ? (
          <span className="signal sell">▼ SELL</span>
        ) : (
          <span className="signal fair">• fair</span>
        )}
      </Tip>
    );
  };

  return (
    <div className="grid">
      {/* --- class overview --- */}
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Classes</h2>
          <span className="muted">
            Price index: 1.00 = base price. Click a class to filter the market.
          </span>
        </div>
        <div className="class-grid">
          {classStats.map((s) => (
            <button
              key={s.c}
              data-sfx="toggle"
              className={`class-tile ${cls === s.c ? 'active' : ''}`}
              title={CLASS_HELP[s.c]}
              onClick={() => setCls(cls === s.c ? 'all' : s.c)}
            >
              <div className="ct-head">
                {CLASS_ICON[s.c]} {CLASS_LABEL[s.c]}
              </div>
              <div className="ct-index">
                <Glitch text={`×${s.index.toFixed(2)}`} /> <Delta v={s.change} />
              </div>
              <Spark data={s.series} width={130} height={26} color={s.change >= 0 ? 'var(--green)' : 'var(--red)'} />
              <div className="ct-meta">
                rel <b>{Math.round(s.rel)}</b> · wins <b>{Math.round(s.wr * 100)}%</b>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* --- robot list --- */}
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Market</h2>
          <div className="row">
            {selected.size > 0 && (
              <span className="muted">
                {selected.size} selected ·{' '}
                <button className="small" onClick={() => setSelected(new Set())}>
                  clear
                </button>
              </span>
            )}
            <span>
              You have: <Cr v={me.credits} />
            </span>
            <div className="info-wrap">
              <button
                data-sfx={help ? 'close' : 'open'}
                className={`info-btn ${help ? 'on' : ''}`}
                onClick={() => setHelp(!help)}
                title="How to read the market"
                aria-expanded={help}
              >
                i
              </button>
              {help && (
                <div className="info-pop">
                  <b>How to read the market</b>
                  <ul>
                    <li>
                      <b>Relevance</b> (0–100) — how good a robot is right now: 70% from its recent win rate, 30% from
                      how many teams use it.
                    </li>
                    <li>
                      <b>Price</b> follows relevance, but each broker <b>notices changes with a delay</b>.
                    </li>
                    <li>
                      <b>Signal</b> compares the two: <span className="up">▲ BUY</span> — the robot already wins more
                      than brokers think, its price will catch up. <span className="down">▼ SELL</span> — the opposite.
                    </li>
                    <li>
                      <b>Best offer</b> — the cheapest broker that has it in stock. ▾ compares all brokers.
                    </li>
                    <li>
                      Hover a <b>robot's name</b> to see its card. <b>Click a row</b> to highlight it; Ctrl/⌘ adds rows,
                      Shift selects a range, Esc clears.
                    </li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="market-controls">
          <input
            className="search"
            placeholder="🔍 Search robot or class…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="chips">
            <button data-sfx="toggle" className={`small ${cls === 'all' ? 'primary' : ''}`} onClick={() => setCls('all')}>
              All classes
            </button>
            {CLASSES.map((c) => (
              <button
                key={c}
                data-sfx="toggle"
                className={`small ${cls === c ? 'primary' : ''}`}
                onClick={() => setCls(cls === c ? 'all' : c)}
              >
                {CLASS_ICON[c]} {CLASS_LABEL[c]}
              </button>
            ))}
          </div>
          <div className="chips">
            <span className="muted">Show:</span>
            {(
              [
                ['all', 'Everything'],
                ['buy', '▲ Buy signals'],
                ['sell', '▼ Sell signals'],
                ['stock', 'In stock'],
                ['owned', 'Owned'],
              ] as [Show, string][]
            ).map(([k, label]) => (
              <button key={k} data-sfx="toggle" className={`small ${show === k ? 'primary' : ''}`} onClick={() => setShow(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {msg && <div className="error">{msg}</div>}
        <div className="market-wrap" onMouseDown={startBox}>
          <table className="nowrap market-table">
            <colgroup>
              <col style={{ width: '18%' }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '5%' }} />
            </colgroup>
            <thead>
              <tr>
                {head('name', 'Model')}
                {head('rel', 'Relevance', 'How good the robot is right now (0–100) and its recent win rate')}
                {head('price', 'Price', 'Average price and its change today')}
                <th>Trend</th>
                {head('signal', 'Signal', 'Actual relevance vs what brokers price in')}
                {head('best', 'Best offer')}
                {head('owned', 'Owned')}
              </tr>
            </thead>
            <tbody>
              {visible.map((r, idx) => {
                const expanded = open.has(r.m.id);
                return (
                  <Fragment key={r.m.id}>
                    <tr
                      data-id={r.m.id}
                      className={`${expanded ? 'expanded' : ''} ${selected.has(r.m.id) ? 'selected' : ''}`}
                      onMouseDown={(e) => e.shiftKey && e.preventDefault() /* Shift-клик не выделяет текст */}
                      onClick={(e) => clickRow(e, r.m.id)}
                    >
                      <td>
                        <div className="model-cell">
                          <span className="row-num">{idx + 1}</span>
                          <div>
                            <CardPeek modelId={r.m.id}>
                              <b>{r.m.name}</b>
                            </CardPeek>{' '}
                            <ClassTag modelId={r.m.id} />
                            <div className="model-sub stat-line">
                              <span title="Energy cost" style={{ color: COST_COLOR[r.m.cost] }}>
                                <EnergyIcon /> {r.m.cost}
                              </span>
                              <span title="Attack" className="atk-c">
                                <AttackIcon /> {r.m.atk}
                              </span>
                              <span title="HP" className="hp-c">
                                <HpIcon /> {r.m.hp}
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div
                          className="relbar wide"
                          title={`Relevance ${Math.round(r.rel)}/100 · brokers see ${Math.round(r.perceived)}`}
                        >
                          <i style={{ width: `${Math.max(2, r.rel)}%` }} />
                          {/* метка: какую актуальность «видят» брокеры — видно, недооценён робот или переоценён */}
                          <b className="perceived" style={{ left: `${Math.min(99, r.perceived)}%` }} />
                          <span>
                            <Glitch text={Math.round(r.rel)} />
                          </span>
                        </div>
                        <div className="model-sub">
                          wins <Glitch text={`${Math.round(r.wr * 100)}%`} />
                          <span className="muted">· brokers see {Math.round(r.perceived)}</span>
                        </div>
                      </td>
                      <td>
                        <Cr v={r.price} />
                        <div className="model-sub">
                          <Delta v={r.change} />
                        </div>
                      </td>
                      <td>
                        <Spark
                          width={150}
                          data={[...hist.map((h) => h.price[r.m.id]), r.price]}
                          color={r.change >= 0 ? 'var(--green)' : 'var(--red)'}
                        />
                      </td>
                      <td>{signalBadge(r)}</td>
                      <td>
                        <div className="offer-cell">
                          {r.best ? (
                            <>
                              <Tip text={r.best.q.explanation}>
                                <Cr v={r.best.q.ask} />
                              </Tip>
                              <small className="muted broker-short">{r.best.b.name}</small>
                              <button
                                className="small"
                                data-sfx="none"
                                disabled={me.credits < r.best.q.ask}
                                onClick={() => buyFrom(r.best!.b.id, r.m.id)}
                              >
                                Buy
                              </button>
                            </>
                          ) : (
                            <span className="muted no-stock">out of stock</span>
                          )}
                          <button
                            className="small expand-btn"
                            data-sfx={expanded ? 'close' : 'open'}
                            title="Compare all brokers"
                            onClick={() =>
                              setOpen((o) => {
                                const n = new Set(o);
                                if (n.has(r.m.id)) n.delete(r.m.id);
                                else n.add(r.m.id);
                                return n;
                              })
                            }
                          >
                            {expanded ? '▴' : '▾'}
                          </button>
                        </div>
                      </td>
                      <td>{r.owned || <span className="muted">—</span>}</td>
                    </tr>
                    {expanded && (
                      <tr className="broker-row">
                        <td colSpan={7}>
                          <div className="row" style={{ gap: 18 }}>
                            {r.quotes.map(({ b, q }) => (
                              <div key={b.id} className="offer">
                                <b>{b.name}</b>{' '}
                                {b.closed ? (
                                  <span className="down">closed</span>
                                ) : q.stock === 0 ? (
                                  <span className="muted">out of stock</span>
                                ) : (
                                  <>
                                    <Tip text={q.explanation}>
                                      <Cr v={q.ask} />
                                    </Tip>{' '}
                                    <small className="muted">×{q.stock}</small>{' '}
                                    <button
                                      className="small"
                                      data-sfx="none"
                                      disabled={me.credits < q.ask}
                                      onClick={() => buyFrom(b.id, r.m.id)}
                                    >
                                      Buy
                                    </button>
                                  </>
                                )}
                                <div className="muted" style={{ fontSize: 13 }}>
                                  sees relevance {Math.round(b.perceived[r.m.id])}
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!visible.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    Nothing matches. Try another class or clear the search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * Наведение на имя робота показывает его карту рядом. Карта остаётся открытой, пока курсор на ней —
 * а на самой карте всплывает подробное описание способности.
 * Карта рисуется поверх всего (через портал), чтобы её не обрезала прокрутка таблицы.
 */
/** the hover preview shows the card 1.5× as big as in the lists */
const PEEK_ZOOM = 1.5;

function CardPeek({ modelId, children }: { modelId: string; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    keep();
    timer.current = setTimeout(() => setPos(null), 160);
  };
  useEffect(() => keep, []);
  const show = (e: MouseEvent<HTMLElement>) => {
    keep();
    const s = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const r = e.currentTarget.getBoundingClientRect();
    const cardH = 190 * PEEK_ZOOM * s;
    const y = Math.min(Math.max(8, r.top + r.height / 2 - cardH / 2), window.innerHeight - cardH - 8);
    const cell = e.currentTarget.closest('td')?.getBoundingClientRect() ?? r; // справа от колонки, не поверх строки
    setPos({ x: (cell.right + 6) / s, y: y / s });
  };
  return (
    <span className="peek-name" onMouseEnter={show} onMouseLeave={close}>
      {children}
      {pos &&
        createPortal(
          <div className="card-peek" style={{ left: pos.x, top: pos.y }} onMouseEnter={keep} onMouseLeave={close}>
            <div className="card-peek-zoom">
              <RobotCard modelId={modelId} />
            </div>
          </div>,
          document.getElementById('root') ?? document.body,
        )}
    </span>
  );
}

type Row = ReturnType<typeof computeRows>[number];

/** A quick run of soft crunches for a Shift-range selection: one per row (at most 10), tone rising a little. */
function ratchet(rows: number) {
  const n = Math.min(rows, 10);
  for (let i = 0; i < n; i++) crunch(i, 0.01 + i * 0.034);
}

function computeRows(w: World) {
  const rel = actualRelevance(w);
  const mine = robotsOf(w, PLAYER_ID);
  const openBrokers = w.brokers.filter((b) => !b.closed);
  return MODELS.map((m) => {
    const price = refPrice(w, m.id);
    const start = w.dayStartPrice[m.id] ?? price;
    const quotes = w.brokers.map((b) => ({ b, q: quote(w, b, m.id, rel) }));
    const offers = quotes.filter((x) => !x.b.closed && x.q.stock > 0).sort((x, y) => x.q.ask - y.q.ask);
    const perceived = openBrokers.length
      ? openBrokers.reduce((s, b) => s + b.perceived[m.id], 0) / openBrokers.length
      : rel[m.id];
    return {
      m,
      cls: classOf(m.id),
      price,
      change: ((price - start) / start) * 100,
      rel: rel[m.id],
      perceived,
      signal: rel[m.id] - perceived,
      wr: winRate(w.stats[m.id]),
      quotes,
      best: offers[0] ?? null,
      owned: mine.filter((x) => x.modelId === m.id).length,
    };
  });

}

function computeClassStats(w: World, rows: Row[]) {
  const hist = w.history.slice(-60);
  return CLASSES.map((c) => {
    const rs = rows.filter((r) => r.cls === c);
    const avg = (f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
    const index = avg((r) => r.price / r.m.basePrice); // 1 = base price
    const startIndex = avg((r) => (w.dayStartPrice[r.m.id] ?? r.price) / r.m.basePrice);
    const series = [
      ...hist.map((h) => rs.reduce((s, r) => s + (h.price[r.m.id] ?? r.price) / r.m.basePrice, 0) / rs.length),
      index,
    ];
    return { c, index, change: ((index - startIndex) / startIndex) * 100, rel: avg((r) => r.rel), wr: avg((r) => r.wr), series };
  });

}
