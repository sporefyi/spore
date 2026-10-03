// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ISpore — Frozen external interfaces for the SPORE credit protocol v1
/// @notice This file is the integration contract for all implementation lanes.
///         Event names and signatures MUST match docs/architecture.md exactly:
///         AgentRegistered, CreditIssued, Borrow, Repay, Default, Revenue,
///         Payment, Sponsor, CreditLimitChanged.
/// @dev Trust assumptions are called out inline. v1 is intentionally NOT
///      upgradeable (see contracts/README.md for the tradeoff note).

/*//////////////////////////////////////////////////////////////
                            SHARED TYPES
//////////////////////////////////////////////////////////////*/

/// @notice On-chain passport record for one autonomous agent.
struct AgentRecord {
    address owner;        // controller authorized to act for the agent (borrow, metadata)
    string metadataURI;   // off-chain passport dossier (JSON)
    bool active;          // false = deactivated; no new lines, no borrows
    uint64 registeredAt;  // block.timestamp at registration
}

/// @notice A single credit line extended to one agent.
struct CreditLine {
    uint256 limit;       // max outstanding principal allowed
    uint256 drawn;       // outstanding principal currently borrowed
    uint256 feeOwed;     // accrued fee not yet repaid
    uint16 feeBps;       // fee rate in basis points, fixed at issuance
    uint64 issuedAt;     // block.timestamp at issuance
    bool active;         // false = never issued or closed
    bool defaulted;      // true = written down via markDefaulted; terminal
}

/// @notice One published credit assessment for an agent.
/// @dev Scores are COMPUTED OFF-CHAIN by the score engine per docs/scoring.md
///      (model v0.1, provisional, unvalidated). The oracle only publishes and
///      timestamps them. The ORACLE_UPDATER_ROLE is a trusted role — this is
///      NOT trustless, and the contracts do not pretend otherwise.
struct ScoreData {
    uint16 score;        // 0..1000 per docs/scoring.md
    uint256 limit;       // suggested max credit limit in asset units
    uint64 updatedAt;    // block.timestamp of publication
    uint8 modelVersion;  // scoring model version that produced this score
}

/*//////////////////////////////////////////////////////////////
                        ARCHITECTURE EVENTS
            (names/signatures frozen — the indexer depends on these)
//////////////////////////////////////////////////////////////*/

/// @notice Emitted by SporeRegistry.registerAgent.
event AgentRegistered(uint256 indexed agentId, address indexed owner, string metadataURI);

/// @notice Emitted by CreditManager.issueLine.
event CreditIssued(uint256 indexed agentId, uint256 limit, uint256 feeBps);

/// @notice Emitted by CreditManager.borrow — credit drawn against the line.
event Borrow(uint256 indexed agentId, uint256 amount, uint256 fee);

/// @notice Emitted by CreditManager.repay. feePortion is routed to the FeeRouter.
event Repay(uint256 indexed agentId, address indexed payer, uint256 amount, uint256 feePortion);

/// @notice Emitted by CreditManager.markDefaulted (called only by BackerVault).
/// @param coveredAmount Portion of drawn principal absorbed by vouched stake.
/// @param shortfall Uncovered remainder — recorded as protocol bad debt.
event Default(
    uint256 indexed agentId, uint256 drawnAmount, uint256 coveredAmount, uint256 shortfall
);

/// @notice Emitted by FeeRouter.collectFee for each revenue split leg.
event Revenue(address indexed recipient, uint256 amount, bytes32 indexed kind);

/// @notice Emitted by CreditManager.borrow — funds settled to the merchant.
/// @dev Purpose-bound routing: credit is spendable only at allowed merchants.
event Payment(uint256 indexed agentId, address indexed merchant, uint256 amount);

/// @notice Emitted by BackerVault.deposit — a backer vouches stake behind an agent.
event Sponsor(uint256 indexed agentId, address indexed backer, uint256 amount);

/// @notice Emitted by CreditManager.setLimit.
event CreditLimitChanged(uint256 indexed agentId, uint256 oldLimit, uint256 newLimit);

