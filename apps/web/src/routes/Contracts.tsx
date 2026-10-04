import { useEffect, useRef, useState } from 'react';

// ── Contract data ──────────────────────────────────────────────
interface ContractInfo {
  name: string;
  address: string;
  purpose: string;
  color: string;
}

const V1: ContractInfo[] = [
  { name: 'SporeRegistry', address: '0x6902670409c4FA3a75C39A734c69beAEEBcF9729', purpose: 'Agent identity & registration (ERC-8004 compatible)', color: '#f97316' },
  { name: 'ScoreOracle', address: '0x31088a5516816ffb050846f6Ae4d460EB32000c4', purpose: 'Publishes credit scores & risk bands on-chain', color: '#8b5cf6' },
  { name: 'CreditManager', address: '0x3348217314cA5641531005A4CFD7b20275Fcb7a9', purpose: 'Issues credit lines, tracks draws & repayments', color: '#06b6d4' },
  { name: 'BackerVault', address: '0xF574091D96518F065f772a1231EBB9dC1AaB2694', purpose: 'Backers stake USDG to fund agent credit', color: '#eab308' },
  { name: 'FeeRouter', address: '0x8F921bF51D603B5ACa827C0adA822aF5259057cc', purpose: 'Splits protocol fees → treasury + backers', color: '#ec4899' },
];

const V2: ContractInfo[] = [
  { name: 'SporeVotes', address: '0x4dee4A2D388bAD0e5FD548Da98561b6Ec691830F', purpose: 'vSPORE wrapper — 1:1 $SPORE with voting checkpoints', color: '#38bdf8' },
  { name: 'TimelockController', address: '0xd69C4f1cA47d75B5CC637fa31F981cB7B33b8E61', purpose: '2-day timelock on all governance actions', color: '#a78bfa' },
  { name: 'SporeGovernor', address: '0x702A8e451752A7036a2cDb8E76f0AAf1C3873536', purpose: '$SPORE-weighted on-chain governance', color: '#4ade80' },
  { name: 'SporeBuyback', address: '0x4955a8286deC81c1fF6Aaf1c3e36df80D6C34a97', purpose: 'Fee share → buys $SPORE → burns it', color: '#fb7185' },
  { name: 'BackerSporeStake', address: '0x6b136Ba05267718CD21fEA1AC343D275FAF70399', purpose: 'Backers stake $SPORE to qualify for fee share', color: '#fbbf24' },
  { name: 'OracleBond', address: '0x2299828160c8c41455EAc98e4CC8403F63289dAa', purpose: 'Slashable $SPORE bond for oracle updaters', color: '#f97316' },
];

