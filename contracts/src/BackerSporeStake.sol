// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Contract-local error: a zero address was supplied.
error BackerSporeStake_ZeroAddress();
/// @dev Contract-local error: a zero amount was supplied.
error BackerSporeStake_ZeroAmount();
/// @dev Contract-local error: unstake request exceeds the backer's active stake.
error BackerSporeStake_InsufficientStake(address backer, uint256 requested, uint256 available);
/// @dev Contract-local error: no unstake request exists at this id for this backer.
error BackerSporeStake_RequestNotFound(address backer, uint256 requestId);
/// @dev Contract-local error: this unstake request was already claimed.
error BackerSporeStake_AlreadyClaimed(address backer, uint256 requestId);
/// @dev Contract-local error: the cooldown for this unstake request has not elapsed.
error BackerSporeStake_CooldownNotElapsed(address backer, uint256 requestId, uint64 unlockAt, uint256 now_);
/// @dev Contract-local error: no matured unstake requests to claim.
error BackerSporeStake_NothingToClaim(address backer);
/// @dev Contract-local error: the $SPORE-per-USDG rate must be non-zero.
error BackerSporeStake_RateMustBeNonZero();
/// @dev Contract-local error: cooldown exceeds the 30-day cap.
error BackerSporeStake_CooldownTooLong(uint256 cooldown);
/// @dev Contract-local error: minimum stake exceeds the sanity cap.
error BackerSporeStake_MinStakeTooHigh(uint256 minStake);

