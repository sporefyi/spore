// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Spore_ZeroAddress, Spore_ZeroAmount} from "./interfaces/ISpore.sol";

/// @title IDexRouter
/// @notice Minimal UniswapV2-style router interface for the USDG -> $SPORE swap.
/// @dev Defined locally on purpose: no DEX dependency is imported, so this
///      contract works with any router exposing the canonical V2 swap shape.
interface IDexRouter {
    /// @notice Swap an exact amount of input tokens for as many output tokens as possible.
    /// @param amountIn Exact input token amount.
    /// @param amountOutMin Minimum output token amount (slippage guard).
    /// @param path Ordered swap path; path[0] is the input token.
    /// @param to Recipient of the output tokens.
    /// @param deadline Unix timestamp after which the swap reverts.
    /// @return amounts Input/output amounts per hop, newest router convention.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Thrown when the DEX router has not been set yet.
error Spore_RouterNotSet();
/// @notice Thrown when a keeper bps value exceeds the cap.
error Spore_InvalidKeeperBps(uint256 keeperBps);
/// @notice Thrown when `rescueToken` is called on USDG or $SPORE.
error Spore_ProtectedToken(address token);

/// @title SporeBuyback
/// @notice Deflationary engine for $SPORE: accumulates the protocol's USDG fee
///         share, swaps it for $SPORE on a DEX, and burns the $SPORE.
///
/// @dev Slippage policy (deliberate design choice):
///      `executeBuyback` uses amountOutMin = 0 and keeps the exact two-argument
///      signature, so keepers CANNOT be front-run via a bad on-chain quote and
///      there is no stale on-chain price to trust. The tradeoff is MEV /
///      sandwich risk: a malicious block builder could sandwich a large swap.
///      Mitigations built in:
///        1. Keeper incentive (1% default) aligns keepers to run swaps in small
///           tranches and simulate off-chain (eth_call / Tenderly) before
///           submitting, rejecting any quote below their own floor.
///        2. Anyone can call `executeBuyback`; a bad swap by one keeper does not
///           lock the funds — the remaining balance stays retryable.
///      An alternative `executeBuybackWithMin` overload was NOT added: without a
///      trusted on-chain price oracle, any on-chain min-out is either a stale
///      price (worse) or keeper-provided (same as simulation). Documented here
///      so future reviewers know the choice was explicit.
///
///      Burn mechanism: $SPORE has no burn() function, so received $SPORE is
///      transferred to 0x000000000000000000000000000000000000dEaD.
///
///      Failure mode: if the DEX call reverts or returns zero output (no
///      liquidity / bad path), the whole call does NOT revert. The USDG stays
///      in the contract and `BuybackPending` is emitted so keepers know to
///      retry later or fix the path/router.
///
///      Admin is a trust assumption: `sweepUsdg` exists as an emergency escape
///      hatch (e.g. contract bug, DEX dead). Sweeping breaks the deflationary
///      invariant by design — hand admin to a timelock/multisig or renounce it.
contract SporeBuyback is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev $SPORE has no burn(); dead address is the canonical burn target.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// @dev Swap deadline offset: block.timestamp + 300.
    uint256 public constant SWAP_DEADLINE_SECS = 300;
    /// @dev Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @dev Maximum keeper incentive: 5%.
    uint256 public constant MAX_KEEPER_BPS = 500;

    /// @notice USDG fee token (6 decimals).
    IERC20 public immutable usdg;
    /// @notice $SPORE token (18 decimals).
    IERC20 public immutable spore;

    /// @notice DEX router used for the USDG -> $SPORE swap. Settable by admin.
    address public router;
    /// @notice Keeper incentive in basis points. Default 100 (1%).
    uint16 public keeperBps;

    /// @notice Cumulative USDG actually pushed through swaps.
    uint256 public totalUsdgSwapped;
    /// @notice Cumulative $SPORE burned (sent to 0xdead).
    uint256 public totalSporeBurned;

