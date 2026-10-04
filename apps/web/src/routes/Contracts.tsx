import { useEffect, useRef, useState } from 'react';
import { Eyebrow, Rule, SectionNo, Reveal } from '../shared/components/primitives';

// ── Data ─────────────────────────────────────────────────────────
interface ContractInfo {
  name: string;
  address: string;
  purpose: string;
  accent: 'moss' | 'fungal';
}

const V1: ContractInfo[] = [
  { name: 'SporeRegistry', address: '0x6902670409c4FA3a75C39A734c69beAEEBcF9729', purpose: 'Agent identity & registration — ERC-8004 compatible. Every event ties back here.', accent: 'fungal' },
  { name: 'ScoreOracle', address: '0x31088a5516816ffb050846f6Ae4d460EB32000c4', purpose: 'Publishes credit scores & risk bands on-chain for every agent.', accent: 'moss' },
  { name: 'CreditManager', address: '0x3348217314cA5641531005A4CFD7b20275Fcb7a9', purpose: 'Issues credit lines. Tracks draws against limits, posts repayments.', accent: 'fungal' },
  { name: 'BackerVault', address: '0xF574091D96518F065f772a1231EBB9dC1AaB2694', purpose: 'Backers stake USDG to fund agent credit. Earns a share of fees.', accent: 'moss' },
  { name: 'FeeRouter', address: '0x8F921bF51D603B5ACa827C0adA822aF5259057cc', purpose: 'Splits protocol fees between the treasury and USDG backers.', accent: 'fungal' },
];

const V2: ContractInfo[] = [
  { name: 'SporeVotes', address: '0x4dee4A2D388bAD0e5FD548Da98561b6Ec691830F', purpose: 'vSPORE wrapper — 1:1 with $SPORE, adds the voting checkpoints $SPORE lacks.', accent: 'moss' },
  { name: 'TimelockController', address: '0xd69C4f1cA47d75B5CC637fa31F981cB7B33b8E61', purpose: 'Two-day timelock. Every governance action waits before executing.', accent: 'fungal' },
  { name: 'SporeGovernor', address: '0x702A8e451752A7036a2cDb8E76f0AAf1C3873536', purpose: '$SPORE-weighted on-chain governance over risk, fees, and merchants.', accent: 'moss' },
  { name: 'SporeBuyback', address: '0x4955a8286deC81c1fF6Aaf1c3e36df80D6C34a97', purpose: 'Takes a share of fees, buys $SPORE on the market, burns it.', accent: 'fungal' },
  { name: 'BackerSporeStake', address: '0x6b136Ba05267718CD21fEA1AC343D275FAF70399', purpose: 'Backers stake $SPORE to qualify for fee share. No stake, no fees.', accent: 'moss' },
  { name: 'OracleBond', address: '0x2299828160c8c41455EAc98e4CC8403F63289dAa', purpose: 'Oracle updaters post slashable $SPORE bond. Bad scores get slashed.', accent: 'fungal' },
];

const accentVar = (a: 'moss' | 'fungal') => (a === 'moss' ? 'var(--moss)' : 'var(--fungal)');

