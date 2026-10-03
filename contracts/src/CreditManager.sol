// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/ISpore.sol";

/// @title CreditManager
/// @notice Manages per-agent credit lines for the SPORE credit protocol: issuance, limit changes,
///         borrowing (funded by the BackerVault), repayment, and default write-down.
/// @dev Trust assumptions:
///      - The registry is trusted to enforce agent existence (reverts for unknown ids) and to report
///        the correct owner of each agent.
///      - The oracle is trusted to report accurate scores, limits and freshness.
///      - The vault is trusted to fund borrows and to call `markDefaulted` only for genuine defaults.
///      - The fee router is trusted to account for fee tokens pushed to it via `safeTransfer`.
///      - The UNDERWRITER_ROLE is trusted: it bears the risk for bootstrap agents (no oracle record),
///        for merchant allow-listing, and for line issuance parameters.
///      - The asset token is assumed to be a standard ERC20 (no fee-on-transfer / rebasing behaviour).
contract CreditManager is ICreditManager, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Role allowed to issue lines, change limits, close lines and manage merchants.
    bytes32 public constant UNDERWRITER_ROLE = keccak256("UNDERWRITER_ROLE");

    /// @notice Role allowed to pause and unpause risk-increasing operations.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Hard cap on the per-line fee, in basis points (20%).
    uint16 public constant MAX_FEE_BPS = 2000;

    /*//////////////////////////////////////////////////////////////
                               STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The credit asset (the token borrowed and repaid).
    IERC20 public immutable asset;

    /// @notice The agent registry.
    ISporeRegistry public registry;

    /// @notice The score oracle. Satisfies `ICreditManager.oracle()`.
    /// @dev Stored as a raw address because the interface getter returns `address`;
    ///      use `_oracle()` for the typed interface.
    address public override oracle;

    /// @notice Authoritative freshness window (seconds) for borrow/issueLine/setLimit gating,
    ///         per the frozen interface. The oracle's own window is informational for off-chain consumers.
    uint64 public maxStalePeriod;

    /// @notice The BackerVault funding borrows. Satisfies `ICreditManager.vault()`.
    address public vault;

    /// @notice The fee router receiving fee tokens. Satisfies `ICreditManager.feeRouter()`.
    address public feeRouter;

    /// @dev agentId => credit line.
    mapping(uint256 => CreditLine) private _lines;

    /// @dev merchant => whether borrowing proceeds may be sent to it.
    mapping(address => bool) private _merchantAllowed;

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploys the CreditManager.
    /// @dev vault and feeRouter are wired post-deploy via `setVault` / `setFeeRouter`.
    ///      Reverts `Spore_ZeroAddress` if any address argument is zero.
    ///      NOTE: the admin role is granted with the internal `_grantRole`, because the deployer holds no
    ///      role at construction time and OZ v5's public `grantRole` would therefore always revert.
    /// @param asset_ The credit asset.
    /// @param registry_ The agent registry.
    /// @param oracle_ The score oracle.
    /// @param admin_ The initial DEFAULT_ADMIN_ROLE holder.
    /// @param maxStalePeriod_ Initial stale period (informational; see `maxStalePeriod`).
    constructor(address asset_, address registry_, address oracle_, address admin_, uint64 maxStalePeriod_) {
        if (asset_ == address(0) || registry_ == address(0) || oracle_ == address(0) || admin_ == address(0)) {
            revert Spore_ZeroAddress();
        }
        asset = IERC20(asset_);
        registry = ISporeRegistry(registry_);
        oracle = oracle_;
        maxStalePeriod = maxStalePeriod_;

        _setRoleAdmin(UNDERWRITER_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(PAUSER_ROLE, DEFAULT_ADMIN_ROLE);
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Returns the line for `agentId`, reverting if it is not active or has defaulted.
    /// @param agentId The agent id.
    /// @return line Storage pointer to the credit line.
    function _requireActiveLine(uint256 agentId) internal view returns (CreditLine storage line) {
        line = _lines[agentId];
        if (!line.active) revert Spore_NoActiveLine(agentId);
        if (line.defaulted) revert Spore_LineDefaulted(agentId);
    }

    /// @dev Typed view of the oracle address.
    /// @return The oracle as IScoreOracle.
    function _oracle() internal view returns (IScoreOracle) {
        return IScoreOracle(oracle);
    }

    /// @dev Oracle gate for limit-setting. If the oracle has a record, it must be fresh against THIS
    ///      contract's `maxStalePeriod` (authoritative per the frozen interface) and the requested
    ///      limit must not exceed the oracle limit. If there is no record, this is bootstrap
    ///      mode: bootstrap agents borrow before the first scoring run, and the UNDERWRITER_ROLE bears
    ///      that risk (trust assumption).
    /// @param agentId The agent id.
    /// @param requestedLimit The limit being requested.
    function _oracleGate(uint256 agentId, uint256 requestedLimit) internal view {
        if (_oracle().hasScore(agentId)) {
            ScoreData memory s = _requireFreshScore(agentId);
            if (requestedLimit > s.limit) {
                revert Spore_ExceedsOracleLimit(agentId, requestedLimit, s.limit);
            }
        }
        // else: bootstrap — no oracle record; underwriter bears the risk.
    }

    /// @dev Loads the agent's score and enforces freshness against this contract's
    ///      `maxStalePeriod`. Reverts Spore_NoOracleData if no record exists.
    /// @param agentId The agent id.
    /// @return s The fresh ScoreData.
    function _requireFreshScore(uint256 agentId) internal view returns (ScoreData memory s) {
        s = _oracle().getScore(agentId);
        // Read once into a local: the staleness window is days-scale, so
        // validator-level timestamp variance (seconds) is immaterial.
        uint256 now_ = block.timestamp;
        // A future-dated score is treated as stale (defensive; not expected in practice).
        if (s.updatedAt > now_) revert Spore_StaleOracleData(agentId, s.updatedAt);
        if (now_ - s.updatedAt > maxStalePeriod) {
            revert Spore_StaleOracleData(agentId, s.updatedAt);
        }
    }

    /*//////////////////////////////////////////////////////////////
                          UNDERWRITER ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Issues a new credit line for an active agent.
    /// @dev Blocked while paused. The registry reverts for unknown agent ids; that revert is not caught.
    /// @param agentId The agent id.
    /// @param limit Credit limit (non-zero).
    /// @param feeBps Fee in basis points, at most `MAX_FEE_BPS`.
    function issueLine(uint256 agentId, uint256 limit, uint16 feeBps)
        external
        onlyRole(UNDERWRITER_ROLE)
        whenNotPaused
    {
        // Registry reverts Spore_AgentNotFound for unknown ids — we trust it to enforce existence.
        AgentRecord memory agent = registry.getAgent(agentId);
        if (!agent.active) revert Spore_AgentNotActive(agentId);
        // Default is terminal: a defaulted line can never be re-issued (frozen spec).
        if (_lines[agentId].defaulted) revert Spore_LineDefaulted(agentId);
        if (_lines[agentId].active) revert Spore_LineAlreadyActive(agentId);
        if (limit == 0) revert Spore_ZeroAmount();
        if (feeBps > MAX_FEE_BPS) revert Spore_FeeBpsTooHigh(feeBps);
        _oracleGate(agentId, limit);

        _lines[agentId] = CreditLine(limit, 0, 0, feeBps, uint64(block.timestamp), true, false);
        emit CreditIssued(agentId, limit, feeBps);
    }

    /// @notice Changes the limit of an active line.
    /// @dev Blocked while paused. Subject to the oracle gate.
    /// @param agentId The agent id.
    /// @param newLimit New non-zero limit.
    function setLimit(uint256 agentId, uint256 newLimit) external onlyRole(UNDERWRITER_ROLE) whenNotPaused {
        CreditLine storage line = _requireActiveLine(agentId);
        // The oracle gate applies ONLY on increases — decreases (including to 0
        // = freeze) are always allowed, even on stale oracle data (frozen spec).
        if (newLimit > line.limit) _oracleGate(agentId, newLimit);
        uint256 old = line.limit;
        line.limit = newLimit;
        emit CreditLimitChanged(agentId, old, newLimit);
    }

    /// @notice Closes a debt-free line.
    /// @dev NOT pausable: closing a line unwinds risk, so it must remain available under pause.
    /// @param agentId The agent id.
    function closeLine(uint256 agentId) external onlyRole(UNDERWRITER_ROLE) {
        CreditLine storage line = _requireActiveLine(agentId);
        if (line.drawn != 0 || line.feeOwed != 0) revert Spore_LineHasDebt(agentId, line.drawn);
        // Historical data is retained in storage for the indexer; only the active flag is cleared.
        line.active = false;
    }

    /// @notice Allows or disallows a merchant as a borrow destination.
    /// @dev No event is emitted because the frozen event set contains no merchant-allowlist event.
    /// @param merchant The merchant address (non-zero).
    /// @param allowed Whether the merchant is allowed.
    function setMerchantAllowed(address merchant, bool allowed) external onlyRole(UNDERWRITER_ROLE) {
        if (merchant == address(0)) revert Spore_ZeroAddress();
        _merchantAllowed[merchant] = allowed;
    }

    /*//////////////////////////////////////////////////////////////
                           BORROW / REPAY
    //////////////////////////////////////////////////////////////*/

    /// @notice Borrows against a line, paying an allow-listed merchant directly from the vault.
    /// @dev Blocked while paused. Only the agent owner may call. In bootstrap mode (no oracle record)
    ///      borrows stay open; if an oracle record exists it must be fresh. The fee is
    ///      `amount * feeBps / 10000` and rounds down (intended). The `Payment` event is the settlement
    ///      leg of the borrow. The vault is trusted to fund the merchant.
    /// @param agentId The agent id.
    /// @param amount Amount to borrow (non-zero).
    /// @param merchant Destination merchant (must be allow-listed).
    function borrow(uint256 agentId, uint256 amount, address merchant) external nonReentrant whenNotPaused {
        // Authentication first, before any other check.
        if (registry.agentOwner(agentId) != msg.sender) revert Spore_NotAgentOwner(agentId, msg.sender);
        CreditLine storage line = _requireActiveLine(agentId);
        if (amount == 0) revert Spore_ZeroAmount();
        if (merchant == address(0)) revert Spore_ZeroAddress();
        if (!_merchantAllowed[merchant]) revert Spore_MerchantNotAllowed(merchant);
        // Saturating: a limit cut can leave drawn > limit (frozen line); available is then 0.
        uint256 available = line.limit > line.drawn ? line.limit - line.drawn : 0;
        if (amount > available) {
            revert Spore_ExceedsLimit(agentId, amount, available);
        }
        // Bootstrap mode (no oracle record) stays open for borrows; otherwise the score must be
        // fresh against this contract's maxStalePeriod (authoritative per the frozen interface).
        if (_oracle().hasScore(agentId)) {
            _requireFreshScore(agentId);
        }

        // Fee rounds down by integer division (intended).
        uint256 fee = (amount * uint256(line.feeBps)) / 10000;

        // Effects before interaction.
        line.drawn += amount;
        line.feeOwed += fee;

        IBackerVault(vault).fundBorrow(agentId, merchant, amount);

        emit Borrow(agentId, amount, fee);
        emit Payment(agentId, merchant, amount);
    }

    /// @notice Repays debt on a line. Anyone may repay on behalf of an agent.
    /// @dev NOT pausable: repayment must stay open even when paused so defaults remain resolvable.
    ///      Fees are repaid first, then principal; overpayment is returned to the caller.
    ///      Defaulted lines are written off and accept no repayment.
    /// @param agentId The agent id.
    /// @param amount Amount offered (non-zero).
    function repay(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert Spore_ZeroAmount();
        CreditLine storage line = _requireActiveLine(agentId);

        // Collect first. If the token's transferFrom fails, everything reverts before any state change.
        asset.safeTransferFrom(msg.sender, address(this), amount);

        uint256 feeOwed = line.feeOwed;
        uint256 feePortion = amount < feeOwed ? amount : feeOwed;
        uint256 principalPortion = amount - feePortion;
        uint256 excess;
        if (principalPortion > line.drawn) {
            excess = principalPortion - line.drawn;
            principalPortion = line.drawn;
        }

        // Effects before any external calls.
        line.feeOwed -= feePortion;
        line.drawn -= principalPortion;

        if (feePortion > 0) {
            asset.safeTransfer(feeRouter, feePortion);
            IFeeRouter(feeRouter).collectFee(agentId, feePortion);
        }
        if (principalPortion > 0) {
            asset.safeTransfer(vault, principalPortion);
            IBackerVault(vault).receiveRepay(agentId, principalPortion);
        }
        if (excess > 0) {
            asset.safeTransfer(msg.sender, excess);
        }

        emit Repay(agentId, msg.sender, amount, feePortion);
    }

    /*//////////////////////////////////////////////////////////////
                               DEFAULT
    //////////////////////////////////////////////////////////////*/

    /// @notice Writes off a line as defaulted. Callable only by the vault.
    /// @dev NOT pausable: defaults must always be resolvable even under pause. The line stays `active`
    ///      so the record reads as "issued, defaulted". Reverts `Spore_ZeroAmount` if there is no debt to
    ///      write down. The vault is trusted to supply accurate `coveredAmount` / `shortfall` values.
    /// @param agentId The agent id.
    /// @param coveredAmount Amount covered by backers (reported in the event).
    /// @param shortfall Amount not covered (reported in the event).
    function markDefaulted(uint256 agentId, uint256 coveredAmount, uint256 shortfall) external {
        // Access control before any state read.
        if (msg.sender != vault) revert Spore_OnlyBackerVault(msg.sender);
        CreditLine storage line = _requireActiveLine(agentId);
        if (line.drawn == 0) revert Spore_NothingToDefault(agentId);

        uint256 drawnAmount = line.drawn;
        // The vault's accounting must exactly cover the drawn amount (frozen spec).
        if (coveredAmount + shortfall != drawnAmount) {
            revert Spore_DefaultMismatch(agentId, drawnAmount, coveredAmount, shortfall);
        }
        line.drawn = 0;
        line.feeOwed = 0;
        line.defaulted = true;
        line.active = false;

        emit Default(agentId, drawnAmount, coveredAmount, shortfall);
    }

    /*//////////////////////////////////////////////////////////////
                               WIRING
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the BackerVault. Admin only. Accepted admin-trust assumption per the frozen
    /// interface: not set-once — a compromised admin key could re-point wiring (multisig +
    /// monitoring are the mitigations; see the interface NatSpec).
    /// @param v The vault address (non-zero).
    function setVault(address v) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (v == address(0)) revert Spore_ZeroAddress();
        vault = v;
    }

    /// @notice Sets the fee router. Admin only. Accepted admin-trust assumption per the frozen
    /// interface: not set-once (see setVault note).
    /// @dev No approvals are granted: this contract PUSHES fee tokens to the router via safeTransfer,
    ///      so the router needs no allowance.
    /// @param f The fee router address (non-zero).
    function setFeeRouter(address f) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (f == address(0)) revert Spore_ZeroAddress();
        feeRouter = f;
    }

    /// @notice Sets the score oracle. Admin only.
    /// @param o The oracle address (non-zero).
    function setOracle(address o) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (o == address(0)) revert Spore_ZeroAddress();
        oracle = o;
    }

    /// @notice Sets the registry. Admin only.
    /// @param r The registry address (non-zero).
    function setRegistry(address r) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (r == address(0)) revert Spore_ZeroAddress();
        registry = ISporeRegistry(r);
    }

    /// @notice Sets the authoritative freshness window used by `_requireFreshScore`. Admin only.
    /// @param p The new stale period in seconds.
    function setMaxStalePeriod(uint64 p) external onlyRole(DEFAULT_ADMIN_ROLE) {
            maxStalePeriod = p;
        }

    /*//////////////////////////////////////////////////////////////
                                PAUSE
    //////////////////////////////////////////////////////////////*/

    /// @notice Pauses issueLine, setLimit and borrow. Does NOT block repay, closeLine or markDefaulted.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpauses the contract.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @dev Resolves the Pausable/ICreditManager `paused()` diamond.
    function paused() public view override(Pausable, ICreditManager) returns (bool) {
        return super.paused();
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the full credit line for an agent.
    /// @param agentId The agent id.
    /// @return The credit line.
    function getLine(uint256 agentId) external view returns (CreditLine memory) {
        return _lines[agentId];
    }

    /// @notice Returns outstanding principal and fees for an agent.
    /// @param agentId The agent id.
    /// @return drawn Outstanding principal.
    /// @return feeOwed Outstanding fees.
    function outstandingOf(uint256 agentId) external view returns (uint256 drawn, uint256 feeOwed) {
        CreditLine storage line = _lines[agentId];
        return (line.drawn, line.feeOwed);
    }

    /// @notice Returns how much the agent can still borrow.
    /// @param agentId The agent id.
    /// @return Remaining headroom; zero if the line is inactive or defaulted.
    function availableToBorrow(uint256 agentId) external view returns (uint256) {
        CreditLine storage line = _lines[agentId];
        if (!line.active || line.defaulted) return 0;
        if (line.drawn >= line.limit) return 0; // line frozen or over-drawn after a limit cut
        return line.limit - line.drawn;
    }

    /// @notice Returns whether a merchant is allow-listed as a borrow destination.
    /// @param merchant The merchant address.
    /// @return True if the merchant is allowed.
    function isMerchantAllowed(address merchant) external view returns (bool) {
        return _merchantAllowed[merchant];
    }
}
