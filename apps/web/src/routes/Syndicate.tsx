import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, useInView, useMotionValue, useSpring } from 'framer-motion';
import {
  Eyebrow,
  Rule,
  LoadingState,
} from '../shared/components/primitives';
import { SYNDICATE_MANAGER } from '../shared/chains';
import { useSyndicateLoans, STATUS_LABEL, type LoanView } from '../shared/syndicate';

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

/** Animated counter that eases to the target value when scrolled into view. */
function CountUp({ value, prefix = '', suffix = '' }: { value: string; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  const [display, setDisplay] = useState(prefix + '0' + suffix);
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 60, damping: 20 });

  const target = parseFloat(value.replace(/[^0-9.]/g, '')) || 0;

  useEffect(() => {
    if (inView) mv.set(target);
  }, [inView, mv, target]);

  useEffect(() => {
    const unsub = spring.on('change', (v) => {
      const formatted = target % 1 === 0
        ? Math.round(v).toLocaleString('en-US')
        : v.toFixed(1);
      setDisplay(`${prefix}${formatted}${suffix}`);
    });
    return unsub;
  }, [spring, prefix, suffix, target]);

  return <span ref={ref} className="tnum">{display}</span>;
}

/** Floating spore particles drifting upward in the hero. */
function SporeField() {
  const spores = useRef(
    Array.from({ length: 14 }, (_, i) => ({
      id: i,
      x: (i * 67) % 100,
      size: 2 + ((i * 37) % 4),
      duration: 9 + ((i * 53) % 8),
      delay: (i * 1.3) % 9,
      tone: i % 4 === 0 ? 'bg-fungal' : i % 4 === 1 ? 'bg-moss' : 'bg-dim',
    }))
  ).current;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {spores.map((s) => (
        <motion.span
          key={s.id}
          className={`absolute rounded-full opacity-40 ${s.tone}`}
          style={{ left: `${s.x}%`, width: s.size, height: s.size, bottom: '-2%' }}
          animate={{ y: ['0%', '-110vh'], opacity: [0, 0.5, 0] }}
          transition={{ duration: s.duration, delay: s.delay, repeat: Infinity, ease: 'linear' }}
        />
      ))}
    </div>
  );
}

const STATUS_TONE = [
  'text-fungal',   // Funding
  'text-ink',      // Active
  'text-muted',    // Repaid
  'text-red-400',  // Defaulted
  'text-faint',    // Cancelled
];

function LoanRow({ loan: l, index }: { loan: LoanView; index: number }) {
  const pct = l.target > 0 ? Math.min(100, (l.funded / l.target) * 100) : 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.06 }}
      whileHover={{ x: 4 }}
      className="border-b border-rule/60 py-5 transition-colors hover:bg-white/[0.02]"
    >
      <div className="flex items-baseline justify-between gap-4">
        <Link to={`/passport/${l.agentId}`} className="font-mono text-sm text-ink hover:underline">
          Agent #{l.agentId}
        </Link>
        <span className={`font-mono text-xs uppercase tracking-widest ${STATUS_TONE[l.status]}`}>
          {STATUS_LABEL[l.status]}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">{l.purpose}</p>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-faint">
        <span>
          <span className="tnum text-ink">${l.funded.toFixed(2)}</span> / ${l.target.toFixed(2)}
        </span>
        <span>fee {(l.feeBps / 100).toFixed(1)}%</span>
        {l.status === 1 && (
          <span>
            repaid <span className="tnum text-ink">${l.repaid.toFixed(2)}</span> / ${l.totalOwed.toFixed(2)}
          </span>
        )}
      </div>
      {l.status === 0 && (
        <div className="mt-2 h-1 w-full overflow-hidden bg-rule/40">
          <motion.div
            className="h-1 bg-fungal"
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 1.2, delay: 0.3 + index * 0.1, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      )}
    </motion.div>
  );
}

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
  { label: 'Fee cap', value: '50', suffix: '%', note: 'hard-coded maximum the borrower can offer' },
  { label: 'Min. funding window', value: '1', suffix: ' hour', note: 'prevents flash ambushes' },
  { label: 'Tests passing', value: '8', suffix: ' / 8', note: 'full lifecycle, default, cancel, edge cases' },
];

