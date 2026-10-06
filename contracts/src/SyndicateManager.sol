// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/ISpore.sol";

/// @title SyndicateManager
/// @notice Syndicated loans for SPORE agents: many backers co-fund one large loan to an
///         agent, splitting fees pro-rata. The borrower proposes (or accepts) a loan;
///         backers commit slices during a funding window; once the target is reached the
///         loan activates and funds flow to the agent's wallet. Repayments are split
///         pro-rata among backers. Missed repay deadlines trigger a default state where
///         backers claim their share of whatever was recovered.
/// @dev Trust assumptions:
///      - The registry is trusted to report the correct wallet for each agent id.
///      - The asset token is assumed to be a standard ERC20 (no fee-on-transfer / rebasing).
///      - Backers bear default risk: there is no insurance or protocol backstop in v1.
///      - The UNDERWRITER_ROLE can pause funding of new loans; it cannot touch escrowed funds.
contract SyndicateManager is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Role allowed to pause/unpause new loan proposals and funding.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Hard cap on the borrower-offered fee, in basis points (50%).
    uint16 public constant MAX_FEE_BPS = 5000;

    /// @notice Minimum funding window (1 hour) to prevent flash ambushes.
    uint256 public constant MIN_FUNDING_WINDOW = 1 hours;

    /// @notice Maximum funding window (30 days).
    uint256 public constant MAX_FUNDING_WINDOW = 30 days;

    /*//////////////////////////////////////////////////////////////
                               STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The funding asset (USDG).
    IERC20 public immutable asset;

    /// @notice The agent registry, used to resolve agent wallets.
    ISporeRegistry public registry;

    enum Status {
        Funding,   // accepting backer commitments
        Active,    // target reached, funds released to borrower, awaiting repayment
        Repaid,    // fully repaid, backers can claim
        Defaulted, // repay deadline passed with balance owing, backers can claim recovery
        Cancelled  // funding target missed, backers can reclaim
    }

    struct Loan {
        uint256 agentId;
        address borrower;      // agent wallet at proposal time
        uint256 target;        // total funding wanted (asset units)
        uint256 funded;        // committed so far
        uint256 repaid;        // repaid so far (principal + fee portion combined)
        uint256 claimBase;     // denominator for pro-rata claims (target, or funded on cancel)
        uint256 feeBps;        // fee offered by borrower, in bps on principal
        uint256 fundingDeadline;
        uint256 repayDeadline;
        Status status;
        string purpose;
    }

    /// @notice loanId => Loan.
    mapping(uint256 => Loan) public loans;

    /// @notice loanId => backer => committed amount.
    mapping(uint256 => mapping(address => uint256)) public shares;

    /// @notice loanId => backer => amount already claimed.
    mapping(uint256 => mapping(address => uint256)) public claimed;

    /// @notice loanId => list of backers (for UI enumeration).
    mapping(uint256 => address[]) public backerList;

    /// @notice loanId => backer => true if ever funded (dedupes backerList).
    mapping(uint256 => mapping(address => bool)) public isBacker;

    /// @notice Next loan id.
    uint256 public nextLoanId = 1;

    /*//////////////////////////////////////////////////////////////
                               EVENTS
    //////////////////////////////////////////////////////////////*/

    event LoanProposed(
        uint256 indexed loanId,
        uint256 indexed agentId,
        address indexed borrower,
        uint256 target,
        uint256 feeBps,
        uint256 fundingDeadline,
        uint256 repayDeadline,
        string purpose
    );
    event Funded(uint256 indexed loanId, address indexed backer, uint256 amount, uint256 totalFunded);
    event Activated(uint256 indexed loanId, uint256 amount);
    event Repaid(uint256 indexed loanId, address indexed payer, uint256 amount, uint256 totalRepaid);
    event Claimed(uint256 indexed loanId, address indexed backer, uint256 amount);
    event Defaulted(uint256 indexed loanId, uint256 repaid, uint256 owed);
    event Cancelled(uint256 indexed loanId);

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _asset, address _registry, address admin) {
        require(_asset != address(0), "Syndicate: asset zero");
        require(_registry != address(0), "Syndicate: registry zero");
        asset = IERC20(_asset);
        registry = ISporeRegistry(_registry);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /*//////////////////////////////////////////////////////////////
                           LOAN LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Propose a syndicated loan for a registered agent.
    /// @param agentId The agent the loan is for.
    /// @param target Total funding wanted, in asset units.
    /// @param feeBps Fee the borrower offers backers, in basis points on principal.
    /// @param fundingWindow How long backers have to fund (seconds).
    /// @param tenor How long the borrower has to repay after activation (seconds).
    /// @param purpose Human-readable purpose (e.g. "H100 cluster, 72h render job").
    function propose(
        uint256 agentId,
        uint256 target,
        uint16 feeBps,
        uint256 fundingWindow,
        uint256 tenor,
        string calldata purpose
    ) external whenNotPaused returns (uint256 loanId) {
        require(target > 0, "Syndicate: target zero");
        require(feeBps <= MAX_FEE_BPS, "Syndicate: fee too high");
        require(fundingWindow >= MIN_FUNDING_WINDOW && fundingWindow <= MAX_FUNDING_WINDOW, "Syndicate: bad window");
        require(tenor > 0, "Syndicate: tenor zero");
        require(bytes(purpose).length > 0, "Syndicate: purpose empty");

        address borrower = registry.agentOwner(agentId); // reverts for unknown agents

        loanId = nextLoanId++;
        Loan storage l = loans[loanId];
        l.agentId = agentId;
        l.borrower = borrower;
        l.target = target;
        l.feeBps = feeBps;
        l.fundingDeadline = block.timestamp + fundingWindow;
        // repayDeadline is set at activation (tenor starts when funds release)
        l.repayDeadline = 0;
        l.status = Status.Funding;
        l.purpose = purpose;

        // stash tenor in a transient way: reuse repayDeadline slot pre-activation
        // (set properly on activate). Store tenor via purpose? No — store in funded? No.
        // Cleanest: separate mapping.
        tenors[loanId] = tenor;

        emit LoanProposed(loanId, agentId, borrower, target, feeBps, l.fundingDeadline, 0, purpose);
    }

    /// @notice Back a loan during its funding window.
    function fund(uint256 loanId, uint256 amount) external nonReentrant whenNotPaused {
        Loan storage l = loans[loanId];
        require(l.status == Status.Funding, "Syndicate: not funding");
        require(block.timestamp <= l.fundingDeadline, "Syndicate: funding closed");
        require(amount > 0, "Syndicate: amount zero");
        require(l.funded + amount <= l.target, "Syndicate: over target");

        if (!isBacker[loanId][msg.sender]) {
            isBacker[loanId][msg.sender] = true;
            backerList[loanId].push(msg.sender);
        }
        shares[loanId][msg.sender] += amount;
        l.funded += amount;

        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(loanId, msg.sender, amount, l.funded);
    }

    /// @notice Activate a fully-funded loan: release funds to the borrower, start the tenor.
    function activate(uint256 loanId) external nonReentrant {
        Loan storage l = loans[loanId];
        require(l.status == Status.Funding, "Syndicate: not funding");
        require(l.funded == l.target, "Syndicate: target not reached");

        l.status = Status.Active;
        l.repayDeadline = block.timestamp + tenors[loanId];
        l.claimBase = l.target;

        asset.safeTransfer(l.borrower, l.target);
        emit Activated(loanId, l.target);
    }

    /// @notice Repay (partially or fully). Anyone can pay on the borrower's behalf.
    function repay(uint256 loanId, uint256 amount) external nonReentrant {
        Loan storage l = loans[loanId];
        require(l.status == Status.Active, "Syndicate: not active");
        require(amount > 0, "Syndicate: amount zero");

        uint256 owed = totalOwed(loanId);
        uint256 pay = amount > owed ? owed : amount;
        l.repaid += pay;

        asset.safeTransferFrom(msg.sender, address(this), pay);
        emit Repaid(loanId, msg.sender, pay, l.repaid);

        if (l.repaid >= owed) {
            l.status = Status.Repaid;
        }
    }

    /// @notice Backers claim their pro-rata share once repaid or defaulted.
    function claim(uint256 loanId) external nonReentrant {
        Loan storage l = loans[loanId];
        require(
            l.status == Status.Repaid || l.status == Status.Defaulted || l.status == Status.Cancelled,
            "Syndicate: not claimable"
        );
        uint256 share = shares[loanId][msg.sender];
        require(share > 0, "Syndicate: no share");

        uint256 entitlement = (l.repaid * share) / l.claimBase;
        uint256 already = claimed[loanId][msg.sender];
        require(entitlement > already, "Syndicate: nothing to claim");

        uint256 payout = entitlement - already;
        claimed[loanId][msg.sender] = entitlement;

        asset.safeTransfer(msg.sender, payout);
        emit Claimed(loanId, msg.sender, payout);
    }

    /// @notice Anyone can mark a loan defaulted after the repay deadline with balance owing.
    function markDefault(uint256 loanId) external {
        Loan storage l = loans[loanId];
        require(l.status == Status.Active, "Syndicate: not active");
        require(block.timestamp > l.repayDeadline, "Syndicate: tenor not elapsed");
        require(l.repaid < totalOwed(loanId), "Syndicate: fully repaid");

        l.status = Status.Defaulted;
        emit Defaulted(loanId, l.repaid, totalOwed(loanId));
    }

    /// @notice Anyone can cancel an underfunded loan after the funding deadline; backers reclaim.
    function cancel(uint256 loanId) external {
        Loan storage l = loans[loanId];
        require(l.status == Status.Funding, "Syndicate: not funding");
        require(block.timestamp > l.fundingDeadline, "Syndicate: funding open");
        require(l.funded < l.target, "Syndicate: target reached");

        l.status = Status.Cancelled;
        // On cancel, "repaid" is set to funded so claim() refunds pro-rata (= full refund).
        l.repaid = l.funded;
        l.claimBase = l.funded;
        emit Cancelled(loanId);
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Tenor per loan (set at proposal, consumed at activation).
    mapping(uint256 => uint256) public tenors;

    /// @notice Total owed by the borrower: principal + fee.
    function totalOwed(uint256 loanId) public view returns (uint256) {
        Loan storage l = loans[loanId];
        return l.target + (l.target * l.feeBps) / 10_000;
    }

    /// @notice Amount still owed.
    function outstanding(uint256 loanId) external view returns (uint256) {
        Loan storage l = loans[loanId];
        uint256 owed = totalOwed(loanId);
        return owed > l.repaid ? owed - l.repaid : 0;
    }

    /// @notice Backers of a loan (for UI enumeration).
    function backers(uint256 loanId) external view returns (address[] memory) {
        return backerList[loanId];
    }

    /// @notice Claimable amount for a backer right now (0 unless claimable state).
    function claimable(uint256 loanId, address backer) external view returns (uint256) {
        Loan storage l = loans[loanId];
        if (
            l.status != Status.Repaid &&
            l.status != Status.Defaulted &&
            l.status != Status.Cancelled
        ) return 0;
        uint256 share = shares[loanId][backer];
        if (share == 0) return 0;
        uint256 entitlement = (l.repaid * share) / l.claimBase;
        uint256 already = claimed[loanId][backer];
        return entitlement > already ? entitlement - already : 0;
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setRegistry(address _registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_registry != address(0), "Syndicate: registry zero");
        registry = ISporeRegistry(_registry);
    }
}
