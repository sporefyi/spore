import { useEffect, useState } from 'react';
import {
  Eyebrow,
  Rule,
  Reveal,
  DemoBadge,
} from '../shared/components/primitives';
import { useWallet } from '../shared/wallet/useWallet';
import ConnectButton from '../shared/wallet/ConnectButton';
import { indexerApiBase } from '../shared/data/providers';
import { explorerTxUrl, MARKET_MERCHANT, USDG } from '../shared/chains';

const CATEGORIES: { name: string; live: boolean }[] = [
  { name: 'AI inference', live: true },
  { name: 'Image generation', live: true },
  { name: 'APIs', live: true },
  { name: 'Data', live: true },
  { name: 'Storage', live: true },
  { name: 'RPC', live: true },
];

const DESTINATIONS: string[] = ['API', 'COMPUTE', 'DATA', 'RPC', 'STORAGE'];

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '1',
    title: 'Credit is issued against the record.',
    body: "An agent's credit line is sized from its on-ledger record of observed activity. The record comes first; the line follows from it, never the other way around.",
  },
  {
    n: '2',
    title: 'Spends are checked against an allowlist.',
    body: 'Every spend is matched to an allowlist of merchant categories before it settles. A request outside the allowlist is refused by the router, not by policy or goodwill.',
  },
  {
    n: '3',
    title: 'Merchants are paid directly.',
    body: 'Settlement goes to the verified merchant. The agent never holds the funds, so credit cannot be redirected, withdrawn, or spent on anything other than the compute it needs.',
  },
];

