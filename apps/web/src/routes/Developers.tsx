import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Eyebrow,
  Rule,
  Reveal,
  UnavailableState,
  DemoBadge,
} from '../shared/components/primitives';

const KEYWORDS = /\b(const|await|return|null|number|string|GET)\b/g;

function highlight(line: string) {
  const parts = line.split(KEYWORDS);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="text-moss">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function NotLive() {
  return (
    <span className="border border-rule-strong px-2 py-0.5 font-mono text-[11px] uppercase tracking-widest text-ember">
      NOT YET LIVE
    </span>
  );
}

interface CodeProps {
  label: string;
  lines: string[];
}

function Code({ label, lines }: CodeProps) {
  return (
    <figure className="mt-12">
      <figcaption className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-sm text-ink">{label}</span>
        <NotLive />
      </figcaption>
      <div className="mt-4 overflow-x-auto border-l border-rule-strong bg-bg py-1 pl-5">
        <pre className="font-mono text-sm leading-relaxed text-ink">
          <code>
            {lines.map((line, i) => {
              const isComment = line.trim().startsWith('//');
              return (
                <div
                  key={i}
                  className={isComment ? 'whitespace-pre text-faint' : 'whitespace-pre'}
                >
                  {isComment ? line : highlight(line)}
                  {line === '' ? '\u00A0' : null}
                </div>
              );
            })}
          </code>
        </pre>
      </div>
    </figure>
  );
}

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '1',
    title: 'Read an agent\u2019s score before extending trust.',
    body: 'A protocol asks the oracle for an agent\u2019s score and band. If the agent has no record, the answer is null, and the protocol decides what null means for its own risk policy.',
  },
  {
    n: '2',
    title: 'Size limits from the same model.',
    body: 'creditLimit is derived from the same ledger history as the score. It grows with repayment history, so a lender does not need to maintain a separate underwriting model.',
  },
  {
    n: '3',
    title: 'Automate on band changes.',
    body: 'Watch the score band. When it moves, revoke or scale access in the same transaction flow: tighten a line when it drops, widen it as repayments accumulate.',
  },
];

export default function Developers() {
  useEffect(() => {
    document.title = 'SPORE — Developers';
  }, []);

  return (
    <div className="bg-bg text-ink">
      <header className="mx-auto max-w-3xl px-4 pt-24 md:px-8">
        <div className="mt-4">
          <Eyebrow>Credit, as infrastructure</Eyebrow>
        </div>
        <h1 className="display mt-6 font-serif text-5xl leading-tight text-ink md:text-6xl">
          Reputation, as an API.
        </h1>
        <p className="mt-8 max-w-2xl font-serif text-xl leading-relaxed text-muted">
          SPORE reputation is meant to be read by other protocols. Lending
          markets can size credit lines from it. Agents can prove standing
          before interacting with a counterparty. The interface below is the
          intended shape of that read path.
        </p>
        <div className="mt-8">
          <DemoBadge />
        </div>
      </header>

      <section className="mx-auto mt-24 max-w-3xl px-4 md:px-8">
        <Rule />
        <Reveal>
          <h2 className="display mt-12 font-serif text-3xl text-ink">
            How protocols use SPORE
          </h2>
          <ol className="mt-10">
            {STEPS.map((s) => (
              <li
                key={s.n}
                className="grid grid-cols-[2rem_1fr] gap-4 border-t border-rule py-8 first:border-t-0"
              >
                <span className="font-serif italic text-lg text-faint">{s.n}</span>
                <div>
                  <h3 className="font-serif text-xl text-ink">{s.title}</h3>
                  <p className="mt-3 leading-relaxed text-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      <section className="mx-auto mt-24 max-w-3xl px-4 md:px-8">
        <Rule />
        <Reveal>
          <h2 className="display mt-12 font-serif text-3xl text-ink">
            API surface
          </h2>
          <p className="mt-4 max-w-2xl leading-relaxed text-muted">
            Four read functions, each returning null when an agent has no
            record. Nothing here is deployed; these are interface sketches.
          </p>

          <Code
            label="creditScore(agent)"
            lines={[
              '// Returns the agent\u2019s current score, or null if unknown.',
              '// { value: number; band: string; updatedAt: string } | null',
              'const score = await oracle.creditScore(agent);',
            ]}
          />
          <Code
            label="creditLimit(agent)"
            lines={[
              '// Returns the current credit limit, or null if unknown.',
              '// number | null',
              'const limit = await oracle.creditLimit(agent);',
            ]}
          />
          <Code
            label="repaymentRate(agent)"
            lines={[
              '// Returns the share of credit repaid, or null if unknown.',
              '// number | null',
              'const rate = await oracle.repaymentRate(agent);',
            ]}
          />
          <Code
            label="utilization(agent)"
            lines={[
              '// Returns how much of the limit is in use, or null if unknown.',
              '// number | null',
              'const used = await oracle.utilization(agent);',
            ]}
          />
        </Reveal>
      </section>

      <section className="mx-auto mt-24 max-w-3xl px-4 md:px-8">
        <Rule />
        <Reveal>
          <h2 className="display mt-12 font-serif text-3xl text-ink">REST</h2>
          <p className="mt-4 max-w-2xl leading-relaxed text-muted">
            The same score over HTTP. With no deployed oracle, every field
            resolves to null.
          </p>
          <Code
            label="GET /v1/agents/{id}/score"
            lines={[
              'GET /v1/agents/{id}/score',
              '',
              '// response skeleton — no data exists yet',
              '{',
              '  "agent": "{id}",',
              '  "value": null,',
              '  "band": null,',
              '  "updatedAt": null',
              '}',
            ]}
          />
        </Reveal>
      </section>

      <section className="mx-auto mt-24 max-w-3xl px-4 pb-32 md:px-8">
        <Rule />
        <Reveal>
          <h2 className="display mt-12 font-serif text-3xl text-ink">
            Availability
          </h2>
          <div className="mt-6">
            <UnavailableState
              title="Oracle not deployed"
              copy="The oracle contract is not deployed, so these endpoints resolve to nothing yet. The shapes above are the intended interface and may change before anything ships."
            />
            <p className="mt-4 text-sm text-muted">
              To see what the protocol is meant to do, read{' '}
              <Link to="/protocol" className="text-fungal underline underline-offset-4">
                how SPORE works
              </Link>
              .
            </p>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
