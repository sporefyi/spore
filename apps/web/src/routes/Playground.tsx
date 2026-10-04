import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import { useWallet } from '../shared/wallet/useWallet';
import { indexerApiBase } from '../shared/data/providers';
import {
  LoadingState,
  Reveal,
  SectionNo,
} from '../shared/components/primitives';
import { PRIMARY_CHAIN, explorerTxUrl } from '../shared/chains';
import Flywheel from './playground/Flywheel';
import { Hero } from './playground/Hero';
import { BurnSection } from './playground/BurnSection';
import { ChatPanel } from './playground/ChatPanel';
import { ImagePanel } from './playground/ImagePanel';
import { AgentSection } from './playground/AgentSection';
import { ApiNote } from './playground/ui';
import type {
  BurnRecord,
  ChatMessage,
  PlaygroundModel,
} from './playground/types';
import './playground/animations.css';

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

const BURN_LOG_KEY = 'spore-playground-burns';

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
/* Playground page                                                   */
/* ------------------------------------------------------------------ */

export default function Playground() {
  const wallet = useWallet();
  const { status, address, connect, disconnect, error: walletError } = wallet;

  const [apiBase] = useState<string | null>(() => indexerApiBase());

  /* Models */
  const [models, setModels] = useState<PlaygroundModel[]>([]);
  const [modelsState, setModelsState] = useState<
    'idle' | 'loading' | 'ready' | 'unavailable'
  >('idle');

  /* Credits */
  const [credits, setCredits] = useState<number | null>(null);
  const [creditsState, setCreditsState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');

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
    if (!eth)
      throw new Error('No wallet detected. Install a browser wallet to continue.');
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

  async function handleBurn(e: FormEvent) {
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
      const granted = pickNumber(data, [
        'creditsGranted',
        'credits_granted',
        'credits',
      ]);
      const newBal = pickNumber(data, [
        'credits',
        'balance',
        'creditsRemaining',
      ]);
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

  async function handleChatSend(e: FormEvent) {
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
        throw new Error(
          'The API returned a successful response with no message text.',
        );
      }
      setMessages([...next, { role: 'assistant', content: reply }]);
      const deducted = pickNumber(data, [
        'creditsDeducted',
        'credits_deducted',
        'creditsUsed',
      ]);
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

  async function handleImageGenerate(e: FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (generating || !text || !address) return;
    if (!apiBase) {
      setImageError('The playground API is not configured. No request was sent.');
      return;
    }
    if (!imageModel) {
      setImageError(
        'No image model is available yet — the model list has not loaded.',
      );
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
        (pickString(data, ['image', 'url'])
          ? [pickString(data, ['image', 'url']) as string]
          : null);
      if (!urls || urls.length === 0) {
        throw new Error(
          'The API returned a successful response with no images.',
        );
      }
      setImages((prev) => [...urls, ...prev].slice(0, 24));
      const deducted = pickNumber(data, [
        'creditsDeducted',
        'credits_deducted',
        'creditsUsed',
      ]);
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
      <Hero
        credits={credits}
        creditsState={creditsState}
        connected={connected}
        status={status}
        walletError={walletError}
        onConnect={() => void connect()}
        modelCount={models.length}
        chatCount={chatModels.length}
        imageCount={imageModels.length}
      />

      <Flywheel />

      <BurnSection
        connected={connected}
        address={address}
        status={status}
        walletError={walletError}
        onConnect={() => void connect()}
        onDisconnect={disconnect}
        sporeBalance={sporeBalance}
        burnAmount={burnAmount}
        setBurnAmount={setBurnAmount}
        onBurn={(e) => void handleBurn(e)}
        burning={burning}
        burnStep={burnStep}
        burnError={burnError}
        burnOk={burnOk}
        lastBurnTx={lastBurnTx}
      />

      {/* 02 — Spend: chat / image */}
      <section
        aria-labelledby="pg-spend"
        className="mx-auto max-w-6xl px-6 pt-14 md:pt-20"
      >
        <Reveal>
          <SectionNo n="02" />
          <h2
            id="pg-spend"
            className="display mt-3 text-3xl text-ink md:text-4xl"
          >
            Spend credits
          </h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            Every request is signed with your wallet — the API verifies the
            signature, spends your credits, and routes the call to a frontier
            model.
          </p>
        </Reveal>

        {!connected && (
          <div className="mt-8">
            <ApiNote>
              Connect a wallet above to use the playground. Models and credits
              are read per-wallet.
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
              responding. No models are shown because none are known.
            </ApiNote>
          </div>
        )}

        {modelsState === 'ready' && (
          <div className="mt-8">
            {/* Tabs */}
            <div
              role="tablist"
              aria-label="Playground modes"
              className="flex border-b border-rule"
            >
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

            {tab === 'chat' ? (
              <div
                key="chat"
                role="tabpanel"
                id="pg-panel-chat"
                aria-labelledby="pg-tab-chat"
                className="pg-tab-in py-8"
              >
                <ChatPanel
                  models={chatModels}
                  model={chatModel}
                  setModel={setChatModel}
                  messages={messages}
                  sending={sending}
                  input={chatInput}
                  setInput={setChatInput}
                  onSend={(e) => void handleChatSend(e)}
                  error={chatError}
                  meta={lastChatMeta}
                  connected={connected}
                />
              </div>
            ) : (
              <div
                key="image"
                role="tabpanel"
                id="pg-panel-image"
                aria-labelledby="pg-tab-image"
                className="pg-tab-in py-8"
              >
                <ImagePanel
                  models={imageModels}
                  model={imageModel}
                  setModel={setImageModel}
                  prompt={prompt}
                  setPrompt={setPrompt}
                  onGenerate={(e) => void handleImageGenerate(e)}
                  generating={generating}
                  error={imageError}
                  ok={imageOk}
                  images={images}
                  connected={connected}
                />
              </div>
            )}
          </div>
        )}
      </section>

      {/* 03 — Burn history (local) */}
      <section
        aria-labelledby="pg-history"
        className="mx-auto max-w-6xl px-6 pt-14 md:pt-20"
      >
        <Reveal>
          <SectionNo n="03" />
          <h2
            id="pg-history"
            className="display mt-3 text-3xl text-ink md:text-4xl"
          >
            Burn history
          </h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            A record of the burns made from this browser. It is kept in this
            browser's local storage — a local ledger, not an on-chain index.
          </p>
        </Reveal>
        <Reveal delay={80}>
          <div className="mt-8">
            {burnLog.length === 0 ? (
              <p className="border border-rule p-5 font-mono text-[12px] text-faint">
                No burns recorded in this browser yet.
              </p>
            ) : (
              <div className="overflow-x-auto border border-rule transition-colors hover:border-rule-strong">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
                      <th
                        scope="col"
                        className="border-b border-rule-strong px-4 py-3 text-left font-normal"
                      >
                        Transaction
                      </th>
                      <th
                        scope="col"
                        className="border-b border-rule-strong px-4 py-3 text-right font-normal"
                      >
                        Amount
                      </th>
                      <th
                        scope="col"
                        className="border-b border-rule-strong px-4 py-3 text-right font-normal"
                      >
                        Time
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {burnLog.map((r) => (
                      <tr
                        key={r.txHash}
                        className="border-b border-rule transition-colors last:border-b-0 hover:bg-ink/[0.03]"
                      >
                        <td className="px-4 py-3">
                          <a
                            href={explorerTxUrl(r.txHash)}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-[13px] text-moss underline underline-offset-4 transition-colors hover:text-ink select-all"
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
        </Reveal>
      </section>

      <AgentSection apiBase={apiBase} merchant={PLAYGROUND_MERCHANT} />
    </div>
  );
}
