# Score engine — model v0.1 reference implementation (frozen by coordinator)

Implements `docs/scoring.md` model v0.1 EXACTLY as specified there, plus the
dimension-score functions below. scoring.md defines weights, bands, and the
limit ladder but leaves normalization curves to the implementation — this
document IS the versioned normalization spec. It is provisional and
unvalidated, like the model itself. Model version recorded on-chain: **1**.

## Master formula

```
score = Σ (weight_d × dimScore_d), weights sum to 1.0
```

Weights (from scoring.md):
d1 repayment history 0.20 | d2 punctuality 0.12 | d3 utilization 0.10 |
d4 revenue consistency 0.08 | d5 revenue growth 0.05 (future, locked 0) |
d6 agent age 0.05 | d7 identity continuity 0.06 | d8 cross-chain 0.05 |
d9 payment volume 0.08 | d10 default history 0.10 |
d11 sponsor quality 0.06 (future, locked 0) | d12 concentration 0.05

Maximum attainable under v0.1: **890** (futures contribute 0). Round the
final score to the nearest integer.

## Bands (from scoring.md)

- VERY LOW: score ≥ 800
- LOW: 650–799
- MODERATE: 500–649
- ELEVATED: 300–499
- HIGH: score < 300

## Limit ladder (from scoring.md) → base units

- VERY LOW → 500 units | LOW → 250 | MODERATE → 100 | ELEVATED → 25 | HIGH → 0
(Units = whole asset units; the publisher converts to base units with the
asset's decimals. The "$" in scoring.md is a USD-stablecoin display
convention.)

## Dimension-score functions (all return 0–1000, integer)

Conventions: amounts in base units; "30-day term" is the v0.1 punctuality
convention (documented assumption — contracts v1 have no on-chain due dates).

- **d1 repayment history:** `repaid_principal / borrowed_principal × 1000`,
  capped at 1000. No borrows → **400** (thin history, not zero, not full).
- **d2 punctuality:** a borrow counts on-time if its principal is fully repaid
  within 30 days of the borrow's block_time (FIFO matching of repays to
  borrows). Score = on-time borrows / total borrows × 1000. No completed
  borrows → **500**.
- **d3 utilization:** current `drawn / line_limit`; score =
  `(1 − utilization) × 1000`. No active line → **500**. Utilization > 1
  impossible (contract-enforced); clamp anyway.
- **d4 revenue consistency:** proxy = Payment (settlement) volume stability.
  Split the last 90 days into three 30-day windows; let v₁,v₂,v₃ be volumes.
  If total = 0 → **300**. Else cv = stddev/mean; score =
  `max(0, 1000 − cv × 1000)`. (Documented proxy: v1 has no agent-revenue
  events; settlement volume is the observable flow.)
- **d5 revenue growth:** future → **0** (locked).
- **d6 agent age:** `min(days_since_registration / 365, 1) × 1000`.
- **d7 identity continuity:** v1 has no owner-change events (gap in EVENT_MAPPING).
  Active agent → **1000**; deactivated → **500**. (Documented limitation.)
- **d8 cross-chain activity:** v1 indexes one chain → **300** for every agent.
  (Documented limitation; rises when more chains are indexed.)
- **d9 payment volume:** total Payment volume V (whole units):
  `min(V / 10000, 1) × 1000`.
- **d10 default history:** 0 defaults → **1000**; else
  `max(0, 1000 − 400 × default_count)`.
- **d11 sponsor quality:** future → **0** (locked).
- **d12 concentration risk:** share s of payment volume with the largest single
  merchant; score = `(1 − s) × 1000`. No payments → **500**.

## Parity rule (hard)

The frontend score lab (`apps/web/.../ScoreLab.tsx`) takes dimension scores
as slider inputs and applies weights → bands → ladder. The engine MUST
produce identical final score/band/limit for identical dimension inputs.
Lane 8's parity test asserts this on fixed vectors, including:
`all-1000 → 890 / VERY LOW / 500`, `all-0 → 0 / HIGH / 0`,
futures nonzero inputs are ignored (forced to 0).

## Engine behavior

- Batch job, runs on a schedule (default every 10 min) and on demand
  (`POST /internal/run` on a localhost-only admin port — never public).
- Reads indexed tables only; writes `scores` (upsert) + appends
  `score_history` ONLY when the score changed since the last run (avoid
  chart spam).
- Never publishes on-chain — that's the oracle publisher's job.
- Logs model version + input snapshot hash per run for auditability.
