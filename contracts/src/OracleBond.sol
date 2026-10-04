// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Contract-local error: zero address supplied for a required parameter.
error OracleBond_ZeroAddress();
/// @dev Contract-local error: stake amount was zero.
error OracleBond_ZeroAmount();
/// @dev Contract-local error: updater has no bond to act on.
error OracleBond_NoBond();
/// @dev Contract-local error: an unstake request is already pending for the updater.
error OracleBond_UnstakeAlreadyPending();
/// @dev Contract-local error: no unstake request is pending for the updater.
error OracleBond_NoUnstakePending();
/// @dev Contract-local error: cooldown has not elapsed yet (unlockAt is when it ends).
error OracleBond_CooldownNotElapsed(uint64 unlockAt);
/// @dev Contract-local error: slash amount exceeds the updater's total bond.
error OracleBond_SlashExceedsBond(uint256 amount, uint256 bond);
/// @dev Contract-local error: stake called while an unstake request is pending
///      (cancel the request first, then stake).
error OracleBond_UnstakePending();
/// @dev Contract-local error: requested cooldown exceeds the 60-day cap.
error OracleBond_CooldownTooLong(uint256 requested, uint256 max);

/// @title OracleBond
/// @notice Slashable $SPORE bond for oracle updaters. Updaters stake $SPORE to become
///         eligible for the ScoreOracle ORACLE_UPDATER_ROLE; the slasher can confiscate
///         part or all of the bond (to treasury) on misbehavior (bad scores).
/// @dev TRUST MODEL — read before integrating:
///      - `isBonded()` is advisory. Any consumer (e.g. an admin tooling granting the
///        v1 ScoreOracle's ORACLE_UPDATER_ROLE) must check it off-chain/on-chain and
///        can revoke the role if the bond drops.
///      - SLASHER_ROLE is fully trusted: it can slash any bond in full, for any reason,
///        including while funds are cooling down. Intended to migrate to a
///        governor/multisig; initially held by the deployer/admin.
///      - The $SPORE token is trusted to behave as a standard ERC20 (no fee-on-transfer;
///        `transferFrom` of `amount` is assumed to move exactly `amount`).
///      - Not upgradeable. Not pausable.
contract OracleBond is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to slash updater bonds (fully trusted).
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    /// @notice Minimum bond for an updater to be considered bonded (18-decimal $SPORE).
    uint256 public constant MIN_BOND_DEFAULT = 10_000e18;

    /// @notice Default unstake cooldown: 14 days.
    uint256 public constant DEFAULT_COOLDOWN = 14 days;

    /// @notice Maximum unstake cooldown the admin may set: 60 days.
    uint256 public constant MAX_COOLDOWN = 60 days;

    /// @notice The $SPORE token bonded by updaters.
    IERC20 public immutable spore;

    /// @notice Destination for slashed $SPORE.
    address public treasury;

    /// @notice Current minimum bond (18-decimal $SPORE). Raising it does NOT
    ///         retroactively unbond anyone, but `isBonded()` immediately reflects
    ///         the new bar.
    uint256 public minBond;

    /// @notice Unstake cooldown in seconds (capped at MAX_COOLDOWN).
    uint256 public cooldown;

    /// @dev Bonded $SPORE per updater (includes funds in cooldown).
    mapping(address updater => uint256) private _bonds;

    /// @dev Pending unstake request unlock timestamp per updater (0 = none).
    mapping(address updater => uint64) private _unstakeUnlockAt;

    /// @notice Emitted when an updater stakes $SPORE into the bond.
    /// @param updater The updater that staked.
    /// @param amount Amount of $SPORE staked.
    event Bonded(address indexed updater, uint256 amount);

    /// @notice Emitted when an updater requests a full unstake.
    /// @param updater The updater requesting unstake.
    /// @param amount The full bond amount placed in cooldown.
    /// @param unlockAt Timestamp after which `claimUnstake` may be called.
    event UnstakeRequested(address indexed updater, uint256 amount, uint64 unlockAt);

    /// @notice Emitted when an updater claims their unstaked bond after cooldown.
    /// @param updater The updater claiming.
    /// @param amount Amount of $SPORE returned (post-slash, if any).
    event UnstakeClaimed(address indexed updater, uint256 amount);

    /// @notice Emitted when an updater cancels a pending unstake request.
    /// @param updater The updater cancelling.
    event UnstakeCancelled(address indexed updater);

    /// @notice Emitted when a bond is slashed.
    /// @param updater The slashed updater.
    /// @param amount Amount of $SPORE sent to treasury.
    /// @param reason Human-readable reason for the slash.
    /// @param slasher Address that executed the slash.
    event Slashed(address indexed updater, uint256 amount, string reason, address indexed slasher);

    /// @notice Emitted when the treasury address is updated.
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    /// @notice Emitted when the minimum bond is updated.
    event MinBondUpdated(uint256 oldMinBond, uint256 newMinBond);

    /// @notice Emitted when the unstake cooldown is updated.
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    /// @notice Deploys the bond vault.
    /// @param spore_ Address of the $SPORE ERC20 token.
    /// @param admin_ Address granted DEFAULT_ADMIN_ROLE.
    /// @param treasury_ Initial treasury address receiving slashed $SPORE.
    /// @param slasher_ Initial holder of SLASHER_ROLE (intended to migrate to a governor/multisig).
    constructor(address spore_, address admin_, address treasury_, address slasher_) {
        if (spore_ == address(0) || admin_ == address(0) || treasury_ == address(0) || slasher_ == address(0)) {
            revert OracleBond_ZeroAddress();
        }
        spore = IERC20(spore_);
        treasury = treasury_;
        minBond = MIN_BOND_DEFAULT;
        cooldown = DEFAULT_COOLDOWN;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(SLASHER_ROLE, slasher_);
    }

    /// @notice Stakes `amount` $SPORE into the updater's bond.
    /// @dev Caller must approve this contract first. Reverts if an unstake request
    ///      is pending (cancel it first, then stake). Staking while below the
    ///      minimum is allowed — it only accumulates toward `isBonded()`.
    /// @param amount Amount of $SPORE to stake (must be > 0).
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert OracleBond_ZeroAmount();
        if (_unstakeUnlockAt[msg.sender] != 0) revert OracleBond_UnstakePending();

        spore.safeTransferFrom(msg.sender, address(this), amount);
        _bonds[msg.sender] += amount;

        emit Bonded(msg.sender, amount);
    }

    /// @notice Whether an updater is currently considered bonded.
    /// @dev DESIGN DECISION: any pending unstake request makes the updater NOT bonded
    ///      until the request is claimed or cancelled. Rationale: during cooldown the
    ///      updater is exiting, and their funds are only partially slashable-in-spirit
    ///      (they could still be slashed, but the updater is no longer committing to
    ///      the role). This is the strict, safe choice — no partial-bond subtleties.
    /// @param updater The updater to check.
    /// @return True iff bond >= minBond AND no unstake request is pending.
    function isBonded(address updater) external view returns (bool) {
        return _bonds[updater] >= minBond && _unstakeUnlockAt[updater] == 0;
    }

    /// @notice Returns the total bonded $SPORE for an updater (includes cooling-down funds).
    /// @param updater The updater to query.
    /// @return Total bond amount.
    function bondOf(address updater) external view returns (uint256) {
        return _bonds[updater];
    }

    /// @notice Returns the unlock timestamp of a pending unstake request (0 = none).
    /// @param updater The updater to query.
    /// @return Unlock timestamp.
    function unstakeUnlockAt(address updater) external view returns (uint64) {
        return _unstakeUnlockAt[updater];
    }

    /// @notice Requests unstake of the FULL bond. Starts the cooldown clock.
    /// @dev The full current bond is placed in cooldown; the updater is immediately
    ///      not bonded (see `isBonded`). Slashing can still take from cooling-down
    ///      funds (see `slash`).
    function requestUnstake() external {
        uint256 bond = _bonds[msg.sender];
        if (bond == 0) revert OracleBond_NoBond();
        if (_unstakeUnlockAt[msg.sender] != 0) revert OracleBond_UnstakeAlreadyPending();

        // forge-lint: disable-next-line(block-timestamp)
        uint64 unlockAt = uint64(block.timestamp + cooldown);
        _unstakeUnlockAt[msg.sender] = unlockAt;

        emit UnstakeRequested(msg.sender, bond, unlockAt);
    }

    /// @notice Claims the unstaked bond after the cooldown has elapsed.
    /// @dev Transfers whatever remains of the bond (post-slash, if any) to the updater.
    function claimUnstake() external nonReentrant {
        uint64 unlockAt = _unstakeUnlockAt[msg.sender];
        if (unlockAt == 0) revert OracleBond_NoUnstakePending();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < unlockAt) revert OracleBond_CooldownNotElapsed(unlockAt);

        uint256 amount = _bonds[msg.sender];
        _bonds[msg.sender] = 0;
        _unstakeUnlockAt[msg.sender] = 0;

        spore.safeTransfer(msg.sender, amount);

        emit UnstakeClaimed(msg.sender, amount);
    }

    /// @notice Cancels a pending unstake request. The updater is instantly re-bonded.
    /// @dev Only clears the request; funds never left the contract.
    function cancelUnstake() external {
        if (_unstakeUnlockAt[msg.sender] == 0) revert OracleBond_NoUnstakePending();
        _unstakeUnlockAt[msg.sender] = 0;

        emit UnstakeCancelled(msg.sender);
    }

    /// @notice Slashes `amount` $SPORE from an updater's bond to the treasury.
    /// @dev DESIGN DECISION — slash scope: the slash applies to the TOTAL bond,
    ///      INCLUDING funds in cooldown (pending unstake). Rationale: a misbehaving
    ///      updater must not be able to dodge a slash by requesting unstake first;
    ///      accountability must outlive the cooldown clock.
    /// @param updater The updater to slash.
    /// @param amount Amount of $SPORE to slash (must be <= total bond).
    /// @param reason Human-readable reason for the slash (recorded on-chain).
    function slash(address updater, uint256 amount, string calldata reason) external nonReentrant onlyRole(SLASHER_ROLE) {
        uint256 bond = _bonds[updater];
        if (amount > bond) revert OracleBond_SlashExceedsBond(amount, bond);

        _bonds[updater] = bond - amount;
        spore.safeTransfer(treasury, amount);

        emit Slashed(updater, amount, reason, msg.sender);
    }

    /// @notice Sets the treasury address receiving slashed $SPORE. Admin only.
    /// @param treasury_ New treasury address.
    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert OracleBond_ZeroAddress();
        address oldTreasury = treasury;
        treasury = treasury_;
        emit TreasuryUpdated(oldTreasury, treasury_);
    }

    /// @notice Sets the minimum bond. Admin only.
    /// @dev Does NOT retroactively unbond anyone; `isBonded()` immediately reflects
    ///      the new bar, so a raise can flip previously-bonded updaters to unbonded
    ///      (they must top up via `stake`), and a lower can bond previously-unbonded
    ///      ones without any further action.
    /// @param minBond_ New minimum bond (18-decimal $SPORE).
    function setMinBond(uint256 minBond_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldMinBond = minBond;
        minBond = minBond_;
        emit MinBondUpdated(oldMinBond, minBond_);
    }

    /// @notice Sets the unstake cooldown in seconds. Admin only.
    /// @param cooldown_ New cooldown (must be <= MAX_COOLDOWN = 60 days).
    function setCooldown(uint256 cooldown_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (cooldown_ > MAX_COOLDOWN) revert OracleBond_CooldownTooLong(cooldown_, MAX_COOLDOWN);
        uint256 oldCooldown = cooldown;
        cooldown = cooldown_;
        emit CooldownUpdated(oldCooldown, cooldown_);
    }
}
