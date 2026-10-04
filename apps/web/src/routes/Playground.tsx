import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import { useWallet, shortAddr } from '../shared/wallet/useWallet';
import { indexerApiBase } from '../shared/data/providers';
import {
  Eyebrow,
  Rule,
  SectionNo,
  Reveal,
  LoadingState,
} from '../shared/components/primitives';
import { PRIMARY_CHAIN, explorerTxUrl, explorerAddressUrl } from '../shared/chains';

/**
 * /playground — the 6th merchant. Burn $SPORE for credits, spend credits on
 * frontier AI models (chat + image), and feed the flywheel.
 *
 * The page never invents values: model lists, credit balances, and burn
 * grants all come from the indexer playground API (VITE_INDEXER_URL +
 * /api/v1). When the API is unreachable, every affected panel says so
 * plainly. The burn log is a localStorage record, labeled as such.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const SPORE_TOKEN = '0xa5127fae2d0986a4cb6619b9c4ec53461726454b';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';
/** Market merchant receiving agent USDG spends (as published in the agent docs). */
const PLAYGROUND_MERCHANT = '0x4c7cfbd388249f3c3027c52635cf70bb78084Ed5';

const SPORE_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const SPORE_PER_CREDIT = 100; // 1 $SPORE = 100 credits
const IMAGE_COST_CREDITS = 50;
const USDG_PER_CREDIT_AGENT = 1000; // 1 USDG = 1000 credits (agent mode)

const BURN_LOG_KEY = 'spore-playground-burns';

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

