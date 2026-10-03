# SPORE Deployment Guide

Target chain: **Robinhood Chain (4663)**. Contracts are **not deployed yet**.
The addresses live in `CHAIN_CONFIG` (frontend `src/shared/chains.ts`) only once
they are real — never invent addresses.

> **The internal security review in this repo is NOT a substitute for the
> third-party audit required before real deposits.** It is a first-pass,
> self-assessment. Real user funds require an independent audit firm, a
> published report, and remediation of every finding above informational.

## 1. Pre-deployment checklist

Mirrors `docs/architecture.md`'s activation checklist (before any real deposits).
Every item must be checked before the ceremony:

1. **Real addresses in CHAIN_CONFIG** — contracts deployed; every address
   entered in CHAIN_CONFIG was code-reviewed against the actual deploy
   transaction receipts (block number, tx hash). Never invent or hand-type
   an address.
2. **Third-party audit** — independent audit completed, report published,
   all findings above informational remediated and re-verified. See the
   statement at the top of this file.
3. **Indexer backfill verified** — the event indexer (tracks `AgentRegistered`,
   `CreditIssued`, `Borrow`, `Repay`, `Default`, `Revenue`, `Payment`, `Sponsor`,
   `CreditLimitChanged`) is backfilled from the deployment block and verified
   against chain head. Spot-check reconstructed state against `getAgent` /
   `getLine` / `stakedFor` views.
4. **Oracle consistency checks** — the off-chain score engine's published
   `(score, limit)` pairs match what `ScoreOracle.getScore` returns, including
   `updatedAt` freshness semantics and `maxStalePeriod`. Publish a canary score
   for a test agentId and read it back before any underwriting.
5. **Incident runbook + pause procedure published** — the pause procedure in
   §4 below is documented, roles assigned to named operators (no single
   anonymous key), and the runbook is reachable during an incident.

Additional hard gates (repo-level):
- `forge build` zero warnings; full `forge test` green (unit + invariant).
- Deployment parameters (ADMIN, UPDATER, TREASURY, TREASURY_BPS,
  MAX_STALE_PERIOD, ASSET) reviewed and signed off — see §2.
- Asset decision final: either the production settlement token address or an
  explicit "testnet/mock asset" label. The script's in-script `ERC20Mock`
  deploy is **simulation only** and must never be presented as the real asset.

## 2. Deployment ceremony

Run by the deployer; every step is logged (tx hash, block, timestamp).

**Step 0 — Prepare.**
```shell
export PATH="$HOME/.foundry/bin:$PATH"
cd ~/workspace/spore/contracts
forge build        # green, zero warnings
forge test         # green
```
Set the ceremony parameters (example; production values decided at the real
ceremony, never the simulation defaults):
```shell
export ADMIN=0x...              # multisig / named operator
export UPDATER=0x...           # score-engine publisher key
export TREASURY=0x...          # treasury multisig
export ASSET=0x...             # production settlement token (unset = mock, sim only)
export TREASURY_BPS=2000       # 20% to treasury
export MAX_STALE_PERIOD=604800 # 7 days
```

**Step 1 — Dry run (simulation).** No keys, no broadcast:
```shell
forge script script/Deploy.s.sol
```
Confirm every `console.log` address and the wiring log lines. If anything
looks wrong, fix and re-run — this costs nothing.

**Step 2 — Broadcast deploy.** (Requires a working signer; note this repo's
foundry nightly has broken `--private-key` flags — use a Ledger/HWW or a
working forge version at ceremony time.)
```shell
forge script script/Deploy.s.sol --rpc-url <RH_RPC> --broadcast
```

**Step 3 — Verify the frozen deploy order.** The script deploys and wires in
this exact order; verify each from the broadcast logs:
1. `registry = new SporeRegistry(admin)`
2. `oracle = new ScoreOracle(admin, updater, maxStalePeriod)`
3. `manager = new CreditManager(asset, registry, oracle, admin, maxStalePeriod)`
4. `vault = new BackerVault(asset, registry, manager, admin)`
5. `router = new FeeRouter(asset, treasury, vault, manager, treasuryBps, admin)`
6. Wiring: `manager.setVault(vault)` → `manager.setFeeRouter(router)` →
   `vault.setFeeRouter(router)`

