import { useState } from 'react';
import { PRIMARY_CHAIN } from '../chains';

export const SPORE_TOKEN_ADDRESS = '0xa5127fae2d0986a4cb6619b9c4ec53461726454b';

/** Glowing $SPORE official-contract badge. Click copies the address. */
export default function SporeTokenBadge() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(SPORE_TOKEN_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — the explorer link still works */
    }
  }

  return (
    <div className="mt-8 flex flex-wrap items-center gap-3">
      <button
        onClick={copy}
        title="Click to copy"
        className="spore-glow flex items-center gap-3 rounded-full border border-fungal/60 bg-bg px-5 py-2.5 transition-transform hover:scale-[1.02] active:scale-[0.99]"
      >
        <span className="font-mono text-[13px] font-bold uppercase tracking-[0.18em] text-fungal">
          $SPORE
        </span>
        <span className="font-mono text-[12px] text-muted break-all">
          {SPORE_TOKEN_ADDRESS}
        </span>
        <span className="font-mono text-[11px] uppercase tracking-widest text-faint">
          {copied ? 'copied ✓' : 'copy'}
        </span>
      </button>
      <a
        href={`${PRIMARY_CHAIN.explorerUrl}/token/${SPORE_TOKEN_ADDRESS}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-[12px] text-faint underline underline-offset-4 hover:text-ink"
      >
        Official contract ↗
      </a>
    </div>
  );
}
