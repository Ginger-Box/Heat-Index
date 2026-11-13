// NEAR in the interface: a HUD cell with the player's account and a status LED, and a drop-down panel with the
// on-chain balance, the latest game transactions (links to the explorer) and the login buttons.

import { useEffect, useReducer, useRef, useState } from 'react';
import { sfx } from '../audio';
import { PLAYER_ID } from '../engine/world';
import { getWorld } from '../store';
import {
  accountUrl,
  chainCredits,
  chainSession,
  chainTxs,
  emailLoginAvailable,
  loginWithEmail,
  loginWithWallet,
  onChain,
  signOutChain,
  txUrl,
} from '../near/chain';
import { linkRobots } from '../near/bridge';
import { CONTRACT_ID, NEAR_AUTH } from '../near/config';

export function useChain() {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => onChain(bump), []);
  return { session: chainSession(), txs: chainTxs() };
}

const short = (id: string) => (id.length > 22 ? `${id.slice(0, 10)}…${id.slice(-10)}` : id);

/** Login buttons shared by the login screen and the HUD panel. */
export function NearLogin({ name, onDone }: { name: string; onDone?: () => void }) {
  const [busy, setBusy] = useState<null | 'email' | 'wallet'>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (kind: 'email' | 'wallet') => {
    setBusy(kind);
    setErr(null);
    try {
      if (kind === 'email') {
        // null = the page is going to the login page (no popups here) and will finish when it comes back
        if ((await loginWithEmail(name || 'player')) === null) return;
      } else await loginWithWallet();
      onDone?.();
      if (getWorld()) await linkRobots();
      sfx('ui-buy');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      sfx('ui-error');
    } finally {
      setBusy(null);
    }
  };
  const emailOk = emailLoginAvailable();
  return (
    <div className="near-login">
      <button
        className="primary"
        type="button"
        disabled={!!busy || !emailOk}
        title={emailOk ? 'NEAR Auth: email, Google or passkey — a NEAR account is created for you' : `Email login runs on ${NEAR_AUTH.origin}`}
        onClick={() => run('email')}
      >
        {busy === 'email' ? 'Creating your account…' : '✉ Continue with email'}
      </button>
      <button type="button" disabled={!!busy} onClick={() => run('wallet')}>
        {busy === 'wallet' ? 'Waiting for the wallet…' : '◈ Connect NEAR wallet'}
      </button>
      {!emailOk && <small className="muted">Email login (NEAR Auth testnet) works when the game runs on {NEAR_AUTH.origin}.</small>}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

/** HUD cell + drop-down panel. */
export function NearCell() {
  const { session, txs } = useChain();
  const [open, setOpen] = useState(false);
  const [cr, setCr] = useState<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const pending = txs.some((t) => t.status === 'pending');
  const failed = txs[0]?.status === 'error';
  useEffect(() => {
    if (!open || !session) return;
    chainCredits(session.accountId).then(setCr, () => setCr(null));
  }, [open, session, txs.length, txs[0]?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const w = getWorld();
  const linked = w ? Object.values(w.robots).filter((r) => r.owner === PLAYER_ID && r.chainId).length : 0;
  const name = w?.managers.find((m) => m.id === PLAYER_ID)?.name ?? '';

  return (
    <div className="hud-cell near" ref={box} title="Your NEAR account and on-chain activity">
      <span className={pending ? 'led-pending' : failed ? 'led-error' : session ? '' : 'led-off'}>NEAR</span>
      <button className="near-btn" data-sfx="open" onClick={() => setOpen(!open)}>
        {session ? short(session.accountId) : 'OFF-CHAIN'}
      </button>
      {open && (
        <div className="near-panel">
          {session ? (
            <>
              <div className="near-row">
                <span className="muted">Account</span>
                <a href={accountUrl(session.accountId)} target="_blank" rel="noreferrer">
                  {session.accountId}
                </a>
              </div>
              <div className="near-row">
                <span className="muted">On-chain credits</span>
                <b className="cr">{cr === null ? '…' : `${cr} CR`}</b>
              </div>
              <div className="near-row">
                <span className="muted">Robots on-chain</span>
                <b>{linked}</b>
              </div>
              <div className="near-row">
                <span className="muted">Contract</span>
                <a href={accountUrl(CONTRACT_ID)} target="_blank" rel="noreferrer">
                  {CONTRACT_ID}
                </a>
              </div>
              <h4>Latest transactions</h4>
              <div className="near-txs">
                {txs.length === 0 && <span className="muted">Buy, sell, repair or fight — every move is written here.</span>}
                {txs.slice(0, 8).map((t) => (
                  <div key={t.id} className={`near-tx ${t.status}`} title={t.error}>
                    <i />
                    {t.hash ? (
                      <a href={txUrl(t.hash)} target="_blank" rel="noreferrer">
                        {t.label}
                      </a>
                    ) : (
                      <span>{t.label}</span>
                    )}
                  </div>
                ))}
              </div>
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <button className="small" onClick={() => void linkRobots()}>
                  Sync robots
                </button>
                <button className="small" onClick={() => signOutChain()}>
                  Disconnect
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Put your robots and credits on NEAR testnet: every trade and battle becomes a transaction, robots are
                NEP-245 tokens you own.
              </p>
              <NearLogin name={name} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
