import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import VoxelMushroomFallback from '../shared/components/VoxelMushroomFallback'
import { MechanismSection } from '../shared/components/MechanismDiagram'
import {
  Eyebrow,
  Rule,
  SectionNo,
  Stat,
  Reveal,
  LedgerTable,
} from '../shared/components/primitives'
import { provider } from '../shared/data/providers'
import type { NetworkStats, Repayment } from '../shared/types'
import type { Voxel } from '../shared/components/voxelModel'
import SporeTokenBadge from '../shared/components/SporeTokenBadge'

const VoxelMushroom = lazy(() => import('../shared/components/VoxelMushroom'))

type LedgerRow = {
  id: string
  block: string
  agent: string
  event: string
  amount: string
  time: string
}

const LEDGER_ROWS: LedgerRow[] = []

const PASSPORT: ReadonlyArray<{ label: string; value: string; kind: 'serif' | 'score' | 'mono' }> = [
  { label: 'AGENT', value: 'research.bot', kind: 'serif' },
  { label: 'CREDIT SCORE', value: '782', kind: 'score' },
  { label: 'CREDIT LIMIT', value: '$250', kind: 'mono' },
  { label: 'REPAYMENT', value: '100%', kind: 'mono' },
  { label: 'UTILIZATION', value: '21%', kind: 'mono' },
  { label: '30D REVENUE', value: '$1,840', kind: 'mono' },
  { label: 'DEFAULTS', value: '0', kind: 'mono' },
]

// Illustrative only: 24 ascending points ending at 782.
const SCORE_TREND: readonly number[] = [
  540, 548, 561, 559, 574, 588, 596, 607, 604, 621, 636, 649,
  655, 668, 679, 676, 692, 708, 721, 734, 745, 758, 771, 782,
]

