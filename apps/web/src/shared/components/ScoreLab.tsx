import { useEffect, useMemo, useRef, useState } from 'react';
import { animate } from 'framer-motion';
import { Eyebrow, Rule, Reveal } from './primitives';

function cx(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* Model v0.1 — from docs/scoring.md. Weights sum to 1.0; the two      */
/* `future` dimensions are defined but unscored, so the maximum        */
/* attainable score under v0.1 is 890.                                 */
/* ------------------------------------------------------------------ */

type Kind = 'observed' | 'derived' | 'future';

interface Dim {
  name: string;
  w: number;
  kind: Kind;
  desc: string;
}

const DIMS: Dim[] = [
  { name: 'Repayment history', w: 0.2, kind: 'observed', desc: 'Share of borrowed credit repaid in full' },
  { name: 'Repayment punctuality', w: 0.12, kind: 'observed', desc: 'Repayments arriving on or before due date' },
  { name: 'Credit utilization', w: 0.1, kind: 'observed', desc: 'Outstanding drawn relative to the limit' },
  { name: 'Revenue consistency', w: 0.08, kind: 'derived', desc: 'Stability of revenue across rolling 90-day windows' },
  { name: 'Revenue growth', w: 0.05, kind: 'future', desc: 'Direction of the revenue trend — not scored yet' },
  { name: 'Agent age', w: 0.05, kind: 'observed', desc: 'Days since first observed on-chain activity' },
  { name: 'Identity continuity', w: 0.06, kind: 'derived', desc: 'One stable identity vs. rotating keys' },
  { name: 'Cross-chain activity', w: 0.05, kind: 'observed', desc: 'Chains with verifiable activity' },
  { name: 'Payment volume', w: 0.08, kind: 'observed', desc: 'Total value settled across observed transactions' },
  { name: 'Default history', w: 0.1, kind: 'observed', desc: 'Count and recency of missed obligations' },
  { name: 'Sponsor / backer quality', w: 0.06, kind: 'future', desc: 'Track record of sponsors — not scored yet' },
  { name: 'Concentration risk', w: 0.05, kind: 'derived', desc: 'Revenue or credit with a single counterparty' },
];

/* Default: a seasoned repayer → 699.5 ≈ 700 (LOW → $250). */
const DEFAULT_X = [850, 800, 750, 700, 0, 650, 900, 500, 700, 1000, 0, 700];
const NEW_SPORE_X = [500, 500, 500, 500, 0, 500, 500, 500, 500, 1000, 0, 500];

function bandOf(s: number): { band: string; limit: string } {
  if (s >= 800) return { band: 'VERY LOW', limit: '$500' };
  if (s >= 650) return { band: 'LOW', limit: '$250' };
  if (s >= 500) return { band: 'MODERATE', limit: '$100' };
  if (s >= 300) return { band: 'ELEVATED', limit: '$25' };
  return { band: 'HIGH', limit: '$0' };
}

const KIND_CLASS: Record<Kind, string> = {
  observed: 'text-moss',
  derived: 'text-fungal',
  future: 'text-faint',
};

export default function ScoreLab() {
  const [xs, setXs] = useState<number[]>(DEFAULT_X);
  const [shown, setShown] = useState(0);
  const prev = useRef(0);

  const { score, parts } = useMemo(() => {
    let s = 0;
    const ps = DIMS.map((d, i) => {
      const c = d.kind === 'future' ? 0 : d.w * xs[i];
      s += c;
      return c;
    });
    return { score: Math.round(s * 10) / 10, parts: ps };
  }, [xs]);

  const scoreInt = Math.round(score);
  const { band, limit } = bandOf(scoreInt);

  const reducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  useEffect(() => {
    if (reducedMotion) {
      setShown(scoreInt);
      prev.current = scoreInt;
      return;
    }
    const controls = animate(prev.current, scoreInt, {
      duration: 0.5,
      ease: 'easeOut',
      onUpdate: (v) => setShown(Math.round(v)),
    });
    prev.current = scoreInt;
    return () => controls.stop();
  }, [scoreInt, reducedMotion]);

  const set = (i: number, v: number) =>
    setXs((prevXs) => prevXs.map((x, j) => (j === i ? v : x)));

  const expansion = useMemo(
    () =>
      DIMS.map((d, i) =>
        d.kind === 'future' ? null : `${d.w.toFixed(2)}×${xs[i]}`,
      )
        .filter(Boolean)
        .join(' + '),
    [xs],
  );

  const maxPart = Math.max(...DIMS.map((d) => d.w * 1000));

  return (
    <div>
      <Reveal>
        <Eyebrow>SCORE LABORATORY</Eyebrow>
        <h3 className="display mt-6 text-3xl text-ink md:text-5xl">
          The equation.
        </h3>
        <p className="mt-6 max-w-2xl font-serif text-lg leading-relaxed text-muted">
          Twelve dimensions, one weighted sum. Move the sliders — every
          dimension is scored 0–1000, and the equation below is the model
          itself, computed live.
        </p>
      </Reveal>

      {/* live equation */}
      <div className="mt-12 border-y border-rule py-8">
        <div className="font-serif text-3xl text-ink md:text-4xl">
          S = <span className="italic text-moss">Σ</span> w<sub>i</sub>·x<sub>i</sub>
          <span className="tnum"> = {shown}</span>
        </div>
        <div className="mt-4 overflow-x-auto">
          <code className="whitespace-nowrap font-mono text-[13px] leading-relaxed text-muted">
            S = {expansion} = <span className="text-ink">{score.toFixed(1)}</span>
          </code>
        </div>
        <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
          Model v0.1 · x<sub>5</sub>, x<sub>11</sub> unscored — maximum attainable 890
        </p>
      </div>

      {/* presets + readout */}
      <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4">
        <button
          type="button"
          onClick={() => setXs(NEW_SPORE_X)}
          className="font-mono text-xs uppercase tracking-[0.18em] text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink"
        >
          A new spore →
        </button>
        <button
          type="button"
          onClick={() => setXs(DEFAULT_X)}
          className="font-mono text-xs uppercase tracking-[0.18em] text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink"
        >
          A seasoned repayer →
        </button>
        <div className="ml-auto flex items-baseline gap-6">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">Risk band</div>
            <div className="mt-1 font-serif text-2xl text-ink">{band}</div>
          </div>
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">Suggested max limit</div>
            <div className="tnum mt-1 font-serif text-2xl text-moss">{limit}</div>
          </div>
        </div>
      </div>

      {/* sliders */}
      <div className="mt-12">
        {DIMS.map((d, i) => {
          const locked = d.kind === 'future';
          return (
            <div key={d.name}>
              {i > 0 && <Rule />}
              <div className="grid gap-3 py-5 md:grid-cols-[minmax(0,1fr)_220px_120px] md:items-center md:gap-8">
                <div>
                  <div className="flex flex-wrap items-baseline gap-x-4">
                    <span className={cx('font-serif text-xl', locked ? 'text-faint' : 'text-ink')}>
                      {d.name}
                    </span>
                    <span className={cx('font-mono text-[10px] uppercase tracking-[0.2em]', KIND_CLASS[d.kind])}>
                      {d.kind}
                    </span>
                    <span className="tnum font-mono text-xs text-faint">
                      w = {d.w.toFixed(2)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-faint">{d.desc}</p>
                  {/* contribution bar */}
                  <div className="mt-3 h-px w-full bg-rule">
                    <div
                      className={cx('h-px transition-all duration-300', locked ? 'bg-rule-strong' : 'bg-moss')}
                      style={{ width: `${(parts[i] / maxPart) * 100}%` }}
                    />
                  </div>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1000}
                  step={10}
                  value={xs[i]}
                  disabled={locked}
                  onChange={(e) => set(i, Number(e.target.value))}
                  aria-label={`${d.name} dimension score`}
                  className="scorelab-range w-full"
                />
                <div className="flex items-baseline justify-between md:justify-end md:gap-6">
                  <span className={cx('tnum font-mono text-sm', locked ? 'text-faint' : 'text-ink')}>
                    x = {locked ? '—' : xs[i]}
                  </span>
                  <span className={cx('tnum font-mono text-sm', locked ? 'text-faint' : 'text-moss')}>
                    +{parts[i].toFixed(1)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        <Rule />
      </div>

      <p className="mt-8 max-w-3xl text-sm leading-relaxed text-faint">
        Model v0.1 — provisional and not validated against real repayment
        outcomes. SPORE publishes no default probabilities: a score is a
        score, not a chance of default. Future dimensions carry no weight
        until they can be measured honestly. Read the full specification in{' '}
        <span className="font-mono text-[12px]">docs/scoring.md</span>.
      </p>
    </div>
  );
}
