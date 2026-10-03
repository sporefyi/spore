import { useState } from 'react';
import { Eyebrow, Rule } from './primitives';
import { PRIMARY_CHAIN } from '../chains';

const API_URL =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_INDEXER_URL ?? '';

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; step: string }
  | { kind: 'done'; agentId: string; txHash: string }
  | { kind: 'error'; message: string };

const inputCls =
  'w-full border border-rule bg-bg px-4 py-3 font-mono text-sm text-ink placeholder:text-faint focus:border-fungal focus:outline-none';

/**
 * "Bring your Orbio agent" — sign in with an Orbio API key (verified once
 * against api.orbio.so, never stored) and register the agent on the
 * SporeRegistry. Gas is sponsored; ownership goes to the wallet given.
 */
export default function OrbioOnboard() {
  const [open, setOpen] = useState(false);
  const [orbioKey, setOrbioKey] = useState('');
  const [agentName, setAgentName] = useState('');
  const [ownerAddress, setOwnerAddress] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function submit() {
    setStatus({ kind: 'working', step: 'Verifying your Orbio key…' });
    try {
      const res = await fetch(`${API_URL}/api/v1/onboard/orbio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orbioKey: orbioKey.trim(),
          agentName: agentName.trim(),
          ownerAddress: ownerAddress.trim(),
        }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const err = data.error as { code?: string; message?: string } | undefined;
        const msg =
          err?.code === 'invalid_orbio_key'
            ? 'That Orbio API key was not recognized. Check it and try again.'
            : err?.code === 'rate_limited'
              ? 'Too many attempts — wait a bit and try again.'
              : (err?.message ?? 'Something went wrong.');
        setStatus({ kind: 'error', message: msg });
        return;
      }
      setStatus({
        kind: 'working',
        step: 'Key verified. Registering on-chain…',
      });
      // The endpoint already registered; surface the result.
      setStatus({
        kind: 'done',
        agentId: String(data.agentId),
        txHash: String(data.txHash),
      });
    } catch {
      setStatus({
        kind: 'error',
        message: 'Could not reach the SPORE API. Try again.',
      });
    }
  }

  const valid =
    orbioKey.trim().length >= 10 &&
    agentName.trim().length >= 1 &&
    /^0x[0-9a-fA-F]{40}$/.test(ownerAddress.trim());

  return (
    <div className="mt-16">
      <Rule />
      <div className="mt-10">
        <Eyebrow>Orbio agents</Eyebrow>
        <h2 className="display mt-6 font-serif text-3xl text-ink md:text-4xl">
          Bring your Orbio agent.
        </h2>
        <p className="mt-4 max-w-2xl leading-relaxed text-muted">
          Run an agent through Orbio? Sign in with your Orbio API key and
          we&apos;ll register it on the SporeRegistry — gas sponsored, ownership
          transferred to your wallet. Your key is verified once and never
          stored.
        </p>
        {!open ? (
          <button
            onClick={() => setOpen(true)}
            className="mt-8 border border-fungal px-8 py-4 font-mono text-[13px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal hover:text-bg"
          >
            Bring your Orbio agent
          </button>
        ) : (
          <div className="mt-8 max-w-xl border border-rule p-6 md:p-8">
            {status.kind === 'done' ? (
              <div>
                <div className="font-mono text-[12px] uppercase tracking-widest text-moss">
                  Agent registered
                </div>
                <p className="mt-4 font-serif text-2xl text-ink">
                  Agent #{status.agentId} is on-chain.
                </p>
                <p className="mt-3 text-sm text-muted">
                  Ownership transferred to your wallet. It will appear in the{' '}
                  <a href="/agents" className="text-fungal underline underline-offset-4">
                    registry
                  </a>{' '}
                  once indexed.
                </p>
                <a
                  href={`${PRIMARY_CHAIN.explorerUrl}/tx/${status.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-block font-mono text-[12px] uppercase tracking-widest text-faint underline underline-offset-4 hover:text-ink"
                >
                  View transaction ↗
                </a>
              </div>
            ) : (
              <div className="space-y-5">
                <div>
                  <label className="font-mono text-[11px] uppercase tracking-widest text-faint">
                    Orbio API key
                  </label>
                  <input
                    type="password"
                    value={orbioKey}
                    onChange={(e) => setOrbioKey(e.target.value)}
                    placeholder="orb_…"
                    autoComplete="off"
                    className={`${inputCls} mt-2`}
                  />
                  <p className="mt-2 text-xs text-faint">
                    From your Orbio dashboard. Verified once, never stored.
                  </p>
                </div>
                <div>
                  <label className="font-mono text-[11px] uppercase tracking-widest text-faint">
                    Agent name
                  </label>
                  <input
                    type="text"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder="My Orbio agent"
                    maxLength={64}
                    className={`${inputCls} mt-2`}
                  />
                </div>
                <div>
                  <label className="font-mono text-[11px] uppercase tracking-widest text-faint">
                    Your wallet address
                  </label>
                  <input
                    type="text"
                    value={ownerAddress}
                    onChange={(e) => setOwnerAddress(e.target.value)}
                    placeholder="0x…"
                    autoComplete="off"
                    className={`${inputCls} mt-2`}
                  />
                  <p className="mt-2 text-xs text-faint">
                    On {PRIMARY_CHAIN.name} — becomes the on-chain owner.
                  </p>
                </div>
                {status.kind === 'error' && (
                  <p className="text-sm text-ember">{status.message}</p>
                )}
                {status.kind === 'working' && (
                  <p className="font-mono text-[12px] uppercase tracking-widest text-faint">
                    {status.step}
                  </p>
                )}
                <button
                  onClick={submit}
                  disabled={!valid || status.kind === 'working'}
                  className="w-full border border-fungal px-8 py-4 font-mono text-[13px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal hover:text-bg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fungal"
                >
                  {status.kind === 'working' ? 'Working…' : 'Sign in with Orbio & register'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