**Step 4 — Post-deploy verification (same session).**
- `manager.vault() == vault`, `manager.feeRouter() == router`,
  `vault`'s fee router set, `router.treasury() == TREASURY`,
  `router.treasuryBps() == TREASURY_BPS`.
- `oracle.maxStalePeriod() == MAX_STALE_PERIOD`.
- Grant roles: `UNDERWRITER_ROLE`, `PAUSER_ROLE` to named operators
  (not the deployer EOA long-term). Renounce or transfer `DEFAULT_ADMIN_ROLE`
  per the governance plan.
- Publish the canary score; read it back (checklist item 4).
- Enter real addresses in CHAIN_CONFIG with code review (checklist item 1).

**Step 5 — Activate.** Only after all five checklist items are green: allow
deposits, publish the incident runbook, announce.

## 3. Environment variables (script inputs)

| Var | Meaning | Default (simulation) |
|---|---|---|
| `ADMIN` | admin for all contracts | `address(1)` |
| `UPDATER` | `ORACLE_UPDATER_ROLE` holder | `address(2)` |
| `TREASURY` | fee-split treasury recipient | `address(3)` |
| `ASSET` | settlement token; if unset the script deploys a fresh `ERC20Mock` labeled simulation-only | unset → mock |
| `TREASURY_BPS` | treasury share of each fee, basis points | `2000` (20%) |
| `MAX_STALE_PERIOD` | oracle freshness window, seconds | `604800` (7 days) |

Production values are set at the real ceremony — the defaults are placeholders
for local simulation only.

## 4. Pause procedure

**Who can pause what:**
- `PAUSER_ROLE` (named operator, ideally a multisig or a 2-of-3) can
  `pause()` / `unpause()` on `CreditManager` and `BackerVault`.
- `DEFAULT_ADMIN_ROLE` assigns `PAUSER_ROLE`. The deployer should not hold
  `PAUSER_ROLE` long-term.

**What pausing stops:**
- `CreditManager`: `issueLine`, `setLimit`, `borrow` — no new credit or
  draws while paused.
- `BackerVault`: `deposit`, `withdraw`, `fundBorrow` — no stake movement
  and no borrow funding while paused.

**What pausing NEVER stops (by design):**
- `CreditManager.repay` — anyone may always repay. A pause must never trap a
  borrower in debt or prevent a good-faith payoff.
- `CreditManager.markDefaulted` / `BackerVault.absorbDefault` — loss
  absorption must always be executable so bad debt is recognized and
  contained, not frozen.
- `BackerVault.receiveRepay`, `BackerVault.receiveYield` — resolution and
  fee flows stay open.

Rationale: pausing is for containing an active exploit or a broken dependency
(bad oracle, compromised underwriter). It must never block the functions that
reduce protocol risk: repayment and default resolution.

**Incident runbook (minimum):**
1. PAUSER holder calls `pause()` on manager and vault; announce immediately.
2. Assess: which function is misbehaving, which funds are at risk.
3. `absorbDefault` any lines that need it; users keep `repay` access.
4. Fix or migrate (v1 is non-upgradeable — the fix path is redeploy +
   state migration, never a proxy swap).
5. Post-mortem published before unpausing or reactivating.

## 5. Wiring is not set-once (accepted admin-trust assumption)

The wiring setters (`manager.setVault/setFeeRouter/setOracle/setRegistry`,
`vault.setFeeRouter`, `router.setTreasury/setVault/setSplit`) remain callable
by `DEFAULT_ADMIN_ROLE` after the ceremony — this is a deliberate spec decision
(spec review A2), not an oversight. A compromised admin key could re-point the
vault, fee router, oracle, or treasury mid-operation. Mitigations, all required
before real deposits:
- `DEFAULT_ADMIN_ROLE` held by a multisig (never a hot EOA long-term);
- on-chain monitoring/alerting on every wiring-setter call;
- timelock on admin actions in a future version.

The deploy script performs the initial wiring; any later wiring change is a
governance event and must be announced.
