import React, { useEffect, useRef, useState } from 'react';
import { Eyebrow, Reveal } from '../../shared/components/primitives';

/* ------------------------------------------------------------------ */
/* Contract constellation — mycelial network visualization for /contracts */
/* ------------------------------------------------------------------ */

export interface ConstellationProps {
  onSelect: (name: string) => void;
  selected: string | null;
}

interface NodeDef {
  name: string;
  address: string;
  purpose: string;
  /** position in the full 1000x560 layout */
  pos: [number, number];
  /** position in the compact layout (<560px container) */
  cpos: [number, number];
  radius: number;
  driftDelay: string;
}

const CENTER: NodeDef = {
  name: '$SPORE',
  address: '0xa5127fae2d0986a4cb6619b9c4ec53461726454b',
  purpose: 'The token at the heart of the protocol',
  pos: [500, 280],
  cpos: [500, 290],
  radius: 46,
  driftDelay: '0s',
};

const NODES: NodeDef[] = [
  {
    name: 'SporeBuyback',
    address: '0x4955a8286deC81c1fF6Aaf1c3e36df80D6C34a97',
    purpose: 'Fee USDG → $SPORE → burn',
    pos: [196, 138],
    cpos: [310, 140],
    radius: 30,
    driftDelay: '-1.7s',
  },
  {
    name: 'BackerSporeStake',
    address: '0x6b136Ba05267718CD21fEA1AC343D275FAF70399',
    purpose: 'Backers stake $SPORE to qualify for fees',
    pos: [804, 138],
    cpos: [690, 140],
    radius: 30,
    driftDelay: '-3.4s',
  },
  {
    name: 'OracleBond',
    address: '0x2299828160c8c41455EAc98e4CC8403F63289dAa',
    purpose: 'Slashable bond securing oracle updaters',
    pos: [196, 422],
    cpos: [310, 440],
    radius: 30,
    driftDelay: '-5.1s',
  },
  {
    name: 'SporeGovernor',
    address: '0x702A8e451752A7036a2cDb8E76f0AAf1C3873536',
    purpose: '$SPORE-weighted on-chain governance',
    pos: [804, 422],
    cpos: [690, 440],
    radius: 30,
    driftDelay: '-6.8s',
  },
];

function trunc(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Gentle curved hypha from the center to a node, with a slight organic bend. */
function linkPath(from: [number, number], to: [number, number]): string {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  // perpendicular offset for a subtle curve
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bend = 26;
  const qx = mx + (-dy / len) * bend;
  const qy = my + (dx / len) * bend;
  return `M ${x1} ${y1} Q ${qx} ${qy} ${x2} ${y2}`;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}

function useCompact(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w > 0 && w < 560);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return compact;
}

const STYLE = `
.sp-pos { transition: transform .6s cubic-bezier(.4,0,.2,1); }
.sp-scale { transform-box: fill-box; transform-origin: center; transition: transform .25s ease, opacity .25s ease; }
.sp-node { cursor: pointer; }
.sp-node:focus { outline: none; }
/* Focus ring must appear on ANY focus, not just :focus-visible — some
   browsers don't match :focus-visible on SVG graphics elements, and the
   default outline is suppressed above. */
.sp-node:focus .sp-focusring,
.sp-node:focus-visible .sp-focusring { opacity: 1; }
.sp-link { transition: stroke .3s ease, opacity .3s ease, stroke-width .3s ease; }
@media (prefers-reduced-motion: no-preference) {
  .sp-drift { animation: sp-bob 7s ease-in-out infinite; }
  .sp-dash { stroke-dasharray: 5 9; animation: sp-dashflow 8s linear infinite; }
}
@media (prefers-reduced-motion: reduce) {
  .sp-pos, .sp-scale, .sp-link { transition: none; }
}
@keyframes sp-bob {
  0%, 100% { transform: translateY(-6px); }
  50% { transform: translateY(6px); }
}
@keyframes sp-dashflow {
  to { stroke-dashoffset: -280; }
}
`;

