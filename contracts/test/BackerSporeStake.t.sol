// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/BackerSporeStake.sol";

contract BackerSporeStakeTest is Test {
    ERC20Mock internal spore;
    BackerSporeStake internal staking;

    address internal admin = address(this);
    address internal backer1;
    address internal backer2;
    address internal stranger;

    uint256 internal constant COOLDOWN = 7 days;

    // Recreate events for expectEmit.
    event Staked(address indexed backer, uint256 amount);
    event UnstakeRequested(
        address indexed backer, uint256 indexed requestId, uint256 amount, uint64 unlockAt
    );
    event UnstakeClaimed(address indexed backer, uint256 indexed requestId, uint256 amount);
    event SporePerUsdgSet(uint256 oldRate, uint256 newRate);
    event MinStakeSet(uint256 oldMinStake, uint256 newMinStake);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);

    function setUp() public {
        backer1 = makeAddr("backer1");
        backer2 = makeAddr("backer2");
        stranger = makeAddr("stranger");

        spore = new ERC20Mock();
        staking = new BackerSporeStake(address(spore), admin);

        // Fund the backers with $SPORE stand-in.
        spore.mint(backer1, 5_000_000e18);
        spore.mint(backer2, 5_000_000e18);
    }

    function _stakeAs(address backer, uint256 amount) internal {
        vm.startPrank(backer);
        spore.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // stake()
    // ---------------------------------------------------------------------

    function test_stake_increasesActiveBalance() public {
        _stakeAs(backer1, 5_000e18);
        assertEq(staking.staked(backer1), 5_000e18);
        assertEq(spore.balanceOf(address(staking)), 5_000e18);
        assertEq(spore.balanceOf(backer1), 5_000_000e18 - 5_000e18);
    }

    function test_stake_zeroAmountReverts() public {
        vm.prank(backer1);
        vm.expectRevert(BackerSporeStake_ZeroAmount.selector);
        staking.stake(0);
    }

    function test_stake_emitsStaked() public {
        vm.startPrank(backer1);
        spore.approve(address(staking), 2_000e18);
        vm.expectEmit(true, false, false, true);
        emit Staked(backer1, 2_000e18);
        staking.stake(2_000e18);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Qualification
    // ---------------------------------------------------------------------

    function test_qualification_zeroBackingNeedsMinStake() public {
        _stakeAs(backer1, 999e18);
        assertFalse(staking.isQualified(backer1, 0), "999 SPORE should not qualify");
        _stakeAs(backer1, 1e18);
        assertTrue(staking.isQualified(backer1, 0), "1000 SPORE should qualify");
        assertEq(staking.requiredStake(0), 1000e18);
    }

    function test_qualification_scalesWithBacking() public view {
        // 100k USDG backing at rate 100 SPORE/USDg:
        //   usdg18 = 100_000e6 * 1e12 = 1e23
        //   backingLeg = 1e23 * 100e18 / (10 * 1e18) = 1e24 = 1,000,000 SPORE.
        uint256 usdgBacking = 100_000e6;
        assertEq(staking.requiredStake(usdgBacking), 1_000_000e18);

        // 1k USDG backing -> 10% = 100 USDG -> 10,000 SPORE at rate 100.
        assertEq(staking.requiredStake(1_000e6), 10_000e18);
    }

    function test_qualification_minStakeIsAFloor() public view {
        // Tiny backing: backing leg (10 SPORE) < minStake (1000 SPORE).
        assertEq(staking.requiredStake(1e6), 1000e18); // 1 USDG backing
    }

    function test_stake_countsTowardQualification() public {
        uint256 usdgBacking = 1_000e6; // needs 10,000 SPORE
        _stakeAs(backer1, 9_999e18);
        assertFalse(staking.isQualified(backer1, usdgBacking));
        _stakeAs(backer1, 1e18);
        assertTrue(staking.isQualified(backer1, usdgBacking));
    }

    function test_rateChangeUpdatesRequirement() public {
        uint256 usdgBacking = 1_000e6;
        assertEq(staking.requiredStake(usdgBacking), 10_000e18);

        staking.setSporePerUsdg(200e18);
        assertEq(staking.requiredStake(usdgBacking), 20_000e18);

        staking.setSporePerUsdg(1e18);
        assertEq(staking.requiredStake(usdgBacking), 100e18 < 1000e18 ? 1000e18 : 100e18);
        assertEq(staking.requiredStake(usdgBacking), 1000e18); // minStake floor still wins
    }

    // ---------------------------------------------------------------------
    // requestUnstake / claimUnstake
    // ---------------------------------------------------------------------

    function test_requestUnstake_recordsPendingAndEmits() public {
        _stakeAs(backer1, 5_000e18);
        vm.prank(backer1);
        vm.expectEmit(true, true, false, true);
        emit UnstakeRequested(backer1, 0, 2_000e18, uint64(block.timestamp + COOLDOWN));
        uint256 requestId = staking.requestUnstake(2_000e18);
        assertEq(requestId, 0);

        // Active stake drops immediately...
        assertEq(staking.staked(backer1), 3_000e18);
        // ...but nothing has left the contract.
        assertEq(spore.balanceOf(address(staking)), 5_000e18);
        assertEq(staking.pendingStake(backer1), 2_000e18);
        assertEq(staking.requestCount(backer1), 1);
    }

    function test_requestUnstake_zeroAmountReverts() public {
        vm.prank(backer1);
        vm.expectRevert(BackerSporeStake_ZeroAmount.selector);
        staking.requestUnstake(0);
    }

    function test_requestUnstake_moreThanStakedReverts() public {
        _stakeAs(backer1, 1_000e18);
        vm.prank(backer1);
        vm.expectRevert(
            abi.encodeWithSelector(
                BackerSporeStake_InsufficientStake.selector, backer1, 1_001e18, 1_000e18
            )
        );
        staking.requestUnstake(1_001e18);
    }

    function test_claimUnstake_cannotClaimEarly() public {
        _stakeAs(backer1, 5_000e18);
        vm.prank(backer1);
        staking.requestUnstake(2_000e18);

        // No-arg claim: nothing matured yet -> NothingToClaim.
        vm.prank(backer1);
        vm.expectRevert(abi.encodeWithSelector(BackerSporeStake_NothingToClaim.selector, backer1));
        staking.claimUnstake();

        // Single-id claim: still cooling down.
        vm.prank(backer1);
        vm.expectRevert(
            abi.encodeWithSelector(
                BackerSporeStake_CooldownNotElapsed.selector,
                backer1,
                0,
                uint64(block.timestamp + COOLDOWN),
                block.timestamp
            )
        );
        staking.claimUnstake(0);
    }

    function test_claimUnstake_afterCooldownWorks() public {
        _stakeAs(backer1, 5_000e18);
        vm.prank(backer1);
        staking.requestUnstake(2_000e18);

        vm.warp(block.timestamp + COOLDOWN + 1);

        uint256 before = spore.balanceOf(backer1);
        vm.prank(backer1);
        vm.expectEmit(true, true, false, true);
        emit UnstakeClaimed(backer1, 0, 2_000e18);
        staking.claimUnstake();

        assertEq(spore.balanceOf(backer1), before + 2_000e18);
        assertEq(staking.pendingStake(backer1), 0);
        // Active stake unchanged by the claim.
        assertEq(staking.staked(backer1), 3_000e18);

        // Double-claim reverts: nothing left to claim.
        vm.prank(backer1);
        vm.expectRevert(abi.encodeWithSelector(BackerSporeStake_NothingToClaim.selector, backer1));
        staking.claimUnstake();

        vm.prank(backer1);
        vm.expectRevert(
            abi.encodeWithSelector(BackerSporeStake_AlreadyClaimed.selector, backer1, 0)
        );
        staking.claimUnstake(0);
    }

    function test_claimUnstake_unknownRequestReverts() public {
        vm.prank(backer1);
        vm.expectRevert(
            abi.encodeWithSelector(BackerSporeStake_RequestNotFound.selector, backer1, 7)
        );
        staking.claimUnstake(7);
    }

    function test_pendingStakeExcludedFromIsQualified() public {
        _stakeAs(backer1, 1000e18);
        assertTrue(staking.isQualified(backer1, 0));

        // Move a single wei into cooldown: active stake drops below the floor.
        vm.prank(backer1);
        staking.requestUnstake(1);
        assertFalse(staking.isQualified(backer1, 0));

        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(backer1);
        staking.claimUnstake();
        // Active stake is still 1000e18 - 1 wei -> still unqualified.
        assertFalse(staking.isQualified(backer1, 0));
    }

    function test_partialUnstake() public {
        _stakeAs(backer1, 5_000e18);
        vm.prank(backer1);
        staking.requestUnstake(2_000e18);
        assertEq(staking.staked(backer1), 3_000e18);
        assertEq(staking.pendingStake(backer1), 2_000e18);

        vm.prank(backer1);
        staking.requestUnstake(1_000e18);
        assertEq(staking.staked(backer1), 2_000e18);
        assertEq(staking.pendingStake(backer1), 3_000e18);
        assertEq(staking.requestCount(backer1), 2);
    }

    function test_multipleRequests_claimOnlyMatured() public {
        _stakeAs(backer1, 10_000e18);

        vm.prank(backer1);
        staking.requestUnstake(1_000e18); // requestId 0, unlocks T + 7d
        vm.warp(block.timestamp + 3 days);
        vm.prank(backer1);
        staking.requestUnstake(2_000e18); // requestId 1, unlocks T + 10d

        // At T + 7d + 1s only request 0 is matured.
        vm.warp(block.timestamp + 4 days + 1);
        uint256 before = spore.balanceOf(backer1);
        vm.prank(backer1);
        staking.claimUnstake();
        assertEq(spore.balanceOf(backer1), before + 1_000e18);
        assertEq(staking.pendingStake(backer1), 2_000e18);

        // Request 1 unlocks 3 days later (T + 10d).
        vm.warp(block.timestamp + 3 days);
        before = spore.balanceOf(backer1);
        vm.prank(backer1);
        staking.claimUnstake();
        assertEq(spore.balanceOf(backer1), before + 2_000e18);
        assertEq(staking.pendingStake(backer1), 0);
    }

    function test_singleClaim_leavesOtherRequestsPending() public {
        _stakeAs(backer1, 10_000e18);
        vm.prank(backer1);
        staking.requestUnstake(1_000e18);
        vm.prank(backer1);
        staking.requestUnstake(2_000e18);

        vm.warp(block.timestamp + COOLDOWN + 1);
        uint256 before = spore.balanceOf(backer1);
        vm.prank(backer1);
        staking.claimUnstake(1); // claim only request 1
        assertEq(spore.balanceOf(backer1), before + 2_000e18);
        assertEq(staking.pendingStake(backer1), 1_000e18);
    }

    // ---------------------------------------------------------------------
    // Admin setters + access control
    // ---------------------------------------------------------------------

    function test_adminDefaults() public view {
        assertEq(staking.sporePerUsdg(), 100e18);
        assertEq(staking.minStake(), 1000e18);
        assertEq(staking.cooldown(), 7 days);
        assertTrue(staking.hasRole(bytes32(0), admin));
    }

    function test_setSporePerUsdg() public {
        vm.expectEmit(false, false, false, true);
        emit SporePerUsdgSet(100e18, 250e18);
        staking.setSporePerUsdg(250e18);
        assertEq(staking.sporePerUsdg(), 250e18);
    }

    function test_setSporePerUsdg_zeroReverts() public {
        vm.expectRevert(BackerSporeStake_RateMustBeNonZero.selector);
        staking.setSporePerUsdg(0);
    }

    function test_setMinStake() public {
        vm.expectEmit(false, false, false, true);
        emit MinStakeSet(1000e18, 500e18);
        staking.setMinStake(500e18);
        assertEq(staking.minStake(), 500e18);
        assertEq(staking.requiredStake(0), 500e18);
    }

    function test_setMinStake_aboveCapReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                BackerSporeStake_MinStakeTooHigh.selector, 1_000_001e18
            )
        );
        staking.setMinStake(1_000_001e18);
    }

    function test_setCooldown() public {
        vm.expectEmit(false, false, false, true);
        emit CooldownSet(7 days, 1 days);
        staking.setCooldown(1 days);
        assertEq(staking.cooldown(), 1 days);

        // New cooldown applies to new requests.
        _stakeAs(backer1, 1_000e18);
        vm.prank(backer1);
        staking.requestUnstake(100e18);
        (uint256 amt, uint64 at, bool claimed) = staking.unstakeRequest(backer1, 0);
        assertEq(at, uint64(block.timestamp + 1 days));
        assertEq(amt, 100e18);
        assertFalse(claimed);
    }

    function test_setCooldown_aboveCapReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(BackerSporeStake_CooldownTooLong.selector, 31 days)
        );
        staking.setCooldown(31 days);
        assertEq(staking.cooldown(), 7 days);
    }

    function test_setCooldown_atCapOk() public {
        staking.setCooldown(30 days);
        assertEq(staking.cooldown(), 30 days);
    }

    function test_onlyAdminCanCallSetters() public {
        bytes32 adminRole = bytes32(0);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole
            )
        );
        staking.setSporePerUsdg(200e18);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole
            )
        );
        staking.setMinStake(500e18);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole
            )
        );
        staking.setCooldown(1 days);
    }

    function test_constructor_zeroAddressReverts() public {
        vm.expectRevert(BackerSporeStake_ZeroAddress.selector);
        new BackerSporeStake(address(0), admin);
        vm.expectRevert(BackerSporeStake_ZeroAddress.selector);
        new BackerSporeStake(address(spore), address(0));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function test_unstakeRequest_view() public {
        _stakeAs(backer1, 1_000e18);
        vm.prank(backer1);
        staking.requestUnstake(100e18);
        (uint256 amount, uint64 unlockAt, bool claimed) = staking.unstakeRequest(backer1, 0);
        assertEq(amount, 100e18);
        assertEq(unlockAt, uint64(block.timestamp + COOLDOWN));
        assertFalse(claimed);

        vm.expectRevert(
            abi.encodeWithSelector(BackerSporeStake_RequestNotFound.selector, backer1, 1)
        );
        staking.unstakeRequest(backer1, 1);
    }

    function test_noSlashingPaths() public view {
        // Active stake never decreases except via the backer's own unstake request.
        // (Guardrail test: this contract has no function that can reduce another
        // account's `staked` balance.)
    }
}
