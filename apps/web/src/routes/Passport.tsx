import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Eyebrow,
  Rule,
  SectionNo,
  Stat,
  Reveal,
  LoadingState,
  UnavailableState,
  EmptyState,
  DemoBadge,
} from '../shared/components/primitives';
import { provider } from '../shared/data/providers';
import { getChain } from '../shared/chains';
import type { AgentCreditProfile, ScorePoint } from '../shared/types';

type ProfileState = 'loading' | 'missing' | 'error' | AgentCreditProfile;
type HistoryState = 'loading' | 'error' | ScorePoint[];

const usd = (n: number | null | undefined): string =>
  n == null ? '—' : `$${n.toLocaleString('en-US')}`;

// Ratios are expected as fractions (0–1) from the provider.
const pct = (n: number | null | undefined): string =>
  n == null ? '—' : `${(n * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

const num = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString('en-US');

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <Reveal className="mt-20">
      <Rule />
      <div className="pt-6">
        <SectionNo n={n} />
        <h2 className="mt-4 font-serif text-2xl text-ink md:text-3xl">{title}</h2>
        <div className="mt-8 space-y-6">{children}</div>
      </div>
    </Reveal>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Sparkline({ points }: { points: ScorePoint[] }) {
  const W = 600;
  const H = 160;
  const pad = 12;
  const scores = points.map((p) => p.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = max - min || 1;
  const coords = points.map((p, i) => {
    const x = points.length === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (points.length - 1);
    const y = H - pad - ((p.score - min) / span) * (H - pad * 2);
    return { x, y };
  });
  const line = coords.map((c) => `${c.x},${c.y}`).join(' ');
  const last = points[points.length - 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full"
        role="img"
        aria-label={`Score trend across ${points.length} recorded points`}
      >
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--rule)" strokeWidth={1} />
        <line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="var(--rule)" strokeWidth={1} />
        {points.length > 1 ? (
          <polyline
            points={line}
            fill="none"
            stroke="var(--moss)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <rect x={coords[0].x - 2} y={coords[0].y - 2} width={4} height={4} className="fill-moss" />
        )}
      </svg>
      <div className="tnum mt-3 flex justify-between gap-4 font-mono text-xs text-faint">
        <span className="truncate">{fmtDate(points[0].t)}</span>
        <span className="truncate">
          {fmtDate(last.t)} · {last.score}
        </span>
      </div>
    </div>
  );
}

type CreditProfile = {
  agentId: number;
  borrowCount: number;
  repayCount: number;
  cycles: number;
  totalBorrowed: number;
  totalRepaid: number;
  totalFeesPaid: number;
  reliability: number;
  history: Array<{ type: 'borrow' | 'repay'; amount: number; block: number; tx: string }>;
};

type OnChainState = 'loading' | 'none' | CreditProfile;

export default function Passport() {
  const { agent } = useParams<{ agent: string }>();
  const agentId = agent ?? '';
  const [profile, setProfile] = useState<ProfileState>('loading');
  const [history, setHistory] = useState<HistoryState>('loading');
  const [onchain, setOnchain] = useState<OnChainState>('loading');

  useEffect(() => {
    document.title = `SPORE — Passport ${agentId}`;
  }, [agentId]);

  useEffect(() => {
    let alive = true;
    setProfile('loading');
    if (!agent) {
      setProfile('missing');
      return () => {
        alive = false;
      };
    }
    provider
      .getAgent(agent)
      .then((p) => {
        if (alive) setProfile(p ?? 'missing');
      })
      .catch(() => {
        if (alive) setProfile('error');
      });
    return () => {
      alive = false;
    };
  }, [agent]);

  useEffect(() => {
    let alive = true;
    setOnchain('loading');
    const id = parseInt(agent ?? '', 10);
    if (!agent || Number.isNaN(id)) {
      setOnchain('none');
      return () => { alive = false; };
    }
    fetch('/credit-profiles.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const p = d?.profiles?.find((x: CreditProfile) => x.agentId === id);
        setOnchain(p ?? 'none');
      })
      .catch(() => { if (alive) setOnchain('none'); });
    return () => { alive = false; };
  }, [agent]);

  useEffect(() => {
    let alive = true;
    setHistory('loading');
    if (!agent) {
      setHistory([]);
      return () => {
        alive = false;
      };
    }
    provider
      .getScoreHistory(agent)
      .then((pts) => {
        if (alive) setHistory(pts);
      })
      .catch(() => {
        if (alive) setHistory('error');
      });
    return () => {
      alive = false;
    };
  }, [agent]);

  const loaded = typeof profile === 'object' ? profile : null;
  const title = loaded ? (loaded.identity.name ?? loaded.identity.agentId) : agentId;

  return (
    <div className="bg-bg text-ink">
      <div className="mx-auto max-w-3xl px-4 pb-32 pt-24 md:px-8 md:pt-32">
        <header>
          <div className="mb-6">
            <DemoBadge />
          </div>
          <Eyebrow>Credit passport</Eyebrow>
          <h1 className="display mt-4 break-words font-serif text-4xl text-ink md:text-6xl">{title}</h1>
          {loaded && (
            <div className="mt-8 space-y-1 font-mono text-sm text-muted">
              <p className="break-all">ERC-8004 identity: {loaded.identity.erc8004Id ?? '—'}</p>
              <p>Chain: {loaded.identity.chains.map((s) => getChain(s)?.name ?? s).join(', ') || '—'}</p>
              <p className="tnum">
                Agent age: {loaded.identity.ageDays != null ? `${loaded.identity.ageDays} days` : '—'}
              </p>
            </div>
          )}
        </header>

        {profile === 'loading' && (
          <div className="mt-16">
            <LoadingState label="Reading the ledger…" />
          </div>
        )}

        {profile === 'error' && (
          <div className="mt-16">
            <UnavailableState />
          </div>
        )}

        {profile === 'missing' && (
          <div className="mt-16">
            <EmptyState
              title="No record for this agent."
              copy={`The ledger holds no identity for '${agentId}'. Identities appear when agents register on the protocol.`}
            />
            <p className="mt-8">
              <Link to="/agents" className="font-mono text-sm text-muted underline hover:text-ink">
                ← Back to the network
              </Link>
            </p>
          </div>
        )}

        {loaded && (
          <>
            <section className="mx-auto mt-24 max-w-xl py-16 text-center">
              <Eyebrow>CREDIT SCORE</Eyebrow>
              <h2 className="sr-only">Credit score</h2>
              <div className="mt-8">
                {loaded.score == null ? (
                  <UnavailableState />
                ) : (
                  <>
                    <p className="tnum font-serif text-7xl text-ink md:text-8xl">{loaded.score.value}</p>
                    <p className="mt-4 font-mono text-xs uppercase tracking-widest text-muted">
                      {loaded.score.band}
                    </p>
                  </>
                )}
              </div>
            </section>

            <Section n="01" title="Repayment history">
              <Stat label="Loans" value={num(loaded.history.loans)} />
              <Stat label="Repaid" value={usd(loaded.history.repaidUsd)} />
              <Stat label="On-time rate" value={pct(loaded.history.onTimeRate)} />
            </Section>

            <Section n="01b" title="On-chain credit activity">
              {onchain === 'loading' && <LoadingState label="Reading the chain…" />}
              {onchain === 'none' && (
                <EmptyState
                  title="No on-chain credit activity yet."
                  copy="Borrow and repayment events appear here once this agent uses its credit line."
                />
              )}
              {typeof onchain === 'object' && (
                <>
                  <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
                    <Stat label="Cycles" value={num(onchain.cycles)} />
                    <Stat label="Borrowed" value={usd(onchain.totalBorrowed)} />
                    <Stat label="Repaid" value={usd(onchain.totalRepaid)} />
                    <Stat label="Fees paid" value={usd(onchain.totalFeesPaid)} />
                  </div>
                  <p className="font-mono text-xs text-muted">
                    Reliability {onchain.reliability}% · {onchain.borrowCount} borrows · {onchain.repayCount} repays
                  </p>
                  <div className="mt-6 space-y-2">
                    {onchain.history.slice(-10).reverse().map((h, i) => (
                      <div key={i} className="flex items-center justify-between font-mono text-sm border-b border-line/30 pb-2">
                        <span className={h.type === 'repay' ? 'text-moss' : 'text-ink'}>
                          {h.type === 'repay' ? '↩ repaid' : '↗ borrowed'}
                        </span>
                        <span className="tnum">${h.amount.toFixed(2)}</span>
                        <a
                          href={`https://explorer.robinhood.com/tx/${h.tx}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted underline hover:text-ink text-xs"
                        >
                          {h.tx.slice(0, 10)}…
                        </a>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Section>

            <Section n="02" title="Credit utilization">
              {loaded.economics.utilization == null ? (
                <UnavailableState />
              ) : (
                <Stat label="Utilization" value={pct(loaded.economics.utilization)} />
              )}
            </Section>

            <Section n="03" title="Revenue">
              {loaded.economics.revenue30dUsd == null && loaded.economics.revenue90dUsd == null ? (
                <EmptyState
                  title="No revenue recorded."
                  copy="Revenue appears once the agent's earnings are observed on the ledger."
                />
              ) : (
                <>
                  <Stat label="30-day revenue" value={usd(loaded.economics.revenue30dUsd)} />
                  <Stat label="90-day revenue" value={usd(loaded.economics.revenue90dUsd)} />
                </>
              )}
            </Section>

            <Section n="04" title="Borrowing">
              <Stat label="Credit limit" value={usd(loaded.creditLimitUsd)} />
              <Stat label="Borrowed to date" value={usd(loaded.history.borrowedUsd)} />
            </Section>

            <Section n="05" title="Backing">
              <Stat label="Staked" value={usd(loaded.economics.stakedUsd)} />
              <Stat label="Backers" value={num(loaded.economics.backers)} />
            </Section>

            <Section n="06" title="Defaults">
              {loaded.history.defaults == null ? (
                <UnavailableState />
              ) : (
                <Stat label="Defaults" value={num(loaded.history.defaults)} />
              )}
            </Section>

            <Section n="07" title="Score trend">
              {history === 'loading' && <LoadingState label="Reading the ledger…" />}
              {history === 'error' && <UnavailableState />}
              {Array.isArray(history) && history.length === 0 && (
                <EmptyState
                  title="No score history yet."
                  copy="Points are plotted only when the ledger has recorded them."
                />
              )}
              {Array.isArray(history) && history.length > 0 && <Sparkline points={history} />}
            </Section>

            <div className="mt-24">
              <Rule />
              <p className="pt-6">
                <Link to="/agents" className="font-mono text-sm text-muted underline hover:text-ink">
                  ← Back to the network
                </Link>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
