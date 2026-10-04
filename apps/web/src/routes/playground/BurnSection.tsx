import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Eyebrow, Reveal, SectionNo } from '../../shared/components/primitives';
import { explorerAddressUrl, explorerTxUrl } from '../../shared/chains';
import { shortAddr } from '../../shared/wallet/useWallet';
import {
  CopyableAddress,
  ErrorLine,
  MagneticButton,
  ParticleBurst,
  SuccessLine,
  TxStepper,
} from './ui';

/**
 * BurnSection — the ceremonial heart of the playground.
 * Ember-glow burn button, particle burst on confirmation,
 * and a three-step tx ceremony: signed → confirmed → credited.
 */

const SPORE_PER_CREDIT = 100;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';

function stepFromBurnStep(s: string | null): number {
  if (!s) return -1;
  if (s.startsWith('Requesting')) return 0;
  if (s.startsWith('Sending')) return 1;
  if (s.startsWith('Waiting')) return 1;
  if (s.startsWith('Burn confirmed')) return 2;
  return -1;
}

interface BurnSectionProps {
  connected: boolean;
  address: string | null;
  status: string;
  walletError: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  sporeBalance: string | null;
  burnAmount: string;
  setBurnAmount: (v: string) => void;
  onBurn: (e: FormEvent) => void;
  burning: boolean;
  burnStep: string | null;
  burnError: string | null;
  burnOk: string | null;
  lastBurnTx: string | null;
}

export function BurnSection(props: BurnSectionProps) {
  const {
    connected,
    address,
    status,
    walletError,
    onConnect,
    onDisconnect,
    sporeBalance,
    burnAmount,
    setBurnAmount,
    onBurn,
    burning,
    burnStep,
    burnError,
    burnOk,
    lastBurnTx,
  } = props;

  const [burstKey, setBurstKey] = useState(0);
  const prevOk = useRef<string | null>(null);

  // Fire the ember burst the moment a burn grant lands.
  useEffect(() => {
    if (burnOk && burnOk !== prevOk.current) {
      setBurstKey((k) => k + 1);
    }
    prevOk.current = burnOk;
  }, [burnOk, setBurstKey]);

  const step = burning ? stepFromBurnStep(burnStep) : burnOk ? 3 : -1;
  const preview =
    burnAmount && Number(burnAmount) > 0 && Number.isFinite(Number(burnAmount))
      ? Math.floor(Number(burnAmount) * SPORE_PER_CREDIT).toLocaleString()
      : null;

  return (
    <section
      aria-labelledby="pg-human"
      className="mx-auto max-w-6xl px-6 pt-14 md:pt-20"
    >
      <Reveal>
        <SectionNo n="01" />
        <h2
          id="pg-human"
          className="display mt-3 text-3xl text-ink md:text-4xl"
        >
          Get credits
        </h2>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          Humans enter the playground by burning $SPORE. Each burn grants
          credits instantly —{' '}
          <span className="text-ink">
            1 $SPORE = {SPORE_PER_CREDIT} credits
          </span>{' '}
          — and the tokens leave circulation for good.
        </p>
      </Reveal>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        {/* Wallet panel */}
        <Reveal className="border border-rule p-6 transition-colors hover:border-rule-strong md:p-8">
          <Eyebrow>Wallet</Eyebrow>
          {status === 'connected' && address ? (
            <div className="mt-4">
              <a
                href={explorerAddressUrl(address)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-sm text-ink underline decoration-rule-strong underline-offset-4 transition-colors hover:decoration-ink"
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
                    {sporeBalance === null
                      ? '…'
                      : `${Number(sporeBalance).toLocaleString(undefined, {
                          maximumFractionDigits: 4,
                        })} $SPORE`}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-faint">Burn destination</dt>
                  <dd className="max-w-[60%] overflow-hidden text-right">
                    <CopyableAddress
                      address={DEAD_ADDRESS}
                      label="Burn address"
                    />
                  </dd>
                </div>
              </dl>
              <button
                type="button"
                onClick={onDisconnect}
                className="mt-5 font-mono text-[11px] uppercase tracking-[0.18em] text-faint transition-colors hover:text-ink"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="mt-4">
              <MagneticButton
                onClick={onConnect}
                disabled={status === 'connecting'}
                className="border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal hover:bg-fungal/10 disabled:opacity-50"
              >
                {status === 'connecting'
                  ? 'Waiting for wallet…'
                  : status === 'wrong-chain'
                    ? 'Switch to Robinhood Chain'
                    : 'Connect wallet'}
              </MagneticButton>
              {walletError && (
                <p
                  role="alert"
                  className="mt-2 font-mono text-[11px] text-ember"
                >
                  {walletError}
                </p>
              )}
              {status === 'wrong-chain' && !walletError && (
                <p className="mt-2 font-mono text-[11px] text-ember">
                  Wrong network — approve the switch to Robinhood Chain (4663).
                </p>
              )}
            </div>
          )}
        </Reveal>

        {/* Burn panel */}
        <Reveal
          delay={80}
          className="relative border border-rule p-6 transition-colors hover:border-rule-strong md:p-8"
        >
          <ParticleBurst burstKey={burstKey} />
          <Eyebrow>Burn $SPORE</Eyebrow>
          <form onSubmit={onBurn} className="relative mt-4">
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
                className="w-full border border-rule-strong bg-transparent px-4 py-3 font-mono text-lg text-ink tnum placeholder:text-faint focus:border-moss focus:outline-none disabled:opacity-50"
              />
              <MagneticButton
                type="submit"
                disabled={burning || !connected}
                className="pg-ember shrink-0 border border-moss/70 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-moss hover:bg-moss/10 disabled:opacity-50"
              >
                {burning ? (burnStep ?? 'Burning…') : 'Burn $SPORE'}
              </MagneticButton>
            </div>
            <p className="mt-3 text-sm text-muted">
              Grants{' '}
              <span className="font-mono text-ink">
                {SPORE_PER_CREDIT} credits
              </span>{' '}
              per $SPORE.
              {preview && (
                <span className="font-mono text-moss"> → {preview} credits</span>
              )}
            </p>
            {!connected && (
              <p className="mt-3 font-mono text-[11px] text-faint">
                Connect a wallet first — the burn is a real on-chain
                transaction.
              </p>
            )}
            {lastBurnTx && (
              <p className="mt-3 font-mono text-[12px] text-faint">
                Last burn:{' '}
                <a
                  href={explorerTxUrl(lastBurnTx)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-moss underline underline-offset-4 transition-colors hover:text-ink select-all"
                >
                  {lastBurnTx.slice(0, 10)}…{lastBurnTx.slice(-8)}
                </a>
              </p>
            )}
            <TxStepper step={step} />
            <ErrorLine message={burnError} />
            <SuccessLine message={burnOk} />
          </form>
        </Reveal>
      </div>
    </section>
  );
}
