# LANE 7 — Security Checklist (systematic analysis, 2026-10-03)

## A. Reentrancy
- Every external entry point that (a) changes state and (b) calls an untrusted/external contract (ERC-20 transfer, router, oracle callback) must follow Checks-Effects-Interactions and/or carry `nonReentrant`.
- ERC-20 tokens can be malicious (fee-on-transfer, reentrant callbacks via ERC-777 style hooks — here plain ERC-20, but callback surface exists through any token with hooks).
- `CreditManager.borrow`: external call is vault.fundBorrow (trusted contract) + merchant transfer inside vault. Not reentrant across trust boundary IF vault is the only callee; still recommend nonReentrant.
- `CreditManager.repay`: pulls fee portion → FeeRouter.collectFee → router splits: ERC-20 transfer to treasury + vault.receiveYield (trusted). ERC-20 transfer is an external call — reentrancy into repay must be blocked. MUST be nonReentrant.
- `BackerVault.deposit/withdraw`: ERC-20 transferIn/out. deposit: transferFrom external before/after state update — CEI (update shares first, then pull). withdraw: MUST update state before sending tokens. nonReentrant recommended.
- `BackerVault.absorbDefault`: calls CreditManager.markDefaulted (external, trusted) while state changes. No user funds move; reentrancy into absorbDefault must revert (line already defaulted) — but still guard.
- `FeeRouter.collectFee`: transfers to treasury and vault. nonReentrant; also must guarantee it never holds a balance after the call (full split, no dust retained).

## B. Access control
- Every state-changing function needs a role: UNDERWRITER_ROLE / PAUSER_ROLE / DEFAULT_ADMIN_ROLE / trusted-contract-only (onlyVault/onlyManager/onlyRouter).
- Admin powers must be enumerable: role grant/revoke via AccessControl (documented), pause/unpause, setters (setVault, setOracle, etc.), merchant allowlist, split, treasury, maxStalePeriod.
- No missing onlyRole on: issueLine, setLimit, closeLine, setMerchantAllowed, absorbDefault, allocateYield, publishScore, setSplit, setTreasury, pause.
- Wiring setters (setVault/setOracle/setRouter/setRegistry) must be DEFAULT_ADMIN_ROLE and emit events. Risk: setter can be called at any time to point at a malicious contract — consider set-once guard; at minimum document.
- Check no `onlyOwner` leftovers; spec says AccessControl.

## C. Pausable coverage
- repay and absorbDefault MUST stay unpaused (debt service and loss absorption must work under pause).
- Pause should block: issueLine, borrow, deposit (new risk), setLimit raises, allocateYield? — allocateYield is admin; keep simple: pause blocks user-facing risk-increasing entry points only.
- Verify whenPaused modifiers present on the right functions, absent on repay/absorbDefault.

## D. Oracle trust
- publishScore only ORACLE_UPDATER_ROLE (trusted — arbitrary scores possible; documented, acceptable).
- Score sanity: score <= 1000 (else Spore_InvalidScore), limit reasonable.
- Stale data: CreditManager.borrow must check oracle.isFresh when score data exists. Bootstrap mode: no oracle record yet → borrow allowed (documented trust point — an underwriter could issue a line before any score exists; the risk is mitigated by underwriter gating, but the NatSpec must say it).
- Oracle maxStalePeriod setter access-controlled.

## E. Share-pool rounding (vault)
- Vault uses share accounting per agent? (per the interface, deposit/withdraw are per-agent; stakedFor(agentId, backer)). If there are ERC-20-style shares, rounding must favor the pool on withdraw: assets = shares * poolAssets / totalShares rounded DOWN.
- Division by zero: first deposit when totalShares == 0 or poolAssets == 0 → 1:1 mint. Every division needs a zero-denominator guard.

## F. Front-running / first-depositor share inflation
- If vault mints shares per agent pool: first depositor could inflate share price by donating. Mitigations: 1:1 on empty pool, virtual shares/assets (ERC-4626-style offset), or per-agent pools with same. Check the math. A donation attack to the vault is the classic; since pools are per-agent and backers share them, check for virtual offset or dead shares.

## G. DoS vectors
- No unbounded loops anywhere. Borrow/repay/default must be O(1). Merchant allowlist is a mapping (no enumeration). Check no arrays iterated per-agent.

## H. Integer edge cases
- Division by zero: poolAssets/totalShares == 0; feeBps math (amount * feeBps / 10000 — overflow impossible in 256-bit for realistic amounts, but use mulDiv-safe ordering).
- feeBps cap: issueLine must enforce feeBps <= MAX (Spore_FeeBpsTooHigh). MAX value? Must be < 10000 (100% would confiscate). Recommend cap like 2500 (25%) — flag if unbounded or 10000.
- Underflow on repay when amount > outstanding: must cap or revert; fee-first ordering.
- limit decrease below drawn: setLimit must allow decrease? If newLimit < drawn, borrows blocked but line stays — fine, but must not allow borrow to exceed. Check.

