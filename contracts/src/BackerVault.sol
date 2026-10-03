// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/ISpore.sol";

/// @dev Contract-local error (not part of the frozen set): vault token balance too low for a request.
error Spore_InsufficientVaultBalance(uint256 requested, uint256 available);
/// @dev Contract-local error: caller of a FeeRouter-only function is not the FeeRouter.
error Spore_OnlyFeeRouter(address caller);
/// @dev Contract-local error: a set-once parameter was already set.
error Spore_AlreadySet();
/// @dev Contract-local error: agent pool has outstanding shares but zero assets (fully slashed).
error Spore_PoolWipedOut(uint256 agentId);
/// @dev Contract-local error: yield cannot be allocated to an agent pool with no shares.
error Spore_EmptyPool(uint256 agentId);

/// @title BackerVault
/// @notice SPORE backer vault. Backers deposit the ERC20 `asset` and vouch stake for an agent.
///         The vault funds borrows requested by the CreditManager and absorbs defaults from
///         the vouched stake first; any remainder is recorded as bad debt.
/// @dev Trust assumptions:
///      - `creditManager` is trusted to call fundBorrow/receiveRepay honestly and to transfer
///        repaid principal into this vault BEFORE calling receiveRepay.
///      - `feeRouter` is trusted to push yield tokens BEFORE calling receiveYield.
///      - UNDERWRITER_ROLE is a trusted keeper role (yield allocation, default absorption).
///      Rounding: share/asset conversions round in the VAULT's favor — mulDiv down on
///      user asset values (deposit mint, withdraw entitlement, views) and mulDiv UP on
///      shares burned on withdraw (so the vault never burns fewer shares than value left).
///      `poolAssets` = staked minus slashed and is NOT reduced by borrows; encumbrance of
///      stake by an open line is logical (see withdraw), not an accounting deduction.
contract BackerVault is IBackerVault, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to allocate yield and absorb defaults.
    bytes32 public constant UNDERWRITER_ROLE = keccak256("UNDERWRITER_ROLE");
    /// @notice Role allowed to pause/unpause.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Staked ERC20 asset.
    IERC20 public immutable asset;
    /// @notice SPORE registry (used for agent existence checks).
    ISporeRegistry public immutable registry;
    /// @notice CreditManager, set once in the constructor.
    address public creditManager;
    /// @notice FeeRouter, set once via setFeeRouter.
    address public feeRouter;

    /// @notice Backer shares per agent pool.
    mapping(uint256 => mapping(address => uint256)) public shares;
    /// @notice Total shares per agent pool.
    mapping(uint256 => uint256) public totalShares;
    /// @notice Staked minus slashed per agent. Not reduced by borrows.
    mapping(uint256 => uint256) public poolAssets;

    /// @notice Principal currently lent out across all agents.
    uint256 public totalOutstanding;
    /// @notice Cumulative defaulted amount not covered by stake.
    uint256 public badDebt;
    /// @notice Yield received from the FeeRouter and not yet allocated to an agent pool.
    uint256 public yieldReserve;

    /// @param asset_ Staking asset.
    /// @param registry_ SporeRegistry.
    /// @param creditManager_ CreditManager.
    /// @param admin_ Receives admin, underwriter and pauser roles.
    constructor(address asset_, address registry_, address creditManager_, address admin_) {
        if (
            asset_ == address(0) || registry_ == address(0) || creditManager_ == address(0)
                || admin_ == address(0)
        ) {
            revert Spore_ZeroAddress();
        }
        asset = IERC20(asset_);
        registry = ISporeRegistry(registry_);
        creditManager = creditManager_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(UNDERWRITER_ROLE, admin_);
        _grantRole(PAUSER_ROLE, admin_);
    }

    // ---------------------------------------------------------------------
    // Backer actions
    // ---------------------------------------------------------------------

    /// @notice Deposit `amount` of asset as vouch stake for `agentId`.
    /// @dev Shares minted round down (vault-favor). First depositor mints 1:1.
    ///      Reverts if the pool has shares but zero assets (fully slashed), since the
    ///      share price would be undefined.
    function deposit(uint256 agentId, uint256 amount) external nonReentrant whenNotPaused {
        if (agentId == 0 || agentId > registry.agentCount()) revert Spore_AgentNotFound(agentId);
        if (amount == 0) revert Spore_ZeroAmount();

        asset.safeTransferFrom(msg.sender, address(this), amount);

        uint256 ts = totalShares[agentId];
        uint256 sharesToMint;
        if (ts == 0) {
            sharesToMint = amount;
        } else {
            uint256 pa = poolAssets[agentId];
            if (pa == 0) revert Spore_PoolWipedOut(agentId);
            sharesToMint = Math.mulDiv(amount, ts, pa);
        }

        shares[agentId][msg.sender] += sharesToMint;
        totalShares[agentId] = ts + sharesToMint;
        poolAssets[agentId] += amount;

        emit Sponsor(agentId, msg.sender, amount);
    }

    /// @notice Withdraw `amount` of asset from your stake on `agentId`.
    /// @dev The withdrawable amount excludes the backer's pro-rata share of the encumbered
    ///      stake, where encumbered = min(poolAssets, line.drawn). The entitlement converts
    ///      shares to assets rounding down (vault-favor); shares burned round UP (vault-favor,
    ///      so the vault never burns fewer shares than the value withdrawn). Tiny withdrawals
    ///      therefore cost at least one full share — a deliberate dust penalty, not a bug.
    function withdraw(uint256 agentId, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert Spore_ZeroAmount();

        uint256 backerShares = shares[agentId][msg.sender];
        if (backerShares == 0) revert Spore_InsufficientStake(agentId, msg.sender, amount, 0);

        uint256 pa = poolAssets[agentId];
        uint256 ts = totalShares[agentId];
        uint256 withdrawableAssets = _withdrawable(agentId, backerShares, pa, ts);
        if (amount > withdrawableAssets) {
            revert Spore_StakeEncumbered(agentId, msg.sender, amount, withdrawableAssets);
        }

        // withdrawableAssets > 0 implies pa > 0 and ts > 0.
        uint256 sharesToBurn = Math.mulDiv(amount, ts, pa, Math.Rounding.Ceil);
        // sharesToBurn <= backerShares: amount <= withdrawableAssets <= assets
        // implies ceil(amount*ts/pa) <= backerShares.

        // Liquidity check (fuzzer-found, documented): the vault's token balance is
        // fungible across agents, so another agent's borrows can leave the vault short
        // even when this backer's stake is unencumbered per accounting. This is genuine
        // pooled-liquidity risk — withdrawals are first-come-first-served when utilization
        // is high. Surfaced as a proper error rather than a raw ERC20 revert.
        uint256 bal = asset.balanceOf(address(this));
        if (bal < amount) revert Spore_InsufficientVaultBalance(amount, bal);

        shares[agentId][msg.sender] = backerShares - sharesToBurn;
        totalShares[agentId] = ts - sharesToBurn;
        poolAssets[agentId] = pa - amount;

        asset.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // CreditManager hooks
    // ---------------------------------------------------------------------

    /// @notice Send `amount` of asset to `merchant` for a borrow.
    /// @dev Only CreditManager. The agentId is unused: accounting is fungible across pools.
    /// @dev Paused under emergency: borrow funding is a risk-increasing flow. NOT pausable:
    ///      absorbDefault, receiveRepay, receiveYield — resolution flows always stay open.
    function fundBorrow(uint256, address merchant, uint256 amount) external whenNotPaused {
        if (msg.sender != creditManager) revert Spore_OnlyCreditManager(msg.sender);
        if (amount == 0) revert Spore_ZeroAmount();
        uint256 bal = asset.balanceOf(address(this));
        if (bal < amount) revert Spore_InsufficientVaultBalance(amount, bal);
        totalOutstanding += amount;
        asset.safeTransfer(merchant, amount);
    }

    /// @notice Record repaid principal.
    /// @dev Only CreditManager. ORDERING ASSUMPTION: the manager has already transferred the
    ///      principal into this vault before calling. poolAssets is unchanged (borrows never
    ///      reduced it). Defensive min keeps accounting sane if the manager over-reports.
    function receiveRepay(uint256, uint256 principalAmount) external {
        if (msg.sender != creditManager) revert Spore_OnlyCreditManager(msg.sender);
        if (principalAmount == 0) revert Spore_ZeroAmount();
        totalOutstanding -= Math.min(totalOutstanding, principalAmount);
    }

    // ---------------------------------------------------------------------
    // Yield
    // ---------------------------------------------------------------------

    /// @notice Record yield pushed by the FeeRouter (tokens are transferred before this call).
    /// @dev Uses contract-local Spore_OnlyFeeRouter since the frozen error set has none for this.
    function receiveYield(uint256 amount) external {
        if (msg.sender != feeRouter) revert Spore_OnlyFeeRouter(msg.sender);
        if (amount == 0) revert Spore_ZeroAmount();
        yieldReserve += amount;
    }

    /// @notice Allocate reserved yield to an agent's pool, raising backers' share value.
    /// @dev TRUSTED KEEPER FUNCTION — allocation across agents is an operator decision,
    ///      fully visible on-chain via the YieldAllocated event. Requires an existing pool
    ///      (totalShares > 0): allocating to an empty pool would let the first depositor
    ///      capture reserved yield at 1:1 minting.
    function allocateYield(uint256 agentId, uint256 amount) external onlyRole(UNDERWRITER_ROLE) {
        if (amount == 0) revert Spore_ZeroAmount();
        if (amount > yieldReserve) revert Spore_InsufficientVaultBalance(amount, yieldReserve);
        if (totalShares[agentId] == 0) revert Spore_EmptyPool(agentId);
        yieldReserve -= amount;
        poolAssets[agentId] += amount;
        emit YieldAllocated(agentId, amount);
    }

    // ---------------------------------------------------------------------
    // Default handling
    // ---------------------------------------------------------------------

    /// @notice Absorb an agent's default from vouched stake first; the remainder is bad debt.
    /// @dev Intentionally NOT whenNotPaused: defaults must always be resolvable, even during
    ///      a pause, so that a pause can never block loss recognition or leave a defaulted
    ///      line open. Restricted to UNDERWRITER_ROLE and nonReentrant. No token transfer is
    ///      needed: the borrowed tokens already left the vault at borrow time, so this is pure
    ///      loss accounting — poolAssets is written down (share-price loss, socialized across
    ///      the agent's backers) and any shortfall becomes protocol badDebt.
    function absorbDefault(uint256 agentId) external nonReentrant onlyRole(UNDERWRITER_ROLE) {
        ICreditManager cm = ICreditManager(creditManager);
        CreditLine memory line = cm.getLine(agentId);
        if (!line.active) revert Spore_NoActiveLine(agentId);
        if (line.defaulted) revert Spore_LineDefaulted(agentId);
        if (line.drawn == 0) revert Spore_NothingToDefault(agentId);

        uint256 covered = Math.min(line.drawn, poolAssets[agentId]);        poolAssets[agentId] -= covered;
        uint256 shortfall = line.drawn - covered;
        badDebt += shortfall;
        totalOutstanding -= Math.min(totalOutstanding, line.drawn);

        cm.markDefaulted(agentId, covered, shortfall);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Set the FeeRouter. Set-once (prefer at deploy).
    function setFeeRouter(address feeRouter_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeRouter_ == address(0)) revert Spore_ZeroAddress();
        if (feeRouter != address(0)) revert Spore_AlreadySet();
        feeRouter = feeRouter_;
    }

    /// @notice Pause deposits and withdrawals.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @dev Resolves the Pausable/IBackerVault `paused()` diamond.
    function paused() public view override(Pausable, IBackerVault) returns (bool) {
        return super.paused();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Raw share balance of `backer` in `agentId`'s pool.
    function sharesOf(uint256 agentId, address backer) external view returns (uint256) {
        return shares[agentId][backer];
    }

    /// @notice Asset value of `backer`'s shares in `agentId` (rounded down).
    function stakedFor(uint256 agentId, address backer) external view returns (uint256) {
        uint256 ts = totalShares[agentId];
        if (ts == 0) return 0;
        return Math.mulDiv(shares[agentId][backer], poolAssets[agentId], ts);
    }

    /// @notice Total staked (minus slashed) for `agentId`.
    function totalStakedFor(uint256 agentId) external view returns (uint256) {
        return poolAssets[agentId];
    }

    /// @notice Stake logically encumbered by the agent's drawn balance: min(poolAssets, drawn).
    function encumberedFor(uint256 agentId) public view returns (uint256) {
        return Math.min(poolAssets[agentId], ICreditManager(creditManager).getLine(agentId).drawn);
    }

    /// @notice Amount `backer` could withdraw now (rounded down).
    function withdrawableFor(uint256 agentId, address backer) external view returns (uint256) {
        return _withdrawable(agentId, shares[agentId][backer], poolAssets[agentId], totalShares[agentId]);
    }

    /// @dev Pro-rata encumbrance: each backer leaves `encumbered/pa` of their stake behind.
    function _withdrawable(uint256 agentId, uint256 backerShares, uint256 pa, uint256 ts)
        internal
        view
        returns (uint256)
    {
        if (pa == 0 || ts == 0 || backerShares == 0) return 0;
        uint256 assets = Math.mulDiv(backerShares, pa, ts);
        uint256 encumbered = Math.min(pa, ICreditManager(creditManager).getLine(agentId).drawn);
        return assets - Math.mulDiv(assets, encumbered, pa);
    }
}