// ── Animated flow edges (SVG) ──────────────────────────────────
function FlowChart({ contracts, idPrefix }: { contracts: ContractInfo[]; idPrefix: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { threshold: 0.2 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const n = contracts.length;
  const W = 900, H = 340;
  const nodeW = 160, nodeH = 76;
  const positions = contracts.map((_, i) => ({
    x: 60 + i * ((W - 120 - nodeW) / Math.max(n - 1, 1)),
    y: i % 2 === 0 ? 40 : 200,
  }));

  // Connect in sequence with curved paths
  const paths: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = positions[i], b = positions[i + 1];
    const x1 = a.x + nodeW, y1 = a.y + nodeH / 2;
    const x2 = b.x, y2 = b.y + nodeH / 2;
    const mx = (x1 + x2) / 2;
    paths.push(`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
  }

  return (
    <div ref={ref} className="flow-chart" style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: 700, width: '100%', display: 'block' }}>
        <defs>
          {contracts.map((c, i) => (
            <linearGradient key={i} id={`${idPrefix}-g${i}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={c.color} stopOpacity="0.9" />
              <stop offset="100%" stopColor={c.color} stopOpacity="0.4" />
            </linearGradient>
          ))}
          <filter id={`${idPrefix}-glow`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {/* edges */}
        {paths.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={contracts[i].color}
            strokeWidth="2"
            strokeDasharray="8 6"
            className={visible ? 'flow-edge' : ''}
            style={{ animationDelay: `${i * 0.3}s`, opacity: visible ? 1 : 0 }}
            filter={`url(#${idPrefix}-glow)`}
          />
        ))}
        {/* nodes */}
        {contracts.map((c, i) => (
          <g key={i}
             className={visible ? 'flow-node' : ''}
             style={{ animationDelay: `${i * 0.25}s`, opacity: visible ? 1 : 0 }}>
            <rect x={positions[i].x} y={positions[i].y} width={nodeW} height={nodeH} rx="12"
                  fill={`url(#${idPrefix}-g${i})`} stroke={c.color} strokeWidth="1.5"
                  filter={`url(#${idPrefix}-glow)`} />
            <text x={positions[i].x + nodeW / 2} y={positions[i].y + 32}
                  textAnchor="middle" fill="#fff" fontSize="14" fontWeight="700"
                  fontFamily="system-ui">{c.name}</text>
            <text x={positions[i].x + nodeW / 2} y={positions[i].y + 52}
                  textAnchor="middle" fill="#ffffffcc" fontSize="10"
                  fontFamily="monospace">{c.address.slice(0, 6)}…{c.address.slice(-4)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Contract card ──────────────────────────────────────────────
function ContractCard({ c, index, live }: { c: ContractInfo; index: number; live?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { threshold: 0.15 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref}
         className={`contract-card ${visible ? 'card-visible' : ''}`}
         style={{ animationDelay: `${index * 0.12}s`, ['--accent' as string]: c.color }}>
      <div className="card-header">
        <span className="card-dot" style={{ background: c.color }} />
        <h3>{c.name}</h3>
        {live && <span className="live-pill">LIVE</span>}
      </div>
      <p className="card-purpose">{c.purpose}</p>
      <a className="card-address"
         href={`https://explorer.robinhood.com/address/${c.address}`}
         target="_blank" rel="noopener noreferrer">
        {c.address}
      </a>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────
export default function Contracts() {
  return (
    <div className="contracts-page">
      <style>{`
        .contracts-page { max-width: 1100px; margin: 0 auto; padding: 48px 24px 96px; }
        .contracts-hero { text-align: center; margin-bottom: 64px; }
        .contracts-hero h1 { font-size: clamp(2.2rem, 6vw, 3.6rem); font-weight: 800; letter-spacing: -0.02em; margin: 0 0 16px; background: linear-gradient(135deg, #f97316, #ec4899, #8b5cf6); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .contracts-hero p { color: #a1a1aa; font-size: 1.1rem; max-width: 640px; margin: 0 auto; line-height: 1.7; }
        .gen-section { margin-bottom: 80px; }
        .gen-heading { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
        .gen-heading h2 { font-size: 1.8rem; font-weight: 800; margin: 0; }
        .gen-sub { color: #a1a1aa; margin: 0 0 32px; line-height: 1.7; max-width: 700px; }
        .v2-glow-heading { position: relative; }
        .v2-glow-heading h2 {
          background: linear-gradient(90deg, #4ade80, #38bdf8, #4ade80);
          background-size: 200% auto;
          -webkit-background-clip: text; background-clip: text; color: transparent;
          animation: glow-slide 3s linear infinite;
          filter: drop-shadow(0 0 18px rgba(74,222,128,0.55));
        }
        .v2-live-badge {
          font-size: 0.85rem; font-weight: 800; letter-spacing: 0.2em;
          color: #052e16; background: linear-gradient(135deg, #4ade80, #86efac);
          padding: 6px 18px; border-radius: 999px;
          animation: live-pulse 2s ease-in-out infinite;
          box-shadow: 0 0 24px rgba(74,222,128,0.7), 0 0 60px rgba(74,222,128,0.35);
        }
        @keyframes glow-slide { to { background-position: 200% center; } }
        @keyframes live-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 24px rgba(74,222,128,0.7), 0 0 60px rgba(74,222,128,0.35); }
          50% { transform: scale(1.06); box-shadow: 0 0 36px rgba(74,222,128,0.95), 0 0 90px rgba(74,222,128,0.5); }
        }
        .flow-chart { margin: 32px 0 48px; padding: 16px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; }
        .flow-edge { stroke-dashoffset: 28; animation: dash-flow 1.2s linear infinite; transition: opacity 0.6s; }
        @keyframes dash-flow { to { stroke-dashoffset: 0; } }
        .flow-node { transform-origin: center; animation: node-pop 0.5s cubic-bezier(0.34,1.56,0.64,1) both; }
        @keyframes node-pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        .cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
        .contract-card {
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1);
          border-radius: 14px; padding: 22px; opacity: 0; transform: translateY(24px);
          transition: transform 0.25s, border-color 0.25s, box-shadow 0.25s;
        }
        .contract-card.card-visible { animation: card-rise 0.6s cubic-bezier(0.22,1,0.36,1) forwards; }
        @keyframes card-rise { to { opacity: 1; transform: translateY(0); } }
        .contract-card:hover { transform: translateY(-4px); border-color: var(--accent); box-shadow: 0 8px 32px color-mix(in srgb, var(--accent) 25%, transparent); }
        .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .card-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 10px currentColor; }
        .card-header h3 { margin: 0; font-size: 1.05rem; font-weight: 700; flex: 1; }
        .live-pill { font-size: 0.65rem; font-weight: 800; letter-spacing: 0.15em; color: #052e16; background: #4ade80; padding: 3px 10px; border-radius: 999px; animation: live-pulse 2s ease-in-out infinite; }
        .card-purpose { color: #d4d4d8; font-size: 0.92rem; line-height: 1.6; margin: 0 0 12px; }
        .card-address { font-family: monospace; font-size: 0.72rem; color: #71717a; word-break: break-all; text-decoration: none; transition: color 0.2s; }
        .card-address:hover { color: var(--accent); }
        .bridge-note { text-align: center; margin: 0 0 80px; padding: 28px; border: 1px dashed rgba(74,222,128,0.4); border-radius: 16px; background: rgba(74,222,128,0.04); }
        .bridge-note p { color: #d4d4d8; margin: 0; line-height: 1.7; }
        .bridge-note strong { color: #4ade80; }
        @media (prefers-reduced-motion: reduce) {
          .flow-edge, .flow-node, .contract-card.card-visible, .v2-glow-heading h2, .v2-live-badge, .live-pill { animation: none !important; }
          .flow-edge { stroke-dashoffset: 0; }
          .contract-card { opacity: 1; transform: none; }
        }
      `}</style>

      <div className="contracts-hero">
        <h1>Protocol Contracts</h1>
        <p>Every contract that powers SPORE — the immutable v1 core that runs agent credit today, and the v2 $SPORE utility layer that wires the token into the protocol. All on Robinhood Chain, all verifiable.</p>
      </div>

      {/* V1 */}
      <section className="gen-section">
        <div className="gen-heading"><h2>V1 — Core Protocol</h2></div>
        <p className="gen-sub">
          Deployed at block 79007660. Five immutable contracts that run agent identity,
          scoring, credit, backing, and fee routing — all settling in USDG.
        </p>
        <FlowChart contracts={V1} idPrefix="v1" />
        <div className="cards-grid">
          {V1.map((c, i) => <ContractCard key={c.name} c={c} index={i} />)}
        </div>
      </section>

      {/* Bridge */}
      <div className="bridge-note">
        <p>
          V1 answered <strong>"how do agents get credit?"</strong> — V2 answers
          <strong> "what flows back to $SPORE holders?"</strong> Fee buybacks and burns,
          backer staking, bonded oracles, on-chain governance. New modules, deployed
          alongside v1 — nothing migrated, nothing disrupted.
        </p>
      </div>

      {/* V2 */}
      <section className="gen-section">
        <div className="gen-heading v2-glow-heading">
          <h2>V2 — $SPORE Utility Layer</h2>
          <span className="v2-live-badge">● LIVE</span>
        </div>
        <p className="gen-sub">
          Deployed 2026-10-04. Six new modules that give $SPORE on-chain utility:
          every fee, every backer, every oracle update, and every protocol decision
          now touches the token.
        </p>
        <FlowChart contracts={V2} idPrefix="v2" />
        <div className="cards-grid">
          {V2.map((c, i) => <ContractCard key={c.name} c={c} index={i} live />)}
        </div>
      </section>
    </div>
  );
}