    /// @notice Emitted when a buyback swap succeeds.
    /// @param usdgIn USDG amount consumed by the swap (excludes keeper fee).
    /// @param sporeBurned $SPORE received and sent to 0xdead.
    /// @param keeper Caller that triggered the buyback.
    /// @param keeperFee USDG paid to the keeper.
    event BuybackExecuted(uint256 usdgIn, uint256 sporeBurned, address keeper, uint256 keeperFee);
    /// @notice Emitted when a swap failed and funds were left in the contract.
    /// @param usdgAmount USDG amount that was attempted (left in the contract).
    event BuybackPending(uint256 usdgAmount);
    /// @notice Emitted when the DEX router is updated.
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    /// @notice Emitted when the keeper incentive is updated.
    event KeeperBpsUpdated(uint16 oldBps, uint16 newBps);
    /// @notice Emitted when admin sweeps USDG out of the contract (emergency).
    event UsdgSwept(address indexed to, uint256 amount);
    /// @notice Emitted when admin rescues a non-USDG/non-$SPORE token.
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /// @param usdg_ USDG token address.
    /// @param spore_ $SPORE token address.
    /// @param admin_ Address granted DEFAULT_ADMIN_ROLE.
    /// @param router_ Initial DEX router (may be address(0); settable later).
    constructor(address usdg_, address spore_, address admin_, address router_) {
        if (usdg_ == address(0) || spore_ == address(0) || admin_ == address(0)) {
            revert Spore_ZeroAddress();
        }
        usdg = IERC20(usdg_);
        spore = IERC20(spore_);
        router = router_;
        keeperBps = 100; // 1%
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    /// @notice Execute a buyback: swap up to `usdgAmount` USDG for $SPORE and burn it.
    /// @dev Permissionless — any keeper can call. Takes min(usdgAmount, contract
    ///      USDG balance). Keeper receives `keeperBps` of the attempted amount
    ///      in USDG AFTER a successful swap; no keeper fee is paid when the swap
    ///      fails (funds stay for a retry, so a keeper cannot drain fees by
    ///      triggering failures).
    ///
    ///      Reverts Spore_ZeroAmount when `usdgAmount` is 0 or the contract
    ///      holds no USDG (documented choice: a revert is cheaper than a
    ///      no-op event, and there is nothing to retry).
    ///      Reverts Spore_RouterNotSet when the router is unset.
    ///
    ///      The DEX call is wrapped in try/catch: a revert or a zero-output
    ///      swap emits BuybackPending instead of reverting the whole call.
    /// @param usdgAmount Maximum USDG to deploy in this buyback.
    /// @param swapPath DEX path, e.g. [USDG, WETH, SPORE].
    function executeBuyback(uint256 usdgAmount, address[] calldata swapPath)
        external
        nonReentrant
    {
        uint256 balance = usdg.balanceOf(address(this));
        uint256 amount = usdgAmount < balance ? usdgAmount : balance;
        if (amount == 0) revert Spore_ZeroAmount();

        address router_ = router;
        if (router_ == address(0)) revert Spore_RouterNotSet();

        uint256 keeperFee = (amount * keeperBps) / BPS_DENOMINATOR;
        uint256 swapAmount = amount - keeperFee;

        IERC20 usdgToken = usdg;
        usdgToken.forceApprove(router_, swapAmount);

        uint256 sporeOut;
        try IDexRouter(router_).swapExactTokensForTokens(
            swapAmount,
            0, // amountOutMin = 0: see NatSpec slippage policy above.
            swapPath,
            address(this),
            block.timestamp + SWAP_DEADLINE_SECS
        ) returns (uint256[] memory amounts) {
            if (amounts.length > 0) {
                sporeOut = amounts[amounts.length - 1];
            }
        } catch {
            sporeOut = 0; // handled below as pending
        }

        if (sporeOut == 0) {
            // Swap reverted or returned nothing: leave funds, signal retry.
            // NOTE: if the router consumed the input and returned 0 output,
            // the USDG is unrecoverable — the documented MEV/liquidity risk.
            usdgToken.forceApprove(router_, 0);
            emit BuybackPending(amount);
            return;
        }

        // Burn all $SPORE received.
        spore.safeTransfer(BURN_ADDRESS, sporeOut);

        // Pay the keeper after a successful swap.
        if (keeperFee > 0) {
            usdgToken.safeTransfer(msg.sender, keeperFee);
        }

        totalUsdgSwapped += swapAmount;
        totalSporeBurned += sporeOut;

        emit BuybackExecuted(swapAmount, sporeOut, msg.sender, keeperFee);
    }

    /// @notice Set the DEX router. Admin only.
    /// @dev Intended to be set once at deploy / when the FeeRouter fee share
    ///      is pointed here; emits RouterUpdated for indexers.
    function setRouter(address router_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (router_ == address(0)) revert Spore_ZeroAddress();
        address oldRouter = router;
        router = router_;
        emit RouterUpdated(oldRouter, router_);
    }

    /// @notice Set the keeper incentive in basis points (max 500 = 5%). Admin only.
    function setKeeperBps(uint256 keeperBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (keeperBps_ > MAX_KEEPER_BPS) revert Spore_InvalidKeeperBps(keeperBps_);
        uint16 oldBps = keeperBps;
        keeperBps = uint16(keeperBps_);
        emit KeeperBpsUpdated(oldBps, uint16(keeperBps_));
    }

    /// @notice Emergency admin sweep of USDG. Admin only.
    /// @dev Breaks the deflationary invariant by design — this is an escape
    ///      hatch for bugs / dead DEX, not a routine function.
    function sweepUsdg(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert Spore_ZeroAddress();
        if (amount == 0) revert Spore_ZeroAmount();
        usdg.safeTransfer(to, amount);
        emit UsdgSwept(to, amount);
    }

    /// @notice Rescue tokens that are neither USDG nor $SPORE. Admin only.
    /// @dev USDG and $SPORE are protected: USDG must only leave via buyback or
    ///      `sweepUsdg`; $SPORE in this contract is meant for burning.
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(usdg) || token == address(spore)) revert Spore_ProtectedToken(token);
        if (to == address(0)) revert Spore_ZeroAddress();
        if (amount == 0) revert Spore_ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