// ── Animated flow diagram (editorial style) ──────────────────────
function FlowDiagram({ contracts, idPrefix }: { contracts: ContractInfo[]; idPrefix: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { threshold: 0.2 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const W = 960, H = 300;
  const nodeW = 168, nodeH = 64;
  const n = contracts.length;
  const xs = contracts.map((_, i) => 40 + i * ((W - 80 - nodeW) / Math.max(n - 1, 1)));
  const ys = contracts.map((_, i) => (i % 2 === 0 ? 36 : 196));

  const edges: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    const x1 = xs[i] + nodeW, y1 = ys[i] + nodeH / 2;
    const x2 = xs[i + 1], y2 = ys[i + 1] + nodeH / 2;
    const mx = (x1 + x2) / 2;
    edges.push(`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
  }

  return (
    <div ref={ref} className="overflow-x-auto border border-rule rounded-none my-10" style={{ background: 'rgba(255,255,255,0.015)' }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" style={{ minWidth: 720 }}>
        <defs>
          <filter id={`${idPrefix}-soft`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {edges.map((d, i) => (
          <path key={i} d={d} fill="none"
            stroke={accentVar(contracts[i].accent)} strokeWidth="1"
            strokeDasharray="5 5" opacity={visible ? 0.7 : 0}
            className={visible ? 'edge-flow' : ''}
            style={{ animationDelay: `${0.4 + i * 0.35}s`, transition: 'opacity 0.8s' }} />
        ))}
        {contracts.map((c, i) => (
          <g key={c.name} opacity={visible ? 1 : 0}
             className={visible ? 'node-enter' : ''}
             style={{ animationDelay: `${i * 0.28}s`, transition: 'opacity 0.6s' }}>
            <rect x={xs[i]} y={ys[i]} width={nodeW} height={nodeH} fill="var(--bg)"
              stroke={accentVar(c.accent)} strokeWidth="1"
              filter={`url(#${idPrefix}-soft)`} />
            <rect x={xs[i]} y={ys[i]} width={3} height={nodeH} fill={accentVar(c.accent)} />
            <text x={xs[i] + 14} y={ys[i] + 28} fill="var(--ink)"
              fontSize="13" fontWeight="600" fontFamily="var(--font-sans)">{c.name}</text>
            <text x={xs[i] + 14} y={ys[i] + 48} fill="var(--faint)"
              fontSize="10" fontFamily="var(--font-mono)">
              {c.address.slice(0, 6)}…{c.address.slice(-4)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Contract entry (editorial ledger row) ────────────────────────
function ContractRow({ c, index }: { c: ContractInfo; index: number }) {
  return (
    <Reveal delay={index * 60}>
      <div className="group border-t border-rule py-6 grid md:grid-cols-[1fr_2fr] gap-3 md:gap-8 transition-colors hover:bg-white/[0.015]">
        <div>
          <div className="flex items-center gap-3">
            <span className="inline-block w-2 h-2" style={{ background: accentVar(c.accent) }} />
            <h3 className="font-sans font-semibold text-lg text-ink">{c.name}</h3>
          </div>
          <a href={`https://explorer.robinhood.com/address/${c.address}`}
             target="_blank" rel="noopener noreferrer"
             className="font-mono text-[11px] text-faint hover:text-moss transition-colors break-all">
            {c.address}
          </a>
        </div>
        <p className="text-muted leading-relaxed text-[15px]">{c.purpose}</p>
      </div>
    </Reveal>
  );
}

// ── Page ─────────────────────────────────────────────────────────
export default function Contracts() {
  return (
    <div className="max-w-4xl mx-auto px-6 pt-16 pb-28">
      <style>{`
        .edge-flow { stroke-dashoffset: 20; animation: edge-dash 1.4s linear infinite; }
        @keyframes edge-dash { to { stroke-dashoffset: 0; } }
        .node-enter { animation: node-rise 0.7s cubic-bezier(0.22,1,0.36,1) both; }
        @keyframes node-rise { from { transform: translateY(14px); } to { transform: translateY(0); } }
        .v2-live-glow {
          display: inline-flex; align-items: center; gap: 8px;
          font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.22em;
          color: var(--moss); border: 1px solid var(--moss);
          padding: 6px 16px 6px 14px;
          animation: live-breathe 2.4s ease-in-out infinite;
        }
        .v2-live-glow .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--moss); animation: dot-pulse 2.4s ease-in-out infinite; }
        @keyframes live-breathe {
          0%, 100% { box-shadow: 0 0 0 rgba(143,174,90,0); }
          50% { box-shadow: 0 0 22px rgba(143,174,90,0.45); }
        }
        @keyframes dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        @media (prefers-reduced-motion: reduce) {
          .edge-flow, .node-enter, .v2-live-glow, .v2-live-glow .dot { animation: none !important; }
          .edge-flow { stroke-dashoffset: 0; }
        }
      `}</style>

      {/* Hero */}
      <Reveal>
        <Eyebrow>The protocol, on-chain</Eyebrow>
        <h1 className="display text-5xl md:text-6xl text-ink mt-4 mb-6">Contracts</h1>
        <p className="text-muted text-lg leading-relaxed max-w-2xl">
          Every contract that powers SPORE. The immutable v1 core runs agent credit today —
          the v2 layer wires <span className="text-ink">$SPORE</span> into the protocol.
          All on Robinhood Chain. All verifiable.
        </p>
      </Reveal>

      <div className="my-14"><Rule strong /></div>

      {/* V1 */}
      <Reveal>
        <div className="flex items-baseline gap-4 mb-2">
          <SectionNo n="I" />
          <h2 className="display text-3xl md:text-4xl text-ink">The core</h2>
        </div>
        <p className="text-faint font-mono text-xs tracking-[0.18em] uppercase mb-6">
          Deployed at block 79007660 · Immutable · Settles in USDG
        </p>
        <p className="text-muted leading-relaxed max-w-2xl mb-4">
          Five contracts. Agent identity, credit scores, credit lines, backer staking,
          fee routing. This is the machinery that lets an agent borrow against its
          on-chain reputation — and lets backers earn for funding it.
        </p>
      </Reveal>

      <Reveal delay={120}>
        <FlowDiagram contracts={V1} idPrefix="v1flow" />
      </Reveal>

      <div className="border-b border-rule mb-20">
        {V1.map((c, i) => <ContractRow key={c.name} c={c} index={i} />)}
      </div>

      {/* Bridge */}
      <Reveal>
        <div className="border border-rule p-8 md:p-10 mb-20" style={{ background: 'rgba(143,174,90,0.04)' }}>
          <Eyebrow>Why a second generation</Eyebrow>
          <p className="serif italic text-xl md:text-2xl text-ink leading-relaxed mt-4">
            V1 answered how agents get credit. V2 answers what flows back to $SPORE holders —
            fee buybacks and burns, backer staking, bonded oracles, on-chain governance.
          </p>
          <p className="text-muted mt-4 leading-relaxed">
            New modules, deployed alongside v1. Nothing migrated, nothing disrupted.
            The core keeps running exactly as it does today.
          </p>
        </div>
      </Reveal>

      {/* V2 */}
      <Reveal>
        <div className="flex items-baseline gap-4 mb-2 flex-wrap">
          <SectionNo n="II" />
          <h2 className="display text-3xl md:text-4xl text-ink">$SPORE utility layer</h2>
          <span className="v2-live-glow"><span className="dot" />LIVE</span>
        </div>
        <p className="text-faint font-mono text-xs tracking-[0.18em] uppercase mb-6">
          Deployed 2026-10-04 · New modules · Every fee, backer, oracle & vote touches $SPORE
        </p>
        <p className="text-muted leading-relaxed max-w-2xl mb-4">
          Six contracts that give the token on-chain work to do. A share of fees buys
          and burns $SPORE. Backers stake it to earn. Oracle updaters bond it — and can
          be slashed. Holders vote with it.
        </p>
      </Reveal>

      <Reveal delay={120}>
        <FlowDiagram contracts={V2} idPrefix="v2flow" />
      </Reveal>

      <div className="border-b border-rule">
        {V2.map((c, i) => <ContractRow key={c.name} c={c} index={i} />)}
      </div>

      <div className="mt-16"><Rule /></div>
      <Reveal delay={80}>
        <p className="text-faint text-sm leading-relaxed mt-6 max-w-2xl">
          Admin roles on v2 modules are currently held by the deployer and designed to
          transfer to the governor and a multisig as the protocol matures. V1 contracts
          are immutable and unaudited — experimental software, use accordingly.
        </p>
      </Reveal>
    </div>
  );
}
