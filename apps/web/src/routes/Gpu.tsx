import { useEffect, useState } from 'react';
import { Eyebrow, Rule, Reveal } from '../shared/components/primitives';
import { useWallet } from '../shared/wallet/useWallet';
import ConnectButton from '../shared/wallet/ConnectButton';
import { indexerApiBase } from '../shared/data/providers';
import { explorerTxUrl, MARKET_MERCHANT, SPORE, USDG } from '../shared/chains';

const PRICE = '1';
const MODEL_LABEL = 'Flux Schnell';

type Phase = 'idle' | 'paying' | 'paid' | 'submitting' | 'done' | 'error';

interface ApiError {
  code: string;
  message: string;
}

function friendlyError(code: string, message: string): string {
  switch (code) {
    case 'payment_not_found':
      return 'Payment not found on-chain yet. Wait for the transfer to confirm, then submit again.';
    case 'already_used':
      return 'This payment was already used. Pay again for another image.';
    case 'rate_limited':
      return 'Rate limited. Wait a moment and try again.';
    case 'not_configured':
      return 'The GPU merchant is not configured right now.';
    case 'generation_failed':
      return 'Image generation failed. Try again with a different prompt.';
    case 'budget_exhausted':
      return 'The rental budget is exhausted — pick a cheaper GPU.';
    case 'provision_failed':
      return 'GPU provisioning failed. Your payment was not consumed — try again.';
    default:
      return message || 'Request failed.';
  }
}

async function marketPost(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: any } | { ok: false; error: ApiError }> {
  const base = indexerApiBase();
  if (!base) {
    return { ok: false, error: { code: 'not_configured', message: 'Market API is not configured.' } };
  }
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: { code: 'network_error', message: 'Could not reach the market API.' } };
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: String(json?.code ?? `http_${res.status}`),
        message: String(json?.message ?? json?.error ?? 'Request failed.'),
      },
    };
  }
  return { ok: true, data: json };
}

const inputClass =
  'w-full border border-rule bg-bg px-3 py-2 font-mono text-sm text-ink placeholder:text-faint focus:border-fungal/60 focus:outline-none';

const buttonClass =
  'w-full border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50';

