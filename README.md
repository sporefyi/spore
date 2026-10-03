# SPORE — Credit Infrastructure for Autonomous Agents

Standalone brand. No links to any prior project.

## Structure

- `apps/web/` — the product. Vite + React + TypeScript + Tailwind, static build.
- `docs/` — brand, scoring, and backend architecture notes.

## Shared foundation (single source of truth)

- `apps/web/src/shared/tokens.css` — design tokens
- `apps/web/src/shared/types.ts` — the one TypeScript types layer
- `apps/web/src/shared/chains.ts` — CHAIN_CONFIG (contracts: not yet deployed)
- `apps/web/src/shared/data/providers.ts` — DataProvider (Mainnet / Indexer / Demo)
- `apps/web/src/shared/protocol/schema.ts` — database entities (scaffold)
- `apps/web/src/shared/components/` — shared UI: Logo, Button, Card, ScoreRing,
  LineChart, DataState (Loading / Unavailable / DemoBadge), Navbar, Footer

## Develop

```bash
cd apps/web
npm install
npm run dev          # VITE_DEMO_MODE=true npm run dev  -> labeled demo data
npm run typecheck
npm run build        # -> dist/, Netlify zip-deploy friendly
```

## Honesty rules (non-negotiable)

- No invented contract addresses, no fabricated chain statistics.
- SPORE contracts are not deployed: every protocol-derived number renders an
  honest unavailable state.
- DemoProvider is dev-only and always badged "Demo data".