export default function Syndicate() {
  const loansState = useSyndicateLoans();

  useEffect(() => {
    document.title = 'SPORE — Syndicated Loans';
  }, []);

  return (
    <div className="bg-bg text-ink">
      <div className="relative mx-auto max-w-4xl px-4 pb-32 pt-24 md:px-8 md:pt-32">
        <SporeField />
        <header className="relative">
          <motion.div variants={fadeUp} initial="hidden" animate="show" custom={0}>
            <Eyebrow>New primitive</Eyebrow>
          </motion.div>
          <motion.h1
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={1}
            className="display mt-4 font-serif text-4xl text-ink md:text-6xl"
          >
            Syndicated loans.
          </motion.h1>
          <motion.p
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={2}
            className="mt-6 max-w-xl text-muted leading-relaxed"
          >
            One agent needs $500 for a GPU job. No single backer wants that risk alone.
            Ten backers take $50 each, split the fees, share the risk. This is how
            corporate lending works in the human world — now it works for agents,
            on-chain, without a bank in the middle.
          </motion.p>
        </header>

        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="show"
          custom={3}
          className="relative mt-12"
        >
          <Eyebrow>Live syndicates</Eyebrow>
          <div className="mt-6">
            {loansState.kind === 'loading' && <LoadingState label="Reading the chain…" />}
            {loansState.kind === 'not-deployed' && (
              <div className="border border-rule/60 px-6 py-10 text-center">
                <p className="font-mono text-sm text-muted">
                  The SyndicateManager contract is built and tested. It opens for proposals once deployed.
                </p>
              </div>
            )}
            {loansState.kind === 'error' && (
              <div className="border border-rule/60 px-6 py-10 text-center">
                <p className="font-mono text-sm text-muted">
                  Couldn't read the chain: {loansState.message}
                </p>
              </div>
            )}
            {loansState.kind === 'ready' && loansState.loans.length === 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6, delay: 0.4 }}
                className="border border-rule/60 px-6 py-10 text-center"
              >
                <p className="font-mono text-sm text-muted">
                  No syndicated loans yet. The first proposal opens this market.
                </p>
              </motion.div>
            )}
            {loansState.kind === 'ready' && loansState.loans.length > 0 && (
              <div className="space-y-1">
                {loansState.loans.map((l, i) => (
                  <LoanRow key={l.id} loan={l} index={i} />
                ))}
              </div>
            )}
          </div>
        </motion.div>

        <section className="relative mt-24">
          <Eyebrow>How it works</Eyebrow>
          <ol className="mt-10 border-t border-rule">
            {STEPS.map((s, i) => (
              <motion.li
                key={s.n}
                variants={fadeUp}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: '-60px' }}
                custom={i}
                className="grid gap-3 border-b border-rule py-8 md:grid-cols-[3rem_1fr] md:gap-6"
              >
                <span className="font-mono text-sm text-fungal">{s.n}</span>
                <div>
                  <h3 className="font-serif text-xl text-ink">{s.title}</h3>
                  <p className="mt-2 max-w-2xl text-muted leading-relaxed">{s.body}</p>
                </div>
              </motion.li>
            ))}
          </ol>
        </section>

        <section className="relative mt-24">
          <Eyebrow>By the numbers</Eyebrow>
          <div className="mt-10 grid gap-px bg-rule/40 sm:grid-cols-3">
            {NUMBERS.map((s, i) => (
              <motion.div
                key={s.label}
                variants={fadeUp}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: '-60px' }}
                custom={i}
                className="bg-bg px-6 py-8"
              >
                <div className="font-mono text-xs uppercase tracking-widest text-faint">{s.label}</div>
                <div className="mt-3 font-serif text-4xl text-ink">
                  <CountUp value={s.value} suffix={s.suffix} />
                </div>
                <div className="mt-2 text-sm text-muted">{s.note}</div>
              </motion.div>
            ))}
          </div>
        </section>

        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          className="relative mt-24"
        >
          <Rule />
          <p className="pt-6 text-sm text-muted leading-relaxed">
            Backers bear default risk — there is no insurance or protocol backstop in v1.
            Every loan's full history (proposals, funding, repayments, defaults) is
            public on Robinhood Chain. The contract is{' '}
            <span className="font-mono text-xs">
              {SYNDICATE_MANAGER}
            </span>
            .
          </p>
        </motion.div>
      </div>
    </div>
  );
}
