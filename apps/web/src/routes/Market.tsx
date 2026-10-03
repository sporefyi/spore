import { useEffect } from 'react';
import {
  Eyebrow,
  Rule,
  Reveal,
  UnavailableState,
  DemoBadge,
} from '../shared/components/primitives';

const CATEGORIES: string[] = [
  'AI inference',
  'GPU compute',
  'APIs',
  'Data',
  'Storage',
  'RPC',
];

const DESTINATIONS: string[] = ['API', 'COMPUTE', 'DATA', 'RPC', 'STORAGE'];

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '1',
    title: 'Credit is issued against the record.',
    body: "An agent's credit line is sized from its on-ledger record of observed activity. The record comes first; the line follows from it, never the other way around.",
  },
  {
    n: '2',
    title: 'Spends are checked against an allowlist.',
    body: 'Every spend is matched to an allowlist of merchant categories before it settles. A request outside the allowlist is refused by the router, not by policy or goodwill.',
  },
  {
    n: '3',
    title: 'Merchants are paid directly.',
    body: 'Settlement goes to the verified merchant. The agent never holds the funds, so credit cannot be redirected, withdrawn, or spent on anything other than the compute it needs.',
  },
];

function FlowLink() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto h-10 w-px bg-rule-strong md:mx-0 md:h-px md:w-16 md:flex-none"
    />
  );
}

export default function Market() {
  useEffect(() => {
    document.title = 'SPORE — Market';
  }, []);

  return (
    <div className="bg-bg text-ink">
      <header className="mx-auto max-w-3xl px-4 pt-24 md:px-8">
        <div className="flex justify-end gap-4">
          <DemoBadge />
        </div>
        <div className="mt-6">
          <Eyebrow>The market</Eyebrow>
        </div>
        <h1 className="display mt-6 font-serif text-4xl leading-tight text-ink md:text-6xl">
          Purpose-bound credit.
        </h1>
        <p className="mt-8 max-w-2xl font-serif text-xl leading-relaxed text-muted">
          SPORE credit is purpose-bound. An agent&apos;s credit can only be spent
          at verified merchants, for the compute it needs. The credit
          router enforces this on-chain.
        </p>
      </header>

      <section className="mx-auto mt-24 max-w-3xl px-4 md:px-8">
        <Rule />
        <Reveal>
          <p className="mt-6 font-mono text-[11px] uppercase tracking-widest text-faint">
            Router, as designed
          </p>

          <div className="mt-10 flex flex-col items-stretch md:flex-row md:items-center">
            <div className="text-center md:text-left">
              <span className="tnum font-mono text-2xl text-ink">$100</span>
              <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-faint">
                Illustrative amount
              </div>
            </div>
            <FlowLink />
            <div className="border-y border-rule-strong py-3 text-center md:px-6 md:text-left">
              <span className="font-mono text-sm tracking-widest text-ink">
                ROUTER
              </span>
            </div>
            <FlowLink />
            <ul className="flex flex-col items-center gap-2 md:items-start md:border-l md:border-rule-strong md:pl-6">
              {DESTINATIONS.map((d) => (
                <li
                  key={d}
                  className="font-mono text-sm tracking-widest text-muted"
                >
                  {d}
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-10 max-w-2xl font-sans text-sm leading-relaxed text-muted">
            Credit routes exist as design; no merchant integration is live.
          </p>
        </Reveal>

        <ul className="mt-12 border-t border-rule">
          {CATEGORIES.map((c) => (
            <li
              key={c}
              className="flex items-center gap-4 border-b border-rule py-4"
            >
              <span className="font-mono text-sm text-ink">{c}</span>
              <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-rule" />
              <span className="font-mono text-[11px] tracking-widest text-ember">
                NOT INTEGRATED
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto mt-32 max-w-3xl px-4 md:px-8">
        <Rule />
        <Reveal>
          <div className="mt-6">
            <Eyebrow>How routing works</Eyebrow>
          </div>
          <h2 className="display mt-6 font-serif text-3xl leading-tight text-ink md:text-4xl">
            Three checks between credit and spend.
          </h2>
          <ol className="mt-12 border-t border-rule">
            {STEPS.map((s) => (
              <li
                key={s.n}
                className="grid gap-3 border-b border-rule py-8 md:grid-cols-[3rem_1fr] md:gap-6"
              >
                <span className="tnum font-mono text-sm text-faint">{s.n}</span>
                <div>
                  <h3 className="font-serif text-xl text-ink">{s.title}</h3>
                  <p className="mt-3 font-sans text-base leading-relaxed text-muted">
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      <section className="mx-auto mt-32 max-w-3xl px-4 pb-32 md:px-8">
        <Rule />
        <div className="mt-10">
          <UnavailableState
            title="Market not activated"
            copy="Routing settles through contracts that are not deployed. Until they are, there are no merchants to route to, no credit to spend, and nothing on this page that moves value."
          />
        </div>
      </section>
    </div>
  );
}
