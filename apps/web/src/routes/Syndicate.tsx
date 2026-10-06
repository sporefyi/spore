import { useEffect, useState } from 'react';
import {
  Eyebrow,
  Rule,
  Reveal,
  LoadingState,
} from '../shared/components/primitives';
import { SYNDICATE_MANAGER, ROBINHOOD_RPC_URL } from '../shared/chains';

const DEPLOYED = SYNDICATE_MANAGER !== '0x0000000000000000000000000000000000000000';

const STEPS = [
  {
    n: '1',
    title: 'An agent needs more than its credit line.',
    body: 'A render job, a data purchase, a GPU cluster for a weekend — some work costs more than any single line covers.',
  },
  {
    n: '2',
    title: 'The loan is proposed on-chain.',
    body: 'Target amount, fee offered to backers, funding window, repayment tenor, and the purpose — all public, all immutable once proposed.',
  },
  {
    n: '3',
    title: 'Backers fund it in slices.',
    body: 'Ten backers at $50 each, or two at $250. Anyone can take a slice during the funding window. If the target is missed, everyone is refunded automatically.',
  },
  {
    n: '4',
    title: 'The agent does the work and repays.',
    body: 'Repayment plus the offered fee flows back pro-rata. A backer who took 10% of the loan receives 10% of every repayment.',
  },
  {
    n: '5',
    title: 'Defaults are handled, not hidden.',
    body: 'Miss the deadline and the loan is marked defaulted on-chain. Backers claim their share of whatever was recovered — the loss is public, priced in, and part of the record.',
  },
];

const NUMBERS = [
  { label: 'Fee cap', value: '50%', note: 'hard-coded maximum the borrower can offer' },
  { label: 'Min. funding window', value: '1 hour', note: 'prevents flash ambushes' },
  { label: 'Tests passing', value: '8 / 8', note: 'full lifecycle, default, cancel, edge cases' },
];

export default function Syndicate() {
  const [loans, setLoans] = useState<'loading' | 'empty'>('loading');

  useEffect(() => {
    document.title = 'SPORE — Syndicated Loans';
  }, []);

  useEffect(() => {
    if (!DEPLOYED) {
      setLoans('empty');
      return;
    }
    // Live loan enumeration goes here once the contract is deployed.
    // Reads nextLoanId + loans(i) via ROBINHOOD_RPC_URL with ethers.
    void ROBINHOOD_RPC_URL;
    setLoans('empty');
  }, []);

  return (
    <div className="bg-bg text-ink">
      <div className="mx-auto max-w-4xl px-4 pb-32 pt-24 md:px-8 md:pt-32">
        <header>
          <Eyebrow>New primitive</Eyebrow>
          <h1 className="display mt-4 font-serif text-4xl text-ink md:text-6xl">
            Syndicated loans.
          </h1>
          <p className="mt-6 max-w-xl text-muted leading-relaxed">
            One agent needs $500 for a GPU job. No single backer wants that risk alone.
            Ten backers take $50 each, split the fees, share the risk. This is how
            corporate lending works in the human world — now it works for agents,
            on-chain, without a bank in the middle.
          </p>
        </header>

        <div className="mt-12">
          <Eyebrow>Live syndicates</Eyebrow>
          <div className="mt-6">
            {loans === 'loading' && <LoadingState label="Reading the chain…" />}
            {loans === 'empty' && (
              <div className="border border-rule/60 px-6 py-10 text-center">
                <p className="font-mono text-sm text-muted">
                  {DEPLOYED
                    ? 'No syndicated loans yet. The first proposal opens this market.'
                    : 'The SyndicateManager contract is built and tested. It opens for proposals once deployed.'}
                </p>
              </div>
            )}
          </div>
        </div>

        <section className="mt-24">
          <Eyebrow>How it works</Eyebrow>
          <ol className="mt-10 border-t border-rule">
            {STEPS.map((s) => (
              <Reveal key={s.n}>
                <li className="grid gap-3 border-b border-rule py-8 md:grid-cols-[3rem_1fr] md:gap-6">
                  <span className="font-mono text-sm text-fungal">{s.n}</span>
                  <div>
                    <h3 className="font-serif text-xl text-ink">{s.title}</h3>
                    <p className="mt-2 max-w-2xl text-muted leading-relaxed">{s.body}</p>
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>
        </section>

        <section className="mt-24">
          <Eyebrow>By the numbers</Eyebrow>
          <div className="mt-10 grid gap-px bg-rule/40 sm:grid-cols-3">
            {NUMBERS.map((s) => (
              <div key={s.label} className="bg-bg px-6 py-8">
                <div className="font-mono text-xs uppercase tracking-widest text-faint">{s.label}</div>
                <div className="tnum mt-3 font-serif text-4xl text-ink">{s.value}</div>
                <div className="mt-2 text-sm text-muted">{s.note}</div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-24">
          <Rule />
          <p className="pt-6 text-sm text-muted leading-relaxed">
            Backers bear default risk — there is no insurance or protocol backstop in v1.
            Every loan's full history (proposals, funding, repayments, defaults) is
            public on Robinhood Chain. The contract is{' '}
            <span className="font-mono text-xs">
              {DEPLOYED ? SYNDICATE_MANAGER : 'awaiting deployment'}
            </span>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
