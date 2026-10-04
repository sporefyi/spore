import { Link } from 'react-router-dom';
import SporeField from './SporeField';
import { Eyebrow, Reveal } from '../../shared/components/primitives';
import { useCountUp } from './hooks';
import { MagneticButton } from './ui';

/**
 * Hero — the SporeField canvas breathes behind the headline:
 * spores spawning from the ground, mycelial lines beneath.
 * Live credit balance with count-up, model census, connect CTA.
 */

interface HeroProps {
  credits: number | null;
  creditsState: 'idle' | 'loading' | 'ready' | 'error';
  connected: boolean;
  status: string;
  walletError: string | null;
  onConnect: () => void;
  modelCount: number;
  chatCount: number;
  imageCount: number;
}

export function Hero({
  credits,
  creditsState,
  connected,
  status,
  walletError,
  onConnect,
  modelCount,
  chatCount,
  imageCount,
}: HeroProps) {
  const creditDisplay = useCountUp(credits);

  return (
    <header className="relative overflow-hidden border-b border-rule">
      <SporeField className="absolute inset-0 block h-full w-full" />
      {/* blend the canvas floor into the page */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-bg to-transparent"
      />

      <div className="relative mx-auto max-w-6xl px-6">
        <nav aria-label="Breadcrumb" className="pt-6">
          <Link
            to="/"
            className="font-mono text-[12px] uppercase tracking-widest text-faint transition-colors hover:text-moss"
          >
            <span aria-hidden="true">←</span> SPORE
          </Link>
        </nav>
      </div>

      <div className="relative mx-auto max-w-6xl px-6 pb-32 pt-14 md:pb-44 md:pt-24">
        <Reveal>
          <Eyebrow>The 6th merchant</Eyebrow>
          <h1 className="display mt-4 text-7xl text-ink md:text-8xl">
            Playground
          </h1>
          <p className="mt-4 max-w-xl font-serif text-xl italic text-muted md:text-2xl">
            Burn $SPORE. Use frontier AI models. Every call feeds the flywheel.
          </p>
        </Reveal>

        <Reveal delay={140}>
          <div className="mt-12 flex flex-wrap items-end gap-x-14 gap-y-10">
            <div>
              <div className="eyebrow">Your credits</div>
              <div
                role="status"
                aria-live="polite"
                className="mt-2 font-mono text-5xl text-ink tnum md:text-6xl"
              >
                {creditsState === 'ready' && credits !== null ? (
                  <>
                    {creditDisplay}{' '}
                    <span className="text-2xl text-moss">credits</span>
                  </>
                ) : creditsState === 'loading' ? (
                  <span className="text-faint">…</span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </div>
              <p className="mt-2 max-w-[16rem] text-sm text-faint">
                {connected
                  ? 'Spendable on chat and image models below.'
                  : 'Connect a wallet to read your balance.'}
              </p>
            </div>

            <div>
              <div className="eyebrow">Models live</div>
              <div className="mt-2 font-mono text-5xl text-ink tnum md:text-6xl">
                {modelCount > 0 ? (
                  <>
                    {modelCount.toLocaleString()}
                    <span className="ml-3 align-middle text-lg text-faint">
                      {chatCount} chat · {imageCount} image
                    </span>
                  </>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </div>
              <p className="mt-2 max-w-[16rem] text-sm text-faint">
                Probed individually. Only working models are listed.
              </p>
            </div>

            {!connected && (
              <div className="pb-1">
                <MagneticButton
                  onClick={onConnect}
                  disabled={status === 'connecting'}
                  className="border border-fungal/60 px-8 py-4 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal hover:bg-fungal/10 disabled:opacity-50"
                >
                  {status === 'connecting'
                    ? 'Waiting for wallet…'
                    : 'Connect wallet'}
                </MagneticButton>
                {walletError && (
                  <p
                    role="alert"
                    className="mt-2 max-w-[16rem] font-mono text-[11px] text-ember"
                  >
                    {walletError}
                  </p>
                )}
              </div>
            )}
          </div>
        </Reveal>
      </div>

      <div
        aria-hidden="true"
        className="absolute bottom-6 left-1/2 -translate-x-1/2"
      >
        <div className="pg-scroll-cue font-mono text-[10px] uppercase tracking-[0.3em] text-faint">
          Scroll
        </div>
      </div>
    </header>
  );
}
