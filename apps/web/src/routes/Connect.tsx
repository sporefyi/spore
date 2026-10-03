import { useEffect } from 'react';
import {
  Eyebrow,
  Rule,
  Reveal,
  UnavailableState,
  DemoBadge,
} from '../shared/components/primitives';
import OrbioOnboard from '../shared/components/OrbioOnboard';

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '1',
    title: 'An agent registers an on-ledger identity.',
    body: 'Registration is live on the SporeRegistry, giving the agent a persistent identity that its record attaches to.',
  },
  {
    n: '2',
    title: 'A record accrues from observed activity.',
    body: 'Activity the protocol observes is written against that identity over time. The record is earned, not declared.',
  },
  {
    n: '3',
    title: 'A credit line opens from the record.',
    body: 'Once the record supports it, a purpose-bound credit line opens, sized by what the agent has actually done.',
  },
];

export default function Connect() {
  useEffect(() => {
    document.title = 'SPORE — Connect';
  }, []);

  return (
    <div className="bg-bg text-ink">
      <div className="mx-auto max-w-3xl px-4 pb-32 pt-24 md:px-8">
        <div className="flex justify-end gap-4">
          <DemoBadge />
        </div>
        <div className="mt-6">
          <Eyebrow>Connect</Eyebrow>
        </div>
        <h1 className="display mt-6 font-serif text-4xl leading-tight text-ink md:text-6xl">
          Bring your agent.
        </h1>

        <div className="mt-8 max-w-2xl space-y-6 font-serif text-xl leading-relaxed text-muted">
          <p>
            Agent onboarding happens through the protocol contracts. Those
            contracts are deployed on Robinhood Chain, and the first agent
            is already registered.
          </p>
          <p>
            This page does not offer a wallet button, because any button here
            would only pretend. We would rather show you an empty page than a
            fake connection.
          </p>
        </div>

        <OrbioOnboard />

        <div className="mt-16">
          <UnavailableState
            title="Onboarding is open"
            copy="Onboarding runs through the SporeRegistry on Robinhood Chain. Registration is permissionless — the first agent is already on-chain with an open credit line. Backers stake through the BackerVault; borrowers draw through the CreditManager."
          />
        </div>

        <section className="mt-24">
          <Rule />
          <Reveal>
            <div className="mt-6">
              <Eyebrow>What onboarding will look like</Eyebrow>
            </div>
            <ol className="mt-10 border-t border-rule">
              {STEPS.map((s) => (
                <li
                  key={s.n}
                  className="grid gap-3 border-b border-rule py-8 md:grid-cols-[3rem_1fr] md:gap-6"
                >
                  <span className="font-serif italic text-lg text-faint">
                    {s.n}
                  </span>
                  <div>
                    <h2 className="font-serif text-xl text-ink">{s.title}</h2>
                    <p className="mt-3 font-sans text-base leading-relaxed text-muted">
                      {s.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Reveal>
        </section>

        <p className="mt-16 font-mono text-sm text-faint">
          Orbio agents can also register directly through the SporeRegistry contract.
        </p>
      </div>
    </div>
  );
}
