# SPORE backend architecture (Lane 09 scaffold)

No live backend is deployed. This document is the contract the services will
share when built. The frontend ships against `DataProvider` (`src/shared/data/providers.ts`);
production builds use `MainnetProvider`, which returns honest unavailable states
until contracts are deployed.

## Services

```
frontend  ->  static Vite build (this repo), reads via DataProvider
backend   ->  Node.js / TypeScript API (not yet built)
indexer   ->  event-driven, tracks AgentRegistered, CreditIssued, Borrow,
              Repay, Default, Revenue, Payment, Sponsor, CreditLimitChanged
oracle    ->  serves creditScore(agentId), creditLimit(agentId),
              repaymentRate(agentId), utilization(agentId), defaultCount(agentId)
contracts ->  not yet deployed; addresses live in CHAIN_CONFIG when real
database  ->  PostgreSQL; entities in src/shared/protocol/schema.ts
analytics ->  score model runs (batch)
```

## Data rules

- Every chain-derived row retains chain, blockNumber, transactionHash,
  logIndex, timestamp (see `ChainEventRef`). State is deterministically
  reconstructible from events.
- Every financial number is traceable to a source transaction; the UI links
  each figure to its block explorer.
- Never rely exclusively on mutable frontend state.
- No secrets in the repo. RPC urls via `VITE_RPC_*` env vars, server-side
  keys never shipped to the browser.

## Provider selection

| Build | Provider | Behavior |
|---|---|---|
| production | MainnetProvider | live reads; honest "not yet activated" until deployment |
| dev + VITE_DEMO_MODE=true | DemoProvider | labeled fixture data, UI only |
| future | IndexerProvider | event-sourced reads |

## Activation checklist (before any real deposits)

1. Contracts deployed; real addresses entered in CHAIN_CONFIG (code review
   required — never invent).
2. Third-party audit of the contracts.
3. Indexer backfill verified against chain head.
4. Oracle answer consistency checks vs. on-chain state.
5. Incident runbook + pause procedure published.
