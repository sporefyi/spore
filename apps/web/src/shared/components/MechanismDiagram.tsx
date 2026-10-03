import { useEffect, useMemo, useRef, useState } from 'react';
import { Eyebrow, Rule, Reveal } from './primitives';

function cx(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const W = 760;
const H = 620;

interface Node {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  caption: string;
  accent?: boolean;
}

const NODES: Node[] = [
  { id: 'backer', x: 30, y: 24, w: 230, h: 96, title: 'the backer', caption: 'stakes credit, first to lose' },
  { id: 'agent', x: 30, y: 252, w: 230, h: 96, title: 'the agent', caption: 'draws within its line', accent: true },
  { id: 'pool', x: 30, y: 480, w: 230, h: 96, title: 'the pool', caption: 'lenders fund it' },
  { id: 'record', x: 500, y: 252, w: 230, h: 96, title: 'the record', caption: 'every repayment becomes a spore' },
];

interface Flow {
  id: string;
  d: string;
  label: string;
  labelX: number;
  labelY: number;
  rotate?: boolean;
}

const FLOWS: Flow[] = [
  { id: 'f1', d: 'M145,120 L145,244', label: 'vouches a line', labelX: 158, labelY: 188 },
  { id: 'f2', d: 'M112,480 L112,356', label: 'extends credit', labelX: 100, labelY: 420, rotate: true },
  { id: 'f3', d: 'M178,348 L178,480', label: 'repays + fee', labelX: 190, labelY: 420 },
  { id: 'f4', d: 'M260,300 L492,300', label: 'recorded on Robinhood Chain', labelX: 376, labelY: 284 },
  {
    id: 'f5',
    d: 'M260,72 C 400,72 400,528 268,528',
    label: 'on default, the stake absorbs the loss',
    labelX: 418,
    labelY: 470,
    rotate: true,
  },
];

interface Step {
  numeral: string;
  title: string;
  body: string;
  flows: string[];
}

const STEPS: Step[] = [
  {
    numeral: 'i.',
    title: 'A backer vouches the line',
    body: 'A sponsor stakes credit behind the agent. If the agent defaults, this stake absorbs the loss first — lenders are never first to lose.',
    flows: ['f1', 'f5'],
  },
  {
    numeral: 'ii.',
    title: 'The pool extends credit',
    body: 'Lenders fund the pool. The agent draws purpose-bound credit — spendable only at integrated merchants, never as free cash.',
    flows: ['f2'],
  },
  {
    numeral: 'iii.',
    title: 'The agent repays',
    body: 'Principal plus fee flows back to the pool. Lenders earn their share; the backer\u2019s stake is released.',
    flows: ['f3'],
  },
  {
    numeral: 'iv.',
    title: 'Repayments become spores',
    body: 'Every repayment is written to the record. The record feeds the score, and the score sizes the agent\u2019s next line.',
    flows: ['f4'],
  },
];

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function MechanismDiagram() {
  const [active, setActive] = useState<number>(0);
  const [paused, setPaused] = useState(false);
  const timer = useRef<number | null>(null);

  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  useEffect(() => {
    if (reduced || paused) return;
    timer.current = window.setInterval(() => {
      setActive((a) => (a + 1) % STEPS.length);
    }, 4200);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [reduced, paused]);

  const activeFlows = useMemo(() => new Set(STEPS[active].flows), [active]);

  return (
    <div
      className="grid gap-10 lg:grid-cols-[1fr_340px] lg:gap-14"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Diagram */}
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full min-w-[600px]"
          role="img"
          aria-label="How SPORE credit works: a backer vouches a line, the pool extends credit, the agent repays, repayments become spores in the record."
        >
          <defs>
            <marker
              id="spore-arr"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
            </marker>
          </defs>

          {/* flows */}
          {FLOWS.map((f) => {
            const isActive = activeFlows.has(f.id);
            return (
              <g
                key={f.id}
                className={cx(isActive ? 'text-moss' : 'text-faint')}
                style={{ transition: 'color 0.5s ease, opacity 0.5s ease', opacity: reduced ? 0.75 : isActive ? 1 : 0.28 }}
              >
                <path
                  d={f.d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={isActive ? 1.6 : 1}
                  strokeDasharray={f.id === 'f2' ? '5 5' : undefined}
                  markerEnd="url(#spore-arr)"
                />
                {!reduced && isActive && (
                  <>
                    <circle r="3.2" fill="currentColor" opacity="0.9">
                      <animateMotion dur="2.6s" repeatCount="indefinite" path={f.d} />
                    </circle>
                    <circle r="2" fill="currentColor" opacity="0.55">
                      <animateMotion dur="2.6s" begin="1.3s" repeatCount="indefinite" path={f.d} />
                    </circle>
                  </>
                )}
                <text
                  x={f.labelX}
                  y={f.labelY}
                  textAnchor="middle"
                  fontStyle="italic"
                  fontSize="15"
                  fill="currentColor"
                  fontFamily="var(--font-serif)"
                  transform={f.rotate ? `rotate(-90 ${f.labelX} ${f.labelY})` : undefined}
                >
                  {f.label}
                </text>
              </g>
            );
          })}

          {/* nodes */}
          {NODES.map((n) => (
            <g key={n.id}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                fill="var(--bg)"
                stroke={n.accent ? 'var(--moss)' : 'var(--ink)'}
                strokeOpacity={n.accent ? 0.9 : 0.75}
                strokeWidth={n.accent ? 1.4 : 1}
              />
              <text
                x={n.x + n.w / 2}
                y={n.y + 42}
                textAnchor="middle"
                fontSize="24"
                fill="var(--ink)"
                fontFamily="var(--font-serif)"
              >
                {n.title}
              </text>
              <text
                x={n.x + n.w / 2}
                y={n.y + 68}
                textAnchor="middle"
                fontSize="12.5"
                fill="var(--muted)"
                fontFamily="var(--font-sans)"
              >
                {n.caption}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {/* steps */}
      <ol className="list-none p-0">
        {STEPS.map((s, i) => {
          const isActive = i === active;
          return (
            <li key={s.numeral}>
              {i > 0 && <Rule />}
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onClick={() => setActive(i)}
                className="block w-full py-6 text-left"
                aria-current={isActive}
              >
                <div className="flex items-baseline gap-5">
                  <span
                    className={cx(
                      'font-serif text-2xl italic transition-colors duration-500',
                      isActive ? 'text-moss' : 'text-faint',
                    )}
                  >
                    {s.numeral}
                  </span>
                  <span
                    className={cx(
                      'font-serif text-2xl transition-colors duration-500',
                      isActive ? 'text-ink' : 'text-muted',
                    )}
                  >
                    {s.title}
                  </span>
                </div>
                <p
                  className={cx(
                    'mt-3 pl-[3.25rem] text-[15px] leading-relaxed transition-colors duration-500',
                    isActive ? 'text-muted' : 'text-faint',
                  )}
                >
                  {s.body}
                </p>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function MechanismSection() {
  return (
    <>
      <Reveal>
        <Eyebrow>THE MECHANISM</Eyebrow>
        <h3 className="display mt-6 text-3xl text-ink md:text-5xl">
          How a line opens.
        </h3>
        <p className="mt-6 max-w-2xl font-serif text-lg leading-relaxed text-muted">
          Four movements. A backer takes the first loss, the pool provides the
          capital, the agent repays, and every repayment hardens into record.
        </p>
      </Reveal>
      <div className="mt-14">
        <MechanismDiagram />
      </div>
    </>
  );
}
