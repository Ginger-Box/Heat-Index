// Email login on the public site: Privy sends a 6-digit code, then the Worker creates (or reopens) the player's
// NEAR account — see near/chain.ts → finishPrivyLogin and web/src/index.ts. Uses Privy's headless core SDK (our
// own form, no Privy modal and no wallet code). Loaded lazily, only on the public site.

import Privy, { LocalStorage } from '@privy-io/js-sdk-core';
import { useEffect, useState } from 'react';
import { finishPrivyLogin } from '../near/chain';
import { PRIVY_APP_ID } from '../near/config';

interface Props {
  name: string;
  onDone: () => void;
  onError: (msg: string | null) => void;
}

let client: Privy | null = null;
let ready: Promise<void> | null = null;
function privy() {
  client ??= new Privy({ appId: PRIVY_APP_ID, storage: new LocalStorage() });
  ready ??= client.initialize();
  return { client, ready };
}

/** The current Privy login's access token (for the self-custody hand-over), or null when it has expired. */
export async function privyAccessToken(): Promise<string | null> {
  const { client, ready } = privy();
  await ready;
  return client.getAccessToken();
}

export default function PrivyEmail({ name, onDone, onError }: Props) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'loading' | 'email' | 'code'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    privy()
      .ready.then(() => setStep('email'))
      .catch((e) => {
        onError(`Email login is unavailable: ${e instanceof Error ? e.message : String(e)}`);
        setStep('email');
      });
  }, [onError]);

  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'loading') return <small className="muted">Loading email login…</small>;
  return step === 'email' ? (
    <form
      className="privy-form"
      onSubmit={(e) => {
        e.preventDefault();
        go(async () => {
          const { client, ready } = privy();
          await ready;
          await client.auth.email.sendCode(email.trim());
          setStep('code');
        });
      }}
    >
      <input type="email" required placeholder="your@email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      <button type="submit" className="primary" disabled={busy || !email.includes('@')}>
        {busy ? 'Sending the code…' : '✉ Send me a login code'}
      </button>
    </form>
  ) : (
    <form
      className="privy-form"
      onSubmit={(e) => {
        e.preventDefault();
        go(async () => {
          const { client } = privy();
          await client.auth.email.loginWithCode(email.trim(), code.trim());
          const token = await client.getAccessToken();
          if (!token) throw new Error('No login token from Privy — please try again');
          await finishPrivyLogin(token, name);
          onDone();
        });
      }}
    >
      <small className="muted">A 6-digit code was sent to {email}.</small>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        placeholder="123456"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        autoFocus
      />
      <button type="submit" className="primary" disabled={busy || code.length < 6}>
        {busy ? 'Opening your NEAR account…' : 'Enter the arena'}
      </button>
      <button type="button" className="login-offline" disabled={busy} onClick={() => setStep('email')}>
        another email
      </button>
    </form>
  );
}