interface PlaygroundModel {
  id: string;
  type: string;
  name: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface BurnRecord {
  txHash: string;
  amount: string;
  time: string;
  wallet: string;
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                    */
/* ------------------------------------------------------------------ */

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pickNumber(data: unknown, keys: string[]): number | null {
  const r = asRecord(data);
  if (!r) return null;
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

function pickString(data: unknown, keys: string[]): string | null {
  const r = asRecord(data);
  if (!r) return null;
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickStringArray(data: unknown, keys: string[]): string[] | null {
  const r = asRecord(data);
  if (!r) return null;
  for (const k of keys) {
    const v = r[k];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      return v as string[];
    }
  }
  return null;
}

interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
}

async function apiPost(url: string, body: unknown): Promise<ApiResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error bodies stay null */
  }
  return { ok: res.ok, status: res.status, data };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function readBurnLog(): BurnRecord[] {
  try {
    const raw = localStorage.getItem(BURN_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is BurnRecord =>
        asRecord(r) !== null &&
        typeof (r as BurnRecord).txHash === 'string' &&
        typeof (r as BurnRecord).amount === 'string' &&
        typeof (r as BurnRecord).time === 'string',
    );
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                        */
/* ------------------------------------------------------------------ */

function CopyableAddress({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-2">
      <code
        title={address}
        className="block truncate font-mono text-[13px] text-ink select-all"
        aria-label={label}
      >
        {address}
      </code>
      <button
        type="button"
        onClick={() => {
          void copyText(address).then((ok) => {
            setCopied(ok);
            if (ok) window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 font-mono text-[11px] uppercase tracking-[0.18em] text-faint transition-colors hover:text-moss"
        aria-label={`Copy ${label}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function ApiNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="border border-rule p-4 font-mono text-[12px] leading-relaxed text-muted">
      {children}
    </p>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-3 font-mono text-[12px] leading-relaxed text-ember">
      {message}
    </p>
  );
}

function SuccessLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="mt-3 font-mono text-[12px] leading-relaxed text-moss">
      {message}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Flywheel strip                                                    */
/* ------------------------------------------------------------------ */

const FLYWHEEL_STEPS = [
  { n: '01', title: 'Backers stake USDG', line: 'Capital enters the vault.' },
  { n: '02', title: 'Agents borrow', line: 'Credit lines open on score.' },
  { n: '03', title: 'Spend at playground', line: 'Calls settle in USDG and credits.' },
  { n: '04', title: '$SPORE burns', line: 'Every burn shrinks supply.', accent: true },
  { n: '05', title: 'Agents repay, scores rise', line: 'Clean credit feeds the next loan.' },
];

function FlywheelStrip() {
  return (
    <section aria-label="The flywheel" className="border-y border-rule">
      <div className="mx-auto max-w-6xl px-6">
        <ol className="grid md:grid-cols-5">
          {FLYWHEEL_STEPS.map((s, i) => (
            <li
              key={s.n}
              className={[
                'relative px-5 py-6',
                i > 0 ? 'border-t border-rule md:border-t-0 md:border-l' : '',
              ].join(' ')}
            >
              <div className="font-mono text-[11px] tracking-[0.18em] text-faint">
                {s.n}
              </div>
              <h3
                className={[
                  'mt-2 font-mono text-[12px] uppercase tracking-[0.14em]',
                  s.accent ? 'text-moss' : 'text-ink',
                ].join(' ')}
              >
                {s.title}
              </h3>
              <p className="mt-1 text-sm text-muted">{s.line}</p>
              <span
                aria-hidden="true"
                className="absolute right-3 top-6 hidden font-mono text-[11px] text-faint md:inline"
              >
                {i < FLYWHEEL_STEPS.length - 1 ? '→' : ''}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Playground page                                                   */
/* ------------------------------------------------------------------ */

export default function Playground() {
  const wallet = useWallet();
  const { status, address, connect, disconnect, error: walletError } = wallet;

  const [apiBase] = useState<string | null>(() => indexerApiBase());

  /* Models */
  const [models, setModels] = useState<PlaygroundModel[]>([]);
  const [modelsState, setModelsState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');

  /* Credits */
  const [credits, setCredits] = useState<number | null>(null);
  const [creditsState, setCreditsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  /* Burn */
  const [sporeBalance, setSporeBalance] = useState<string | null>(null);
  const [burnAmount, setBurnAmount] = useState('');
  const [burning, setBurning] = useState(false);
  const [burnStep, setBurnStep] = useState<string | null>(null);
  const [burnError, setBurnError] = useState<string | null>(null);
  const [burnOk, setBurnOk] = useState<string | null>(null);
  const [lastBurnTx, setLastBurnTx] = useState<string | null>(null);
  const [burnLog, setBurnLog] = useState<BurnRecord[]>(() => readBurnLog());

  /* Tabs + chat */
  const [tab, setTab] = useState<'chat' | 'image'>('chat');
  const [chatModel, setChatModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [lastChatMeta, setLastChatMeta] = useState<string | null>(null);

  /* Image */
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageOk, setImageOk] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);

  const connected = status === 'connected' && address !== null;

  /* ---------------- models ---------------- */

  useEffect(() => {
    if (!apiBase) {
      setModelsState('unavailable');
      return;
    }
    let cancelled = false;
    setModelsState('loading');
    (async () => {
      try {
        const res = await fetch(`${apiBase}/playground/models`);
        if (cancelled) return;
        if (!res.ok) {
          setModelsState('unavailable');
          return;
        }
        const data: unknown = await res.json();
        const r = asRecord(data);
        const raw = r && Array.isArray(r.models) ? r.models : [];
        const parsed: PlaygroundModel[] = [];
        for (const m of raw) {
          const rec = asRecord(m);
          if (rec && typeof rec.id === 'string' && typeof rec.type === 'string') {
            parsed.push({
              id: rec.id,
              type: rec.type,
              name: typeof rec.name === 'string' ? rec.name : rec.id,
            });
          }
        }
        setModels(parsed);
        setModelsState('ready');
        const firstChat = parsed.find((m) => m.type === 'chat');
        const firstImage = parsed.find((m) => m.type === 'image');
        if (firstChat) setChatModel((cur) => cur || firstChat.id);
        if (firstImage) setImageModel((cur) => cur || firstImage.id);
      } catch {
        if (!cancelled) setModelsState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  /* ---------------- credits ---------------- */

  const refreshCredits = useCallback(
    async (walletAddr: string) => {
      if (!apiBase) {
        setCreditsState('error');
        return;
      }
      setCreditsState('loading');
      try {
        const res = await fetch(
          `${apiBase}/playground/credits/${encodeURIComponent(walletAddr.toLowerCase())}`,
        );
        if (!res.ok) {
          setCreditsState('error');
          return;
        }
        const n = pickNumber(await res.json(), ['credits', 'balance']);
        if (n === null) {
          setCreditsState('error');
          return;
        }
        setCredits(n);
        setCreditsState('ready');
      } catch {
        setCreditsState('error');
      }
    },
    [apiBase],
  );

  useEffect(() => {
    if (connected && address) {
      void refreshCredits(address);
    } else {
      setCredits(null);
      setCreditsState('idle');
    }
  }, [connected, address, refreshCredits]);

  /* ---------------- $SPORE balance ---------------- */

  const refreshSporeBalance = useCallback(async (addr: string) => {
    try {
      const eth = window.ethereum;
      if (!eth) {
        setSporeBalance(null);
        return;
      }
      const provider = new BrowserProvider(eth);
      const token = new Contract(SPORE_TOKEN, SPORE_ABI, provider);
      const bal = (await token.balanceOf(addr)) as bigint;
      const dec = (await token.decimals()) as number;
      setSporeBalance(formatUnits(bal, Number(dec)));
    } catch {
      setSporeBalance(null);
    }
  }, []);

  useEffect(() => {
    if (connected && address) {
      void refreshSporeBalance(address);
    } else {
      setSporeBalance(null);
    }
  }, [connected, address, refreshSporeBalance]);

  /* ---------------- signing ---------------- */

  const getSigner = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) throw new Error('No wallet detected. Install a browser wallet to continue.');
    const provider = new BrowserProvider(eth);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== PRIMARY_CHAIN.chainId) {
      throw new Error(`Robinhood Chain (${PRIMARY_CHAIN.chainId}) is required.`);
    }
    return provider.getSigner();
  }, []);

  const signPlaygroundAuth = useCallback(
    async (addr: string) => {
      const signer = await getSigner();
      const signerAddr = (await signer.getAddress()).toLowerCase();
      const addrLc = addr.toLowerCase();
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await signer.signMessage(
        `SPORE Playground\nWallet: ${addrLc}\nTimestamp: ${timestamp}`,
      );
      return { wallet: signerAddr, signature, timestamp };
    },
    [getSigner],
  );

  const applyCreditsFrom = useCallback(
    (data: unknown, addr: string) => {
      const remaining = pickNumber(data, [
        'creditsRemaining',
        'credits_remaining',
        'credits',
        'balance',
      ]);
      if (remaining !== null) {
        setCredits(remaining);
        setCreditsState('ready');
      } else {
        void refreshCredits(addr);
      }
    },
    [refreshCredits],
  );

  /* ---------------- burn ---------------- */

  async function handleBurn(e: React.FormEvent) {
    e.preventDefault();
    if (burning || !address) return;
    setBurnError(null);
    setBurnOk(null);
    const amount = burnAmount.trim();
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
      setBurnError('Enter a positive $SPORE amount.');
      return;
    }
    if (!apiBase) {
      setBurnError(
        'The playground API is not configured, so a burn cannot be credited. No transaction was sent.',
      );
      return;
    }
    setBurning(true);
    try {
      setBurnStep('Requesting signature…');
      const signer = await getSigner();
      const addr = (await signer.getAddress()).toLowerCase();
      const token = new Contract(SPORE_TOKEN, SPORE_ABI, signer);
      const dec = Number((await token.decimals()) as number);
      const value = parseUnits(amount, dec);
      const bal = (await token.balanceOf(addr)) as bigint;
      if (bal < value) {
        throw new Error(
          `Insufficient $SPORE balance (${formatUnits(bal, dec)} $SPORE).`,
        );
      }
      setBurnStep('Sending burn transaction…');
      const tx = await token.transfer(DEAD_ADDRESS, value);
      setLastBurnTx(tx.hash as string);
      setBurnStep('Waiting for on-chain confirmation…');
      const receipt = await tx.wait(1);
      if (receipt?.status !== 1) {
        throw new Error('Burn transaction failed on-chain.');
      }
      setBurnStep('Burn confirmed. Claiming credits…');
      const { ok, status, data } = await apiPost(
        `${apiBase}/playground/credits/burn`,
        { txHash: tx.hash },
      );
      if (!ok) {
        throw new Error(
          `The burn succeeded on-chain (${tx.hash}), but the credit grant failed (HTTP ${status}). ` +
            'The transaction is recorded below — keep the hash and retry the grant.',
        );
      }
      const granted = pickNumber(data, ['creditsGranted', 'credits_granted', 'credits']);
      const newBal = pickNumber(data, ['credits', 'balance', 'creditsRemaining']);
      setBurnOk(
        granted !== null
          ? `Burned ${amount} $SPORE → ${granted.toLocaleString()} credits granted.`
          : `Burned ${amount} $SPORE. Credit grant confirmed by the API.`,
      );
      const record: BurnRecord = {
        txHash: tx.hash as string,
        amount,
        time: new Date().toISOString(),
        wallet: addr,
      };
      setBurnLog((prev) => {
        const next = [record, ...prev].slice(0, 50);
        try {
          localStorage.setItem(BURN_LOG_KEY, JSON.stringify(next));
        } catch {
          /* storage full or unavailable — the list simply won't persist */
        }
        return next;
      });
      if (newBal !== null) {
        setCredits(newBal);
        setCreditsState('ready');
      } else {
        void refreshCredits(addr);
      }
      void refreshSporeBalance(addr);
      setBurnAmount('');
    } catch (err) {
      setBurnError(errMsg(err));
    } finally {
      setBurning(false);
      setBurnStep(null);
    }
  }

  /* ---------------- chat ---------------- */

  async function handleChatSend(e: React.FormEvent) {
    e.preventDefault();
    const content = chatInput.trim();
    if (sending || !content || !address) return;
    if (!apiBase) {
      setChatError('The playground API is not configured. No request was sent.');
      return;
    }
    if (!chatModel) {
      setChatError('No chat model is available yet — the model list has not loaded.');
      return;
    }
    setSending(true);
    setChatError(null);
    setLastChatMeta(null);
    const next: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setChatInput('');
    try {
      const auth = await signPlaygroundAuth(address);
      const { ok, status, data } = await apiPost(`${apiBase}/playground/chat`, {
        ...auth,
        model: chatModel,
        messages: next,
      });
      if (!ok && status === 402) {
        setChatError(
          'Insufficient credits (402). Burn more $SPORE above to top up, then send again.',
        );
        setMessages(messages);
        setChatInput(content);
        return;
      }
      if (!ok) {
        throw new Error(
          pickString(data, ['error', 'message']) ??
            `Chat request failed (HTTP ${status}).`,
        );
      }
      const reply = pickString(data, ['reply', 'message', 'content', 'text']);
      if (!reply) {
        throw new Error('The API returned a successful response with no message text.');
      }
      setMessages([...next, { role: 'assistant', content: reply }]);
      const deducted = pickNumber(data, ['creditsDeducted', 'credits_deducted', 'creditsUsed']);
      const metaParts = [`model: ${chatModel}`];
      if (deducted !== null) metaParts.push(`−${deducted} credits`);
      setLastChatMeta(metaParts.join(' · '));
      applyCreditsFrom(data, auth.wallet);
    } catch (err) {
      setChatError(errMsg(err));
    } finally {
      setSending(false);
    }
  }

  /* ---------------- image ---------------- */

  async function handleImageGenerate(e: React.FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (generating || !text || !address) return;
    if (!apiBase) {
      setImageError('The playground API is not configured. No request was sent.');
      return;
    }
    if (!imageModel) {
      setImageError('No image model is available yet — the model list has not loaded.');
      return;
    }
    setGenerating(true);
    setImageError(null);
    setImageOk(null);
    try {
      const auth = await signPlaygroundAuth(address);
      const { ok, status, data } = await apiPost(`${apiBase}/playground/image`, {
        ...auth,
        model: imageModel,
        prompt: text,
      });
      if (!ok && status === 402) {
        setImageError(
          'Insufficient credits (402). Burn more $SPORE above to top up, then generate again.',
        );
        return;
      }
      if (!ok) {
        throw new Error(
          pickString(data, ['error', 'message']) ??
            `Image request failed (HTTP ${status}).`,
        );
      }
      const urls =
        pickStringArray(data, ['images', 'urls']) ??
        (pickString(data, ['image', 'url']) ? [pickString(data, ['image', 'url']) as string] : null);
      if (!urls || urls.length === 0) {
        throw new Error('The API returned a successful response with no images.');
      }
      setImages((prev) => [...urls, ...prev].slice(0, 24));
      const deducted = pickNumber(data, ['creditsDeducted', 'credits_deducted', 'creditsUsed']);
      setImageOk(
        `Generated ${urls.length} image${urls.length === 1 ? '' : 's'}` +
          (deducted !== null ? ` · −${deducted} credits.` : '.'),
      );
      applyCreditsFrom(data, auth.wallet);
    } catch (err) {
      setImageError(errMsg(err));
    } finally {
      setGenerating(false);
    }
  }

  /* ---------------- render ---------------- */

  const chatModels = models.filter((m) => m.type === 'chat');
  const imageModels = models.filter((m) => m.type === 'image');

  return (
    <div className="bg-bg text-ink">
      {/* Breadcrumb (page-local; Chrome.tsx untouched) */}
      <div className="mx-auto max-w-6xl px-6">
        <nav aria-label="Breadcrumb" className="pt-6">
          <Link
            to="/"
            className="font-mono text-[12px] uppercase tracking-widest text-faint transition-colors hover:text-moss"
          >
            <span aria-hidden="true">←</span> SPORE
          </Link>
        </nav>
      </div>

      {/* Hero */}
      <header className="mx-auto max-w-6xl px-6 pb-14 pt-10 md:pb-20 md:pt-16">
        <Reveal>
          <Eyebrow>The 6th merchant</Eyebrow>
          <h1 className="display mt-4 text-6xl text-ink md:text-7xl">Playground</h1>
          <p className="mt-3 max-w-xl font-serif text-xl italic text-muted md:text-2xl">
            Burn $SPORE. Use frontier AI models. Every call feeds the flywheel.
          </p>
        </Reveal>
      </header>

      <Reveal>
        <FlywheelStrip />
      </Reveal>

      {/* Credit balance bar */}
      <section aria-label="Credit balance" className="mx-auto max-w-6xl px-6 pt-12">
        <div className="border-y border-rule-strong py-6 md:py-8">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <div>
              <div className="eyebrow">Your credits</div>
              <p className="mt-1 text-sm text-faint">
                {creditsState === 'ready'
                  ? 'Spendable on chat and image models below.'
                  : creditsState === 'loading'
                    ? 'Reading balance…'
                    : 'Connect a wallet to read your balance.'}
              </p>
            </div>
            <div
              role="status"
              aria-live="polite"
              className="font-mono text-3xl text-ink tnum md:text-4xl"
            >
              {creditsState === 'ready' && credits !== null ? (
                <>
                  {credits.toLocaleString()}{' '}
                  <span className="text-lg text-moss">credits</span>
                </>
              ) : creditsState === 'loading' ? (
                <span className="text-faint">…</span>
              ) : (
                <span className="text-faint">—</span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 01 — Human mode: get credits */}
      <section aria-labelledby="pg-human" className="mx-auto max-w-6xl px-6 pt-14 md:pt-20">
        <Reveal>
          <SectionNo n="01" />
          <h2 id="pg-human" className="display mt-3 text-3xl text-ink md:text-4xl">
            Get credits
          </h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            Humans enter the playground by burning $SPORE. Each burn grants
            credits instantly — <span className="text-ink">1 $SPORE = {SPORE_PER_CREDIT} credits</span> —
            and the tokens leave circulation for good.
          </p>
        </Reveal>

        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          {/* Wallet panel */}
          <Reveal className="border border-rule p-6">
            <div className="eyebrow">Wallet</div>
            {status === 'connected' && address ? (
              <div className="mt-4">
                <a
                  href={explorerAddressUrl(address)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-sm text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
                >
                  {shortAddr(address)}
                </a>
                <div className="mt-3 max-w-full overflow-hidden">
                  <CopyableAddress address={address} label="Wallet address" />
                </div>
                <dl className="mt-5 space-y-2 text-sm">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-faint">$SPORE balance</dt>
                    <dd className="font-mono text-ink tnum">
                      {sporeBalance === null ? '…' : `${Number(sporeBalance).toLocaleString(undefined, { maximumFractionDigits: 4 })} $SPORE`}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-faint">Burn destination</dt>
                    <dd className="max-w-[60%] overflow-hidden text-right">
                      <CopyableAddress address={DEAD_ADDRESS} label="Burn address" />
                    </dd>
                  </div>
                </dl>
                <button
                  type="button"
                  onClick={disconnect}
                  className="mt-5 font-mono text-[11px] uppercase tracking-[0.18em] text-faint transition-colors hover:text-ink"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => void connect()}
                  disabled={status === 'connecting'}
                  className="border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
                >
                  {status === 'connecting'
                    ? 'Waiting for wallet…'
                    : status === 'wrong-chain'
                      ? 'Switch to Robinhood Chain'
                      : 'Connect wallet'}
                </button>
                {walletError && (
                  <p role="alert" className="mt-2 font-mono text-[11px] text-ember">{walletError}</p>
                )}
                {status === 'wrong-chain' && !walletError && (
                  <p className="mt-2 font-mono text-[11px] text-ember">
                    Wrong network — approve the switch to Robinhood Chain (4663).
                  </p>
                )}
              </div>
            )}
          </Reveal>

          {/* Burn form */}
          <Reveal className="border border-rule p-6" delay={80}>
            <div className="eyebrow">Burn $SPORE</div>
            <form onSubmit={(e) => void handleBurn(e)} className="mt-4">
              <label
                htmlFor="pg-burn-amount"
                className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint"
              >
                Amount ($SPORE)
              </label>
              <div className="mt-2 flex gap-3">
                <input
                  id="pg-burn-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={burnAmount}
                  onChange={(e) => setBurnAmount(e.target.value)}
                  disabled={burning || !connected}
                  className="w-full border border-rule-strong bg-transparent px-4 py-3 font-mono text-ink placeholder:text-faint focus:border-moss focus:outline-none disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={burning || !connected}
                  className="shrink-0 border border-moss/70 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-moss transition-colors hover:bg-moss/10 disabled:opacity-50"
                >
                  {burning ? (burnStep ?? 'Burning…') : 'Burn $SPORE'}
                </button>
              </div>
              <p className="mt-3 text-sm text-muted">
                Grants <span className="font-mono text-ink">{SPORE_PER_CREDIT} credits</span> per $SPORE.
                {burnAmount && Number(burnAmount) > 0
                  ? ` ${Number(burnAmount) * SPORE_PER_CREDIT} credits for ${burnAmount} $SPORE.`
                  : ''}
              </p>
              {!connected && (
                <p className="mt-3 font-mono text-[11px] text-faint">
                  Connect a wallet first — the burn is a real on-chain transaction.
                </p>
              )}
              {lastBurnTx && (
                <p className="mt-3 font-mono text-[12px] text-faint">
                  Last burn:{' '}
                  <a
                    href={explorerTxUrl(lastBurnTx)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-moss underline underline-offset-4 hover:text-ink select-all"
                  >
                    {lastBurnTx.slice(0, 10)}…{lastBurnTx.slice(-8)}
                  </a>
                </p>
              )}
              <ErrorLine message={burnError} />
              <SuccessLine message={burnOk} />
            </form>
          </Reveal>
        </div>
      </section>

      {/* 02 — Spend: chat / image */}
      <section aria-labelledby="pg-spend" className="mx-auto max-w-6xl px-6 pt-14 md:pt-20">
        <Reveal>
          <SectionNo n="02" />
          <h2 id="pg-spend" className="display mt-3 text-3xl text-ink md:text-4xl">
            Spend credits
          </h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            Every request is signed with your wallet — the API verifies the
            signature, spends your credits, and routes the call to a frontier model.
          </p>
        </Reveal>

        {!connected && (
          <div className="mt-8">
            <ApiNote>
              Connect a wallet above to use the playground. Models and credits are
              read per-wallet.
            </ApiNote>
          </div>
        )}

        {modelsState === 'loading' && (
          <div className="mt-8">
            <LoadingState label="Models loading — the index is being probed…" />
          </div>
        )}
        {(modelsState === 'unavailable' || modelsState === 'idle') && (
          <div className="mt-8">
            <ApiNote>
              The model catalog is unavailable — the playground API is not
              responding. No models are shown because none are known. Check back
              after the API lane lands.
            </ApiNote>
          </div>
        )}

        {modelsState === 'ready' && (
          <div className="mt-8">
            {/* Tabs */}
            <div role="tablist" aria-label="Playground modes" className="flex border-b border-rule">
              {(['chat', 'image'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  id={`pg-tab-${t}`}
                  aria-selected={tab === t}
                  aria-controls={`pg-panel-${t}`}
                  onClick={() => setTab(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                      e.preventDefault();
                      setTab(tab === 'chat' ? 'image' : 'chat');
                    }
                  }}
                  className={[
                    'px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-moss',
                    tab === t
                      ? 'border-b-2 border-moss text-ink'
                      : 'border-b-2 border-transparent text-faint hover:text-muted',
                  ].join(' ')}
                >
                  {t === 'chat' ? 'Chat' : 'Image'}
                </button>
              ))}
            </div>

            {/* Chat panel */}
            <div
              role="tabpanel"
              id="pg-panel-chat"
              aria-labelledby="pg-tab-chat"
              hidden={tab !== 'chat'}
              className="py-8"
            >
              <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
                <div>
                  <label
                    htmlFor="pg-chat-model"
                    className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint"
                  >
                    Model
                  </label>
                  {chatModels.length === 0 ? (
                    <p className="mt-2 text-sm text-muted">
                      No chat models returned by the API yet — models loading,
                      the index is being probed.
                    </p>
                  ) : (
                    <select
                      id="pg-chat-model"
                      value={chatModel}
                      onChange={(e) => setChatModel(e.target.value)}
                      className="mt-2 w-full border border-rule-strong bg-bg px-3 py-2.5 font-mono text-sm text-ink focus:border-moss focus:outline-none"
                    >
                      {chatModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <p className="mt-3 text-sm text-faint">
                    Signed with your wallet on every send. Replies stream in as a
                    single response.
                  </p>
                </div>

                <div className="border border-rule">
                  <div className="max-h-[420px] overflow-y-auto p-5" aria-live="polite" aria-label="Chat messages">
                    {messages.length === 0 ? (
                      <p className="font-mono text-[12px] text-faint">
                        No messages yet. Ask something — the flywheel is listening.
                      </p>
                    ) : (
                      <ol className="space-y-4">
                        {messages.map((m, i) => (
                          <li
                            key={i}
                            className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                          >
                            <div
                              className={[
                                'max-w-[80%] px-4 py-3 text-sm leading-relaxed',
                                m.role === 'user'
                                  ? 'border border-moss/50 bg-moss/10 text-ink'
                                  : 'border border-rule bg-transparent text-muted',
                              ].join(' ')}
                            >
                              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
                                {m.role === 'user' ? 'You' : 'Model'}
                              </div>
                              <p className="whitespace-pre-wrap">{m.content}</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                    {sending && (
                      <p className="mt-4 font-mono text-[12px] text-faint motion-safe:animate-pulse">
                        Signing and sending…
                      </p>
                    )}
                  </div>
                  <form onSubmit={(e) => void handleChatSend(e)} className="border-t border-rule p-4">
                    <div className="flex gap-3">
                      <label htmlFor="pg-chat-input" className="sr-only">
                        Message
                      </label>
                      <input
                        id="pg-chat-input"
                        type="text"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        disabled={sending || !connected || chatModels.length === 0}
                        placeholder="Type a message…"
                        className="w-full border border-rule-strong bg-transparent px-4 py-3 text-sm text-ink placeholder:text-faint focus:border-moss focus:outline-none disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={sending || !connected || chatModels.length === 0 || !chatInput.trim()}
                        className="shrink-0 border border-moss/70 px-5 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-moss transition-colors hover:bg-moss/10 disabled:opacity-50"
                      >
                        Send
                      </button>
                    </div>
                    {lastChatMeta && (
                      <p className="mt-2 font-mono text-[11px] text-faint">{lastChatMeta}</p>
                    )}
                    <ErrorLine message={chatError} />
                  </form>
                </div>
              </div>
            </div>

            {/* Image panel */}
            <div
              role="tabpanel"
              id="pg-panel-image"
              aria-labelledby="pg-tab-image"
              hidden={tab !== 'image'}
              className="py-8"
            >
              <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
                <div>
                  <label
                    htmlFor="pg-image-model"
                    className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint"
                  >
                    Model
                  </label>
                  {imageModels.length === 0 ? (
                    <p className="mt-2 text-sm text-muted">
                      No image models returned by the API yet — models loading,
                      the index is being probed.
                    </p>
                  ) : (
                    <select
                      id="pg-image-model"
                      value={imageModel}
                      onChange={(e) => setImageModel(e.target.value)}
                      className="mt-2 w-full border border-rule-strong bg-bg px-3 py-2.5 font-mono text-sm text-ink focus:border-moss focus:outline-none"
                    >
                      {imageModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <p className="mt-3 text-sm text-faint">
                    <span className="font-mono text-ink">{IMAGE_COST_CREDITS} credits</span> per image.
                  </p>
                </div>

                <div>
                  <form onSubmit={(e) => void handleImageGenerate(e)} className="flex gap-3">
                    <label htmlFor="pg-image-prompt" className="sr-only">
                      Image prompt
                    </label>
                    <input
                      id="pg-image-prompt"
                      type="text"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      disabled={generating || !connected || imageModels.length === 0}
                      placeholder="A mushroom city at dusk, mycelium streets…"
                      className="w-full border border-rule-strong bg-transparent px-4 py-3 text-sm text-ink placeholder:text-faint focus:border-moss focus:outline-none disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={generating || !connected || imageModels.length === 0 || !prompt.trim()}
                      className="shrink-0 border border-moss/70 px-5 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-moss transition-colors hover:bg-moss/10 disabled:opacity-50"
                    >
                      {generating ? 'Generating…' : 'Generate'}
                    </button>
                  </form>
                  <ErrorLine message={imageError} />
                  <SuccessLine message={imageOk} />
                  {images.length > 0 ? (
                    <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {images.map((src, i) => (
                        <figure key={i} className="border border-rule p-2">
                          <img
                            src={src}
                            alt={`Generated image ${i + 1}`}
                            className="aspect-square w-full object-cover"
                            loading="lazy"
                          />
                        </figure>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-6 font-mono text-[12px] text-faint">
                      Nothing generated yet this session.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 03 — Burn history (local) */}
      <section aria-labelledby="pg-history" className="mx-auto max-w-6xl px-6 pt-14 md:pt-20">
        <Reveal>
          <SectionNo n="03" />
          <h2 id="pg-history" className="display mt-3 text-3xl text-ink md:text-4xl">
            Burn history
          </h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            A record of the burns made from this browser. It is kept in this
            browser's local storage — a local ledger, not an on-chain index.
          </p>
        </Reveal>
        <div className="mt-8">
          {burnLog.length === 0 ? (
            <p className="border border-rule p-5 font-mono text-[12px] text-faint">
              No burns recorded in this browser yet.
            </p>
          ) : (
            <div className="overflow-x-auto border border-rule">
              <table className="w-full text-sm">
                <thead>
                  <tr className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
                    <th scope="col" className="border-b border-rule-strong px-4 py-3 text-left font-normal">Transaction</th>
                    <th scope="col" className="border-b border-rule-strong px-4 py-3 text-right font-normal">Amount</th>
                    <th scope="col" className="border-b border-rule-strong px-4 py-3 text-right font-normal">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {burnLog.map((r) => (
                    <tr key={r.txHash} className="border-b border-rule last:border-b-0">
                      <td className="px-4 py-3">
                        <a
                          href={explorerTxUrl(r.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[13px] text-moss underline underline-offset-4 hover:text-ink select-all"
                        >
                          {r.txHash.slice(0, 10)}…{r.txHash.slice(-8)}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-ink tnum">
                        {r.amount} $SPORE
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[12px] text-faint">
                        {new Date(r.time).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* 04 — Agent mode */}
      <section aria-labelledby="pg-agents" className="mx-auto max-w-6xl px-6 py-14 md:py-20">
        <Reveal>
          <SectionNo n="04" />
          <h2 id="pg-agents" className="display mt-3 text-3xl text-ink md:text-4xl">
            For agents
          </h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            Agents spend USDG with the market merchant, then claim credits against
            the payment transaction. <span className="text-ink">1 USDG = {USDG_PER_CREDIT_AGENT.toLocaleString()} credits.</span>{' '}
            No keys, no accounts — a signed payment and a POST.
          </p>
        </Reveal>
        <Reveal delay={80}>
          <div className="mt-8 border border-rule">
            <div className="flex items-center justify-between border-b border-rule px-5 py-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
                Merchant spend flow
              </span>
              <CopyableAddress address={PLAYGROUND_MERCHANT} label="Merchant address" />
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-muted">
{`# 1. Pay USDG (6 decimals) to the market merchant
transfer(usdg, ${PLAYGROUND_MERCHANT}, amount_usdg)

# 2. Claim playground credits against the payment
POST ${apiBase ?? '<indexer>'}/playground/merchant/spend
{
  "paymentTx": "0x..."
}

# → { "credits": <amount_usdg × ${USDG_PER_CREDIT_AGENT}> }`}
            </pre>
          </div>
          <p className="mt-4 font-mono text-[12px] text-faint">
            Credits from merchant spends and $SPORE burns are fungible — one
            balance, one playground.
          </p>
        </Reveal>
        <Rule strong className="mt-16" />
      </section>
    </div>
  );
}
