import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SporeScene } from './components/spore/SporeScene';
import { SporeMushroom } from './components/spore/SporeMushroom';
import { MyceliumNetwork } from './components/spore/MyceliumNetwork';
import { SporeParticles } from './components/spore/SporeParticles';
import { MarketScene } from './components/spore/MarketScene';
import { AgentWorld } from './components/spore/AgentWorld';
import { ServiceZone } from './components/spore/ServiceZone';
import { fetchRepayments, refreshRepayments } from './components/spore/repayments';
import type { PhaseName, Repayment, ZoneInfo } from './components/spore/types';
import { PHASE_ORDER } from './components/spore/types';

/** The engine's final phase ('LIVE') — the end card rises when it fires. */
const TERMINAL_PHASE: PhaseName = PHASE_ORDER[PHASE_ORDER.length - 1];

const PHASE_CAPTIONS: Record<PhaseName, string> = {
  DARKNESS: '01 — DARKNESS',
  MYCELIUM: '02 — MYCELIUM',
  MARKET: '03 — MARKET',
  AGENTS: '04 — AGENTS',
  ZONES: '05 — ZONES',
  MUSHROOM: '06 — MUSHROOM',
  ACTIVATION: '07 — ACTIVATION',
  LIVE: '08 — LIVE',
};

function captionFor(phase: PhaseName, repayCount: number | null): string {
  if (phase === 'MYCELIUM') {
    if (repayCount === null) return '02 — MYCELIUM';
    if (repayCount === 0)
      return 'The mycelium is empty — for now. Every repayment becomes a spore, read from the chain.';
    const s = repayCount === 1 ? '' : 's';
    return `${repayCount} repayment${s} on-chain — every repayment a spore, read from the chain.`;
  }
  return PHASE_CAPTIONS[phase] ?? String(phase).replace(/[_-]+/g, ' ').toUpperCase();
}

