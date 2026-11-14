// One-off tool (localhost only): link the public site's email login to an older NEAR Auth account.
// Open http://localhost:3000/?link-account=ginger&from=ginger-3 — you sign in with NEAR Auth (the key that owns
// `ginger`) and approve ONE transaction that adds the email login's key (the full-access key of `ginger-3`) to
// `ginger`. After that the contract owner points the email login at `ginger` and merges the duplicates into it.

import { useEffect, useState } from 'react';
import { JsonRpcProvider, PublicKey, actions, baseDecode, createTransaction } from 'near-api-js';
import { CONTRACT_ID, RPC_URL } from '../near/config';
import { nearAuthClient } from '../near/chain';

const provider = new JsonRpcProvider({ url: RPC_URL });
type Signer = Awaited<ReturnType<Awaited<ReturnType<typeof nearAuthClient>>['getSigner']>>;
const full = (name: string) => (name.includes('.') ? name : `${name}.${CONTRACT_ID}`);

async function keysOf(accountId: string) {
  const r = (await provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: accountId })) as unknown as {
    keys: { public_key: string; access_key: { nonce: number | string; permission: unknown } }[];
  };
  return r.keys;
}

export function LinkAccount() {
  const q = new URLSearchParams(location.search);
  const target = full(q.get('link-account') ?? '');
  const from = full(q.get('from') ?? '');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState<Awaited<ReturnType<typeof nearAuthClient>> | null>(null);
  const say = (s: string) => setLog((l) => [...l, s]);
  // load the NEAR Auth SDK up front, so that button 1 opens its window straight from the click
  useEffect(() => {
    nearAuthClient().then(setClient, (e) => say(`✖ ${e instanceof Error ? e.message : String(e)}`));
  }, []);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      say(`✖ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Browsers only allow the NEAR Auth window to open right from a click, so everything that needs the network
  // happens before: signing in loads the signer and builds the transaction; button 2 only opens the window.
  const [prepared, setPrepared] = useState<{ signer: Signer; tx: ReturnType<typeof createTransaction> } | null>(null);

  const signIn = () =>
    step(async () => {
      const c = client ?? (await nearAuthClient());
      setClient(c);
      await c.login();
      const signer = await c.getSigner();
      const pub = String(await signer.getPublicKey());
      const keys = await keysOf(target);
      const ak = keys.find((k) => k.public_key === pub);
      if (!ak) throw new Error(`This NEAR Auth login (${pub.slice(0, 16)}…) is not a key of ${target}`);
      say(`✔ Signed in — your NEAR Auth key owns ${target}`);
      const emailKey = (await keysOf(from)).find((k) => k.access_key.permission === 'FullAccess')?.public_key;
      if (!emailKey) throw new Error(`No email-login key found on ${from}`);
      if (keys.some((k) => k.public_key === emailKey)) {
        say('✔ The email login key is already on the account — nothing to sign');
        return;
      }
      const block = (await provider.viewBlock({ finality: 'final' })) as unknown as { header: { hash: string } };
      const tx = createTransaction(
        target,
        PublicKey.fromString(pub),
        target,
        BigInt(ak.access_key.nonce) + 1n,
        [actions.addFullAccessKey(PublicKey.fromString(emailKey))],
        baseDecode(block.header.hash),
      );
      setPrepared({ signer, tx });
      say('✔ Transaction ready — now press 2');
    });

  // no awaits before requestTransactionSignature: it must open its window inside the click
  const approve = () => {
    if (!prepared) return;
    const { signer, tx } = prepared;
    setBusy(true);
    say('… approve the transaction in the NEAR Auth window');
    signer
      .requestTransactionSignature({ transaction: tx } as never)
      .then(async () => {
        const { signatureRequest } = await signer.getSignatureRequest();
        say('… asking the NEAR MPC network to sign');
        const res = await fetch('/api/near/fastauth-sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...signatureRequest, signPayload: Array.from(signatureRequest.signPayload as ArrayLike<number>) }),
        });
        const out = (await res.json()) as { signature?: string; error?: string };
        if (!res.ok || !out.signature) throw new Error(out.error ?? 'No signature');
        const { FastAuthSignature } = await import('@fast-auth-near/browser-sdk');
        const result = (await signer.sendTransaction(tx as never, FastAuthSignature.fromBase64(out.signature))) as {
          transaction?: { hash?: string };
        };
        say(`✔ Done — the email login key was added to ${target}${result?.transaction?.hash ? ` (tx ${result.transaction.hash})` : ''}`);
        setPrepared(null);
      })
      .catch((e) => say(`✖ ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="panel login" style={{ maxWidth: 640 }}>
      <h2>Link your email login</h2>
      <p className="muted">
        Adds the public site's email login (the key of <b>{from}</b>) to <b>{target}</b>, so that signing in with your email
        opens <b>{target}</b>. You approve one transaction with the NEAR Auth login that owns {target}.
      </p>
      <div className="grid">
        <button className="primary" disabled={busy || !!prepared || !client} onClick={signIn}>
          1 · Sign in with NEAR Auth
        </button>
        <button className="primary" disabled={busy || !prepared} onClick={approve}>
          2 · Approve adding the email login to {target.split('.')[0]}
        </button>
      </div>
      <pre style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{log.join('\n')}</pre>
    </div>
  );
}
