import { PLAYER_ID, STRATEGY_LABEL, netWorth, type World } from '../engine/world';
import { ClassTag, Cr, Glitch } from '../ui/common';

export function Ratings({ w }: { w: World }) {
  const champs = [...w.managers].sort((a, b) => b.elo - a.elo);
  const mags = w.managers.map((m) => ({ m, worth: netWorth(w, m) })).sort((a, b) => b.worth - a.worth);
  const hl = (id: string) => (id === PLAYER_ID ? { background: '#22e3ff18', fontWeight: 700 } : undefined);
  return (
    <div className="grid">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
        <div className="panel">
          <h2>⚔️ Champions</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            ELO rating from battles. The top 3 at season end get 300 / 200 / 100 CR.
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Team</th>
                <th>ELO</th>
                <th>W/D/L</th>
              </tr>
            </thead>
            <tbody>
              {champs.map((m, i) => (
                <tr key={m.id} style={hl(m.id)}>
                  <td>{i + 1}</td>
                  <td title={STRATEGY_LABEL[m.strategy]}>
                    {m.name} {m.focus && <ClassTag cls={m.focus} />}
                  </td>
                  <td>
                    <Glitch text={m.elo} />
                  </td>
                  <td className="muted">
                    {m.wins}/{m.draws}/{m.losses}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>💰 Magnates</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Net worth = credits + robots at buyback price + broker shares. The top 3 get 300 / 200 / 100 CR.
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Team</th>
                <th>Net worth</th>
                <th>Strategy</th>
              </tr>
            </thead>
            <tbody>
              {mags.map(({ m, worth }, i) => (
                <tr key={m.id} style={hl(m.id)}>
                  <td>{i + 1}</td>
                  <td>{m.name}</td>
                  <td>
                    <Cr v={worth} />
                  </td>
                  <td className="muted">{STRATEGY_LABEL[m.strategy].split(':')[0]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {w.seasons.length > 0 && (
        <div className="panel">
          <h2>Past seasons</h2>
          <table>
            <thead>
              <tr>
                <th>Season</th>
                <th>Champions</th>
                <th>Magnates</th>
              </tr>
            </thead>
            <tbody>
              {[...w.seasons].reverse().map((s) => (
                <tr key={s.season}>
                  <td>{s.season}</td>
                  <td>{s.champions.map((c) => `${c.name} (${c.elo})`).join(', ')}</td>
                  <td>{s.magnates.map((c) => `${c.name} (${c.worth} CR)`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