/// @notice Emitted by BackerVault.allocateYield.
event YieldAllocated(uint256 indexed agentId, uint256 amount);

// Revenue leg identifiers (frozen for the indexer).
// FeeRouter.collectFee emits one Revenue event per non-zero leg;
// zero-value legs are skipped (no transfer, no event).
// Hex literals keep forge-lint's unsafe-typecast rule quiet (no string cast).
bytes32 constant SPORE_REVENUE_TREASURY = 0x7472656173757279000000000000000000000000000000000000000000000000; // "treasury"
bytes32 constant SPORE_REVENUE_VAULT = 0x6261636b65722d7969656c640000000000000000000000000000000000000000; // "backer-yield"

/*//////////////////////////////////////////////////////////////
                           CUSTOM ERRORS
//////////////////////////////////////////////////////////////*/

error Spore_ZeroAmount();
error Spore_ZeroAddress();
error Spore_AgentNotFound(uint256 agentId);
error Spore_AgentNotActive(uint256 agentId);
error Spore_NotAgentOwner(uint256 agentId, address caller);
error Spore_LineAlreadyActive(uint256 agentId);
error Spore_NoActiveLine(uint256 agentId);
error Spore_LineDefaulted(uint256 agentId);
error Spore_ExceedsLimit(uint256 agentId, uint256 requested, uint256 available);
error Spore_ExceedsOracleLimit(uint256 agentId, uint256 requested, uint256 oracleLimit);
error Spore_MerchantNotAllowed(address merchant);
error Spore_StaleOracleData(uint256 agentId, uint64 updatedAt);
error Spore_NoOracleData(uint256 agentId);
error Spore_InvalidScore(uint16 score);
error Spore_InsufficientStake(uint256 agentId, address backer, uint256 requested, uint256 available);
error Spore_StakeEncumbered(uint256 agentId, address backer, uint256 requested, uint256 withdrawable);
error Spore_OnlyCreditManager(address caller);
error Spore_OnlyBackerVault(address caller);
error Spore_FeeBpsTooHigh(uint16 feeBps);
error Spore_SplitBpsInvalid(uint16 treasuryBps);
error Spore_LineHasDebt(uint256 agentId, uint256 drawn);
error Spore_DefaultMismatch(uint256 agentId, uint256 drawn, uint256 covered, uint256 shortfall);
error Spore_NothingToDefault(uint256 agentId);

/*//////////////////////////////////////////////////////////////
                            INTERFACES
//////////////////////////////////////////////////////////////*/

/// @title SporeRegistry — agent passport registry
/// @notice Issues stable on-chain identities (agentIds) for autonomous agents.
///         An agentId is required before any credit line can exist.
/// @dev Role map (frozen):
///      - permissionless: registerAgent (owner = msg.sender; sybil registration
///        is harmless — credit is underwritten, identity is not scarce)
///      - agent owner OR OPERATOR_ROLE: setMetadataURI
///      - current owner OR DEFAULT_ADMIN_ROLE: setAgentOwner
///      - OPERATOR_ROLE: deactivateAgent, reactivateAgent
interface ISporeRegistry {
    function registerAgent(string calldata metadataURI) external returns (uint256 agentId);
    function setMetadataURI(uint256 agentId, string calldata metadataURI) external;
    function setAgentOwner(uint256 agentId, address newOwner) external;
    function deactivateAgent(uint256 agentId) external;
    function reactivateAgent(uint256 agentId) external;

    function getAgent(uint256 agentId) external view returns (AgentRecord memory);
    function agentCount() external view returns (uint256);
    function isActiveAgent(uint256 agentId) external view returns (bool);
    function agentOwner(uint256 agentId) external view returns (address);
}

