# Event → table mapping (frozen by coordinator)

Source of truth: `contracts/src/interfaces/ISpore.sol`. Event names and
signatures MUST match it exactly. All handlers are idempotent:
`INSERT ... ON CONFLICT (tx_hash, log_index) DO NOTHING`, and state-table
upserts are written so replaying the same log twice yields the same row.

Handler rule per event (all in one DB transaction per log: event row +
state updates + sync_state cursor advance):

**Idempotency rule (hard):** the event-row INSERT MUST use
`INSERT ... ON CONFLICT (tx_hash, log_index) DO NOTHING`, and ALL state
updates for that log MUST be gated on the insert actually inserting a row
(`rowCount > 0`). If the insert was a conflict no-op, skip every state
update for that log and return. Rationale: incremental updates
(`drawn += amount`) are not naturally idempotent — without the gate, a
replayed log (crash mid-batch, overlapping poll windows, two indexers)
would double-count. Set-based upserts (agents, credit_lines on
CreditIssued) are naturally replay-safe and need no gate, but apply the
gate uniformly anyway — it costs nothing.

| Event | Event-table row | State updates |
|---|---|---|
| `AgentRegistered(agentId, owner, metadataURI)` | — (agents IS the record) | upsert `agents`: owner, metadata_uri, active=true, registered_at=block_time |
| `CreditIssued(agentId, limit, feeBps)` | — | upsert `credit_lines`: line_limit=limit, fee_bps=feeBps, drawn=0, fee_owed=0, active=true, defaulted=false, issued_at=block_time |
| `Borrow(agentId, amount, fee)` | `borrows` (merchant unknown here) | `credit_lines`: drawn += amount, fee_owed += fee |
| `Payment(agentId, merchant, amount)` | `payments` | none (informational; joins to borrows by tx_hash for merchant attribution) |
| `Repay(agentId, payer, amount, feePortion)` | `repays` | `credit_lines`: fee_owed = max(0, fee_owed − feePortion); drawn = max(0, drawn − (amount − feePortion)) |
| `Default(agentId, drawnAmount, coveredAmount, shortfall)` | `defaults` | `credit_lines`: drawn=0, fee_owed=0, active=false, defaulted=true (terminal — never re-issued) |
| `Sponsor(agentId, backer, amount)` | `sponsors` | none (deposits-only; see gap W1) |
| `Revenue(recipient, amount, kind)` | `revenues` (kind decoded: `0x7472…` → `treasury`, `0x6261…` → `backer-yield`; unknown → hex string) | none |
| `CreditLimitChanged(agentId, oldLimit, newLimit)` | `credit_limit_changes` | `credit_lines`: line_limit=newLimit |
| `YieldAllocated(agentId, amount)` | `yield_allocations` | none |

Derived `credit_lines` correctness notes:
- Borrow and Payment are emitted in the same transaction (borrow → fundBorrow
  → merchant transfer). The indexer links them by `(tx_hash)` for merchant
  attribution on the borrow row; if a Payment is missing (shouldn't happen),
  the borrow row stays with merchant NULL — never drop the borrow.
- Overpayment refunds: Repay's `amount` is the gross paid; principal reduction
  is `amount − feePortion`. State math above matches the contract waterfall
  (fee first, then principal).

## Known event gaps (contracts v1 — documented, not fixed here)

- **G1 `closeLine` emits no event.** The indexer cannot see line closures from
  logs. Mitigation (frozen): a reconciliation job (indexer lane) calls
  `CreditManager.getLine(agentId)` for every agent with an active line on a
  configurable interval (default 10 min) and corrects `credit_lines`
  (active=false on closed lines). Reconciliation writes are plain updates —
  they never fabricate event rows.
- **W1 `withdraw` emits no event.** Backer stake balances in `sponsors` are
  deposits-only. The API MUST label stake figures as "vouched (deposits)" and
  never as current balances. A future contract version should emit
  `Withdrawal`; until then, no withdrawal accounting.
- **`setAgentOwner` / `deactivateAgent` / `setMerchantAllowed` emit no events.**
  Identity-continuity scoring uses registration data only (see
  docs/SCORING_IMPL.md). Merchant allowlist changes are not tracked in v1.

## Reorg policy (frozen)

- The indexer only processes blocks up to `head − CONFIRMATIONS`
  (default 12; configurable; local anvil may use 1).
- Before advancing past a checkpoint, it verifies the stored `last_hash`
  equals the chain's block hash at `last_block`. Mismatch ⇒ reorg deeper
  than CONFIRMATIONS ⇒ **full rebuild**: truncate all chain-derived tables,
  reset `sync_state` to `deploy_block`, and re-backfill. `scores` /
  `score_history` are kept (they're engine outputs, re-derived anyway).
- Within-CONFIRMATIONS reorgs never touch processed data by construction.

## Backfill

On first boot (`sync_state.last_block = 0`), backfill from `deploy_block`
(the block the contracts were deployed in — from the local deploy output or
env `DEPLOY_BLOCK`) to `head − CONFIRMATIONS` in chunked
`eth_getLogs` ranges (default 2,000 blocks/chunk, configurable).
