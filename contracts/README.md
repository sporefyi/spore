# SPORE Contracts

SPORE is credit infrastructure for autonomous agents: on-chain passports identify each
agent, an off-chain score engine assesses creditworthiness, backers vouch stake behind
agents they trust, and agents draw purpose-bound credit that settles directly to
allowlisted merchants. This repo is the v1 Solidity core (Foundry, solc 0.8.24),
target chain Robinhood Chain (4663). Build and test only — nothing here is deployed,
and deployment needs the full ceremony in `DEPLOY.md`.

## Architecture

```
                                ┌─────────────────┐
                                │  ScoreOracle    │  publishes (score, limit)
                                │  (off-chain    │  per agent; ORACLE_UPDATER_ROLE
                                │   scores)       │  is trusted
                                └────────┬────────┘
                                         │ fresh-score gate
                                         ▼
 ┌──────────┐ register   ┌───────────────────┐ issueLine / borrow / repay ┌────────────────┐
 │ Spore    │────────────▶│  CreditManager    │────────────────────────────▶│  BackerVault   │
 │ Registry │ agentIds    │  (lines, purpose- │ funds borrow from vault,    │  (backer stake │
 │          │            │   bound borrows)  │ returns principal on repay  │   per agent)   │
 └──────────┘            └───────┬───────────┘                             └────────┬───────┘
                                 │ fee portion of repay                            │ absorbDefault
                                 ▼                                                 ▼
                         ┌───────────────────┐  backer share of fees   (stake absorbs loss first)
                         │    FeeRouter      │────────────────────────▶  yieldReserve → allocateYield
                         │  (fee splitter,   │  pure splitter, holds no user balances
                         │   no balances)    │  treasuryBps → treasury
                         └───────────────────┘

Asset (settlement token) flows:
  deposit:   backer ──▶ BackerVault                        (Sponsor an agent)
  borrow:    BackerVault ──▶ merchant  (never to the agent; purpose-bound)
  repay:     payer ──▶ CreditManager ─┬─ principal ─▶ BackerVault
                                     └─ fee ─▶ FeeRouter ─┬─ treasuryBps ─▶ treasury
                                                          └─ rest ─▶ BackerVault (yieldReserve)
  default:   BackerVault absorbs min(drawn, vouched stake); marks line defaulted;
             uncovered remainder → protocol bad debt
```

Frozen event vocabulary (the indexer depends on it): `AgentRegistered`,
`CreditIssued`, `Borrow`, `Repay`, `Default`, `Revenue`, `Payment`, `Sponsor`,
`CreditLimitChanged`. See `src/interfaces/ISpore.sol` — it is the frozen
integration contract for all implementation lanes; signatures there match
`~/workspace/spore/docs/architecture.md` exactly.

## Contracts

| Contract | Purpose |
|---|---|
| `SporeRegistry` | Issues stable on-chain passport identities (agentIds); operator/admin controls. |
| `CreditManager` | Issues and services credit lines; purpose-bound borrows disbursed direct to allowlisted merchants; fees routed to FeeRouter. Fee rate capped at `MAX_FEE_BPS` (2000 = 20%); a defaulted line is terminal and can never be re-issued. |
| `BackerVault` | Holds backer stake vouched per agent; funds borrows, receives principal, absorbs defaults from vouched stake first. Share-based pool accounting (see `IBackerVault` NatSpec). |
| `ScoreOracle` | Publishes off-chain-computed `(score, limit)` assessments with timestamps; CreditManager gates borrows on freshness. |
| `FeeRouter` | Splits collected fees: `treasuryBps` to treasury, remainder to BackerVault as backer yield. Holds no user balances. `creditManager` is constructor-immutable; revenue legs are labeled by the frozen `SPORE_REVENUE_TREASURY` / `SPORE_REVENUE_VAULT` constants. |
| `script/Deploy.s.sol` | Deployment script (simulation-safe; see below). |

## Upgradeability tradeoff

v1 is deliberately **non-upgradeable**. Immutable contracts are auditable
as-deployed: what the auditor reviewed is exactly what runs, and there is no
upgrade-key centralization risk over user funds. The cost is real — a bug fix
requires redeployment and state migration, not a proxy swap — and the project
accepts it for v1 because this protocol holds user funds. Migration path:
versioned contracts (v2, v3…) plus a documented state-migration procedure;
never an in-place upgrade key.

## Trust assumptions

- **Oracle updater** (`ORACLE_UPDATER_ROLE`): publishes arbitrary scores and
  limits. Off-chain score engine (model v0.1, provisional, unvalidated) computes
  them; the chain only timestamps. Consumers must check freshness.
- **Underwriter** (`UNDERWRITER_ROLE`): issues lines, sets limits/fees,
  allowlists merchants, declares defaults, allocates yield. CreditManager's
  oracle gate (limits may not exceed the fresh oracle limit) constrains but
  does not eliminate this trust.
- **allocateYield keeper**: `BackerVault.allocateYield` (also underwriter-gated)
  directs accrued fee yield into specific agent pools. Discretionary by design.
- **Bootstrap mode**: `borrow` works with *no* oracle record yet (bootstrap),
  but once a record exists it must be fresh. A protocol can start before the
  oracle is live — know which mode you're in.
- **Wiring is NOT set-once (accepted admin-trust assumption)**: the wiring
  setters (`manager.setVault/setFeeRouter/setOracle/setRegistry`,
  `vault.setFeeRouter`, `router.setTreasury/setVault/setSplit`) remain callable
  by `DEFAULT_ADMIN_ROLE` after deploy — a compromised admin key could re-point
  the vault, router, or treasury. Accepted deliberately (spec review A2);
  mitigations: multisig admin, on-chain monitoring/alerting on every wiring
  change, timelock in a future version. Never leave `DEFAULT_ADMIN_ROLE` on a
  hot EOA long-term.
- **Pooled liquidity risk (fuzzer-found, invariant-tested)**: the vault's token
  balance is fungible across agents while encumbrance is per-agent — another
  agent's borrows can leave the vault short even when your stake is
  "unencumbered" per accounting. Withdrawals in that state revert with
  `Spore_InsufficientVaultBalance` (first-come-first-served, like any pooled
  lending vault at high utilization). `withdrawableFor` is an accounting view;
  actual withdrawal also requires vault liquidity.
- **Paused vs unpaused (`PAUSER_ROLE`)**: on `CreditManager`, pausing stops
  `issueLine`, `setLimit`, `borrow` — `repay` and `markDefaulted` stay open by
  design. On `BackerVault`, pausing stops `deposit`, `withdraw`, `fundBorrow` —
  `absorbDefault`, `receiveRepay`, `receiveYield` stay open by design. A pause
  must never trap a borrower in debt or freeze default resolution (see
  `DEPLOY.md` §4).

## Build / test

```shell
export PATH="$HOME/.foundry/bin:$PATH"
forge build        # must be green, zero warnings
forge test         # unit + invariant suites
forge snapshot     # gas snapshot -> snapshots/.gas-snapshot
forge script script/Deploy.s.sol   # dry-run simulation (no keys, no broadcast)
```

Deploy script parameters come from env (`ADMIN`, `UPDATER`, `TREASURY`, `ASSET`,
`TREASURY_BPS`, `MAX_STALE_PERIOD`) with local-simulation defaults. The real
ceremony — parameters, order, wiring, verification — is in `DEPLOY.md`.
