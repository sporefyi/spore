import { useEffect, useRef, useState } from 'react';
import { Reveal, SectionNo } from '../../shared/components/primitives';
import { useInView, useReducedMotion } from './hooks';

/**
 * Flywheel — the stake→borrow→spend→burn→repay loop as a living circle.
 *
 * Five nodes on a ring. A pulse wave travels the loop in sequence; small
 * particles ride the ring continuously. The $SPORE burn node glows moss.
 * Pure SVG + CSS — no WebGL needed. Reduced motion: static ring.
 */

const STEPS = [
  { n: '01', title: 'Backers stake USDG', line: 'Capital enters the vault.' },
  { n: '02', title: 'Agents borrow', line: 'Credit lines open on score.' },
  { n: '03', title: 'Spend at playground', line: 'Calls settle in USDG and credits.' },
  { n: '04', title: '$SPORE burns', line: 'Every burn shrinks supply.', accent: true },
  { n: '05', title: 'Agents repay', line: 'Clean credit feeds the next loan.' },
];

const CYCLE_S = 10; // full pulse cycle

export default function Flywheel() {
  const [wrapRef, inView] = useInView<HTMLDivElement>(0.2);
  const reduced = useReducedMotion();
  const [pulse, setPulse] = useState(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!inView || reduced) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = ((now - start) / 1000) % CYCLE_S;
      setPulse(Math.floor(t / (CYCLE_S / STEPS.length)) % STEPS.length);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [inView, reduced]);

  // Ring geometry: 5 nodes on a circle, viewBox 600x600, center 300,300, r 190.
  const nodes = STEPS.map((s, i) => {
    const a = (i / STEPS.length) * Math.PI * 2 - Math.PI / 2;
    return { ...s, x: 300 + Math.cos(a) * 190, y: 300 + Math.sin(a) * 190, i };
  });

  // Ring path for traveling particles.
  const ringPath = `M 300 110 A 190 190 0 1 1 299.9 110`;

  return (
    <section aria-label="The flywheel" className="border-y border-rule">
      <div className="mx-auto max-w-6xl px-6 py-14 md:py-20">
        <Reveal>
          <SectionNo n="✳" />
          <h2 className="display mt-3 text-3xl text-ink md:text-4xl">The flywheel</h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            Capital in, intelligence out, supply down. Every loop makes the next
            one cheaper to run and harder to fake.
          </p>
        </Reveal>

        <div ref={wrapRef} className="mt-10 grid items-center gap-10 lg:grid-cols-2">
          {/* Ring diagram */}
          <div className={`relative mx-auto w-full max-w-[520px] ${inView ? 'fw-in' : 'opacity-0'}`}>
            <svg viewBox="0 0 600 600" className="block w-full" role="img"
              aria-label="Circular diagram of the SPORE flywheel: stake, borrow, spend, burn, repay">
              <defs>
                <filter id="fw-glow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="6" result="b" />
                  <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>

              {/* faint ring */}
              <circle cx="300" cy="300" r="190" fill="none" stroke="var(--rule)" strokeWidth="1" />
              {/* progress arc — grows through the cycle */}
              {!reduced && (
                <circle cx="300" cy="300" r="190" fill="none" stroke="var(--moss)"
                  strokeWidth="1.5" opacity="0.55" strokeLinecap="round"
                  strokeDasharray={`${(pulse + 1) * 238.8} 1194`}
                  transform="rotate(-90 300 300)"
                  style={{ transition: 'stroke-dasharray 0.6s ease' }} />
              )}

              {/* traveling particles */}
              {!reduced && [0, 1, 2].map((k) => (
                <circle key={k} r="3.5" fill="var(--moss)" opacity="0.9" filter="url(#fw-glow)">
                  <animateMotion dur={`${CYCLE_S}s`} repeatCount="indefinite" path={ringPath}
                    begin={`${-k * (CYCLE_S / 3)}s`} />
                </circle>
              ))}

              {/* nodes */}
              {nodes.map((nd) => {
                const active = !reduced && nd.i === pulse;
                const color = nd.accent ? 'var(--moss)' : active ? 'var(--fungal)' : 'var(--faint)';
                return (
                  <g key={nd.n} className="fw-node" style={{ transitionDelay: `${nd.i * 120}ms` }}>
                    {active && (
                      <circle cx={nd.x} cy={nd.y} r="34" fill="none" stroke={color}
                        strokeWidth="1" opacity="0.5" filter="url(#fw-glow)" />
                    )}
                    <circle cx={nd.x} cy={nd.y} r="22" fill="var(--bg)" stroke={color}
                      strokeWidth={active || nd.accent ? 1.5 : 1}
                      filter={active || nd.accent ? 'url(#fw-glow)' : undefined}
                      style={{ transition: 'all 0.5s ease' }} />
                    <text x={nd.x} y={nd.y + 4} textAnchor="middle" fill="var(--ink)"
                      fontSize="12" fontFamily="var(--font-mono)">{nd.n}</text>
                  </g>
                );
              })}

              {/* center label */}
              <text x="300" y="292" textAnchor="middle" fill="var(--ink)"
                fontSize="17" fontFamily="var(--font-serif)" fontStyle="italic">$SPORE</text>
              <text x="300" y="314" textAnchor="middle" fill="var(--faint)"
                fontSize="10" fontFamily="var(--font-mono)" letterSpacing="2">FLYWHEEL</text>
            </svg>
          </div>

          {/* Step list — highlights in sync with the pulse */}
          <ol className="space-y-1">
            {nodes.map((nd) => {
              const active = !reduced && nd.i === pulse;
              return (
                <li key={nd.n}
                  className={`border-l-2 py-3 pl-5 pr-4 transition-all duration-500 ${
                    active ? 'border-moss bg-moss/[0.06]' : 'border-rule'
                  }`}>
                  <div className="flex items-baseline gap-3">
                    <span className={`font-mono text-[11px] tracking-[0.18em] ${active ? 'text-moss' : 'text-faint'}`}>
                      {nd.n}
                    </span>
                    <h3 className={`font-mono text-[12px] uppercase tracking-[0.14em] ${nd.accent ? 'text-moss' : 'text-ink'}`}>
                      {nd.title}
                    </h3>
                  </div>
                  <p className="mt-1 pl-9 text-sm text-muted">{nd.line}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <style>{`
        .fw-in .fw-node { animation: fw-node-in 0.7s cubic-bezier(0.22,1,0.36,1) both; }
        @keyframes fw-node-in { from { opacity: 0; transform: scale(0.7); } to { opacity: 1; transform: scale(1); } }
        @media (prefers-reduced-motion: reduce) {
          .fw-in .fw-node { animation: none; }
        }
      `}</style>
    </section>
  );
}