/// @title CreditManager — credit line lifecycle
/// @notice Issues and services purpose-bound credit lines. Borrowed funds are
///         disbursed DIRECTLY to an allowlisted merchant — never to the agent —
///         which is what makes the credit purpose-bound. Liquidity comes from
///         the BackerVault; fees are routed to the FeeRouter.
/// @dev TRUST: UNDERWRITER_ROLE sets limits/fees and allowlists merchants.
///      ORACLE-gated: new lines and limit raises may not exceed the oracle's
///      published limit for the agent while that data is fresh.
/// @dev Zero-amount policy (frozen): issueLine with limit == 0 reverts
///      Spore_ZeroAmount; borrow/repay with amount == 0 revert Spore_ZeroAmount;
///      setLimit allows 0 (freeze).
interface ICreditManager {
    // --- roles (OpenZeppelin AccessControl) ---
    // UNDERWRITER_ROLE: issueLine, setLimit, closeLine, setMerchantAllowed
    // PAUSER_ROLE:      pause/unpause
    // DEFAULT_ADMIN_ROLE: role admin, wiring setters

    /// @dev Fee-rate policy (frozen): per-line feeBps is capped at 2000 (20%) —
    ///      exposed as public constant MAX_FEE_BPS on the implementation.
    ///      feeBps == 0 is allowed.

    /// @notice Issue a credit line. Reverts Spore_LineAlreadyActive if a line
    ///         exists; reverts Spore_LineDefaulted if the line was EVER
    ///         defaulted — default is terminal, a line can never be re-issued.
    function issueLine(uint256 agentId, uint256 limit, uint16 feeBps) external;
    /// @notice Change a line's limit. The oracle gate applies ONLY when
    ///         newLimit exceeds the current limit — decreases (including to 0
    ///         = freeze) are always allowed, even on stale oracle data.
    ///         Reverts Spore_LineDefaulted on defaulted lines.
    function setLimit(uint256 agentId, uint256 newLimit) external;
    function closeLine(uint256 agentId) external;

    /// @notice Draw credit; funds go straight to `merchant`.
    /// @dev Caller must be the agent's registered owner. Requires fresh
    ///      oracle data OR no oracle record yet (bootstrap mode, documented).
    function borrow(uint256 agentId, uint256 amount, address merchant) external;

    /// @notice Repay outstanding debt. Anyone may pay. Fee portion is covered
    ///         first and forwarded to the FeeRouter; the rest reduces principal.
    /// @dev Overpayment (amount > drawn + feeOwed) is NOT a revert: the excess
    ///      is refunded to the payer. Repayment waterfall: fee first, then principal.
    function repay(uint256 agentId, uint256 amount) external;

    /// @notice Write a line down as defaulted. ONLY callable by the BackerVault,
    ///         which absorbs the loss from vouched stake atomically in the same flow.
    /// @dev Reverts Spore_DefaultMismatch unless coveredAmount + shortfall == line.drawn.
    ///      On success: drawn = 0, feeOwed = 0 (accrued fees are written off, not
    ///      counted in badDebt), defaulted = true, active = false.
    function markDefaulted(uint256 agentId, uint256 coveredAmount, uint256 shortfall) external;

    // --- emergency controls (PAUSER_ROLE) ---
    // Paused: issueLine, setLimit, borrow. NOT paused by design: repay and
    // markDefaulted — users must always be able to repay, and defaults must
    // always be resolvable. See DEPLOY.md pause procedure.
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);

    // --- wiring (admin, documented; prefer set-once at deploy) ---
    // TRUST (accepted admin-trust assumption, spec review A2): wiring setters
    // are not set-once — a compromised admin key could re-point vault/router.
    // Mitigations: multisig admin, timelock (future), on-chain monitoring of
    // wiring changes. All setters revert Spore_ZeroAddress on zero input.
    function setVault(address vault) external;
    function setFeeRouter(address feeRouter) external;
    function setOracle(address oracle) external;
    function setRegistry(address registry) external;
    function setMerchantAllowed(address merchant, bool allowed) external;
    /// @notice Authoritative for borrow/issueLine/setLimit gating: fresh ⟺
    ///         block.timestamp − score.updatedAt ≤ maxStalePeriod. The oracle's
    ///         own maxStalePeriod is informational for off-chain consumers;
    ///         the deploy script mirrors the same value into both.
    function setMaxStalePeriod(uint64 maxStalePeriod) external;

    // --- views ---
    function getLine(uint256 agentId) external view returns (CreditLine memory);
    function outstandingOf(uint256 agentId) external view returns (uint256 principal, uint256 fee);
    function availableToBorrow(uint256 agentId) external view returns (uint256);
    function isMerchantAllowed(address merchant) external view returns (bool);
    function asset() external view returns (IERC20);
    function vault() external view returns (address);
    function feeRouter() external view returns (address);
    function oracle() external view returns (address);
}