export default function Gpu() {
  useEffect(() => {
    document.title = 'SPORE — GPU';
  }, []);

  const wallet = useWallet();
  const apiBase = indexerApiBase();
  const connected = wallet.status === 'connected';

  const [phase, setPhase] = useState<Phase>('idle');
  const [prompt, setPrompt] = useState('');
  const [paymentTx, setPaymentTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [cached, setCached] = useState(false);

  const paying = phase === 'paying';
  const submitting = phase === 'submitting';

  const onPay = () => {
    setError(null);
    setImages([]);
    setCached(false);
    setPhase('paying');
    wallet
      .payUsdg(PRICE)
      .then((hash) => {
        setPaymentTx(hash);
        setPhase('paid');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Payment failed.');
        setPhase('error');
      });
  };

  const onGenerate = () => {
    if (!paymentTx || prompt.trim().length === 0) return;
    setError(null);
    setPhase('submitting');
    void marketPost('/market/gpu', { prompt: prompt.trim(), paymentTx }).then((res) => {
      if (res.ok) {
        setImages(Array.isArray(res.data.images) ? res.data.images : []);
        setCached(Boolean(res.data.cached));
        setPhase('done');
      } else {
        setError(friendlyError(res.error.code, res.error.message));
        // Only already_used consumes the payment — other failures leave the
        // tx hash usable, so the buyer can fix the prompt and retry.
        setPhase(res.error.code === 'already_used' ? 'error' : 'paid');
      }
    });
  };

  const reset = () => {
    setPhase('idle');
    setPaymentTx(null);
    setError(null);
    setImages([]);
    setCached(false);
  };

  return (
    <div className="bg-bg text-ink">
      <header className="mx-auto max-w-3xl px-4 pt-24 md:px-8">
        <div className="mt-6">
          <Eyebrow>GPU market</Eyebrow>
        </div>
        <h1 className="display mt-6 font-serif text-4xl leading-tight text-ink md:text-6xl">
          GPU.
        </h1>
        <p className="mt-8 max-w-2xl font-serif text-xl leading-relaxed text-muted">
          Text-to-image generation on {MODEL_LABEL} — {PRICE} {USDG.symbol} per image.
          Pay the verified merchant on-chain, then describe what you want to see.
        </p>
      </header>

      <section className="mx-auto mt-16 max-w-3xl px-4 pb-32 md:px-8">
        <Rule />
        <Reveal>
          <div className="mt-10">
            <ConnectButton wallet={wallet} />
          </div>

          {apiBase === null ? (
            <p className="mt-10 border border-rule p-6 font-mono text-[12px] text-ember">
              The market API is not configured in this build — image generation is unavailable.
            </p>
          ) : (
            <div className="mt-10 border border-rule p-6">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="font-serif text-xl text-ink">{MODEL_LABEL}</h2>
                <span className="tnum whitespace-nowrap font-mono text-sm text-fungal">
                  {PRICE} {USDG.symbol}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Payment goes to the verified merchant{' '}
                <span className="font-mono text-[12px] text-ink">
                  {MARKET_MERCHANT.slice(0, 6)}…{MARKET_MERCHANT.slice(-4)}
                </span>
                . Each payment hash works exactly once.
              </p>
              <span aria-hidden="true" className="mt-4 h-px w-full bg-rule" />

              {(phase === 'idle' || phase === 'error' || phase === 'paying') && (
                <div className="mt-4">
                  <button
                    type="button"
                    disabled={!connected || paying}
                    onClick={onPay}
                    className={buttonClass}
                  >
                    {paying ? 'Waiting for wallet…' : `Pay ${PRICE} ${USDG.symbol}`}
                  </button>
                  {!connected && wallet.status !== 'no-provider' && (
                    <p className="mt-2 font-mono text-[11px] text-faint">
                      Connect your wallet above to buy.
                    </p>
                  )}
                </div>
              )}

              {(phase === 'paid' || phase === 'submitting' || phase === 'done') && paymentTx && (
                <div className="mt-4">
                  <p className="break-all font-mono text-[11px] leading-relaxed text-muted">
                    Paid:{' '}
                    <a
                      href={explorerTxUrl(paymentTx)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-fungal underline decoration-fungal/40 underline-offset-4 hover:decoration-fungal"
                    >
                      {paymentTx.slice(0, 10)}…{paymentTx.slice(-8)}
                    </a>
                  </p>

                  {phase !== 'done' && (
                    <div className="mt-4 space-y-3">
                      <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="Describe the image…"
                        rows={4}
                        maxLength={500}
                        className={inputClass}
                      />
                      <button
                        type="button"
                        disabled={submitting || prompt.trim().length === 0}
                        onClick={onGenerate}
                        className={buttonClass}
                      >
                        {submitting ? 'Generating…' : 'Generate image'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {phase === 'done' && (
                <div className="mt-4 space-y-3 border-t border-rule pt-4">
                  {cached && (
                    <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
                      Served from cache for this payment
                    </p>
                  )}
                  {images.length === 0 && (
                    <p className="text-sm text-muted">No images returned.</p>
                  )}
                  {images.map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt={`Generated image ${i + 1}`}
                      className="w-full border border-rule"
                    />
                  ))}
                  <button
                    type="button"
                    onClick={reset}
                    className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint transition-colors hover:text-ink"
                  >
                    Buy again
                  </button>
                </div>
              )}

              {error && (
                <p className="mt-4 border-t border-rule pt-4 font-mono text-[11px] leading-relaxed text-ember">
                  {error}
                </p>
              )}
            </div>
          )}
        </Reveal>
      </section>

      <RentSection />
    </div>
  );
}

interface CatalogGpu {
  id: string;
  display: string;
  vramGb: number | null;
  community: boolean;
  pricePerHr: number;
  sporePerHr: number | null;
}

function fmtSpore(n: number): string {
  return Math.ceil(n).toLocaleString('en-US');
}

type RentPhase = 'idle' | 'paying' | 'paid' | 'submitting' | 'done' | 'error';

function RentSection() {
  const wallet = useWallet();
  const apiBase = indexerApiBase();
  const connected = wallet.status === 'connected';

  const [gpus, setGpus] = useState<CatalogGpu[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hours, setHours] = useState(1);
  const [phase, setPhase] = useState<RentPhase>('idle');
  const [paymentTx, setPaymentTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rental, setRental] = useState<any>(null);
  const [statusInfo, setStatusInfo] = useState<any>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!apiBase) return;
    let cancelled = false;
    void fetch(apiBase + '/market/gpu/catalog', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`http ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        const list: CatalogGpu[] = Array.isArray(json.gpus) ? json.gpus : [];
        setGpus(list);
        if (!selected && list.length > 0) {
          const cheap = list[0];
          setSelected(cheap.id);
        }
      })
      .catch(() => {
        if (!cancelled) setCatalogError('Could not load the GPU catalog.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const gpu = gpus?.find((g) => g.id === selected) ?? null;
  const priceSpore = gpu && gpu.sporePerHr != null ? Math.ceil(gpu.sporePerHr * hours) : 0;
  const priceStr = priceSpore.toLocaleString('en-US');

  const onPay = () => {
    setError(null);
    setRental(null);
    setStatusInfo(null);
    setPhase('paying');
    wallet
      .paySpore(String(priceSpore))
      .then((hash) => {
        setPaymentTx(hash);
        setPhase('paid');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Payment failed.');
        setPhase('error');
      });
  };

  const onRent = () => {
    if (!paymentTx || !gpu) return;
    setError(null);
    setPhase('submitting');
    void marketPost('/market/gpu/rent', { gpuTypeId: gpu.id, hours, paymentTx }).then((res) => {
      if (res.ok) {
        setRental(res.data);
        setPhase('done');
      } else {
        setError(friendlyError(res.error.code, res.error.message));
        setPhase(res.error.code === 'already_used' ? 'error' : 'paid');
      }
    });
  };

  const onCheckStatus = () => {
    if (!rental?.id || !apiBase) return;
    setChecking(true);
    void fetch(apiBase + '/market/gpu/rentals/' + rental.id, {
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        setStatusInfo(json);
      })
      .catch(() => setStatusInfo(null))
      .finally(() => setChecking(false));
  };

  const reset = () => {
    setPhase('idle');
    setPaymentTx(null);
    setError(null);
    setRental(null);
    setStatusInfo(null);
  };

  return (
    <section className="mx-auto max-w-3xl px-4 pb-32 md:px-8">
      <Rule />
      <Reveal>
        <div className="mt-6">
          <Eyebrow>Rent a GPU</Eyebrow>
        </div>
        <h2 className="display mt-6 font-serif text-3xl leading-tight text-ink md:text-4xl">
          Real GPUs, by the hour.
        </h2>
        <p className="mt-6 max-w-2xl font-sans text-sm leading-relaxed text-muted">
          Live RunPod capacity — pick a GPU, pay in {SPORE.symbol}, get SSH and Jupyter
          access to a running pod. Prices are the real per-hour rates; you pay for the
          hours you rent.
        </p>
      </Reveal>

      <div className="mt-10">
        {catalogError && (
          <p className="border border-rule p-6 font-mono text-[12px] text-ember">{catalogError}</p>
        )}
        {!catalogError && gpus === null && (
          <p className="font-mono text-[12px] text-faint">Loading GPU catalog…</p>
        )}
        {gpus && gpus.length === 0 && (
          <p className="font-mono text-[12px] text-ember">No GPUs available right now.</p>
        )}
        {gpus && gpus.length > 0 && (
          <div>
            <div className="grid gap-3 md:grid-cols-2">
              {gpus.map((g) => {
                const active = g.id === selected;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelected(g.id)}
                    className={[
                      'border p-4 text-left transition-colors',
                      active ? 'border-fungal/70 bg-fungal/5' : 'border-rule hover:border-fungal/40',
                    ].join(' ')}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-serif text-lg text-ink">{g.display}</span>
                      <span className="tnum whitespace-nowrap font-mono text-sm text-fungal">
                        {g.sporePerHr != null ? `${fmtSpore(g.sporePerHr)} ${SPORE.symbol}/hr` : '—'}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted">
                      {g.vramGb != null ? `${g.vramGb} GB VRAM` : 'GPU'}
                      {g.community ? ' · community' : ' · secure'}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 border border-rule p-6">
              <div className="flex flex-wrap items-center gap-4">
                <label className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
                  Hours
                </label>
                <select
                  value={hours}
                  onChange={(e) => setHours(parseInt(e.target.value, 10))}
                  className="border border-rule bg-bg px-3 py-2 font-mono text-sm text-ink focus:border-fungal/60 focus:outline-none"
                >
                  {[1, 2, 3, 4, 6, 8, 12].map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                <span className="tnum ml-auto font-mono text-sm text-ink">
                  Total: {priceStr} {SPORE.symbol}
                  {gpu && (
                    <span className="ml-2 text-[11px] text-faint">
                      ≈ ${(gpu.pricePerHr * hours).toFixed(2)}
                    </span>
                  )}
                </span>
              </div>

              {(phase === 'idle' || phase === 'error' || phase === 'paying') && (
                <div className="mt-4">
                  <button
                    type="button"
                    disabled={!connected || phase === 'paying' || !gpu}
                    onClick={onPay}
                    className={buttonClass}
                  >
                    {phase === 'paying' ? 'Waiting for wallet…' : `Pay ${priceStr} ${SPORE.symbol}`}
                  </button>
                  {!connected && wallet.status !== 'no-provider' && (
                    <p className="mt-2 font-mono text-[11px] text-faint">
                      Connect your wallet above to rent.
                    </p>
                  )}
                </div>
              )}

              {(phase === 'paid' || phase === 'submitting') && paymentTx && (
                <div className="mt-4">
                  <p className="break-all font-mono text-[11px] leading-relaxed text-muted">
                    Paid:{' '}
                    <a
                      href={explorerTxUrl(paymentTx)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-fungal underline decoration-fungal/40 underline-offset-4 hover:decoration-fungal"
                    >
                      {paymentTx.slice(0, 10)}…{paymentTx.slice(-8)}
                    </a>
                  </p>
                  <button
                    type="button"
                    disabled={phase === 'submitting'}
                    onClick={onRent}
                    className={buttonClass + ' mt-4'}
                  >
                    {phase === 'submitting'
                      ? 'Provisioning GPU…'
                      : `Rent ${gpu?.display} for ${hours}h`}
                  </button>
                </div>
              )}

              {phase === 'done' && rental && (
                <div className="mt-4 space-y-3 border-t border-rule pt-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-moss">
                    Pod provisioning
                  </p>
                  <p className="break-all font-mono text-xs text-ink">
                    Pod {String(rental.podId)} · {String(rental.gpu)} · {String(rental.hours)}h ·{' '}
                    {Number(String(rental.priceSpore)).toLocaleString('en-US', {
                      maximumFractionDigits: 0,
                    })}{' '}
                    {SPORE.symbol}
                  </p>
                  <p className="font-mono text-[11px] text-muted">
                    Expires {new Date(String(rental.expiresAt)).toLocaleString()}. Check status
                    for SSH/Jupyter access once the pod is running.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      disabled={checking}
                      onClick={onCheckStatus}
                      className="border border-fungal/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
                    >
                      {checking ? 'Checking…' : 'Check status'}
                    </button>
                    <button
                      type="button"
                      onClick={reset}
                      className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint transition-colors hover:text-ink"
                    >
                      Rent another
                    </button>
                  </div>
                  {statusInfo && (
                    <div className="border border-rule bg-ink/[0.03] p-4 font-mono text-[11px] leading-relaxed text-muted">
                      <p>
                        Status: <span className="text-ink">{String(statusInfo.status ?? '—')}</span>
                      </p>
                      {statusInfo.access?.ssh && (
                        <p className="mt-2 break-all">
                          SSH: <span className="text-ink">{String(statusInfo.access.ssh)}</span>
                        </p>
                      )}
                      {statusInfo.access?.jupyter && (
                        <p className="mt-1 break-all">
                          Jupyter:{' '}
                          <a
                            href={String(statusInfo.access.jupyter)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-fungal underline decoration-fungal/40 underline-offset-4"
                          >
                            {String(statusInfo.access.jupyter)}
                          </a>
                        </p>
                      )}
                      {!statusInfo.access?.ssh && (
                        <p className="mt-2">Access details appear once the pod is running.</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {error && (
                <p className="mt-4 border-t border-rule pt-4 font-mono text-[11px] leading-relaxed text-ember">
                  {error}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