function webglAvailable(canvas: HTMLCanvasElement): boolean {
  try {
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

const POSTER = '/brand/market-live-poster.jpg';
const LINK_CLS =
  'text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink';
const BTN_CLS =
  'pointer-events-auto border border-rule-strong bg-bg/70 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink/80 backdrop-blur-sm transition-colors hover:border-ink hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-moss focus-visible:outline-offset-2';

export default function LivePage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<SporeScene | null>(null);
  const myceliumRef = useRef<MyceliumNetwork | null>(null);
  const repayCountRef = useRef<number | null>(null);
  const zonesRef = useRef<ZoneInfo[]>([]);
  const activeZonesRef = useRef<Set<string>>(new Set());
  const labelElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const endedRef = useRef(false);

  const [webglOk, setWebglOk] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [zones, setZones] = useState<ZoneInfo[]>([]);
  const [phase, setPhase] = useState<PhaseName | null>(null);
  const [ended, setEnded] = useState(false);
  const [repayCount, setRepayCount] = useState<number | null>(null);
  const [dragged, setDragged] = useState(false);
  const [reducedMotion] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  const markEnded = useCallback(() => {
    endedRef.current = true;
    setEnded(true);
  }, []);

  const handleReplay = useCallback(() => {
    endedRef.current = false;
    activeZonesRef.current = new Set();
    setEnded(false);
    engineRef.current?.replay();
  }, []);

  const handleSkip = useCallback(() => {
    engineRef.current?.skipToEnd();
    activeZonesRef.current = new Set(zonesRef.current.map((z) => z.id));
    markEnded();
  }, [markEnded]);

  // Reduced motion: the engine stills the 3D; the page shows final type at once.
  useEffect(() => {
    if (reducedMotion) markEnded();
  }, [reducedMotion, markEnded]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    if (!webglAvailable(canvas)) {
      setWebglOk(false);
      return;
    }
    setWebglOk(true);

    const projectLabels = () => {
      const engine = engineRef.current;
      const box = wrapRef.current;
      if (!engine || !box) return;
      const rect = box.getBoundingClientRect();
      for (const z of zonesRef.current) {
        const el = labelElsRef.current.get(z.id);
        if (!el) continue;
        const p = engine.project(z.anchor);
        const show = activeZonesRef.current.has(z.id) && p.visible;
        const x = Math.min(Math.max(p.x, 96), Math.max(96, rect.width - 96));
        const y = Math.min(Math.max(p.y, 64), Math.max(64, rect.height - 32));
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -130%)`;
        el.style.opacity = show ? '1' : '0';
      }
    };

    const engine = new SporeScene(canvas, {
      onPhase: (p: PhaseName) => {
        setPhase(p);
        if (p === TERMINAL_PHASE) markEnded();
      },
      onFirstDrag: () => setDragged(true),
    });
    engineRef.current = engine;

    // Integration seam: SporeScene exposes the LiveContext its modules need.
    const ctx = engine.getContext();

    const particles = new SporeParticles(ctx);
    const serviceZone = new ServiceZone(ctx, particles, {
      onZoneActive: (id: string) => {
        activeZonesRef.current.add(id);
      },
    });

    const mycelium = new MyceliumNetwork(ctx);
    myceliumRef.current = mycelium;

    engine.addModule(new SporeMushroom(ctx));
    engine.addModule(mycelium);
    engine.addModule(particles);
    engine.addModule(new MarketScene(ctx));
    engine.addModule(new AgentWorld(ctx, particles));
    engine.addModule(serviceZone);

    // Chain data: every on-chain repayment becomes a spore thread in the
    // mycelium. Resolves [] on failure — the procedural fallback stays.
    // Re-reads every 2 minutes so new repayments grow new threads live.
    const applyRepayments = (reps: Repayment[]) => {
      repayCountRef.current = reps.length;
      setRepayCount(reps.length);
      ctx.repayments = reps;
      myceliumRef.current?.setRepayments(reps);
    };
    fetchRepayments().then(applyRepayments);
    const repayTimer = window.setInterval(() => {
      refreshRepayments().then((reps) => {
        if (reps.length !== repayCountRef.current) applyRepayments(reps);
      });
    }, 120000);

    const zs = serviceZone.getZones();
    zonesRef.current = zs;
    setZones(zs);
    engine.setZones(zs);

    engine.start();

    // Loader: first frame painted, then a short minimum beat before the fade.
    let readyTimer = 0;
    const readyRaf = requestAnimationFrame(() => {
      readyTimer = window.setTimeout(() => setReady(true), 600);
    });

    // Zone labels follow the 3D anchors; projected every 3rd frame.
    let raf = 0;
    let frame = 0;
    let disposed = false;
    const tick = () => {
      if (disposed) return;
      frame += 1;
      if (frame % 3 === 0) projectLabels();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(readyRaf);
      window.clearTimeout(readyTimer);
      window.clearInterval(repayTimer);
      engine.dispose();
      engineRef.current = null;
      myceliumRef.current = null;
      zonesRef.current = [];
      activeZonesRef.current = new Set();
      labelElsRef.current.clear();
    };
  }, [markEnded]);

  const zoneNames = zones.map((z) => z.label).join(', ');

  return (
    <div className="overflow-x-hidden bg-bg text-ink">
      <section aria-label="The market is live — cinematic">
        <p className="sr-only">
          A cinematic WebGL sequence: a single spore germinates into a mycelium network, which blooms
          into a marketplace where agents trade on stake-backed credit, ending with the network alive.
          {zoneNames ? ` Zone markers: ${zoneNames}.` : ''}
        </p>

        {webglOk === false ? (
          <div className="relative flex h-[92svh] min-h-[560px] w-full items-center justify-center overflow-hidden">
            <img
              src={POSTER}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover opacity-40"
            />
            <div className="relative max-w-xl px-6 text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-moss">
                SPORE — cinematic
              </p>
              <h1 className="mt-4 font-serif text-4xl text-ink md:text-5xl">The market is live</h1>
              <p className="mt-4 font-serif text-lg leading-relaxed text-muted">
                This browser couldn&rsquo;t start WebGL, so the cinematic can&rsquo;t play here — but
                the market doesn&rsquo;t wait for a renderer. Explore the network and see how credit
                works instead.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
                <Link to="/agents" className={LINK_CLS}>
                  Explore the network →
                </Link>
                <Link to="/protocol" className={LINK_CLS}>
                  How credit works →
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <div ref={wrapRef} className="relative h-[92svh] min-h-[560px] w-full overflow-hidden">
            <canvas
              ref={canvasRef}
              aria-hidden="true"
              className="absolute inset-0 block h-full w-full"
              style={{ touchAction: 'pan-y' }}
            />

            {/* Zone labels — positioned from 3D anchors every 3rd frame */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-1000"
              style={{ opacity: ended ? 0 : 1 }}
            >
              {zones.map((z) => (
                <div
                  key={z.id}
                  ref={(el) => {
                    if (el) labelElsRef.current.set(z.id, el);
                    else labelElsRef.current.delete(z.id);
                  }}
                  className="absolute left-0 top-0 opacity-0 transition-opacity duration-700"
                >
                  <div className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.22em] text-ink/80">
                    {z.label}
                  </div>
                  <div className="mt-1 h-px w-12 bg-ink/40" />
                </div>
              ))}
            </div>

            {/* Phase caption */}
            {phase && !ended && (
              <p className="pointer-events-none absolute bottom-4 left-4 z-20 max-w-[60%] font-mono text-[10px] uppercase leading-relaxed tracking-[0.22em] text-ink/60">
                {captionFor(phase, repayCount)}
              </p>
            )}

            {/* Drag hint — fades after the first drag */}
            {!dragged && !ended && phase && (phase === 'DARKNESS' || phase === 'MYCELIUM' || phase === 'MARKET') && (
              <p className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.22em] text-ink/50">
                Drag to turn it
              </p>
            )}

            {/* Controls */}
            <div className="absolute bottom-4 right-4 z-20 flex gap-2">
              <button
                type="button"
                onClick={handleReplay}
                aria-label="Replay the cinematic from the beginning"
                className={BTN_CLS}
              >
                Replay
              </button>
              <button
                type="button"
                onClick={handleSkip}
                aria-label="Skip to the end of the cinematic"
                className={BTN_CLS}
              >
                Skip
              </button>
            </div>

            {/* Final frame */}
            <div
              aria-hidden={!ended}
              className={`pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center transition-opacity duration-[2000ms] ${
                ended ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <p className="font-serif text-5xl text-ink md:text-6xl">$SPORE</p>
              <div className="mt-5 h-px w-16 bg-ink/40" />
              <p className="mt-5 font-mono text-xs tracking-[0.3em] text-ink/85">
                THE MARKET IS LIVE
              </p>
              {reducedMotion && (
                <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
                  Reduced motion — showing the final frame
                </p>
              )}
            </div>

            {/* Loader */}
            <div
              aria-hidden="true"
              className={`absolute inset-0 z-30 flex flex-col items-center justify-center overflow-hidden transition-opacity duration-700 ${
                ready ? 'pointer-events-none opacity-0' : 'opacity-100'
              }`}
            >
              <img
                src={POSTER}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-cover opacity-30"
              />
              <div className="absolute inset-0 bg-bg/30" />
              <p className="relative font-serif text-4xl tracking-[0.35em] text-ink">SPORE</p>
              <span
                aria-hidden="true"
                className="live-dot relative mt-8 block h-2 w-2 rounded-full bg-moss"
              />
            </div>
          </div>
        )}
      </section>

      {/* Editorial — no WebGL required */}
      <section className="mx-auto max-w-3xl px-6 py-16 md:py-24">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-moss">
          The cinematic
        </p>
        <h2 className="mt-4 font-serif text-3xl text-ink md:text-4xl">The market is live</h2>
        <div className="mt-6 space-y-4 font-serif text-lg leading-relaxed text-muted">
          <p>
            It begins with a single spore — one agent&rsquo;s first repayment, recorded on Robinhood
            Chain. From there the mycelium spreads: backers stake behind the agents they believe in,
            and every repayment feeds the network&rsquo;s shared memory.
          </p>
          <p>
            The market is what grows on top — agents borrowing against portable credit history,
            merchants accepting stake-backed spending, the whole loop compounding. What you just
            watched is that loop, alive.
          </p>
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4">
          <Link to="/agents" className={LINK_CLS}>
            Explore the network →
          </Link>
          <Link to="/protocol" className={LINK_CLS}>
            How credit works →
          </Link>
        </div>
      </section>
    </div>
  );
}