/// @title BackerVault — backer staking and loss absorption
/// @notice Backers deposit the settlement asset and vouch it behind specific
///         agents (Sponsor). The vault funds borrows from CreditManager and
///         receives principal repayments. On default, the agent's vouched
///         stake absorbs the loss FIRST — only the uncovered remainder becomes
///         protocol bad debt.
/// @dev Withdrawals are limited to the UNENCUMBERED portion: a backer's stake
///      vouched to an agent cannot be withdrawn while that agent has
///      outstanding debt against it.
/// @dev Per-agent pool accounting (all values in `asset` units) — frozen:
///      poolAssets[agentId] = deposits − withdrawals − absorbedLosses + allocatedYield.
///      Repaid principal does NOT credit poolAssets (it returns to the vault's
///      free balance); it only reduces `drawn`, which un-encumbers stake.
///      encumberedFor(agentId)   = min(poolAssets[agentId], line.drawn)
///      stakedFor(backer)       = sharesOf(backer) * poolAssets / totalShares (asset value)
///      withdrawableFor(backer) = stakedFor(backer) * (poolAssets − encumberedFor) / poolAssets
///      Share pricing: first deposit mints 1:1; later deposits mint at current
///      price; allocateYield adds assets without minting shares (appreciation);
///      absorbDefault removes assets without burning shares (socialized loss).
///      `withdraw`'s `amount` is denominated in ASSET units; shares burn pro-rata.
///      Rounding on withdraw favors the pool (documented in implementation).
/// @dev totalOutstanding() = Σ drawn over all lines. Maintained: + on fundBorrow,
///      − on receiveRepay, − full drawn on absorbDefault.
/// @dev Zero-amount policy (frozen): deposit, withdraw, fundBorrow, receiveRepay,
///      receiveYield, allocateYield with amount == 0 revert Spore_ZeroAmount.
///      Check Spore_InsufficientStake before Spore_StakeEncumbered on withdraw
///      (deterministic error ordering).
interface IBackerVault {
    function deposit(uint256 agentId, uint256 amount) external;
    function withdraw(uint256 agentId, uint256 amount) external;

    /// @notice Fund a borrow. ONLY CreditManager. Transfers asset to merchant.
    function fundBorrow(uint256 agentId, address merchant, uint256 amount) external;

    /// @notice Receive principal repayment. ONLY CreditManager.
    function receiveRepay(uint256 agentId, uint256 principalAmount) external;

    /// @notice Declare default on an agent's line: absorb min(drawn, vouched
    ///         stake) as the loss cover, mark the line defaulted via the
    ///         CreditManager, record any shortfall. Callable by UNDERWRITER_ROLE.
    /// @dev Reverts Spore_NothingToDefault if line.drawn == 0. NOT pausable by
    ///      design — defaults must always be resolvable (see DEPLOY.md).
    function absorbDefault(uint256 agentId) external;

    /// @notice Receive the backer share of fees from the FeeRouter. ONLY FeeRouter.
    /// @dev Accrues to yieldReserve; a keeper allocates it to agent pools via
    ///      allocateYield (documented trust point — see BackerVault NatSpec).
    function receiveYield(uint256 amount) external;

    /// @notice Move accrued fee yield into an agent's vouch pool (share-price
    ///         appreciation for that agent's backers). UNDERWRITER_ROLE.
    function allocateYield(uint256 agentId, uint256 amount) external;

    /// @notice Set the authorized FeeRouter (DEFAULT_ADMIN_ROLE). Prefer set-once
    ///         at deploy; reverts Spore_ZeroAddress on zero input.
    function setFeeRouter(address feeRouter) external;