/// @title BackerSporeStake
/// @notice Backers stake $SPORE to qualify for a share of protocol fees. This module is
///         PURELY A QUALIFICATION GATE — it has no slashing: stake leaves only through
///         the backer's own unstake flow after the cooldown.
/// @dev Design notes:
///      - Active stake (the `staked` mapping) is the only thing that counts toward
///        qualification. The moment `requestUnstake` is called, the requested amount
///        stops counting — stake in its cooldown window is pending, not qualified.
///      - Decimal handling: USDG backing arrives in 6-dec base units; $SPORE accounting
///        is 18-dec. `requiredStake` converts via Math.mulDiv full precision and rounds
///        DOWN the backing leg (the protocol accepts the floor of a user's obligation).
///      - Unstake requests are a per-backer queue (array of structs). Multiple partial
///        requests coexist; each has its own unlock timestamp. `claimUnstake()` claims
///        all matured requests in one call; `claimUnstake(requestId)` claims one.
contract BackerSporeStake is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Default $SPORE-per-USDG rate: 100 $SPORE per 1 USDG (1e18 = 1 $SPORE).
    uint256 public constant DEFAULT_SPORE_PER_USDG = 100e18;
    /// @notice Default qualification floor: 1,000 $SPORE.
    uint256 public constant DEFAULT_MIN_STAKE = 1000e18;
    /// @notice Default unstake cooldown: 7 days.
    uint256 public constant DEFAULT_COOLDOWN = 7 days;
    /// @notice Hard cap on the admin-set cooldown: 30 days.
    uint256 public constant MAX_COOLDOWN = 30 days;
    /// @notice Sanity cap on the admin-set minimum stake: 1,000,000 $SPORE.
    uint256 public constant MAX_MIN_STAKE = 1_000_000e18;

    /// @notice The $SPORE token (18 decimals). Immutable.
    IERC20 public immutable spore;

    /// @notice Active (qualification-counting) $SPORE stake per backer.
    mapping(address => uint256) public staked;

    /// @notice A pending unstake: leaves active stake at request time, pays out at claim.
    struct UnstakeRequest {
        uint256 amount;
        uint64 unlockAt;
        bool claimed;
    }

    /// @notice Per-backer FIFO queue of unstake requests; index is the requestId.
    mapping(address => UnstakeRequest[]) private _unstakeRequests;

    /// @notice $SPORE-per-USDG rate in 1e18 units: how many $SPORE (1e18 = 1 $SPORE)
    ///         equal 1 USDG. Admin-set, default 100e18.
    uint256 public sporePerUsdg;
    /// @notice Qualification floor: max over this and the backing leg. Default 1000e18.
    uint256 public minStake;
    /// @notice Cooldown between unstake request and claim. Default 7 days, cap 30 days.
    uint256 public cooldown;

    event Staked(address indexed backer, uint256 amount);
    event UnstakeRequested(
        address indexed backer, uint256 indexed requestId, uint256 amount, uint64 unlockAt
    );
    event UnstakeClaimed(address indexed backer, uint256 indexed requestId, uint256 amount);
    event SporePerUsdgSet(uint256 oldRate, uint256 newRate);
    event MinStakeSet(uint256 oldMinStake, uint256 newMinStake);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);

    /// @param spore_ The $SPORE ERC20 (18 decimals).
    /// @param admin_ Receives DEFAULT_ADMIN_ROLE.
    constructor(address spore_, address admin_) {
        if (spore_ == address(0) || admin_ == address(0)) revert BackerSporeStake_ZeroAddress();
        spore = IERC20(spore_);
        sporePerUsdg = DEFAULT_SPORE_PER_USDG;
        minStake = DEFAULT_MIN_STAKE;
        cooldown = DEFAULT_COOLDOWN;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    // ---------------------------------------------------------------------
    // Qualification
    // ---------------------------------------------------------------------

    /// @notice Minimum active $SPORE stake (18 dec) required given `usdgBacking` USDG
    ///         of backing (6 dec base units).
    /// @dev Formula: required = max(minStake, backingLeg), where
    ///         usdg18       = usdgBacking * 1e12          (6 -> 18 decimals)
    ///         backingLeg   = usdg18 / 10 * sporePerUsdg / 1e18   (10% of backing, USDG->SPORE)
    ///      Computed as Math.mulDiv(usdg18, sporePerUsdg, 10 * 1e18) so the 10% haircut
    ///      and the rate conversion happen in one full-precision step, rounding DOWN —
    ///      the protocol accepts the floor of the obligation, never rounding it up.
    function requiredStake(uint256 usdgBacking) public view returns (uint256) {
        uint256 usdg18 = Math.mulDiv(usdgBacking, 1e12, 1);
        uint256 backingLeg = Math.mulDiv(usdg18, sporePerUsdg, 10 * 1e18);
        return Math.max(minStake, backingLeg);
    }

    /// @notice True if `backer`'s ACTIVE stake (pending cooldown amounts excluded)
    ///         meets the required stake for `usdgBacking` USDG of backing.
    function isQualified(address backer, uint256 usdgBacking) external view returns (bool) {
        return staked[backer] >= requiredStake(usdgBacking);
    }

    // ---------------------------------------------------------------------
    // Backer actions
    // ---------------------------------------------------------------------

    /// @notice Stake `amount` of $SPORE. Increments active (qualifying) stake.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert BackerSporeStake_ZeroAmount();
        spore.safeTransferFrom(msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        emit Staked(msg.sender, amount);
    }

    /// @notice Request to unstake `amount` of $SPORE. The amount immediately leaves
    ///         active (qualification-counting) stake; it pays out once the cooldown
    ///         elapses via `claimUnstake`.
    /// @return requestId Index of the request in the backer's queue.
    function requestUnstake(uint256 amount) external returns (uint256 requestId) {
        if (amount == 0) revert BackerSporeStake_ZeroAmount();
        uint256 available = staked[msg.sender];
        if (amount > available) {
            revert BackerSporeStake_InsufficientStake(msg.sender, amount, available);
        }
        staked[msg.sender] = available - amount;
        uint64 unlockAt = uint64(block.timestamp + cooldown);
        requestId = _unstakeRequests[msg.sender].length;
        _unstakeRequests[msg.sender].push(
            UnstakeRequest({amount: amount, unlockAt: unlockAt, claimed: false})
        );
        emit UnstakeRequested(msg.sender, requestId, amount, unlockAt);
    }

    /// @notice Claim ALL of the backer's matured (cooldown-elapsed) unstake requests
    ///         in a single payout. Reverts if none have matured.
    function claimUnstake() external nonReentrant {
        UnstakeRequest[] storage queue = _unstakeRequests[msg.sender];
        uint256 len = queue.length;
        uint256 payout;
        uint256 i = 0;
        while (i < len) {
            UnstakeRequest storage req = queue[i];
            if (!req.claimed && block.timestamp >= req.unlockAt) {
                req.claimed = true;
                payout += req.amount;
                emit UnstakeClaimed(msg.sender, i, req.amount);
            }
            i = i + 1; // unchecked not needed: i < len <= type(uint256).max - 1 paths
        }
        if (payout == 0) revert BackerSporeStake_NothingToClaim(msg.sender);
        spore.safeTransfer(msg.sender, payout);
    }

    /// @notice Claim a single matured unstake request by id.
    function claimUnstake(uint256 requestId) external nonReentrant {
        UnstakeRequest[] storage queue = _unstakeRequests[msg.sender];
        if (requestId >= queue.length) revert BackerSporeStake_RequestNotFound(msg.sender, requestId);
        UnstakeRequest storage req = queue[requestId];
        if (req.claimed) revert BackerSporeStake_AlreadyClaimed(msg.sender, requestId);
        if (block.timestamp < req.unlockAt) {
            revert BackerSporeStake_CooldownNotElapsed(msg.sender, requestId, req.unlockAt, block.timestamp);
        }
        req.claimed = true;
        emit UnstakeClaimed(msg.sender, requestId, req.amount);
        spore.safeTransfer(msg.sender, req.amount);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Set the $SPORE-per-USDG rate (1e18 = 1 $SPORE per 1 USDG). Must be non-zero.
    function setSporePerUsdg(uint256 newRate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRate == 0) revert BackerSporeStake_RateMustBeNonZero();
        uint256 oldRate = sporePerUsdg;
        sporePerUsdg = newRate;
        emit SporePerUsdgSet(oldRate, newRate);
    }

    /// @notice Set the qualification floor. Capped at MAX_MIN_STAKE for sanity.
    function setMinStake(uint256 newMinStake) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMinStake > MAX_MIN_STAKE) revert BackerSporeStake_MinStakeTooHigh(newMinStake);
        uint256 oldMinStake = minStake;
        minStake = newMinStake;
        emit MinStakeSet(oldMinStake, newMinStake);
    }

    /// @notice Set the unstake cooldown. Capped at MAX_COOLDOWN (30 days).
    function setCooldown(uint256 newCooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newCooldown > MAX_COOLDOWN) revert BackerSporeStake_CooldownTooLong(newCooldown);
        uint256 oldCooldown = cooldown;
        cooldown = newCooldown;
        emit CooldownSet(oldCooldown, newCooldown);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Number of unstake requests (including claimed) ever made by `backer`.
    function requestCount(address backer) external view returns (uint256) {
        return _unstakeRequests[backer].length;
    }

    /// @notice Fetch one unstake request by id.
    function unstakeRequest(address backer, uint256 requestId)
        external
        view
        returns (uint256 amount, uint64 unlockAt, bool claimed)
    {
        UnstakeRequest[] storage queue = _unstakeRequests[backer];
        if (requestId >= queue.length) revert BackerSporeStake_RequestNotFound(backer, requestId);
        UnstakeRequest storage req = queue[requestId];
        return (req.amount, req.unlockAt, req.claimed);
    }

    /// @notice Total $SPORE currently cooling down (requested but unclaimed) for `backer`.
    ///         Does NOT count toward qualification.
    function pendingStake(address backer) external view returns (uint256 pending) {
        UnstakeRequest[] storage queue = _unstakeRequests[backer];
        uint256 len = queue.length;
        for (uint256 i = 0; i < len; ++i) {
            if (!queue[i].claimed) pending += queue[i].amount;
        }
    }
}
