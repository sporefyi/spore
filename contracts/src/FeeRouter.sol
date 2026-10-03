// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    IFeeRouter,
    IBackerVault,
    Revenue,
    SPORE_REVENUE_TREASURY,
    SPORE_REVENUE_VAULT,
    Spore_OnlyCreditManager,
    Spore_SplitBpsInvalid,
    Spore_ZeroAddress,
    Spore_ZeroAmount
} from "./interfaces/ISpore.sol";

/// @title FeeRouter
/// @notice Splits protocol fees between the treasury and the backer vault (push model).
/// @dev Trust assumption: the router trusts the CreditManager (the only authorized caller of
///      `collectFee`). The CreditManager transfers the fee amount to this router BEFORE calling
///      `collectFee`; the router then forwards the legs onward in the same transaction.
///
///      Structural guarantee: the router never custodies user funds. It only holds fee amounts
///      transiently inside `collectFee`. Therefore "no owner sweep" is structural: there is
///      nothing to sweep, and no withdraw/sweep function exists by design.
///
///      Admin setters (`setTreasury`, `setVault`, `setSplit`) are gated by DEFAULT_ADMIN_ROLE and
///      are intended to be set once at deploy (prefer-set-once; hand admin to a timelock/multisig
///      or renounce afterwards). They intentionally emit no events: the frozen interface does not
///      define any, and the external surface is kept minimal.
///      `asset` and `creditManager` are immutable; `treasury` and `vault` are storage because
///      they have admin setters.
contract FeeRouter is IFeeRouter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Maximum treasury share: 50%.
    uint16 private constant MAX_TREASURY_BPS = 5000;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice ERC20 asset in which fees are denominated.
    IERC20 public immutable asset;
    /// @notice The only address allowed to call `collectFee`.
    address public immutable creditManager;

    address public treasury;
    address public vault;
    uint16 public treasuryBps;
    uint256 public totalFeesRouted;

    constructor(
        address asset_,
        address treasury_,
        address vault_,
        address creditManager_,
        uint16 treasuryBps_,
        address admin_
    ) {
        if (
            asset_ == address(0) || treasury_ == address(0) || vault_ == address(0)
                || creditManager_ == address(0) || admin_ == address(0)
        ) revert Spore_ZeroAddress();
        if (treasuryBps_ > MAX_TREASURY_BPS) revert Spore_SplitBpsInvalid(treasuryBps_);

        asset = IERC20(asset_);
        treasury = treasury_;
        vault = vault_;
        creditManager = creditManager_;
        treasuryBps = treasuryBps_;
        totalFeesRouted = 0;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    /// @notice Split `amount` between treasury and backer vault.
    /// @dev Caller (CreditManager) must have already transferred `amount` to this contract.
    ///      `agentId` does not affect logic; it is part of the frozen signature for
    ///      indexer / future per-agent use.
    function collectFee(uint256 agentId, uint256 amount) external nonReentrant {
        agentId; // unused by design (frozen signature)

        if (msg.sender != creditManager) revert Spore_OnlyCreditManager(msg.sender);
        if (amount == 0) revert Spore_ZeroAmount();

        uint256 treasuryAmt = (amount * treasuryBps) / BPS_DENOMINATOR;
        uint256 vaultAmt = amount - treasuryAmt;

        totalFeesRouted += amount;

        address treasury_ = treasury;
        address vault_ = vault;
        IERC20 token = asset;

        // Treasury leg first (no external logic beyond the token transfer).
        if (treasuryAmt > 0) {
            token.safeTransfer(treasury_, treasuryAmt);
            emit Revenue(treasury_, treasuryAmt, SPORE_REVENUE_TREASURY);
        }

        // Vault leg: push funds, then let the vault account for them.
        if (vaultAmt > 0) {
            token.safeTransfer(vault_, vaultAmt);
            IBackerVault(vault_).receiveYield(vaultAmt);
            emit Revenue(vault_, vaultAmt, SPORE_REVENUE_VAULT);
        }
    }

    /// @notice Set the treasury address. Prefer set-once at deploy.
    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert Spore_ZeroAddress();
        treasury = treasury_;
    }

    /// @notice Set the backer vault address. Prefer set-once at deploy.
    function setVault(address vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vault_ == address(0)) revert Spore_ZeroAddress();
        vault = vault_;
    }

    /// @notice Set the treasury share in bps (max 5000). Prefer set-once at deploy.
    function setSplit(uint16 treasuryBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasuryBps_ > MAX_TREASURY_BPS) revert Spore_SplitBpsInvalid(treasuryBps_);
        treasuryBps = treasuryBps_;
    }
}