    // --- emergency controls (PAUSER_ROLE) ---
    // Paused: deposit, withdraw, fundBorrow. NOT paused by design: absorbDefault,
    // receiveRepay, receiveYield — resolution flows must always stay open.
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);

    // --- views ---
    function poolAssets(uint256 agentId) external view returns (uint256);
    function sharesOf(uint256 agentId, address backer) external view returns (uint256);
    function totalShares(uint256 agentId) external view returns (uint256);
    function stakedFor(uint256 agentId, address backer) external view returns (uint256);
    function totalStakedFor(uint256 agentId) external view returns (uint256);
    function encumberedFor(uint256 agentId) external view returns (uint256);
    function withdrawableFor(uint256 agentId, address backer) external view returns (uint256);
    function totalOutstanding() external view returns (uint256);
    function badDebt() external view returns (uint256);
    function yieldReserve() external view returns (uint256);
    function asset() external view returns (IERC20);
}

/// @title ScoreOracle — published credit assessments
/// @notice Publishes per-agent (score, limit) pairs computed OFF-CHAIN by the
///         score engine (docs/scoring.md, model v0.1 — provisional and
///         unvalidated). On-chain code NEVER computes scores.
/// @dev TRUST: ORACLE_UPDATER_ROLE can publish arbitrary scores. Consumers
///      MUST check freshness via isFresh()/maxStalePeriod; the CreditManager
///      blocks new borrows on stale data.
/// @dev Role map (frozen): publishScore requires ORACLE_UPDATER_ROLE (reverts
///      Spore_InvalidScore if score > 1000; zero limit explicitly allowed =
///      "no credit recommended"); setMaxStalePeriod requires DEFAULT_ADMIN_ROLE.
///      Scores may be published for any agentId > 0, including not-yet-registered
///      agents — they are simply unused until a line exists (coordinator decision,
///      spec review F16).
interface IScoreOracle {
    /// @notice Publish a credit assessment. ORACLE_UPDATER_ROLE only.
    function publishScore(
        uint256 agentId, uint16 score, uint256 limit, uint8 modelVersion
    ) external;

    /// @notice Read a published assessment. Reverts Spore_NoOracleData if none.
    function getScore(uint256 agentId) external view returns (ScoreData memory);
    function hasScore(uint256 agentId) external view returns (bool);
    /// @notice Fresh ⟺ hasScore && block.timestamp − updatedAt ≤ maxStalePeriod.
    /// @dev Returns false (does NOT revert) when no record exists.
    function isFresh(uint256 agentId) external view returns (bool);
    function setMaxStalePeriod(uint64 maxStalePeriod) external;
    function maxStalePeriod() external view returns (uint64);
}

/// @title FeeRouter — fee collection and splits
/// @notice Receives fee portions from CreditManager.repay and splits them
///         immediately: treasuryBps to the treasury, the remainder to the
///         BackerVault as backer yield. Holds NO user balances — pure splitter.
/// @dev "No owner sweep of user funds" is structural: the router never custodies
///      backer or agent funds, only transient fee amounts within collectFee.
interface IFeeRouter {
    /// @notice Split a fee. ONLY CreditManager (immutable, set in constructor).
    /// @dev Push model: the manager transfers `amount` to the router, then calls
    ///      this. The router trusts the manager — enforced by Spore_OnlyCreditManager.
    ///      Emits Revenue per non-zero leg using SPORE_REVENUE_TREASURY /
    ///      SPORE_REVENUE_VAULT; zero legs are skipped. amount == 0 reverts
    ///      Spore_ZeroAmount.
    function collectFee(uint256 agentId, uint256 amount) external;

    /// @notice Admin setters (DEFAULT_ADMIN_ROLE). Prefer set-once at deploy;
    ///         zero addresses revert Spore_ZeroAddress; setSplit caps at 5000 bps.
    function setTreasury(address treasury) external;
    function setVault(address vault) external;
    /// @param treasuryBps Basis points of each fee to the treasury (rest to vault).
    function setSplit(uint16 treasuryBps) external;

    function asset() external view returns (IERC20);
    function creditManager() external view returns (address);
    function treasury() external view returns (address);
    function vault() external view returns (address);
    function treasuryBps() external view returns (uint16);
    function totalFeesRouted() external view returns (uint256);
}
