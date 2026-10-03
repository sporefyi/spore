import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Eyebrow,
  Rule,
  Reveal,
  LoadingState,
  UnavailableState,
  EmptyState,
  DemoBadge,
} from '../shared/components/primitives';
import { provider } from '../shared/data/providers';
import type { AgentSummary } from '../shared/types';

type Spore = { x: number; y: number; s: number; tone: 'dim' | 'moss' | 'fungal'; o: number };

const SPORES: Spore[] = [
  { x: 62, y: 48, s: 4, tone: 'dim', o: 0.8 },
  { x: 148, y: 120, s: 3, tone: 'dim', o: 0.7 },
  { x: 233, y: 36, s: 5, tone: 'moss', o: 0.35 },
  { x: 301, y: 188, s: 3, tone: 'dim', o: 0.75 },
  { x: 372, y: 92, s: 4, tone: 'dim', o: 0.8 },
  { x: 428, y: 262, s: 3, tone: 'dim', o: 0.6 },
  { x: 497, y: 150, s: 5, tone: 'dim', o: 0.85 },
  { x: 541, y: 46, s: 3, tone: 'dim', o: 0.65 },
  { x: 603, y: 318, s: 4, tone: 'fungal', o: 0.3 },
  { x: 655, y: 208, s: 3, tone: 'dim', o: 0.75 },
  { x: 712, y: 84, s: 4, tone: 'dim', o: 0.8 },
  { x: 768, y: 372, s: 3, tone: 'dim', o: 0.6 },
  { x: 817, y: 142, s: 5, tone: 'moss', o: 0.3 },
  { x: 874, y: 246, s: 4, tone: 'dim', o: 0.8 },
  { x: 926, y: 58, s: 3, tone: 'dim', o: 0.7 },
  { x: 968, y: 330, s: 4, tone: 'dim', o: 0.75 },
  { x: 1012, y: 176, s: 3, tone: 'dim', o: 0.65 },
  { x: 1066, y: 102, s: 5, tone: 'dim', o: 0.85 },
  { x: 1121, y: 284, s: 3, tone: 'fungal', o: 0.28 },
  { x: 1164, y: 40, s: 4, tone: 'dim', o: 0.7 },
  { x: 96, y: 296, s: 4, tone: 'dim', o: 0.7 },
  { x: 188, y: 388, s: 3, tone: 'dim', o: 0.6 },
  { x: 262, y: 310, s: 5, tone: 'dim', o: 0.8 },
  { x: 1090, y: 402, s: 3, tone: 'dim', o: 0.6 },
];

const LINKS: Array<[number, number]> = [
  [0, 1],
  [1, 3],
  [2, 4],
  [4, 6],
  [6, 9],
  [5, 8],
  [9, 12],
  [10, 12],
  [12, 13],
  [13, 16],
  [16, 17],
  [15, 18],
  [20, 22],
  [22, 3],
];

function linkPath([a, b]: [number, number], i: number): string {
  const p = SPORES[a];
  const q = SPORES[b];
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const bend = (i % 2 === 0 ? 1 : -1) * (14 + (i % 4) * 6);
  return `M ${p.x} ${p.y} Q ${mx + bend} ${my - bend} ${q.x} ${q.y}`;
}

function SporeField() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 1200 440"
      preserveAspectRatio="xMidYMid slice"
    >
      {LINKS.map((l, i) => (
        <path key={`l-${i}`} d={linkPath(l, i)} fill="none" stroke="var(--rule)" strokeWidth={1} />
      ))}
      {SPORES.map((s, i) => (
        <rect
          key={`s-${i}`}
          x={s.x}
          y={s.y}
          width={s.s}
          height={s.s}
          opacity={s.o}
          fill={s.tone === 'dim' ? 'var(--faint)' : undefined}
          className={s.tone === 'moss' ? 'fill-moss' : s.tone === 'fungal' ? 'fill-fungal' : undefined}
        />
      ))}
    </svg>
  );
}

export default function Agents() {
  const [state, setState] = useState<'loading' | 'error' | AgentSummary[]>('loading');

  useEffect(() => {
    document.title = 'SPORE — The network';
  }, []);

  useEffect(() => {
    let alive = true;
    provider
      .listAgents()
      .then((rows) => {
        if (alive) setState(rows);
      })
      .catch(() => {
        if (alive) setState('error');
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="bg-bg text-ink">
      <header className="mx-auto max-w-3xl px-4 pb-20 pt-24 md:px-8 md:pt-32">
        <Reveal>
          <div className="mb-6">
            <DemoBadge />
          </div>
          <div className="mt-6">
            <Eyebrow>Registry</Eyebrow>
          </div>
          <h1 className="display mt-4 font-serif text-5xl text-ink md:text-7xl">The network.</h1>
          <p className="mt-8 max-w-xl font-serif text-xl leading-relaxed text-muted">
            Every agent on the ledger, listed by its on-ledger identity. Nothing here
            is estimated or filled in: if an agent is shown, it is registered.
          </p>
        </Reveal>
      </header>

      <section className="relative overflow-hidden border-y border-rule">
        <SporeField />
        <div className="relative z-10 mx-auto max-w-3xl px-4 py-16 md:px-8">
          {state === 'loading' && <LoadingState label="Reading the ledger…" />}
          {state === 'error' && <UnavailableState />}
          {Array.isArray(state) && state.length === 0 && (
            <EmptyState
              title="No agents on the ledger yet."
              copy="When agents register on the SPORE protocol, they appear here — one row per agent, keyed to its on-ledger identity."
            />
          )}
          {Array.isArray(state) && state.length > 0 && (
            <ul>
              {state.map((a) => (
                <li key={a.agentId}>
                  <Link
                    to={`/passport/${a.agentId}`}
                    className="flex items-center gap-4 py-5 text-muted transition-colors hover:text-ink"
                  >
                    <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 bg-moss" />
                    <span className="min-w-0 flex-1 truncate font-serif text-lg">
                      {a.name ?? a.agentId}
                    </span>
                    <span className="tnum shrink-0 text-right font-mono text-sm">
                      {a.score != null ? a.score : '—'}
                    </span>
                  </Link>
                  <Rule />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
