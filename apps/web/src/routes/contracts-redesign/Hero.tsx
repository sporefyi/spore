import { Eyebrow } from '../../shared/components/primitives';
import HeroScene from './HeroScene';

/**
 * ContractsHero — /contracts page hero (redesign).
 *
 * Two-column editorial layout: protocol copy on the left, an interactive
 * voxel-mushroom WebGL scene on the right (~480px square), stacking on
 * mobile. All text content is plain markup, so it stays accessible even
 * when WebGL is unavailable (the scene falls back to a static SVG).
 */
export function ContractsHero() {
  return (
    <section className="border-b border-rule">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 md:py-24 lg:grid-cols-2 lg:items-center">
        <div>
          <Eyebrow>THE PROTOCOL, ON-CHAIN</Eyebrow>
          <h1 className="display mt-4 text-6xl text-ink md:text-7xl">CONTRACTS</h1>
          <p className="mt-3 font-serif text-xl italic text-muted md:text-2xl">
            Where SPORE becomes infrastructure.
          </p>
          <p className="mt-5 max-w-md leading-relaxed text-muted">
            Verified protocol contracts powering credit, staking, oracle security,
            governance and the SPORE economy.
          </p>
          <p className="mt-8 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-moss motion-safe:animate-pulse"
            />
            MAINNET — CONTRACTS LIVE
          </p>
        </div>
        <div className="mx-auto aspect-square w-full max-w-[480px]">
          <HeroScene className="aspect-square" />
        </div>
      </div>
    </section>
  );
}

export default ContractsHero;