function FlowLink() {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto h-10 w-px bg-rule-strong md:mx-0 md:h-px md:w-16 md:flex-none"
    >
      <span className="flow-packet" />
      <span className="flow-packet flow-packet-2" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Market store                                                        */
/* ------------------------------------------------------------------ */

type MerchantKind = 'inference' | 'search' | 'storage' | 'data' | 'gpu' | 'rpc';

interface MerchantDef {
  id: string;
  name: string;
  price: string;
  endpoint: string;
  tagline: string;
  kind: MerchantKind;
}

const MERCHANTS: MerchantDef[] = [
  { id: 'inference', name: 'SPORE Inference', price: '0.5', endpoint: '/market/inference', tagline: 'Chat completions from a hosted model.', kind: 'inference' },
  { id: 'search', name: 'SPORE Search', price: '0.2', endpoint: '/market/search', tagline: 'Web search, no tracking.', kind: 'search' },
  { id: 'storage', name: 'SPORE Vault', price: '1', endpoint: '/market/storage/pin', tagline: 'Pin a file to IPFS — 10 MB max.', kind: 'storage' },
  { id: 'data', name: 'SPORE Data', price: '0.1', endpoint: '/market/data/query', tagline: 'Balances, transactions, blocks.', kind: 'data' },
  { id: 'gpu', name: 'SPORE Image', price: '1', endpoint: '/market/gpu', tagline: 'Text-to-image generation.', kind: 'gpu' },
  { id: 'rpc', name: 'SPORE RPC', price: '5', endpoint: '/market/rpc/key', tagline: 'Metered RPC access key, 30 days.', kind: 'rpc' },
];

type CardPhase = 'idle' | 'paying' | 'paid' | 'submitting' | 'done' | 'error';

interface ApiError {
  code: string;
  message: string;
}

function friendlyError(code: string, message: string): string {
  switch (code) {
    case 'payment_not_found':
      return 'Payment not found on-chain yet. Wait for the transfer to confirm, then submit again.';
    case 'already_used':
      return 'This payment was already used. Pay again for another call.';
    case 'rate_limited':
      return 'Rate limited. Wait a moment and try again.';
    case 'not_configured':
      return 'This merchant is not configured right now.';
    case 'upstream_error':
      return 'The merchant\u2019s upstream provider failed. Try again.';
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

function TxLine({ hash }: { hash: string }) {
  return (
    <p className="mt-3 break-all font-mono text-[11px] leading-relaxed text-muted">
      Paid:{' '}
      <a
        href={explorerTxUrl(hash)}
        target="_blank"
        rel="noreferrer"
        className="text-fungal underline decoration-fungal/40 underline-offset-4 hover:decoration-fungal"
      >
        {hash.slice(0, 10)}…{hash.slice(-8)}
      </a>
    </p>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result as string;
      const idx = s.indexOf(',');
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    r.onerror = () => reject(new Error('Could not read file.'));
    r.readAsDataURL(file);
  });
}

/* Per-merchant service form + result rendering. */

function ServiceForm({
  kind,
  onSubmit,
  submitting,
}: {
  kind: MerchantKind;
  onSubmit: (params: Record<string, unknown>) => void;
  submitting: boolean;
}) {
  const [message, setMessage] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [query, setQuery] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dataType, setDataType] = useState<'balance' | 'tx' | 'block'>('balance');
  const [dataParam, setDataParam] = useState('');
  const [prompt, setPrompt] = useState('');

  if (kind === 'rpc') {
    return (
      <button
        type="button"
        disabled={submitting}
        onClick={() => onSubmit({})}
        className="mt-4 w-full border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
      >
        {submitting ? 'Issuing key…' : 'Issue RPC key'}
      </button>
    );
  }

  if (kind === 'inference') {
    return (
      <div className="mt-4 space-y-3">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask anything…"
          rows={3}
          className={inputClass}
        />
        <input
          value={maxTokens}
          onChange={(e) => setMaxTokens(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="Max tokens (optional)"
          inputMode="numeric"
          className={inputClass}
        />
        <button
          type="button"
          disabled={submitting || message.trim().length === 0}
          onClick={() => {
            const params: Record<string, unknown> = {
              messages: [{ role: 'user', content: message.trim() }],
            };
            const n = parseInt(maxTokens, 10);
            if (!Number.isNaN(n) && n > 0) params.maxTokens = n;
            onSubmit(params);
          }}
          className="w-full border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
        >
          {submitting ? 'Running…' : 'Run inference'}
        </button>
      </div>
    );
  }

  if (kind === 'search') {
    return (
      <div className="mt-4 space-y-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the web…"
          maxLength={300}
          className={inputClass}
        />
        <button
          type="button"
          disabled={submitting || query.trim().length === 0}
          onClick={() => onSubmit({ query: query.trim() })}
          className="w-full border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
        >
          {submitting ? 'Searching…' : 'Search'}
        </button>
      </div>
    );
  }

  if (kind === 'storage') {
    return (
      <div className="mt-4 space-y-3">
        <label className="block cursor-pointer border border-dashed border-rule-strong px-4 py-6 text-center font-mono text-[12px] text-muted transition-colors hover:border-fungal/60 hover:text-ink">
          {file ? file.name : 'Choose a file (max 10 MB)'}
          <input
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFileError(null);
              if (f && f.size > 10 * 1024 * 1024) {
                setFileError('File is over 10 MB.');
                setFile(null);
                return;
              }
              setFile(f);
            }}
          />
        </label>
        {fileError && <p className="font-mono text-[11px] text-ember">{fileError}</p>}
        <button
          type="button"
          disabled={submitting || !file}
          onClick={() => {
            if (!file) return;
            void readFileAsBase64(file).then((fileData) =>
              onSubmit({ fileName: file.name, fileData }),
            );
          }}
          className="w-full border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
        >
          {submitting ? 'Pinning…' : 'Pin to IPFS'}
        </button>
      </div>
    );
  }

  if (kind === 'data') {
    const placeholder =
      dataType === 'balance'
        ? '0x… address'
        : dataType === 'tx'
          ? '0x… transaction hash'
          : 'Block number or "latest"';
    return (
      <div className="mt-4 space-y-3">
        <select
          value={dataType}
          onChange={(e) => setDataType(e.target.value as 'balance' | 'tx' | 'block')}
          className={inputClass}
        >
          <option value="balance">Balance</option>
          <option value="tx">Transaction</option>
          <option value="block">Block</option>
        </select>
        <input
          value={dataParam}
          onChange={(e) => setDataParam(e.target.value)}
          placeholder={placeholder}
          className={inputClass}
        />
        <button
          type="button"
          disabled={submitting || dataParam.trim().length === 0}
          onClick={() => {
            const v = dataParam.trim();
            if (dataType === 'balance') onSubmit({ type: 'balance', address: v });
            else if (dataType === 'tx') onSubmit({ type: 'tx', txHash: v });
            else {
              const n = /^\d+$/.test(v) ? parseInt(v, 10) : v;
              onSubmit({ type: 'block', blockNumber: n });
            }
          }}
          className="w-full border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
        >
          {submitting ? 'Querying…' : 'Query chain'}
        </button>
      </div>
    );
  }

  // gpu
  return (
    <div className="mt-4 space-y-3">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the image…"
        rows={3}
        maxLength={500}
        className={inputClass}
      />
      <button
        type="button"
        disabled={submitting || prompt.trim().length === 0}
        onClick={() => onSubmit({ prompt: prompt.trim() })}
        className="w-full border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
      >
        {submitting ? 'Generating…' : 'Generate image'}
      </button>
    </div>
  );
}

function ServiceResult({ kind, data }: { kind: MerchantKind; data: any }) {
  if (kind === 'inference') {
    return (
      <div className="mt-4 border-t border-rule pt-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
          {String(data.model ?? 'model')}
          {data.usage?.totalTokens != null && ` · ${data.usage.totalTokens} tokens`}
        </p>
        <p className="mt-3 whitespace-pre-wrap font-serif text-base leading-relaxed text-ink">
          {String(data.response ?? '')}
        </p>
      </div>
    );
  }
  if (kind === 'search') {
    const results: { title: string; url: string; snippet: string }[] = Array.isArray(data.results)
      ? data.results
      : [];
    return (
      <div className="mt-4 space-y-4 border-t border-rule pt-4">
        {results.length === 0 && <p className="text-sm text-muted">No results.</p>}
        {results.map((r, i) => (
          <div key={i}>
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="font-serif text-base text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
            >
              {r.title}
            </a>
            <p className="mt-1 text-sm leading-relaxed text-muted">{r.snippet}</p>
          </div>
        ))}
      </div>
    );
  }
  if (kind === 'storage') {
    return (
      <div className="mt-4 border-t border-rule pt-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">Pinned</p>
        <p className="mt-2 break-all font-mono text-xs text-ink">{String(data.cid ?? '')}</p>
        {data.ipfsUrl && (
          <a
            href={String(data.ipfsUrl)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block font-mono text-[11px] uppercase tracking-[0.18em] text-fungal underline decoration-fungal/40 underline-offset-4 hover:decoration-fungal"
          >
            Open on IPFS →
          </a>
        )}
      </div>
    );
  }
  if (kind === 'data') {
    return (
      <div className="mt-4 border-t border-rule pt-4">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted">
          {JSON.stringify(data.result ?? data, null, 2)}
        </pre>
      </div>
    );
  }
  if (kind === 'gpu') {
    const images: string[] = Array.isArray(data.images) ? data.images : [];
    return (
      <div className="mt-4 space-y-3 border-t border-rule pt-4">
        {images.length === 0 && <p className="text-sm text-muted">No images returned.</p>}
        {images.map((src, i) => (
          <img key={i} src={src} alt={`Generated image ${i + 1}`} className="w-full border border-rule" />
        ))}
      </div>
    );
  }
  // rpc — key shown once
  return <RpcKeyResult data={data} />;
}

function RpcKeyResult({ data }: { data: any }) {
  const [copied, setCopied] = useState(false);
  const key = String(data.apiKey ?? '');
  const copy = () => {
    const done = () => setCopied(true);
    try {
      const clip = navigator.clipboard;
      if (clip?.writeText) {
        void clip.writeText(key).then(done, () => setCopied(false));
      } else {
        setCopied(false);
      }
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mt-4 border-t border-rule pt-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ember">
        Shown once — copy it now
      </p>
      <div className="mt-3 flex items-stretch gap-2">
        <p className="flex-1 break-all border border-rule bg-ink/[0.03] px-3 py-2 font-mono text-xs text-ink">
          {key}
        </p>
        <button
          type="button"
          onClick={copy}
          className="border border-fungal/60 px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-3 font-mono text-[11px] text-muted">
        {data.expiresAt ? `Expires ${new Date(String(data.expiresAt)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
        {data.requestsPerMinute != null ? ` · ${data.requestsPerMinute}/min` : ''}
      </p>
    </div>
  );
}

function MerchantCard({ def, wallet }: { def: MerchantDef; wallet: ReturnType<typeof useWallet> }) {
  const [phase, setPhase] = useState<CardPhase>('idle');
  const [paymentTx, setPaymentTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  const connected = wallet.status === 'connected';
  const paying = phase === 'paying';
  const submitting = phase === 'submitting';

  const onPay = () => {
    setError(null);
    setResult(null);
    setPhase('paying');
    wallet
      .payUsdg(def.price)
      .then((hash) => {
        setPaymentTx(hash);
        setPhase('paid');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Payment failed.');
        setPhase('error');
      });
  };

  const onSubmit = (params: Record<string, unknown>) => {
    if (!paymentTx) return;
    setError(null);
    setPhase('submitting');
    void marketPost(def.endpoint, { ...params, paymentTx }).then((res) => {
      if (res.ok) {
        setResult(res.data);
        setPhase('done');
      } else {
        setError(friendlyError(res.error.code, res.error.message));
        // Only already_used consumes the payment — every other failure leaves
        // the tx hash usable, so the buyer can fix input and retry.
        setPhase(res.error.code === 'already_used' ? 'error' : 'paid');
      }
    });
  };

  const reset = () => {
    setPhase('idle');
    setPaymentTx(null);
    setError(null);
    setResult(null);
  };

  return (
    <div className="flex flex-col border border-rule p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-serif text-xl text-ink">{def.name}</h3>
        <span className="tnum whitespace-nowrap font-mono text-sm text-fungal">
          {def.price} {USDG.symbol}
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">{def.tagline}</p>
      <span aria-hidden="true" className="mt-4 h-px w-full bg-rule" />

      {/* Step 1 — pay */}
      {(phase === 'idle' || phase === 'error' || phase === 'paying') && (
        <div className="mt-4">
          <button
            type="button"
            disabled={!connected || paying}
            onClick={onPay}
            className="w-full border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
          >
            {paying ? 'Waiting for wallet…' : `Pay ${def.price} ${USDG.symbol}`}
          </button>
          {!connected && wallet.status !== 'no-provider' && (
            <p className="mt-2 font-mono text-[11px] text-faint">Connect your wallet above to buy.</p>
          )}
        </div>
      )}

      {/* Step 2 — paid, show tx + service form */}
      {(phase === 'paid' || phase === 'submitting' || phase === 'done') && paymentTx && (
        <div>
          <TxLine hash={paymentTx} />
          {phase !== 'done' && (
            <ServiceForm kind={def.kind} onSubmit={onSubmit} submitting={submitting} />
          )}
        </div>
      )}

      {phase === 'done' && result && <ServiceResult kind={def.kind} data={result} />}

      {phase === 'done' && (
        <button
          type="button"
          onClick={reset}
          className="mt-4 font-mono text-[11px] uppercase tracking-[0.18em] text-faint transition-colors hover:text-ink"
        >
          Buy again
        </button>
      )}

      {error && (
        <p className="mt-4 border-t border-rule pt-4 font-mono text-[11px] leading-relaxed text-ember">
          {error}
        </p>
      )}
    </div>
  );
}

function StoreSection() {
  const wallet = useWallet();
  const apiBase = indexerApiBase();

  return (
    <section className="mx-auto mt-32 max-w-6xl px-4 pb-32 md:px-8">
      <Rule />
      <Reveal>
        <div className="mt-6">
          <Eyebrow>The store</Eyebrow>
        </div>
        <h2 className="display mt-6 font-serif text-3xl leading-tight text-ink md:text-4xl">
          Six merchants, live.
        </h2>
        <p className="mt-6 max-w-2xl font-sans text-sm leading-relaxed text-muted">
          Buying is three steps: connect a wallet, send the exact {USDG.symbol} payment to the
          verified merchant{' '}
          <span className="font-mono text-[12px] text-ink">
            {MARKET_MERCHANT.slice(0, 6)}…{MARKET_MERCHANT.slice(-4)}
          </span>
          , then submit your request. The API verifies the transfer on-chain — each payment
          hash works exactly once.
        </p>
      </Reveal>

      <div className="mt-10">
        <ConnectButton wallet={wallet} />
      </div>

      {apiBase === null ? (
        <p className="mt-10 border border-rule p-6 font-mono text-[12px] text-ember">
          The market API is not configured in this build — the store cannot reach the merchants.
        </p>
      ) : (
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {MERCHANTS.map((m) => (
            <MerchantCard key={m.id} def={m} wallet={wallet} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function Market() {
  useEffect(() => {
    document.title = 'SPORE — Market';
  }, []);

  return (
    <div className="bg-bg text-ink">
      <header className="mx-auto max-w-3xl px-4 pt-24 md:px-8">
        <div className="flex justify-end gap-4">
          <DemoBadge />
        </div>
        <div className="mt-6">
          <Eyebrow>The market</Eyebrow>
        </div>
        <h1 className="display mt-6 font-serif text-4xl leading-tight text-ink md:text-6xl">
          Purpose-bound credit.
        </h1>
        <p className="mt-8 max-w-2xl font-serif text-xl leading-relaxed text-muted">
          SPORE credit is purpose-bound. An agent&apos;s credit can only be spent
          at verified merchants, for the compute it needs. The credit
          router enforces this on-chain.
        </p>
      </header>

      <section className="mx-auto mt-24 max-w-3xl px-4 md:px-8">
        <Rule />
        <Reveal>
          <p className="mt-6 font-mono text-[11px] uppercase tracking-widest text-faint">
            Router, as designed
          </p>

          <div className="mt-10 flex flex-col items-stretch md:flex-row md:items-center">
            <div className="text-center md:text-left">
              <span className="tnum font-mono text-2xl text-ink">$100</span>
              <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-faint">
                Illustrative amount
              </div>
            </div>
            <FlowLink />
            <div className="flow-router border-y border-rule-strong py-3 text-center md:px-6 md:text-left">
              <span className="font-mono text-sm tracking-widest text-ink">
                ROUTER
              </span>
            </div>
            <FlowLink />
            <ul className="flex flex-col items-center gap-2 md:items-start md:border-l md:border-rule-strong md:pl-6">
              {DESTINATIONS.map((d, i) => (
                <li
                  key={d}
                  className="flow-dest font-mono text-sm tracking-widest text-muted"
                  style={{ animationDelay: `${i * 0.4}s` }}
                >
                  {d}
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-10 max-w-2xl font-sans text-sm leading-relaxed text-muted">
            Six merchant integrations are live: SPORE Vault (storage, 1 USDG/file), SPORE Data (on-chain queries, 0.1 USDG), SPORE Search (web search, 0.2 USDG), SPORE Inference (AI, 0.5 USDG), SPORE Image (generation, 1 USDG), and SPORE RPC (metered access, 5 USDG/30 days).
          </p>
        </Reveal>

        <ul className="mt-12 border-t border-rule">
          {CATEGORIES.map((c, i) => (
            <li
              key={c.name}
              className="merchant-row flex items-center gap-4 border-b border-rule py-4"
              style={{ animationDelay: `${i * 0.08}s` }}
            >
              <span className="font-mono text-sm text-ink">{c.name}</span>
              <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-rule" />
              {c.live ? (
                <span className="live-badge font-mono text-[11px] tracking-widest text-moss">
                  LIVE
                </span>
              ) : (
                <span className="font-mono text-[11px] tracking-widest text-ember">
                  NOT INTEGRATED
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto mt-32 max-w-3xl px-4 md:px-8">
        <Rule />
        <Reveal>
          <div className="mt-6">
            <Eyebrow>How routing works</Eyebrow>
          </div>
          <h2 className="display mt-6 font-serif text-3xl leading-tight text-ink md:text-4xl">
            Three checks between credit and spend.
          </h2>
          <ol className="mt-12 border-t border-rule">
            {STEPS.map((s) => (
              <li
                key={s.n}
                className="grid gap-3 border-b border-rule py-8 md:grid-cols-[3rem_1fr] md:gap-6"
              >
                <span className="tnum font-mono text-sm text-faint">{s.n}</span>
                <div>
                  <h3 className="font-serif text-xl text-ink">{s.title}</h3>
                  <p className="mt-3 font-sans text-base leading-relaxed text-muted">
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      <StoreSection />
    </div>
  );
}
