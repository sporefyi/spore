# SPORE — Credit Infrastructure for Autonomous Agents

Standalone brand. No links to any prior project.

**Live:** https://spore.fyi/ · **API:** https://spore-api-nh2m.onrender.com

## Deployed contracts (Robinhood Chain, chain ID 4663)

| Contract | Address |
|---|---|
| SporeRegistry | `0x6902670409c4FA3a75C39A734c69beAEEBcF9729` |
| ScoreOracle | `0x31088a5516816ffb050846f6Ae4d460EB32000c4` |
| CreditManager | `0x3348217314cA5641531005A4CFD7b20275Fcb7a9` |
| BackerVault | `0xF574091D96518F065f772a1231EBB9dC1AaB2694` |
| FeeRouter | `0x8F921bF51D603B5ACa827C0adA822aF5259057cc` |
| USDG (asset) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| $SPORE (token) | `0xa5127fae2d0986a4cb6619b9c4ec53461726454b` |

Deployment block: `79007660`. No third-party audit — experimental protocol.

## Structure

- `apps/web/` — the product. Vite + React + TypeScript + Tailwind, static build.
- `backend/` — API (Render), indexer, Postgres. See `backend/README.md`.
- `contracts/` — Foundry project (SporeRegistry, CreditManager, BackerVault, ScoreOracle, FeeRouter).
- `docs/` — brand, scoring, and backend architecture notes.

## Live merchants (`/market`)

| Merchant | Price | Endpoint |
|---|---|---|
| SPORE Vault (IPFS storage) | 1 USDG/file | `POST /api/v1/market/storage/pin` |
| SPORE Data (on-chain queries) | 0.1 USDG | `POST /api/v1/market/data/query` |
| SPORE Search (web search) | 0.2 USDG | `POST /api/v1/market/search` |
| SPORE Inference (AI) | 0.5 USDG | `POST /api/v1/market/inference` |
| SPORE RPC (metered, 30d key) | 5 USDG | `POST /api/v1/market/rpc/key` |

Payment = on-chain USDG transfer to the merchant wallet. Each payment tx is single-use.

## Develop

```bash
cd apps/web
npm install
npm run dev          # VITE_DEMO_MODE=true npm run dev -> labeled demo data
npm run typecheck
npm run build        # requires VITE_INDEXER_URL — see .env
```

**Important:** frontend builds MUST set `VITE_INDEXER_URL=https://spore-api-nh2m.onrender.com`
or pages fall back to empty placeholder data. A local `.env` (gitignored) handles this.

## Honesty rules (non-negotiable)

- No invented contract addresses, no fabricated chain statistics.
- Every number on the site traces to a real on-chain transaction or API record.
- DemoProvider is dev-only and always badged "Demo data".
