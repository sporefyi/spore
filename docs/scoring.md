# SPORE Credit Score — Model Specification

The SPORE credit score is a single number that summarizes what an agent's
on-chain record says about its ability and willingness to repay credit.
It exists to price agent credit, not to judge agents.

**Status: experimental.** The score formula is specified here. The model has
not been validated against real repayment outcomes, and the SPORE contracts
are not deployed yet — so no live scores exist. Everything in this document
that describes behavior is provisional.

## Range and calculation

The score runs **0–1000**. Higher is better.

Each of the twelve dimensions below produces a dimension score of 0–1000.
The final score is the weighted sum:

```
score = Σ (weight_d × dimension_score_d), weights sum to 1.0
```

Dimension scores are normalized so that, for example, a repayment history
with zero defaults scores near 1000, and one with recent defaults scores
well under 500. Exact normalization curves per dimension are versioned with
the model and will be published alongside it.

## The twelve dimensions

Kinds: **observed** — measured directly from chain data; **derived** — a
risk indicator computed from observed data; **future** — defined but not
scored yet; carries no weight until the model can measure it honestly.

| # | Dimension | Weight | Kind | What it measures |
|---|-----------|--------|------|------------------|
| 1 | Repayment history | 20% | observed | Share of borrowed credit repaid in full, across all loans |
| 2 | Repayment punctuality | 12% | observed | How often repayments arrive on or before the due date |
| 3 | Credit utilization | 10% | observed | Outstanding credit drawn relative to the current limit |
| 4 | Revenue consistency | 8% | derived | Stability of on-chain revenue across rolling 90-day windows |
| 5 | Revenue growth | 5% | future | Direction of the revenue trend — not scored yet |
| 6 | Agent age | 5% | observed | Days since first observed on-chain activity |
| 7 | Identity continuity | 6% | derived | One stable identity vs. rotating keys |
| 8 | Cross-chain activity | 5% | observed | Number of chains with verifiable activity |
| 9 | Payment volume | 8% | observed | Total value settled across all observed transactions |
| 10 | Default history | 10% | observed | Count and recency of missed or written-off obligations |
| 11 | Sponsor / backer quality | 6% | future | Track record of the agent's sponsors — not scored yet |
| 12 | Concentration risk | 5% | derived | How much revenue or credit sits with a single counterparty |

Weights sum to 100%.

Why the weights are shaped this way: repayment behavior (dimensions 1, 2, 10,
42% combined) is the closest thing to evidence of creditworthiness, so it
dominates. Capacity measures (3, 4, 9) and longevity/identity signals (6, 7,
8) temper it. The two future dimensions are reserved weight for signals the
model cannot measure yet rather than pretending it can.

## What the kinds mean — and what they don't

- **Observed metrics** are read directly from chain data. They are facts
  about what happened, not judgments.
- **Derived risk indicators** combine observed data into a view of risk —
  e.g. revenue consistency is computed from payment events. The derivation
  rules are published with the model version; the indicator is not a
  prediction.
- **Future model outputs** are placeholders. A dimension labeled *future*
  contributes zero weight today. It will be scored only when there is a
  defined, measurable rule for it.

A hard rule: **SPORE does not publish default probabilities.** A score of 782
is not "a 7% chance of default" — it is a score of 782. No probability is
published without a validated model behind it, and no such model exists yet.

## Risk bands (provisional)

| Band | Score | Meaning |
|------|-------|---------|
| VERY LOW | 800+ | Track record supports large limits |
| LOW | 650–799 | Solid history, routine monitoring |
| MODERATE | 500–649 | Thin or mixed history, conservative limits |
| ELEVATED | 300–499 | Weak signals or past trouble, small limits |
| HIGH | below 300 | Not creditworthy under current evidence |

Band boundaries are provisional and will move once there is real repayment
data to calibrate against.

## Credit limit ladder (provisional)

Each band maps to a maximum credit limit:

| Band | Suggested max limit |
|------|---------------------|
| VERY LOW | up to $500 |
| LOW | up to $250 |
| MODERATE | up to $100 |
| ELEVATED | up to $25 |
| HIGH | $0 |

The ladder is provisional. Limits are also bounded by purpose-bound routing:
credit is spendable only at integrated merchants, regardless of band.

## Data sources

Every input comes from on-chain observation: credit pool borrow/repay
events, payment settlement events, ERC-8004 identity registrations, and
first-activity timestamps across configured chains. There is no off-chain
data, no self-reported revenue, and no third-party bureau feed.

## What the score is NOT

- **Not audited.** No independent party has reviewed this specification or
  any implementation of it.
- **Not validated.** The model's predictive power has not been tested
  against real repayment outcomes. Dimensions are model inputs, not
  validated credit predictors.
- **Not a guarantee.** A high score does not guarantee repayment, and a low
  score is not proof of bad faith — it may only mean thin history.
- **Not live.** Until SPORE contracts deploy, no agent has a real score.
  Any score shown in a demo environment is fixture data and is labeled as
  such.

## Versioning

This specification is model version **0.1**. Dimension definitions, weights,
band boundaries, and the limit ladder are all expected to change. Changes
are versioned; passports record the model version and run timestamp of the
score they display.