export function Constellation({ onSelect, selected }: ConstellationProps): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const compact = useCompact(wrapRef);
  const reducedMotion = useReducedMotion();
  const [active, setActive] = useState<string | null>(null);

  const posOf = (n: NodeDef): [number, number] => (compact ? n.cpos : n.pos);
  const [cx, cy] = compact ? CENTER.cpos : CENTER.pos;

  const links = NODES.map((n, i) => {
    const [nx, ny] = posOf(n);
    return { node: n, d: linkPath([cx, cy], [nx, ny]), i };
  });

  const renderCard = (node: NodeDef): React.ReactElement => {
    const [x, y] = posOf(node);
    const r = node.radius;
    const nameLen = node.name.length;
    const purposeLen = node.purpose.length;
    const w = Math.min(320, Math.max(nameLen * 8.2, purposeLen * 7.1) + 30);
    const h = 66;
    // top-row nodes get their card below; bottom-row nodes (and center) above
    const above = y >= cy;
    const cardY = above ? y - r - h - 14 : y + r + 14;
    const cardX = Math.min(Math.max(x - w / 2, 8), 1000 - w - 8);
    return (
      <g key={`card-${node.name}`} pointerEvents="none" aria-hidden="true">
        <rect
          x={cardX}
          y={cardY}
          width={w}
          height={h}
          rx={8}
          fill="var(--bg, #14110d)"
          stroke="var(--rule, #2e2922)"
          strokeWidth={1}
          opacity={0.97}
        />
        <line
          x1={cardX}
          y1={cardY}
          x2={cardX}
          y2={cardY + h}
          stroke="var(--moss, #8fae5a)"
          strokeWidth={2}
        />
        <text
          x={cardX + 16}
          y={cardY + 26}
          fill="var(--moss, #8fae5a)"
          fontSize={13}
          fontWeight={600}
          fontFamily="'IBM Plex Mono', ui-monospace, monospace"
          letterSpacing={1}
        >
          {node.name.toUpperCase()}
        </text>
        <text
          x={cardX + 16}
          y={cardY + 48}
          fill="var(--ink, #f0e9da)"
          fontSize={12.5}
          fontFamily="'Schibsted Grotesk', system-ui, sans-serif"
        >
          {node.purpose}
        </text>
      </g>
    );
  };

  const renderNode = (node: NodeDef, isCenter: boolean): React.ReactElement => {
    const [x, y] = posOf(node);
    const isActive = active === node.name;
    const dimmed = active !== null && !isActive;
    const isSelected = selected === node.name;

    return (
      <g
        key={node.name}
        className="sp-pos sp-node"
        role="button"
        tabIndex={0}
        aria-label={`${node.name}, ${node.purpose}, contract ${node.address}`}
        style={{ transform: `translate(${x}px, ${y}px)`, opacity: dimmed ? 0.4 : 1 }}
        onMouseEnter={() => setActive(node.name)}
        onMouseLeave={() => setActive((a) => (a === node.name ? null : a))}
        onFocus={() => setActive(node.name)}
        onBlur={() => setActive((a) => (a === node.name ? null : a))}
        onClick={() => onSelect(node.name)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(node.name);
          }
        }}
      >
        <title>{node.name} — {node.purpose}</title>
        <g className="sp-drift" style={{ animationDelay: node.driftDelay }}>
          <g className="sp-scale" style={{ transform: isActive ? 'scale(1.08)' : 'scale(1)' }}>
            {/* generous hit area */}
            <circle r={node.radius + 22} fill="transparent" className="sp-hit" />
            {/* focus ring */}
            <circle
              className="sp-focusring"
              r={node.radius + 10}
              fill="none"
              stroke="var(--moss, #8fae5a)"
              strokeWidth={1.5}
              strokeDasharray="4 5"
              opacity={0}
              style={{ transition: 'opacity .2s ease' }}
            />
            {/* selected ring */}
            {isSelected && (
              <circle
                r={node.radius + 6}
                fill="none"
                stroke="var(--moss, #8fae5a)"
                strokeWidth={1.5}
                strokeDasharray="3 6"
              />
            )}
            {isCenter && (
              <circle
                r={node.radius + 14}
                fill="none"
                stroke="var(--rule, #2e2922)"
                strokeWidth={1}
                opacity={0.8}
              />
            )}
            <circle
              r={node.radius}
              fill={isCenter ? 'var(--moss, #8fae5a)' : 'var(--bg, #14110d)'}
              stroke={isCenter ? 'var(--moss, #8fae5a)' : isActive ? 'var(--moss, #8fae5a)' : 'var(--rule, #2e2922)'}
              strokeWidth={isActive || isCenter ? 1.5 : 1}
              style={{ transition: 'stroke .25s ease' }}
            />
            {!isCenter && (
              <circle r={5} fill={isActive ? 'var(--moss, #8fae5a)' : 'var(--fungal, #d9772b)'} opacity={0.9} />
            )}
            <text
              y={isCenter ? -2 : node.radius + 20}
              textAnchor="middle"
              fill={isCenter ? 'var(--bg, #14110d)' : 'var(--ink, #f0e9da)'}
              fontSize={isCenter ? 15 : 12.5}
              fontWeight={isCenter ? 700 : 500}
              fontFamily={isCenter ? "'IBM Plex Mono', ui-monospace, monospace" : "'IBM Plex Mono', ui-monospace, monospace"}
              letterSpacing={isCenter ? 1 : 0.5}
            >
              {node.name}
            </text>
            <text
              y={isCenter ? 16 : node.radius + 36}
              textAnchor="middle"
              fill="var(--muted, #a89f8d)"
              fontSize={10.5}
              fontFamily="'IBM Plex Mono', ui-monospace, monospace"
            >
              {trunc(node.address)}
            </text>
          </g>
        </g>
        {isActive && renderCard(node)}
      </g>
    );
  };

  return (
    <section aria-labelledby="constellation-heading">
      <style>{STYLE}</style>
      <Reveal>
        <Eyebrow>PROTOCOL GRAPH</Eyebrow>
        <h2
          id="constellation-heading"
          className="font-serif text-3xl md:text-5xl mt-3 mb-2"
          style={{ color: 'var(--ink, #f0e9da)' }}
        >
          One protocol. Many interconnected systems.
        </h2>
        <p
          className="text-sm md:text-base max-w-xl mb-8"
          style={{ color: 'var(--muted, #a89f8d)', fontFamily: "'Schibsted Grotesk', system-ui, sans-serif" }}
        >
          Every core contract in the Spore protocol, wired to the $SPORE token at
          its center. Hover or focus a node to trace its flow; select one to open
          its detail.
        </p>
      </Reveal>
      <Reveal delay={120}>
        <div ref={wrapRef} className="w-full">
          <svg
            viewBox="0 0 1000 560"
            className="w-full h-auto block"
            role="group"
            aria-label="Interactive constellation of Spore protocol contracts: $SPORE at the center connected to SporeBuyback, BackerSporeStake, OracleBond and SporeGovernor."
          >
            {/* hyphae: center -> orbit links */}
            {links.map(({ node, d }) => {
              const lit = active === node.name || active === '$SPORE';
              const dimmed = active !== null && !lit;
              return (
                <path
                  key={`link-${node.name}`}
                  d={d}
                  className={reducedMotion ? 'sp-link' : 'sp-link sp-dash'}
                  fill="none"
                  stroke={lit ? 'var(--moss, #8fae5a)' : 'var(--rule, #2e2922)'}
                  strokeWidth={lit ? 1.5 : 1}
                  opacity={dimmed ? 0.35 : lit ? 1 : 0.75}
                />
              );
            })}

            {/* traveling value-flow particles (motion-safe only) */}
            {!reducedMotion &&
              links.map(({ node, d, i }) => (
                <g key={`flow-${node.name}`}>
                  <circle r={3.2} fill="var(--moss, #8fae5a)" opacity={0.85}>
                    <animateMotion dur={`${6.5 + i * 0.8}s`} repeatCount="indefinite" path={d} />
                  </circle>
                  <circle r={2.4} fill="var(--fungal, #d9772b)" opacity={0.75}>
                    <animateMotion
                      dur={`${8 + i * 0.9}s`}
                      begin={`${-2 - i * 1.3}s`}
                      repeatCount="indefinite"
                      path={d}
                      keyPoints="1;0"
                      keyTimes="0;1"
                      calcMode="linear"
                    />
                  </circle>
                </g>
              ))}

            {/* nodes */}
            {renderNode(CENTER, true)}
            {NODES.map((n) => renderNode(n, false))}
          </svg>
        </div>
      </Reveal>
    </section>
  );
}

export default Constellation;
