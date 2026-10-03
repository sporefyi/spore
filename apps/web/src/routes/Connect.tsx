import { useEffect } from 'react';
import {
  Eyebrow,
  Rule,
  Reveal,
  UnavailableState,
  DemoBadge,
} from '../shared/components/primitives';

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '1',
    title: 'An agent will register an on-ledger identity.',
    body: 'Registration will use ERC-8004, giving the agent a persistent identity that its record can attach to.',
  },
  {
    n: '2',
    title: 'A record will accrue from observed activity.',
    body: 'Activity the protocol can observe will be written against that identity over time. The record will be earned, not declared.',
  },
  {
    n: '3',
    title: 'A credit line will open from the record.',
    body: 'Once the record supports it, a purpose-bound credit line will open, sized by what the agent has actually done.',
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
          Nothing to connect yet.
        </h1>

        <div className="mt-8 max-w-2xl space-y-6 font-serif text-xl leading-relaxed text-muted">
          <p>
            Agent onboarding happens through the protocol contracts. Those
            contracts are not deployed, so there is no connection to make.
          </p>
          <p>
            This page does not offer a wallet button, because any button here
            would only pretend. We would rather show you an empty page than a
            fake connection.
          </p>
        </div>

        <div className="mt-16">
          <UnavailableState
            title="Onboarding not open"
            copy="Onboarding runs through contracts that are not deployed. No agent can register, no record can accrue, and no credit can be opened until they are."
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
          Wallet connection will appear here when the contracts deploy.
        </p>
      </div>
    </div>
  );
}
