import { useEffect } from 'react';
import { DIVISIONS } from '../engine/league';
import { CLASS_LABEL, model, type RobotClass } from '../engine/robots';
import { PLAYER_ID, STRATEGY_LABEL, bestBid, getManager, isHuman, netWorth, robotsOf, sharePrice, type Manager, type World } from '../engine/world';
import { ClassTag, Cr } from '../ui/common';

const classOf = (modelId: string): RobotClass => (model(modelId).ability?.kind as RobotClass | undefined) ?? 'none';

/** A team's public profile, opened from the Ratings. Only what is public anyway: the record, the money, the robots
 *  it owns (on NEAR for players) — never the battle deck. */
export function Profile({ w, id, onClose }: { w: World; id: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const m = getManager(w, id);
  const human = isHuman(m);
  const contenders = (xs: Manager[]) => xs.filter((x) => !x.dev);
  const eloPlace = contenders([...w.managers].sort((a, b) => b.elo - a.elo)).findIndex((x) => x.id === id) + 1;
  const worthPlace = contenders([...w.managers].sort((a, b) => netWorth(w, b) - netWorth(w, a))).findIndex((x) => x.id === id) + 1;

  const robots = robotsOf(w, id);
  const robotValue = Math.round(robots.reduce((s, r) => s + (bestBid(w, r)?.price ?? 0), 0));
  const stakes = w.brokers
    .filter((b) => (b.shares[id] ?? 0) > 0)
    .map((b) => ({ b, value: Math.round((b.shares[id] ?? 0) * sharePrice(w, b)) }));
  const stakeValue = stakes.reduce((s, x) => s + x.value, 0);
  const games = m.wins + m.draws + m.losses;

  // the collection: models with counts, most valuable first
  const byModel = new Map<string, number>();
  for (const r of robots) byModel.set(r.modelId, (byModel.get(r.modelId) ?? 0) + 1);
  const models = [...byModel.entries()].sort((a, b) => model(b[0]).basePrice - model(a[0]).basePrice);
  const byClass = new Map<RobotClass, number>();
  for (const r of robots) byClass.set(classOf(r.modelId), (byClass.get(classOf(r.modelId)) ?? 0) + 1);

  // recent battles and market activity from the shared ledger
  const name = (x: string) => w.managers.find((y) => y.id === x)?.name ?? x;
  const battles = w.ledger.filter((e) => e.kind === 'match' && (e.from === id || e.to === id)).slice(-8).reverse();
  const trades = w.ledger.filter((e) => (e.kind === 'buy' && e.from === id) || (e.kind === 'sell' && e.to === id)).length;

  const div = human ? m.league?.div : m.div;
  const league = div !== undefined ? DIVISIONS[div] : undefined;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel profile" onClick={(e) => e.stopPropagation()}>
        <button className="profile-close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
        <div className="profile-head">
          <h2>{m.name}</h2>
          {m.dev && <span className="tag dev-tag">DEV</span>}
          {id === PLAYER_ID ? <span className="tag you-tag">YOU</span> : human ? <span className="tag human-tag">PLAYER</span> : <span className="tag bot-tag">BOT</span>}
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {human ? (
            id === PLAYER_ID ? (
              'Your team'
            ) : (
              <>
                NEAR account{' '}
                <a href={`https://testnet.nearblocks.io/address/${m.id}`} target="_blank" rel="noreferrer">
                  {m.id}
                </a>
              </>
            )
          ) : (
            <>
              A bot team · {STRATEGY_LABEL[m.strategy]} {m.focus && <ClassTag cls={m.focus} />} {m.focus2 && (m.div ?? 0) >= 2 && <ClassTag cls={m.focus2} />}
            </>
          )}
        </p>

        <div className="profile-stats">
          <div>
            <span>ELO</span>
            <b>{m.elo}</b>
            <small>{m.dev ? 'out of competition' : `#${eloPlace} Champions`}</small>
          </div>
          <div>
            <span>Online W/D/L</span>
            <b>
              {m.wins}/{m.draws}/{m.losses}
            </b>
            <small>{games ? `${Math.round((m.wins / games) * 100)}% wins` : 'no online battles yet'}</small>
          </div>
          <div>
            <span>Net worth</span>
            <b>{netWorth(w, m)} CR</b>
            <small>{m.dev ? 'out of competition' : `#${worthPlace} Magnates`}</small>
          </div>
          <div>
            <span>League</span>
            <b style={{ color: league?.color }}>{league?.name ?? '—'}</b>
            <small>{human && m.league?.crowns ? `👑 ×${m.league.crowns} Apex wins` : human ? 'climbing' : 'plays here'}</small>
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <div>
            <h3>Wealth</h3>
            <table>
              <tbody>
                <tr>
                  <td>Credits</td>
                  <td>
                    <Cr v={Math.round(m.credits)} />
                  </td>
                </tr>
                <tr>
                  <td>Robots (buyback)</td>
                  <td>
                    <Cr v={robotValue} />
                  </td>
                </tr>
                <tr>
                  <td>Broker stakes</td>
                  <td>
                    <Cr v={stakeValue} />
                  </td>
                </tr>
                {stakes.map(({ b, value }) => (
                  <tr key={b.id} className="muted">
                    <td>· {b.name}</td>
                    <td>
                      <Cr v={value} />
                    </td>
                  </tr>
                ))}
                <tr className="muted">
                  <td>Market trades</td>
                  <td>{trades}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3>Recent battles</h3>
            {battles.length === 0 ? (
              <p className="muted">None yet.</p>
            ) : (
              <table>
                <tbody>
                  {battles.map((e, i) => {
                    const opp = e.from === id ? e.to : e.from;
                    const res = e.note === 'draw' ? 'draw' : e.note === id ? 'win' : 'loss';
                    return (
                      <tr key={i}>
                        <td>vs {name(opp)}</td>
                        <td className={res === 'win' ? 'up' : res === 'loss' ? 'down' : 'muted'}>{res.toUpperCase()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <h3>
          Collection · {robots.length} {robots.length === 1 ? 'robot' : 'robots'}
        </h3>
        <p className="muted" style={{ marginTop: 0 }}>
          {[...byClass.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => `${CLASS_LABEL[c]} ${n}`)
            .join(' · ') || 'No robots.'}
          {human && id !== PLAYER_ID && ' — the robots it owns, not its battle deck (that stays secret).'}
        </p>
        <div className="profile-models">
          {models.map(([mid, n]) => (
            <span key={mid} className="tag">
              <ClassTag modelId={mid} /> {model(mid).name}
              {n > 1 && ` ×${n}`}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
