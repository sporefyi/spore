// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {SporeVotes} from "../src/SporeVotes.sol";
import {SporeGovernor} from "../src/SporeGovernor.sol";

/// @notice Minimal governed target: `setFlag` only runs when called by the timelock.
contract FlagTarget {
    bool public flag;
    address public immutable timelock;

    error FlagTarget_OnlyTimelock(address caller);

    constructor(address timelock_) {
        timelock = timelock_;
    }

    function setFlag() external {
        if (msg.sender != timelock) revert FlagTarget_OnlyTimelock(msg.sender);
        flag = true;
    }
}

contract SporeGovernorTest is Test {
    ERC20Mock internal spore; // mock $SPORE: plain mintable ERC20 (NOT ERC20Votes)
    SporeVotes internal votes;
    TimelockController internal timelock;
    SporeGovernor internal governor;
    FlagTarget internal target;

    address internal admin = address(this);
    address internal proposer;
    address internal voter1;
    address internal voter2;
    address internal smallHolder;
    address internal stranger;

    uint256 internal constant TIMELOCK_DELAY = 172_800; // 2 days
    uint256 internal constant PROPOSAL_THRESHOLD = 100_000e18;
    uint256 internal constant VOTING_DELAY = 7_200;
    uint256 internal constant VOTING_PERIOD = 50_400;

    // uint8 support values: 0 = Against, 1 = For, 2 = Abstain
    uint8 internal constant FOR = 1;

    function setUp() public {
        proposer = makeAddr("proposer");
        voter1 = makeAddr("voter1");
        voter2 = makeAddr("voter2");
        smallHolder = makeAddr("smallHolder");
        stranger = makeAddr("stranger");

        spore = new ERC20Mock();
        votes = new SporeVotes(IERC20(address(spore)));

        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](1);
        executors[0] = address(0); // open execution
        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, admin);

        governor = new SporeGovernor(IVotes(address(votes)), timelock);
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));

        target = new FlagTarget(address(timelock));

        // Fund holders with mock $SPORE.
        spore.mint(proposer, 1_000_000e18);
        spore.mint(voter1, 5_000_000e18);
        spore.mint(voter2, 5_000_000e18);
        spore.mint(smallHolder, 1e18);
    }

    /// @dev Wrap `amount` $SPORE into vSPORE and delegate voting power.
    function _wrapAndDelegate(address user, uint256 amount) internal {
        vm.startPrank(user);
        spore.approve(address(votes), amount);
        votes.wrap(amount);
        votes.delegate(user);
        vm.stopPrank();
        vm.roll(block.number + 1); // checkpoint must settle before reads at clock()-1
    }

    /// @dev Build a single-target proposal calling target.setFlag().
    function _proposalArgs()
        internal
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        targets = new address[](1);
        targets[0] = address(target);
        values = new uint256[](1);
        calldatas = new bytes[](1);
        calldatas[0] = abi.encodeCall(FlagTarget.setFlag, ());
    }

    function _propose(address by, string memory desc) internal returns (uint256) {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _proposalArgs();
        vm.prank(by);
        return governor.propose(targets, values, calldatas, desc);
    }

    // ============================ SporeVotes ============================

    function test_Wrap_Unwrap_OneToOne() public {
        address user = voter1;
        uint256 amount = 1_234_567e18;

        vm.startPrank(user);
        spore.approve(address(votes), amount);
        votes.wrap(amount);
        assertEq(votes.balanceOf(user), amount, "vSPORE minted 1:1");
        assertEq(spore.balanceOf(address(votes)), amount, "SPORE custodied 1:1");

        votes.unwrap(amount);
        vm.stopPrank();

        assertEq(votes.balanceOf(user), 0, "vSPORE burned");
        assertEq(spore.balanceOf(user), 5_000_000e18, "$SPORE fully redeemed");
        assertEq(spore.balanceOf(address(votes)), 0, "no SPORE left in custody");
    }

    function test_Wrap_Unwrap_ZeroAmount_Reverts() public {
        vm.startPrank(voter1);
        vm.expectRevert(SporeVotes.SporeVotes_ZeroAmount.selector);
        votes.wrap(0);
        vm.expectRevert(SporeVotes.SporeVotes_ZeroAmount.selector);
        votes.unwrap(0);
        vm.stopPrank();
    }

    function test_Delegation_VotingPower() public {
        _wrapAndDelegate(voter1, 2_500_000e18);

        assertEq(votes.getVotes(voter1), 2_500_000e18, "self-delegated voting power");

        // Re-delegate to someone else: power moves with the delegation.
        vm.prank(voter1);
        votes.delegate(voter2);
        vm.roll(block.number + 1);
        assertEq(votes.getVotes(voter1), 0, "power left voter1");
        assertEq(votes.getVotes(voter2), 2_500_000e18, "power arrived at voter2");
    }

    // ============================ Governor params ============================

    function test_Governor_Params() public view {
        assertEq(governor.votingDelay(), VOTING_DELAY, "votingDelay");
        assertEq(governor.votingPeriod(), VOTING_PERIOD, "votingPeriod");
        assertEq(governor.proposalThreshold(), PROPOSAL_THRESHOLD, "proposalThreshold");
        assertEq(governor.name(), "SporeGovernor", "name");
        assertEq(timelock.getMinDelay(), TIMELOCK_DELAY, "timelock delay");
        assertTrue(
            timelock.hasRole(timelock.PROPOSER_ROLE(), address(governor)),
            "governor is timelock proposer"
        );
    }

    function test_Quorum_IsFourPercentOfSupply() public {
        _wrapAndDelegate(voter1, 5_000_000e18);
        uint256 snapshot = block.number; // supply checkpointed at this block
        // Quorum reads past total supply: roll so `snapshot` is in the past.
        vm.roll(block.number + 1);
        assertEq(governor.quorum(snapshot), 200_000e18, "quorum = 4% of 5M");
    }

    // ============================ Proposing ============================

    function test_Propose_BelowThreshold_Reverts() public {
        _wrapAndDelegate(smallHolder, 1e18); // 1 vSPORE << 100k threshold

        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _proposalArgs();
        vm.prank(smallHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGovernor.GovernorInsufficientProposerVotes.selector,
                smallHolder,
                1e18,
                PROPOSAL_THRESHOLD
            )
        );
        governor.propose(targets, values, calldatas, "tiny proposal");
    }

    function test_Propose_AtThreshold_Succeeds() public {
        _wrapAndDelegate(proposer, PROPOSAL_THRESHOLD); // exactly 100k vSPORE

        uint256 proposalId = _propose(proposer, "threshold proposal");
        assertEq(
            uint256(governor.state(proposalId)),
            uint256(IGovernor.ProposalState.Pending),
            "new proposal is Pending"
        );
    }

    // ============================ Voting ============================

    function test_Vote_Counted() public {
        _wrapAndDelegate(proposer, PROPOSAL_THRESHOLD);
        _wrapAndDelegate(voter1, 5_000_000e18);

        uint256 proposalId = _propose(proposer, "count my vote");

        vm.roll(block.number + VOTING_DELAY + 1); // enter Active period
        assertEq(
            uint256(governor.state(proposalId)), uint256(IGovernor.ProposalState.Active), "Active"
        );

        vm.prank(voter1);
        governor.castVote(proposalId, FOR);

        assertTrue(governor.hasVoted(proposalId, voter1), "hasVoted");
        (uint256 against, uint256 forVotes, uint256 abstain) = governor.proposalVotes(proposalId);
        assertEq(forVotes, 5_000_000e18, "for votes counted");
        assertEq(against, 0, "no against");
        assertEq(abstain, 0, "no abstain");
    }

    function test_Quorum_NotReached_ProposalDefeated() public {
        // Total vSPORE supply 10.3M -> quorum 412k. Only 200k votes For.
        // (voter2 wraps a large non-voting position so quorum is unreachable.)
        spore.mint(voter2, 10_000_000e18);
        _wrapAndDelegate(voter2, 10_000_000e18);
        _wrapAndDelegate(proposer, PROPOSAL_THRESHOLD);
        _wrapAndDelegate(voter1, 200_000e18);

        uint256 proposalId = _propose(proposer, "low turnout");

        vm.roll(block.number + VOTING_DELAY + 1);
        vm.prank(voter1);
        governor.castVote(proposalId, FOR);

        vm.roll(block.number + VOTING_PERIOD + 1); // past deadline
        assertEq(
            uint256(governor.state(proposalId)),
            uint256(IGovernor.ProposalState.Defeated),
            "below-quorum proposal is Defeated"
        );
    }

    // ============================ Timelock ============================

    function test_TimelockDelay_Enforced_CannotExecuteEarly() public {
        _wrapAndDelegate(proposer, PROPOSAL_THRESHOLD);
        _wrapAndDelegate(voter1, 5_000_000e18);

        uint256 proposalId = _propose(proposer, "early execution attempt");

        vm.roll(block.number + VOTING_DELAY + 1);
        vm.prank(voter1);
        governor.castVote(proposalId, FOR);

        vm.roll(block.number + VOTING_PERIOD + 1);
        assertEq(
            uint256(governor.state(proposalId)),
            uint256(IGovernor.ProposalState.Succeeded),
            "Succeeded with quorum"
        );

        uint256 proposalId2 = governor.queue(
            _proposalTargets(), _proposalValues(), _proposalCalldatas(), keccak256(bytes("early execution attempt"))
        );
        assertEq(proposalId2, proposalId, "queued id matches");
        assertEq(
            uint256(governor.state(proposalId)),
            uint256(IGovernor.ProposalState.Queued),
            "Queued"
        );

        // Direct timelock execution BEFORE the 2-day delay must revert.
        // (GovernorTimelockControl schedules via scheduleBatch, so execution
        // must also be the batch variant with the governor-derived salt.)
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _proposalArgs();
        bytes32 descriptionHash = keccak256(bytes("early execution attempt"));
        bytes32 salt = _timelockSalt(descriptionHash);
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector,
                timelock.hashOperationBatch(targets, values, calldatas, bytes32(0), salt),
                _expectedReadyStateBitmap()
            )
        );
        timelock.executeBatch(targets, values, calldatas, bytes32(0), salt);
    }

    function test_OnlyGovernance_Execution_Reverts() public {
        // The governed function cannot be invoked directly by an EOA...
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(FlagTarget.FlagTarget_OnlyTimelock.selector, stranger)
        );
        target.setFlag();
        assertFalse(target.flag(), "flag unchanged");

        // ...and an operation that governance never scheduled cannot execute
        // through the timelock (execution is open, but only to ready ops).
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _proposalArgs();
        bytes32 bogusSalt = keccak256("never proposed");
        bytes32 bogusId =
            timelock.hashOperation(targets[0], values[0], calldatas[0], bytes32(0), bogusSalt);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector,
                bogusId,
                _expectedReadyStateBitmap()
            )
        );
        timelock.execute(targets[0], values[0], calldatas[0], bytes32(0), bogusSalt);
        assertFalse(target.flag(), "flag still unchanged");
    }

    // ============================ Happy path ============================

    function test_HappyPath_FullLifecycle() public {
        string memory desc = "flip the flag via governance";

        // 1. wrap -> 2. delegate
        _wrapAndDelegate(proposer, PROPOSAL_THRESHOLD);
        _wrapAndDelegate(voter1, 5_000_000e18);

        // 3. propose
        uint256 proposalId = _propose(proposer, desc);
        assertEq(
            uint256(governor.state(proposalId)),
            uint256(IGovernor.ProposalState.Pending),
            "Pending"
        );

        // 4. vote (quorum: 400k of 10.1M supply; 5M For >> quorum)
        vm.roll(block.number + VOTING_DELAY + 1);
        vm.prank(voter1);
        governor.castVote(proposalId, FOR);

        // 5. succeed -> 6. queue
        vm.roll(block.number + VOTING_PERIOD + 1);
        assertEq(
            uint256(governor.state(proposalId)),
            uint256(IGovernor.ProposalState.Succeeded),
            "Succeeded"
        );
        bytes32 descriptionHash = keccak256(bytes(desc));
        governor.queue(_proposalTargets(), _proposalValues(), _proposalCalldatas(), descriptionHash);
        assertEq(
            uint256(governor.state(proposalId)), uint256(IGovernor.ProposalState.Queued), "Queued"
        );
        assertFalse(target.flag(), "flag not yet flipped");

        // 7. warp past the 2-day timelock delay -> 8. execute (open execution:
        //    anyone may call the timelock once the operation is ready).
        //    Batch variant + governor-derived salt, matching _queueOperations.
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _proposalArgs();
        timelock.executeBatch(targets, values, calldatas, bytes32(0), _timelockSalt(descriptionHash));

        assertTrue(target.flag(), "flag flipped by governance");
        assertEq(
            uint256(governor.state(proposalId)),
            uint256(IGovernor.ProposalState.Executed),
            "Executed"
        );
    }

    // ============================ helpers ============================

    function _proposalTargets() internal view returns (address[] memory targets) {
        (targets,,) = _proposalArgs();
    }

    function _proposalValues() internal view returns (uint256[] memory values) {
        (, values,) = _proposalArgs();
    }

    function _proposalCalldatas() internal view returns (bytes[] memory calldatas) {
        (,, calldatas) = _proposalArgs();
    }

    /// @dev Expected-state bitmap for TimelockUnexpectedOperationState when an
    ///      operation exists but is not yet ready: only the Ready bit set.
    function _expectedReadyStateBitmap() internal pure returns (bytes32) {
        // TimelockController._encodeStateBitmap: bit per OperationState enum
        // index. Ready has index 2 (Unset=0, Waiting=1, Ready=2, Done=3).
        return bytes32(uint256(1) << 2);
    }

    /// @dev Mirrors GovernorTimelockControl._timelockSalt: the salt under
    ///      which the governor schedules operations on the timelock.
    function _timelockSalt(bytes32 descriptionHash) internal view returns (bytes32) {
        return bytes20(address(governor)) ^ descriptionHash;
    }
}
