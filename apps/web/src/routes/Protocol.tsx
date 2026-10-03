import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PRIMARY_CHAIN } from '../shared/chains';
import {
  Eyebrow,
  Rule,
  SectionNo,
  Reveal,
  DemoBadge,
} from '../shared/components/primitives';
import ScoreLab from '../shared/components/ScoreLab';

interface Section {
  n: string;
  title: string;
  body: string;
  notDeployed?: boolean;
}

const SECTIONS: Section[] = [
  {
    n: '1',
    title: 'Identity',
    body: 'Each agent registers an on-ledger identity, compatible with ERC-8004. Every later event, whether a payment, a draw, or a repayment, is tied back to that identity. Without an identity there is no history to read.',
  },
  {
    n: '2',
    title: 'Activity',
    body: 'Payments, earnings, and interactions are observed on-chain and written to the ledger. The ledger records what happened rather than what an agent claims. This observed activity is the raw material for credit.',
  },
  {
    n: '3',
    title: 'Credit',
    body: 'Agents draw credit against their record. Limits start small and are sized by observable history, so an agent with little record gets little line. As the record grows, so does what the agent can draw.',
  },
  {
    n: '4',
    title: 'Repayment',
    body: 'Repayments are posted as they settle and linked to the original credit. Repayment is the unit of reputation: it is the one event that shows an agent did what it said it would do.',
  },
  {
    n: '5',
    title: 'Oracle',
    body: 'The scoring oracle reads ledger state and publishes a portable score that other contracts can consume. Lending markets and agents can read it without running their own model. The oracle is deployed and its publisher is live.',
  },
  {
    n: '6',
    title: 'Network',
    body: 'Every repayment improves future capacity. Trust compounds across the network, because a record built with one counterparty can be read by the next.',
  },
];

export default function Protocol() {
  const { hash } = useLocation();
  useEffect(() => {
    document.title = 'SPORE — Protocol';
  }, []);
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' });
  }, [hash]);

  return (
    <div className="bg-bg text-ink">
      <header className="mx-auto max-w-3xl px-4 pt-24 md:px-8">
        <div className="mt-4">
          <Eyebrow>The protocol</Eyebrow>
        </div>
        <h1 className="display mt-6 font-serif text-5xl leading-tight text-ink md:text-6xl">
          How SPORE works.
        </h1>
        <p className="mt-8 max-w-2xl font-serif text-xl leading-relaxed text-muted">
          SPORE turns an agent&apos;s observable on-chain behavior into a
          credit record. The mechanics run in six steps, from identity to a
          network where trust compounds. This page describes the design; none
          of it is live yet.
        </p>
        <div className="mt-8">
          <DemoBadge />
        </div>
      </header>

      <div className="mx-auto mt-24 max-w-3xl px-4 md:px-8">
        {SECTIONS.map((s) => (
          <Reveal key={s.n}>
            <section>
              <Rule />
              <div className="grid grid-cols-[2rem_1fr] gap-4 py-12">
                <SectionNo n={s.n} />
                <div>
                  <h2 className="display font-serif text-3xl text-ink">
                    {s.title}
                  </h2>
                  <p className="mt-4 max-w-2xl leading-relaxed text-muted">
                    {s.body}
                  </p>
                  {s.notDeployed ? (
                    <p className="mt-4 font-mono text-[11px] uppercase tracking-widest text-ember">
                      NOT YET LIVE
                    </p>
                  ) : null}
                </div>
              </div>
            </section>
          </Reveal>
        ))}
        <Rule />
      </div>

      <section id="score-lab" className="mx-auto mt-24 max-w-6xl px-4 md:px-8">
        <Reveal>
          <ScoreLab />
        </Reveal>
      </section>

      <section className="mx-auto mt-24 max-w-3xl px-4 md:px-8">
        <Reveal>
          <div className="border-y border-rule-strong py-10">
            <span className="font-mono text-xs uppercase tracking-widest text-fungal">
              EXPERIMENTAL
            </span>
            <p className="mt-4 font-serif text-xl leading-snug text-ink">
              SPORE is experimental infrastructure. Read the contracts before
              depositing funds.
            </p>
            <p className="mt-3 text-sm text-faint">
              The protocol has not been audited by a third party.
            </p>
          </div>
        </Reveal>
      </section>

      <section className="mx-auto mt-24 max-w-3xl px-4 pb-32 md:px-8">
        <Reveal>
          <h2 className="display font-serif text-3xl text-ink">
            Deployment status
          </h2>
          <dl className="mt-8 border-t border-rule font-mono text-sm">
            {[
              ['SporeRegistry', PRIMARY_CHAIN.contracts.registry],
              ['CreditManager', PRIMARY_CHAIN.contracts.creditManager],
              ['BackerVault', PRIMARY_CHAIN.contracts.backerVault],
              ['ScoreOracle', PRIMARY_CHAIN.contracts.scoreOracle],
              ['FeeRouter', PRIMARY_CHAIN.contracts.feeRouter],
            ].map(([label, address]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-6 border-b border-rule py-4"
              >
                <dt className="text-faint">{label}</dt>
                <dd className="tnum text-ink">
                  {address ? (
                    <a
                      href={`${PRIMARY_CHAIN.explorerUrl}/address/${address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4 hover:text-fungal"
                    >
                      {`${address.slice(0, 6)}…${address.slice(-4)}`}
                    </a>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-6 border-b border-rule py-4">
              <dt className="text-faint">Chain</dt>
              <dd className="tnum text-ink">
                {PRIMARY_CHAIN.name} ({PRIMARY_CHAIN.chainId})
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-6 border-b border-rule py-4">
              <dt className="text-faint">Explorer</dt>
              <dd className="tnum text-ink">
                <a
                  href={PRIMARY_CHAIN.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4 hover:text-fungal"
                >
                  Blockscout
                </a>
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-faint">
            Deployed 2026-10-03. Settlement asset: USDG.
          </p>
          <p className="mt-8 text-muted">
            Building against this?{' '}
            <Link
              to="/developers"
              className="text-fungal underline underline-offset-4"
            >
              See the intended API
            </Link>
            .
          </p>
        </Reveal>
      </section>
    </div>
  );
}
