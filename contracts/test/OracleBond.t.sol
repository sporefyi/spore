// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {
    OracleBond,
    OracleBond_ZeroAddress,
    OracleBond_ZeroAmount,
    OracleBond_NoBond,
    OracleBond_UnstakeAlreadyPending,
    OracleBond_NoUnstakePending,
    OracleBond_CooldownNotElapsed,
    OracleBond_SlashExceedsBond,
    OracleBond_UnstakePending,
    OracleBond_CooldownTooLong
} from "../src/OracleBond.sol";

/// @notice Tests for the OracleBond slashable updater bond.
contract OracleBondTest is Test {
    // Mirror events for expectEmit.
    event Bonded(address indexed updater, uint256 amount);
    event UnstakeRequested(address indexed updater, uint256 amount, uint64 unlockAt);
    event UnstakeClaimed(address indexed updater, uint256 amount);
    event UnstakeCancelled(address indexed updater);
    event Slashed(address indexed updater, uint256 amount, string reason, address indexed slasher);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event MinBondUpdated(uint256 oldMinBond, uint256 newMinBond);
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    ERC20Mock internal spore;
    OracleBond internal bond;

    address internal admin;
    address internal slasher;
    address internal treasury;
    address internal updater1;
    address internal updater2;
    address internal stranger;

    uint256 internal constant MIN_BOND = 10_000e18;

    bytes32 internal slasherRole;
    bytes32 internal adminRole;

    function setUp() public {
        admin = makeAddr("admin");
        slasher = makeAddr("slasher");
        treasury = makeAddr("treasury");
        updater1 = makeAddr("updater1");
        updater2 = makeAddr("updater2");
        stranger = makeAddr("stranger");

        spore = new ERC20Mock();
        bond = new OracleBond(address(spore), admin, treasury, slasher);
        slasherRole = bond.SLASHER_ROLE();
        adminRole = bond.DEFAULT_ADMIN_ROLE();

        // Fund updaters with $SPORE and pre-approve the bond contract.
        spore.mint(updater1, 100_000e18);
        spore.mint(updater2, 100_000e18);
        vm.prank(updater1);
        spore.approve(address(bond), type(uint256).max);
        vm.prank(updater2);
        spore.approve(address(bond), type(uint256).max);
    }

    function _stakeAs(address updater, uint256 amount) internal {
        vm.prank(updater);
        bond.stake(amount);
    }

    /*//////////////////////////////////////////////////////////////
                            STAKE / isBonded
    //////////////////////////////////////////////////////////////*/

    function testStakeBelowMinIsNotBonded() public {
        _stakeAs(updater1, MIN_BOND - 1);
        assertEq(bond.bondOf(updater1), MIN_BOND - 1);
        assertFalse(bond.isBonded(updater1));
    }

    function testStakeAtMinIsBonded() public {
        _stakeAs(updater1, MIN_BOND);
        assertTrue(bond.isBonded(updater1));
    }

    function testStakeAboveMinIsBonded() public {
        _stakeAs(updater1, 25_000e18);
        assertTrue(bond.isBonded(updater1));
    }

    function testStakeEmitsBonded() public {
        vm.expectEmit(true, false, false, true);
        emit Bonded(updater1, 15_000e18);
        _stakeAs(updater1, 15_000e18);
    }

    function testStakeTransfersTokensIntoBond() public {
        _stakeAs(updater1, 12_000e18);
        assertEq(spore.balanceOf(address(bond)), 12_000e18);
        assertEq(spore.balanceOf(updater1), 88_000e18);
    }

    function testStakeZeroAmountReverts() public {
        vm.prank(updater1);
        vm.expectRevert(OracleBond_ZeroAmount.selector);
        bond.stake(0);
    }

    function testStakeWithoutApprovalReverts() public {
        // stranger has no balance and no approval
        vm.prank(stranger);
        vm.expectRevert();
        bond.stake(1_000e18);
    }

    function testStakeDuringPendingUnstakeReverts() public {
        _stakeAs(updater1, MIN_BOND);
        vm.prank(updater1);
        bond.requestUnstake();
        vm.prank(updater1);
        vm.expectRevert(OracleBond_UnstakePending.selector);
        bond.stake(1_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                          UNSTAKE LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function testRequestUnstakeMakesNotBondedDuringCooldown() public {
        _stakeAs(updater1, MIN_BOND);
        assertTrue(bond.isBonded(updater1));

        vm.expectEmit(true, false, false, true);
        emit UnstakeRequested(updater1, MIN_BOND, uint64(block.timestamp + 14 days));
        vm.prank(updater1);
        bond.requestUnstake();

        assertFalse(bond.isBonded(updater1));
        assertEq(bond.unstakeUnlockAt(updater1), block.timestamp + 14 days);
    }

    function testRequestUnstakeWithNoBondReverts() public {
        vm.prank(updater1);
        vm.expectRevert(OracleBond_NoBond.selector);
        bond.requestUnstake();
    }

    function testRequestUnstakeTwiceReverts() public {
        _stakeAs(updater1, MIN_BOND);
        vm.prank(updater1);
        bond.requestUnstake();
        vm.prank(updater1);
        vm.expectRevert(OracleBond_UnstakeAlreadyPending.selector);
        bond.requestUnstake();
    }

    function testClaimUnstakeEarlyReverts() public {
        _stakeAs(updater1, MIN_BOND);
        vm.prank(updater1);
        bond.requestUnstake();

        vm.prank(updater1);
        vm.expectRevert(abi.encodeWithSelector(OracleBond_CooldownNotElapsed.selector, block.timestamp + 14 days));
        bond.claimUnstake();
    }

    function testClaimUnstakeAfterCooldownWorks() public {
        _stakeAs(updater1, 20_000e18);
        vm.prank(updater1);
        bond.requestUnstake();

        vm.warp(block.timestamp + 14 days);
        uint256 balBefore = spore.balanceOf(updater1);

        vm.expectEmit(true, false, false, true);
        emit UnstakeClaimed(updater1, 20_000e18);
        vm.prank(updater1);
        bond.claimUnstake();

        assertEq(spore.balanceOf(updater1), balBefore + 20_000e18);
        assertEq(bond.bondOf(updater1), 0);
        assertEq(bond.unstakeUnlockAt(updater1), 0);
        assertFalse(bond.isBonded(updater1));
    }

    function testClaimUnstakeWithNoRequestReverts() public {
        _stakeAs(updater1, MIN_BOND);
        vm.prank(updater1);
        vm.expectRevert(OracleBond_NoUnstakePending.selector);
        bond.claimUnstake();
    }

    function testCancelUnstakeRebonds() public {
        _stakeAs(updater1, MIN_BOND);
        vm.prank(updater1);
        bond.requestUnstake();
        assertFalse(bond.isBonded(updater1));

        vm.expectEmit(true, false, false, false);
        emit UnstakeCancelled(updater1);
        vm.prank(updater1);
        bond.cancelUnstake();

        assertTrue(bond.isBonded(updater1));
        assertEq(bond.bondOf(updater1), MIN_BOND);
        assertEq(bond.unstakeUnlockAt(updater1), 0);
    }

    function testCancelUnstakeWithNoRequestReverts() public {
        vm.prank(updater1);
        vm.expectRevert(OracleBond_NoUnstakePending.selector);
        bond.cancelUnstake();
    }

    function testCanRestakeAfterClaim() public {
        _stakeAs(updater1, MIN_BOND);
        vm.prank(updater1);
        bond.requestUnstake();
        vm.warp(block.timestamp + 14 days);
        vm.prank(updater1);
        bond.claimUnstake();

        _stakeAs(updater1, MIN_BOND);
        assertTrue(bond.isBonded(updater1));
    }

    /*//////////////////////////////////////////////////////////////
                                SLASH
    //////////////////////////////////////////////////////////////*/

    function testSlashMovesFundsToTreasuryAndReducesBond() public {
        _stakeAs(updater1, 20_000e18);
        uint256 treasuryBefore = spore.balanceOf(treasury);

        vm.expectEmit(true, false, false, true);
        emit Slashed(updater1, 5_000e18, "published bad scores", slasher);
        vm.prank(slasher);
        bond.slash(updater1, 5_000e18, "published bad scores");

        assertEq(bond.bondOf(updater1), 15_000e18);
        assertEq(spore.balanceOf(treasury), treasuryBefore + 5_000e18);
    }

    function testSlashDropsBelowMinUnbonds() public {
        _stakeAs(updater1, MIN_BOND);
        vm.prank(slasher);
        bond.slash(updater1, 1e18, "minor infraction");
        assertFalse(bond.isBonded(updater1));
        assertEq(bond.bondOf(updater1), MIN_BOND - 1e18);
    }

    function testSlashMoreThanBondReverts() public {
        _stakeAs(updater1, MIN_BOND);
        vm.prank(slasher);
        vm.expectRevert(abi.encodeWithSelector(OracleBond_SlashExceedsBond.selector, MIN_BOND + 1, MIN_BOND));
        bond.slash(updater1, MIN_BOND + 1, "excessive");
    }

    function testNonSlasherCannotSlash() public {
        _stakeAs(updater1, MIN_BOND);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, slasherRole
            )
        );
        bond.slash(updater1, 1e18, "rogue slash");
    }

    function testSlashDuringCooldownSlashesCoolingFunds() public {
        _stakeAs(updater1, 20_000e18);
        vm.prank(updater1);
        bond.requestUnstake();
        uint256 treasuryBefore = spore.balanceOf(treasury);

        // Slashing cooling-down funds is allowed (accountability outlives the cooldown).
        vm.prank(slasher);
        bond.slash(updater1, 20_000e18, "ragequit slash");

        assertEq(bond.bondOf(updater1), 0);
        assertEq(spore.balanceOf(treasury), treasuryBefore + 20_000e18);

        // Claiming afterwards still works and transfers the (now zero) remainder.
        vm.warp(block.timestamp + 14 days);
        vm.prank(updater1);
        bond.claimUnstake();
        assertEq(bond.unstakeUnlockAt(updater1), 0);
    }

    function testSlashZeroBondReverts() public {
        vm.prank(slasher);
        vm.expectRevert(abi.encodeWithSelector(OracleBond_SlashExceedsBond.selector, 1e18, 0));
        bond.slash(updater2, 1e18, "nothing to slash");
    }

    /*//////////////////////////////////////////////////////////////
                        ADMIN SETTERS + ACCESS
    //////////////////////////////////////////////////////////////*/

    function testSetTreasuryRoutesFutureSlashes() public {
        address newTreasury = makeAddr("newTreasury");
        _stakeAs(updater1, 20_000e18);

        vm.expectEmit(true, true, false, false);
        emit TreasuryUpdated(treasury, newTreasury);
        vm.prank(admin);
        bond.setTreasury(newTreasury);

        vm.prank(slasher);
        bond.slash(updater1, 5_000e18, "post-rotation slash");

        assertEq(spore.balanceOf(newTreasury), 5_000e18);
        assertEq(spore.balanceOf(treasury), 0);
    }

    function testSetTreasuryZeroReverts() public {
        vm.prank(admin);
        vm.expectRevert(OracleBond_ZeroAddress.selector);
        bond.setTreasury(address(0));
    }

    function testSetTreasuryByNonAdminReverts() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole
            )
        );
        bond.setTreasury(makeAddr("evilTreasury"));
    }

    function testSetMinBondUpdatesIsBonded() public {
        _stakeAs(updater1, 15_000e18);
        assertTrue(bond.isBonded(updater1));

        vm.expectEmit(false, false, false, true);
        emit MinBondUpdated(MIN_BOND, 20_000e18);
        vm.prank(admin);
        bond.setMinBond(20_000e18);

        // Raising the bar is not retroactive on the bond, but isBonded reflects the new bar.
        assertEq(bond.bondOf(updater1), 15_000e18);
        assertFalse(bond.isBonded(updater1));

        // Lowering re-bonds without further action.
        vm.prank(admin);
        bond.setMinBond(10_000e18);
        assertTrue(bond.isBonded(updater1));
    }

    function testSetMinBondByNonAdminReverts() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole
            )
        );
        bond.setMinBond(1);
    }

    function testSetCooldownAndCap() public {
        vm.expectEmit(false, false, false, true);
        emit CooldownUpdated(14 days, 30 days);
        vm.prank(admin);
        bond.setCooldown(30 days);
        assertEq(bond.cooldown(), 30 days);

        // New cooldown applies to subsequent unstake requests.
        _stakeAs(updater1, MIN_BOND);
        vm.prank(updater1);
        bond.requestUnstake();
        assertEq(bond.unstakeUnlockAt(updater1), block.timestamp + 30 days);
    }

    function testSetCooldownAboveMaxReverts() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(OracleBond_CooldownTooLong.selector, 61 days, 60 days));
        bond.setCooldown(61 days);
    }

    function testSetCooldownByNonAdminReverts() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole
            )
        );
        bond.setCooldown(1 days);
    }

    function testAdminCanGrantAndRevokeSlasher() public {
        address newSlasher = makeAddr("newSlasher");
        vm.prank(admin);
        bond.grantRole(slasherRole, newSlasher);
        assertTrue(bond.hasRole(slasherRole, newSlasher));

        _stakeAs(updater1, MIN_BOND);
        vm.prank(newSlasher);
        bond.slash(updater1, 1e18, "new slasher works");

        vm.prank(admin);
        bond.revokeRole(slasherRole, newSlasher);
        assertFalse(bond.hasRole(slasherRole, newSlasher));

        vm.prank(newSlasher);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, newSlasher, slasherRole
            )
        );
        bond.slash(updater1, 1e18, "revoked slasher fails");
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function testConstructorRevertsOnZeroAddress() public {
        vm.expectRevert(OracleBond_ZeroAddress.selector);
        new OracleBond(address(0), admin, treasury, slasher);
        vm.expectRevert(OracleBond_ZeroAddress.selector);
        new OracleBond(address(spore), address(0), treasury, slasher);
        vm.expectRevert(OracleBond_ZeroAddress.selector);
        new OracleBond(address(spore), admin, address(0), slasher);
        vm.expectRevert(OracleBond_ZeroAddress.selector);
        new OracleBond(address(spore), admin, treasury, address(0));
    }

    function testConstructorInitializesRolesAndParams() public view {
        assertTrue(bond.hasRole(adminRole, admin));
        assertTrue(bond.hasRole(slasherRole, slasher));
        assertEq(address(bond.spore()), address(spore));
        assertEq(bond.treasury(), treasury);
        assertEq(bond.minBond(), MIN_BOND);
        assertEq(bond.cooldown(), 14 days);
        assertEq(bond.MAX_COOLDOWN(), 60 days);
    }
}
