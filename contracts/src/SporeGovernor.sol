// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from
    "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from
    "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title SporeGovernor
/// @notice On-chain governance for the SPORE protocol. Voting power comes from
///         vSPORE (SporeVotes), the 1:1 $SPORE wrapper; proposals execute
///         through a 2-day TimelockController.
///
///         GOVERNANCE PARAMETERS (frozen at deploy):
///         - Voting token: vSPORE (ERC20Votes wrapper of $SPORE 0xa5127fae2d0986a4cb6619b9c4ec53461726454b)
///         - Voting delay: 7,200 blocks. Block-time based (Governor default
///           ERC-6372 clock is block-number). At 12s/block this is ~1 day; on
///           Base (2s/block) it is ~4 hours. Chosen in blocks deliberately: a
///           timestamp clock would drift with miner/sequencer variance.
///         - Voting period: 50,400 blocks (~7 days at 12s/block, ~28h at 2s).
///         - Proposal threshold: 100,000 vSPORE (100_000e18).
///         - Quorum: 4% of vSPORE total supply at the proposal snapshot block.
///         - Timelock: 172,800 seconds (2 days) between queue and execute;
///           proposers = [governor only], executors = [address(0)] = open
///           execution (anyone may execute a ready proposal — keeps the DAO
///           from depending on a keeper); timelock admin = deployer at birth
///           (see migration path below).
///
///         LIFECYCLE OF A PROPOSAL: propose (threshold 100k vSPORE) ->
///         Pending (7,200 blocks) -> Active (50,400 blocks of For/Against/
///         Abstain voting; quorum counts For+Abstain) -> Succeeded (if For >
///         Against AND quorum met) -> Queued on the timelock -> Executed
///         after the 2-day delay, with `msg.sender == timelock` for the call.
///         Failed proposals (quorum missed or Against wins) end as Defeated.
///
///         ==================================================================
///         GOVERNANCE MIGRATION MAP — admin roles this governor should own
///         ==================================================================
///         The v1 core contracts are IMMUTABLE (FeeRouter
///         0x8F921bF51D603B5ACa827C0adA822aF5259057cc, BackerVault
///         0xF574091D96518F065f772a1231EBB9dC1AaB2694, ScoreOracle
///         0x31088a5516816ffb050846f6Ae4d460EB32000c4 are deployed and cannot
///         be changed). Governance controls them only where their admin roles
///         are granted to the timelock. The new (v2) modules below are built
///         with governance as the intended final owner.
///
///         V1 CORE (grant to timelock at the migration ceremony):
///         1. FeeRouter — DEFAULT_ADMIN_ROLE: controls the fee-split params
///            (`setTreasury`, `setVault`, `setSplit`). Migration: grant
///            DEFAULT_ADMIN_ROLE on FeeRouter to the TimelockController, then
///            renounce from the deployer.
///         2. BackerVault — DEFAULT_ADMIN_ROLE: controls vault params
///            (e.g. `setFeeRouter`, yield/fee setters as defined). Migration:
///            grant to the timelock, renounce from the deployer.
///         3. ScoreOracle — ORACLE_UPDATER_ROLE + DEFAULT_ADMIN_ROLE:
///            controls who may post scores (`ORACLE_UPDATER_ROLE` gating) and
///            admin-level oracle params. Migration: grant both to the
///            timelock (or a dedicated updater multisig), renounce deployer.
///         4. CreditManager — merchant allowlist management (the allowlist
///            gating for merchants lives here): grant its DEFAULT_ADMIN_ROLE
///            to the timelock so allowlist adds/removals go through proposals.
///
///         NEW V2 MODULES (assign to timelock/governor at deploy of each):
///         5. SporeBuyback — router/params admin (buyback routing, fee/timing
///            params): deploy with the TimelockController as admin.
///         6. BackerSporeStake — reward-rate admin: deploy with the timelock
///            as the rate-setting admin.
///         7. OracleBond — slasher/treasury admin roles: deploy with the
///            timelock holding the slasher and treasury config roles.
///         8. This governor itself — the timelock's own DEFAULT_ADMIN_ROLE:
///            after the migration ceremony, hand the timelock admin to the
///            timelock itself (`timelock` self-administers), so no EOA can
///            grant/revoke proposer/executor roles unilaterally.
///
///         MIGRATION CEREMONY ORDER (must be a deliberate, announced ceremony):
///         a) Deploy SporeVotes -> TimelockController -> SporeGovernor;
///            grant PROPOSER_ROLE to the governor.
///         b) Pass a test proposal end-to-end on mainnet (queue/execute) to
///            prove the path works before any real power moves.
///         c) Grant each target role to the TimelockController address.
///         d) From the deployer EOA, renounce each corresponding role.
///         e) Finally, renounce the deployer's DEFAULT_ADMIN_ROLE on the
///            timelock itself (or grant it to the timelock). After this step
///            the deployer has zero privileged control and only governance
///            proposals can act. NEVER do (d) before (c), and NEVER do (e)
///            before (b)–(d): a renounced role with no timelock grant bricks
///            the parameter forever.
///
///         CANCELLATION: proposer may cancel while Pending. Otherwise only
///         the timelock (i.e. a governance action) can cancel a queued
///         proposal via CANCELLER_ROLE, which timelock proposers hold.
/// @dev Standard OZ 5.x composition. `_executeOperations`/`_queueOperations`
///      are the 5.x split of the old `_execute` hook. No custom storage or
///      privileged functions are added: the governor is a pure OZ wiring.
contract SporeGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    /// @dev Revert on zero-address wiring inputs.
    error SporeGovernor_ZeroAddress();

    /// @param votes_ The SporeVotes (vSPORE) token used for voting power.
    /// @param timelock_ The TimelockController proposals queue into / execute from.
    constructor(IVotes votes_, TimelockController timelock_)
        Governor("SporeGovernor")
        GovernorSettings(
            7_200, // voting delay, ~1 day at 12s/block (see NatSpec)
            50_400, // voting period, ~7 days at 12s/block (see NatSpec)
            100_000e18 // proposal threshold
        )
        GovernorVotes(votes_)
        GovernorVotesQuorumFraction(4) // 4% of vSPORE supply at snapshot
        GovernorTimelockControl(timelock_)
    {
        if (address(votes_) == address(0) || address(timelock_) == address(0)) {
            revert SporeGovernor_ZeroAddress();
        }
    }

    // ---- GovernorSettings wires -----------------------------------------

    /// @dev 7,200 blocks voting delay.
    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    /// @dev 50,400 blocks voting period.
    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    /// @dev 100,000 vSPORE proposal threshold.
    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    // ---- Quorum -----------------------------------------------------------

    /// @dev 4% of vSPORE total supply at `blockNumber`.
    function quorum(uint256 blockNumber)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    // ---- Timelock wires ---------------------------------------------------

    /// @dev Timelock-aware proposal state.
    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    /// @dev Succeeded proposals always need timelock queueing.
    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    /// @dev Schedule the proposal on the timelock (OZ 5.x `_queueOperations`
    ///      hook; replaces the old `_execute` queueing half).
    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    /// @dev Execute via the timelock (OZ 5.x `_executeOperations` hook).
    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    /// @dev Cancel both the governor record and the timelock operation.
    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    /// @dev Proposals execute with `msg.sender == address(timelock)`; only
    ///      the timelock may call `execute` on the governor.
    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    /// @dev ERC-165: expose the Governor interface. (GovernorTimelockControl
    ///      does not override supportsInterface, so `override(Governor)`
    ///      is the required list.)
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(Governor)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
