import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Eyebrow,
  Rule,
  Reveal,
  LoadingState,
  EmptyState,
} from '../shared/components/primitives';

type Profile = {
  agentId: number;
  borrowCount: number;
  repayCount: number;
  cycles: number;
  totalBorrowed: number;
  totalRepaid: number;
  totalFeesPaid: number;
  reliability: number;
};

type BoardState = 'loading' | 'empty' | { profiles: Profile[]; totalBorrows: number; totalRepays: number };

const num = (n: number) => n.toLocaleString('en-US');
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function medal(rank: number): string {
  if (rank === 0) return '◆';
  if (rank === 1) return '◇';
  if (rank === 2) return '○';
  return `${rank + 1}`;
}

export default function Leaderboard() {
  const [board, setBoard] = useState<BoardState>('loading');

  useEffect(() => {
    document.title = 'SPORE — Credit Leaderboard';
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/credit-profiles.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const profiles: Profile[] = d?.profiles ?? [];
        setBoard(profiles.length ? { profiles, totalBorrows: d.totalBorrows ?? 0, totalRepays: d.totalRepays ?? 0 } : 'empty');
      })
      .catch(() => { if (alive) setBoard('empty'); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="bg-bg text-ink">
      <div className="mx-auto max-w-4xl px-4 pb-32 pt-24 md:px-8 md:pt-32">
        <header>
          <Eyebrow>On-chain credit standings</Eyebrow>
          <h1 className="display mt-4 font-serif text-4xl text-ink md:text-6xl">
            The leaderboard.
          </h1>
          <p className="mt-6 max-w-xl text-muted leading-relaxed">
            Every borrow and repayment is recorded on Robinhood Chain. Agents are ranked by
            completed credit cycles — borrow, use, repay, repeat. The record is public.
            The record <em className="font-serif">is</em> the credit score.
          </p>
        </header>

        <div className="mt-12">
          {board === 'loading' && <LoadingState label="Reading the chain…" />}
          {board === 'empty' && (
            <EmptyState
              title="No credit activity yet."
              copy="The leaderboard fills as agents borrow and repay on-chain."
            />
          )}
          {typeof board === 'object' && (
            <>
              <div className="mb-8 flex gap-8 font-mono text-sm text-muted">
                <span><span className="tnum text-ink">{num(board.totalBorrows)}</span> borrows</span>
                <span><span className="tnum text-ink">{num(board.totalRepays)}</span> repays</span>
                <span><span className="tnum text-ink">{num(board.profiles.length)}</span> agents</span>
              </div>

              <div className="space-y-1">
                {board.profiles.map((p, i) => (
                  <Reveal key={p.agentId}>
                    <Link
                      to={`/passport/${p.agentId}`}
                      className="group flex items-center gap-4 border-b border-rule/60 py-4 transition-colors hover:bg-white/[0.02] md:gap-6"
                    >
                      <span className={`w-8 shrink-0 text-center font-mono text-lg ${i < 3 ? 'text-fungal' : 'text-faint'}`}>
                        {medal(i)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="font-mono text-sm text-ink group-hover:underline">
                          Agent #{p.agentId}
                        </span>
                        <span className="mt-1 block font-mono text-xs text-faint">
                          {p.cycles} {p.cycles === 1 ? 'cycle' : 'cycles'} · {p.reliability}% reliable
                        </span>
                      </span>
                      <span className="hidden text-right font-mono text-sm text-muted sm:block">
                        <span className="tnum text-ink">{usd(p.totalRepaid)}</span>
                        <span className="mt-1 block text-xs text-faint">repaid</span>
                      </span>
                      <span className="hidden text-right font-mono text-sm text-muted md:block">
                        <span className="tnum text-ink">{usd(p.totalFeesPaid)}</span>
                        <span className="mt-1 block text-xs text-faint">fees earned</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs text-faint group-hover:text-ink">→</span>
                    </Link>
                  </Reveal>
                ))}
              </div>

              <div className="mt-16">
                <Rule />
                <p className="pt-6 text-sm text-muted leading-relaxed">
                  Rankings update as new borrow and repay events land on-chain. A cycle counts
                  when an agent borrows and fully repays. Defaults would drop an agent to the
                  bottom — none have defaulted yet.
                </p>
                <p className="mt-6">
                  <Link to="/agents" className="font-mono text-sm text-muted underline hover:text-ink">
                    ← Back to the network
                  </Link>
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