## I. Fee accounting — no dust
- FeeRouter must split the FULL amount: treasury = amount * treasuryBps / 10000; vault gets amount - treasury (remainder to vault, not dropped). Router balance after collectFee == 0.
- CreditManager.repay: feePortion = min(feeOwed, amount); principal = amount - feePortion. Sum must equal amount; no dust locked in manager.
- Vault receiveYield accrues to yieldReserve; allocateYield moves to agent pool — totals must reconcile.

## J. Event completeness (frozen names/signatures)
- Every state change emits the frozen event: AgentRegistered, CreditIssued, Borrow, Repay, Default, Revenue, Payment, Sponsor, CreditLimitChanged, YieldAllocated.
- Check parameter order matches ISpore.sol exactly. Note: interface files define events; implementations must reference the same definitions (import from ISpore.sol).
- borrow emits BOTH Borrow and Payment. repay emits Repay. markDefaulted path emits Default. collectFee emits Revenue per leg. deposit emits Sponsor. allocateYield emits YieldAllocated. setLimit emits CreditLimitChanged.

## K. Cross-contract trust NatSpec
- Oracle updater is trusted (arbitrary scores) — in IScoreOracle + ScoreOracle + CreditManager borrow NatSpec.
- Underwriter sets limits (can exceed oracle? — check: setLimit/issueLine must enforce <= oracle limit while fresh; bootstrap exception documented).
- allocateYield is a keeper/underwriter decision (discretionary allocation of yieldReserve across agent pools — documented as trust point).
- Router trusts the manager (onlyCreditManager on collectFee).

## L. Miscellaneous
- ERC-20 safe transfers: use SafeERC20 (OZ v5) for all token ops; handle non-standard returns.
- Pull over push where users are involved; merchant payment is push by design (purpose-bound) — merchant is allowlisted, acceptable.
- timestamp usage: uint64 casts — block.timestamp fits for millennia; fine.
- No tx.origin. No delegatecall. No selfdestruct.
- Constructor/initializer wiring: immutable where possible (vault/manager/router/oracle addresses set once). If setters exist, they must be admin-only.
- ERC-20 decimals: share math should not assume 18 decimals.
- Fee-on-transfer tokens: settlement asset should be assumed standard; note the assumption in NatSpec (or handle via balance-diff). Recommend documenting that the settlement asset must be a standard ERC-20.

## M. Spec-amendment verification (2026-10-03 ~13:23 IST)

Verified each amended item against implementations:
1. Pause coverage: manager pauses issueLine/setLimit/borrow ✓ (Pausable); repay/markDefaulted/closeLine unpaused ✓. Vault pauses deposit/withdraw ✓ but fundBorrow NOT paused ✗ (FINDING). absorbDefault/receiveRepay/receiveYield unpaused ✓.
2. New errors: Spore_DefaultMismatch never raised ✗; Spore_NothingToDefault never raised ✗ (FINDINGS).
3. issueLine terminal-default check missing ✗ (FINDING).
4. markDefaulted: no mismatch check; active stays true ✗ (FINDING).
5. setLimit: gates decreases too; reverts on 0 ✗ (FINDING).
6. repay overpayment refund ✓ already correct.
7. MAX_FEE_BPS=2000 ✓ value, but duplicate declaration breaks compile ✗ (FINDING).
8. Vault views: poolAssets ✓, totalShares ✓, asset ✓ (type fix needed), sharesOf MISSING ✗ (FINDING). pool-accounting NatSpec ✓. Zero-amount policy gaps ✗ (FINDING).
9. FeeRouter: asset()/creditManager() ✓; emits use string literals, not the frozen constants ✗ (MINOR).
10. ScoreOracle: getScore reverts ✓; isFresh returns false ✓; unregistered-agent publish allowed ✓.
11. Wiring setters: admin-trust assumption NOT documented in CreditManager NatSpec (still says "prefer set-once") ✗ (MINOR); zero-input reverts ✓ everywhere.
12. Registry role map ✓ matches frozen.

New issue found during review: availableToBorrow() underflows (reverts) when limit < drawn — the amended spec explicitly allows limit decreases below drawn, making this a live view-DoS (FINDING, MAJOR).
Also: freshness authority — amended spec declares the MANAGER's maxStalePeriod authoritative for borrow/issueLine/setLimit, but the implementation defers to oracle.isFresh() and documents its own window as "informational" (FINDING, MAJOR).