function buildSparkline(values: readonly number[]): string {
  const min = 520
  const max = 790
  const w = 300
  const h = 60
  const padY = 6
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w
      const y = h - padY - ((v - min) / (max - min)) * (h - padY * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

const SPARK_PATH = buildSparkline(SCORE_TREND)

const ENDPOINTS: ReadonlyArray<{ label: string; y: number }> = [
  { label: 'LENDING', y: 30 },
  { label: 'COMPUTE', y: 80 },
  { label: 'APIS', y: 130 },
  { label: 'DATA', y: 180 },
  { label: 'SERVICES', y: 230 },
]

function scrollToNetwork(): void {
  document.getElementById('network')?.scrollIntoView({ behavior: 'smooth' })
}

/** FNV-1a → seed: each repayment renders the same spore on every load. */
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Every on-chain repayment becomes a spore voxel orbiting the mushroom —
 * same ring/height band as the procedural field, size scaled by amount.
 */
function repaymentSpores(reps: Repayment[]): Voxel[] {
  return reps.slice(0, 140).map((r) => {
    const rng = mulberry32(hashStr(r.txHash))
    const a = rng() * Math.PI * 2
    const rr = 6 + rng() * 9
    const y = 12 + rng() * 10
    const usd = Math.max(0, Number(r.amount) / 1e6)
    const size = 0.35 + Math.min(0.45, Math.log10(1 + usd) * 0.18)
    const pick = rng()
    const color = pick < 0.55 ? '#f0e6cc' : pick < 0.85 ? '#8fae5a' : '#d9772b'
    return {
      pos: [Math.cos(a) * rr, y, Math.sin(a) * rr] as [number, number, number],
      color,
      size,
    }
  })
}

const monoLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '2px',
}

export default function Home() {
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' })
  }, [hash])
  const [stats, setStats] = useState<NetworkStats | null>(null)
  const [repayments, setRepayments] = useState<Repayment[] | null>(null)
  useEffect(() => {
    let live = true
    provider
      .getNetworkStats()
      .then((st) => {
        if (live) setStats(st)
      })
      .catch(() => {})
    provider
      .getRepayments()
      .then((reps) => {
        if (live) setRepayments(reps)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const heroSpores = useMemo(
    () => (repayments === null ? undefined : repaymentSpores(repayments)),
    [repayments]
  )
  const fmtUsd = (v: number | null) =>
    v === null ? '—' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return (
    <div className="bg-bg text-ink overflow-x-hidden">
      {/* 1. HERO — Priors composition: text left, organism right */}
      <section className="pt-16 md:pt-24">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
          <div>
            <Reveal>
              <Eyebrow className="text-moss">CREDIT FOR AUTONOMOUS AGENTS</Eyebrow>
              <h1 className="display display-tight mt-8 text-[clamp(46px,6.2vw,86px)] text-ink">
                Repayment history, made <em className="italic text-moss">portable</em>.
              </h1>
            </Reveal>
            <Reveal delay={100}>
              <div className="mt-8 max-w-xl font-serif text-xl leading-relaxed text-muted">
                <p>Priors proved agents can be creditworthy. SPORE is the system that measures it, records it, and lets any protocol use it. AI agents borrow here. Before an agent can borrow, a backer puts stake behind its line and that stake is lost first if the agent doesn&rsquo;t repay. Every repayment is recorded on Robinhood Chain.</p>
              </div>
            </Reveal>
            <Reveal delay={150}>
              <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4">
                <Link
                  to="/connect"
                  className="bg-ink px-6 py-3 font-sans text-sm font-medium text-bg transition-opacity hover:opacity-85"
                >
                  Launch an agent
                </Link>
                <Link
                  to="/connect"
                  className="border border-fungal px-6 py-3 font-mono text-[13px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal hover:text-bg"
                >
                  Bring your Orbio agent
                </Link>
                <Link
                  to="/agents"
                  className="text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink"
                >
                  Explore the network →
                </Link>
                <Link
                  to="/live"
                  className="text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink"
                >
                  Watch the market come alive →
                </Link>
              </div>
              <Link
                to="/protocol"
                className="mt-6 inline-block text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink"
              >
                How credit works →
              </Link>
              <SporeTokenBadge />
            </Reveal>
          </div>

          <div>
            <div className="h-[52vh] w-full lg:h-[64vh]">
              <Suspense fallback={<VoxelMushroomFallback className="h-full w-full" />}>
                <VoxelMushroom onReadOrganism={scrollToNetwork} className="w-full" spores={heroSpores} />
              </Suspense>
            </div>
            <div className="mt-6 flex items-start justify-between gap-6 border-t border-rule pt-4">
              <span className="whitespace-nowrap font-serif text-lg text-moss">— spores</span>
              <p className="text-right font-serif text-base italic leading-relaxed text-muted">
                {repayments !== null && repayments.length > 0 ? (
                  <>
                    {repayments.length} repayments on-chain — every repayment a spore, read from
                    the chain. Drag to turn it.
                  </>
                ) : (
                  <>
                    The mycelium is empty — for now. Every repayment becomes a spore, and will be
                    read from the chain. Drag to turn it.
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 2. STATS */}
      <div className="mt-16 md:mt-24">
        <Rule />
      </div>
      <section className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <div className="grid grid-cols-2 gap-x-8 gap-y-12 md:grid-cols-4">
          <Stat
            label="Agents"
            value={stats ? String(stats.agents ?? '—') : '—'}
            hint={stats ? 'Registered on-chain' : 'Reading the ledger…'}
          />
          <Stat
            label="Credit issued"
            value={stats ? fmtUsd(stats.creditIssuedUsd) : '—'}
            hint={stats ? 'Across all lines' : 'Reading the ledger…'}
          />
          <Stat
            label="Repaid"
            value={stats ? fmtUsd(stats.repaidUsd) : '—'}
            hint={stats ? 'Settled repayments' : 'Reading the ledger…'}
          />
          <Stat
            label="Active credit"
            value={stats ? fmtUsd(stats.activeCreditUsd) : '—'}
            hint={stats ? 'Currently drawn' : 'Reading the ledger…'}
          />
        </div>
      </section>

      {/* 3. NO. 1 */}
      <Rule />
      <section className="mx-auto max-w-6xl px-6 py-24 md:py-40">
        <Reveal>
          <SectionNo n={1} />
          <h2 className="display mt-6 text-4xl md:text-6xl">An agent starts as a spore.</h2>
          <p className="mt-8 max-w-2xl font-serif text-xl leading-relaxed text-muted">
            An autonomous agent can have an identity, a wallet and a stream of transactions. SPORE
            gives those actions a financial memory.
          </p>
        </Reveal>
        <div className="mt-16">
          <MechanismSection />
        </div>
      </section>

      {/* 4. NO. 2 */}
      <Rule />
      <section className="mx-auto max-w-6xl px-6 py-24 md:py-40">
        <Reveal>
          <SectionNo n={2} />
          <h2 className="display mt-6 text-4xl md:text-6xl">The history becomes the credit.</h2>
          <div className="mt-8">
            <span className="inline-block border border-rule px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-fungal">
              ILLUSTRATIVE EXAMPLE
            </span>
            <p className="mt-3 max-w-xl text-sm text-faint">
              A sketch of the data shape — no agent has been scored yet. These figures are
              placeholders from the design brief, not live data.
            </p>
          </div>
        </Reveal>

        <div className="mt-16 grid gap-16 md:grid-cols-2">
          <Reveal>
            <div>
              <Rule />
              {PASSPORT.map((row) => (
                <div key={row.label}>
                  <div className="flex items-baseline justify-between gap-6 py-5">
                    <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
                      {row.label}
                    </span>
                    {row.kind === 'serif' && (
                      <span className="font-serif text-2xl text-ink md:text-3xl">{row.value}</span>
                    )}
                    {row.kind === 'score' && (
                      <span className="tnum font-serif text-5xl text-moss md:text-6xl">
                        {row.value}
                      </span>
                    )}
                    {row.kind === 'mono' && (
                      <span className="tnum font-serif text-2xl text-ink md:text-3xl">
                        {row.value}
                      </span>
                    )}
                  </div>
                  <Rule />
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div className="flex flex-col justify-center md:h-full">
              <svg
                viewBox="0 0 300 60"
                className="h-auto w-full max-w-md"
                role="img"
                aria-label="Illustrative score trend rising to 782"
              >
                <path
                  d={SPARK_PATH}
                  fill="none"
                  stroke="var(--moss)"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
                score trend — illustrative
              </p>
              <Link
                to="/protocol#score-lab"
                className="mt-6 inline-block text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink"
              >
                How the score is computed →
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 5. NO. 3 */}
      <Rule />
      <section id="network" className="py-24 md:py-40">
        <div className="mx-auto max-w-6xl px-6">
          <Reveal>
            <SectionNo n={3} />
            <h2 className="display mt-6 text-4xl md:text-6xl">One reputation. Many protocols.</h2>
            <p className="mt-8 max-w-2xl font-serif text-xl leading-relaxed text-muted">
              The credit oracle publishes one score; every protocol on the network reads the same record.
            </p>
          </Reveal>
          <Reveal delay={100}>
            <svg
              viewBox="0 0 900 260"
              className="mt-16 hidden h-auto w-full md:block"
              role="img"
              aria-label="Network topology: Agent to SPORE to Credit Oracle to Lending, Compute, APIs, Data and Services"
            >
              <g stroke="var(--rule-strong)" strokeWidth={1} fill="none">
                <line x1={60} y1={130} x2={280} y2={130} />
                <line x1={280} y1={130} x2={520} y2={130} />
                {ENDPOINTS.map((e) => (
                  <line key={e.label} x1={520} y1={130} x2={760} y2={e.y} />
                ))}
              </g>
              <g fill="var(--moss)">
                <circle cx={60} cy={130} r={3} />
                <circle cx={280} cy={130} r={3} />
                <circle cx={520} cy={130} r={3} />
                {ENDPOINTS.map((e) => (
                  <circle key={e.label} cx={760} cy={e.y} r={3} />
                ))}
              </g>
              <g fill="var(--muted)" style={monoLabel}>
                <text x={60} y={112} textAnchor="middle">AGENT</text>
                <text x={280} y={112} textAnchor="middle">SPORE</text>
                <text x={520} y={112} textAnchor="middle">CREDIT ORACLE</text>
                {ENDPOINTS.map((e) => (
                  <text key={e.label} x={774} y={e.y + 4}>
                    {e.label}
                  </text>
                ))}
              </g>
            </svg>
            <div
              className="mt-16 md:hidden"
              role="img"
              aria-label="Network topology: Agent to SPORE to Credit Oracle, fanning out to Lending, Compute, APIs, Data and Services"
            >
              <div className="border-l border-rule-strong">
                {['AGENT', 'SPORE', 'CREDIT ORACLE'].map((label) => (
                  <div key={label} className="relative py-4 pl-6">
                    <span aria-hidden="true" className="absolute -left-[3px] top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-moss" />
                    <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
                      {label}
                    </span>
                  </div>
                ))}
                {ENDPOINTS.map((e) => (
                  <div key={e.label} className="relative py-3 pl-10">
                    <span aria-hidden="true" className="absolute left-0 top-1/2 h-px w-6 bg-rule-strong" />
                    <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
                      {e.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 6. LIVE LEDGER */}
      <Rule />
      <section id="ledger" className="mx-auto max-w-6xl px-6 py-24 md:py-40">
        <Reveal>
          <Eyebrow>LIVE LEDGER</Eyebrow>
          <h2 className="display mt-6 text-4xl md:text-6xl">The credit ledger, as it happens.</h2>
        </Reveal>
        <div className="mt-16">
          <LedgerTable<LedgerRow>
            columns={[
              { key: 'block', header: 'Block', mono: true, render: (r) => r.block },
              { key: 'agent', header: 'Agent', render: (r) => r.agent },
              { key: 'event', header: 'Event', render: (r) => r.event },
              { key: 'amount', header: 'Amount', mono: true, render: (r) => r.amount },
              { key: 'time', header: 'Time', mono: true, render: (r) => r.time },
            ]}
            rows={LEDGER_ROWS}
            keyOf={(r) => r.id}
            emptyTitle="No entries yet"
            emptyCopy="The ledger is live. Every row traces to a real on-chain transaction — the first entries are still settling."
          />
        </div>
      </section>

      {/* 7. LINEAGE */}
      <Rule />
      <section className="mx-auto max-w-3xl px-6 py-24 md:py-40">
        <Reveal>
          <Eyebrow>LINEAGE</Eyebrow>
          <h2 className="display mt-6 text-4xl md:text-6xl">Not a fork.</h2>
        </Reveal>
        <Reveal delay={100}>
          <div className="mt-8 space-y-4 font-serif text-xl leading-relaxed text-muted">
            <p>
              SPORE shares no code and no contracts with Priors — nothing was
              copied, nothing redeployed.
            </p>
            <p>
              What it carries forward is the insight Priors proved: an
              agent&rsquo;s repayments are a credit history nobody can fake.
              SPORE continues that work, turning repayment history into portable
              infrastructure — a credit passport, a score every protocol can
              read, and a marketplace for reputation-backed credit.
            </p>
          </div>
          <div className="mt-12 border-t border-rule">
            <div className="grid gap-6 border-b border-rule py-6 md:grid-cols-[220px_1fr] md:gap-8">
              <span className="font-mono text-xs uppercase tracking-widest text-moss">Lending → infrastructure</span>
              <p className="font-serif text-lg leading-relaxed text-muted">Priors is where agents borrow. SPORE is the credit layer underneath — passports, scores, an oracle, a marketplace.</p>
            </div>
            <div className="grid gap-6 border-b border-rule py-6 md:grid-cols-[220px_1fr] md:gap-8">
              <span className="font-mono text-xs uppercase tracking-widest text-moss">Reputation, portable</span>
              <p className="font-serif text-lg leading-relaxed text-muted">A track record earned in one place should be readable everywhere. SPORE issues it on-chain, for any protocol to read.</p>
            </div>
            <div className="grid gap-6 border-b border-rule py-6 md:grid-cols-[220px_1fr] md:gap-8">
              <span className="font-mono text-xs uppercase tracking-widest text-moss">Trust, formalized</span>
              <p className="font-serif text-lg leading-relaxed text-muted">Priors proved repayment history is credible. SPORE publishes the model that turns it into a score — twelve dimensions, open weights.</p>
            </div>
            <div className="grid gap-6 border-b border-rule py-6 md:grid-cols-[220px_1fr] md:gap-8">
              <span className="font-mono text-xs uppercase tracking-widest text-moss">Lines → a market</span>
              <p className="font-serif text-lg leading-relaxed text-muted">Beyond sponsor-backed credit lines, SPORE adds a marketplace where reputation-backed credit is priced and routed.</p>
            </div>
          </div>
          <a
            href="https://priors.trade"
            target="_blank"
            rel="noreferrer"
            className="mt-8 inline-block text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink"
          >
            priors.trade →
          </a>
        </Reveal>
      </section>
    </div>
  )
}
