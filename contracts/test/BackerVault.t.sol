// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import "../src/BackerVault.sol"; // plain import: also brings file-level errors into scope
import {SporeRegistry} from "../src/SporeRegistry.sol";
import {ScoreOracle} from "../src/ScoreOracle.sol";
import {CreditManager} from "../src/CreditManager.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import "../src/interfaces/ISpore.sol";

contract BackerVaultTest is Test {
    ERC20Mock internal asset;
    SporeRegistry internal registry;
    ScoreOracle internal oracle;
    CreditManager internal manager;
    BackerVault internal vault;
    FeeRouter internal router;

    address internal admin = address(this);
    address internal updater;
    address internal agentOwner1;
    address internal agentOwner2;
    address internal backer1;
    address internal backer2;
    address internal merchant1;
    address internal merchant2;
    address internal stranger;
    address internal treasuryAcct;

    uint64 internal constant STALE_PERIOD = 1 days;
    uint16 internal constant TREASURY_BPS = 1000; // 10% to treasury, 90% to vault

    function setUp() public {
        updater = makeAddr("updater");
        agentOwner1 = makeAddr("agentOwner1");
        agentOwner2 = makeAddr("agentOwner2");
        backer1 = makeAddr("backer1");
        backer2 = makeAddr("backer2");
        merchant1 = makeAddr("merchant1");
        merchant2 = makeAddr("merchant2");
        stranger = makeAddr("stranger");
        treasuryAcct = makeAddr("treasury");

        asset = new ERC20Mock();
        registry = new SporeRegistry(admin);
        oracle = new ScoreOracle(admin, updater, STALE_PERIOD);
        manager = new CreditManager(address(asset), address(registry), address(oracle), admin, STALE_PERIOD);
        vault = new BackerVault(address(asset), address(registry), address(manager), admin);
        router = new FeeRouter(address(asset), treasuryAcct, address(vault), address(manager), TREASURY_BPS, admin);

        // wiring (admin-only setters)
        manager.setVault(address(vault));
        manager.setFeeRouter(address(router));
        vault.setFeeRouter(address(router));

        manager.grantRole(manager.UNDERWRITER_ROLE(), admin);
        manager.grantRole(manager.PAUSER_ROLE(), admin);

        asset.mint(agentOwner1, 1_000_000e18);
        asset.mint(agentOwner2, 1_000_000e18);
        asset.mint(backer1, 1_000_000e18);
        asset.mint(backer2, 1_000_000e18);
        asset.mint(stranger, 1_000_000e18);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _register(address owner_) internal returns (uint256) {
        vm.prank(owner_);
        return registry.registerAgent("ipfs://test/agent");
    }

    function _publishScore(uint256 agentId, uint256 limit_) internal {
        vm.prank(updater);
        oracle.publishScore(agentId, 700, limit_, 1);
    }

    function _fundVault(uint256 amount) internal {
        asset.mint(address(vault), amount);
    }

    function _deposit(address backer, uint256 agentId, uint256 amount) internal {
        vm.startPrank(backer);
        asset.approve(address(vault), amount);
        vault.deposit(agentId, amount);
        vm.stopPrank();
    }

    /// @dev Issue line for agent 1 (limit 3000e18, 10% fee) and allow merchant1.
    function _issueLine1() internal {
        _publishScore(1, 5000e18);
        manager.issueLine(1, 3000e18, 1000);
        manager.setMerchantAllowed(merchant1, true);
    }

    function _borrow1(uint256 amount) internal {
        vm.prank(agentOwner1);
        manager.borrow(1, amount, merchant1);
    }

    /// @dev Register agent 1, backer1 deposits 1000e18, yield reserve of 500e18 pushed by the router.
    function _pushYield(uint256 amount) internal {
        asset.mint(address(router), amount);
        vm.prank(address(router));
        vault.receiveYield(amount);
    }

    // ------------------------------------------------------------------
    // Deposit
    // ------------------------------------------------------------------

    function testDeposit_EmitsSponsorAndMintsSharesOneToOne() public {
        _register(agentOwner1);

        vm.startPrank(backer1);
        asset.approve(address(vault), 1000e18);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Sponsor(1, backer1, 1000e18);
        vault.deposit(1, 1000e18);
        vm.stopPrank();

        assertEq(vault.sharesOf(1, backer1), 1000e18);
        assertEq(vault.totalShares(1), 1000e18);
        assertEq(vault.poolAssets(1), 1000e18);
        assertEq(vault.stakedFor(1, backer1), 1000e18);
    }

    function testDeposit_SecondDepositorShareMath() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _deposit(backer2, 1, 1000e18);

        assertEq(vault.sharesOf(1, backer1), 1000e18);
        assertEq(vault.sharesOf(1, backer2), 1000e18);
        assertEq(vault.totalShares(1), 2000e18);
        assertEq(vault.poolAssets(1), 2000e18);
    }

    function testDeposit_AfterYieldDilutesSharePrice() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _pushYield(500e18);
        vault.allocateYield(1, 500e18);

        _deposit(backer2, 1, 1000e18);

        uint256 expected = Math.mulDiv(1000e18, 1000e18, 1500e18);
        assertEq(expected, 666666666666666666666);
        assertEq(vault.sharesOf(1, backer2), 666666666666666666666);
        assertEq(vault.totalShares(1), 1000e18 + 666666666666666666666);
        assertEq(vault.poolAssets(1), 2500e18);
    }

    function testDeposit_ZeroAmountReverts() public {
        _register(agentOwner1);
        vm.prank(backer1);
        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAmount.selector));
        vault.deposit(1, 0);
    }

    function testDeposit_UnknownAgentReverts() public {
        vm.startPrank(backer1);
        asset.approve(address(vault), 100e18);

        vm.expectRevert(abi.encodeWithSelector(Spore_AgentNotFound.selector, uint256(999)));
        vault.deposit(999, 100e18);

        vm.expectRevert(abi.encodeWithSelector(Spore_AgentNotFound.selector, uint256(0)));
        vault.deposit(0, 100e18);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Withdraw
    // ------------------------------------------------------------------

    function testWithdraw_UnencumberedOk() public {
        _register(agentOwner1);
        uint256 balBefore = asset.balanceOf(backer1);
        _deposit(backer1, 1, 1000e18);
        assertEq(asset.balanceOf(backer1), balBefore - 1000e18);

        vm.prank(backer1);
        vault.withdraw(1, 1000e18);

        assertEq(asset.balanceOf(backer1), balBefore);
        assertEq(vault.sharesOf(1, backer1), 0);
        assertEq(vault.totalShares(1), 0);
        assertEq(vault.poolAssets(1), 0);
    }

    function testWithdraw_EncumberedPortionReverts() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _issueLine1();
        _borrow1(400e18);

        assertEq(vault.withdrawableFor(1, backer1), 600e18);
        assertEq(vault.encumberedFor(1), 400e18);

        vm.prank(backer1);
        vm.expectRevert(
            abi.encodeWithSelector(Spore_StakeEncumbered.selector, uint256(1), backer1, 700e18, 600e18)
        );
        vault.withdraw(1, 700e18);

        uint256 balBefore = asset.balanceOf(backer1);
        vm.prank(backer1);
        vault.withdraw(1, 600e18);
        assertEq(asset.balanceOf(backer1), balBefore + 600e18);
        assertEq(vault.poolAssets(1), 400e18);
    }

    function testWithdraw_NoSharesReverts() public {
        _register(agentOwner1);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Spore_InsufficientStake.selector, uint256(1), stranger, 100e18, uint256(0))
        );
        vault.withdraw(1, 100e18);
    }

    // ------------------------------------------------------------------
    // fundBorrow
    // ------------------------------------------------------------------

    function testFundBorrow_OnlyManager() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Spore_OnlyCreditManager.selector, stranger));
        vault.fundBorrow(1, merchant1, 1e18);
    }

    function testFundBorrow_InsufficientBalanceReverts() public {
        vm.prank(address(manager));
        vm.expectRevert(
            abi.encodeWithSelector(Spore_InsufficientVaultBalance.selector, 1e18, uint256(0))
        );
        vault.fundBorrow(1, merchant1, 1e18);
    }

    // ------------------------------------------------------------------
    // absorbDefault
    // ------------------------------------------------------------------

    function testAbsorbDefault_FullCover() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _issueLine1();
        _borrow1(400e18);

        CreditLine memory before_ = manager.getLine(1);
        assertEq(before_.drawn, 400e18);
        assertEq(before_.feeOwed, 40e18);
        assertEq(vault.totalOutstanding(), 400e18);

        vm.expectEmit(true, false, false, true, address(manager));
        emit Default(1, 400e18, 400e18, 0);
        vault.absorbDefault(1);

        assertEq(vault.poolAssets(1), 600e18);
        assertEq(vault.badDebt(), 0);
        assertEq(vault.totalOutstanding(), 0);

        CreditLine memory line = manager.getLine(1);
        assertTrue(line.defaulted);
        assertFalse(line.active);
        assertEq(line.drawn, 0);
        assertEq(line.feeOwed, 0);
    }

    function testAbsorbDefault_Shortfall() public {
        _register(agentOwner1);
        _register(agentOwner2);
        _deposit(backer1, 1, 100e18);
        _deposit(backer2, 2, 900e18);
        _issueLine1();
        _borrow1(500e18);

        vm.expectEmit(true, false, false, true, address(manager));
        emit Default(1, 500e18, 100e18, 400e18);
        vault.absorbDefault(1);

        assertEq(vault.poolAssets(1), 0);
        assertEq(vault.poolAssets(2), 900e18);
        assertEq(vault.badDebt(), 400e18);
        assertEq(vault.totalOutstanding(), 0);
    }

    function testAbsorbDefault_NothingToDefaultReverts() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _issueLine1();
        // no borrow yet: drawn == 0
        vm.expectRevert(abi.encodeWithSelector(Spore_NothingToDefault.selector, uint256(1)));
        vault.absorbDefault(1);
    }

    // ------------------------------------------------------------------
    // Pause
    // ------------------------------------------------------------------

    function testPause_BlocksDepositWithdraw() public {
        _register(agentOwner1);
        vault.pause();
        assertTrue(vault.paused());

        vm.startPrank(backer1);
        asset.approve(address(vault), 1000e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1, 1000e18);
        vm.stopPrank();

        // fund, then check withdraw is blocked too
        vault.unpause();
        _deposit(backer1, 1, 1000e18);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(backer1);
        vault.withdraw(1, 100e18);

        vault.unpause();
        assertFalse(vault.paused());
    }

    /// @dev SPEC GAP (reported to coordinator): amended spec requires the vault
    ///      pause to block fundBorrow, but BackerVault.fundBorrow has no
    ///      whenNotPaused — the borrow below succeeds while paused. This test
    ///      documents the required behavior and currently FAILS against the
    ///      implementation; it should pass once the impl lane adds the guard.
    function testPause_BlocksFundBorrow() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _issueLine1();
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(agentOwner1);
        manager.borrow(1, 100e18, merchant1);
    }

    function testPause_ResolutionFlowsStayOpen() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _issueLine1();
        _borrow1(400e18);
        vault.pause();

        // absorbDefault stays open under pause
        vault.absorbDefault(1);
        assertEq(vault.badDebt(), 0);
        assertEq(vault.poolAssets(1), 600e18);

        // receiveYield stays open under pause
        asset.mint(address(router), 50e18);
        vm.prank(address(router));
        vault.receiveYield(50e18);
        assertEq(vault.yieldReserve(), 50e18);
    }

    function testPause_RepayStaysOpen() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _issueLine1();
        _borrow1(400e18);
        vault.pause();

        // manager.repay -> vault.receiveRepay must not be blocked by the vault pause
        uint256 outstandingBefore = vault.totalOutstanding();
        vm.startPrank(agentOwner1);
        asset.approve(address(manager), 440e18);
        manager.repay(1, 440e18);
        vm.stopPrank();
        assertEq(vault.totalOutstanding(), outstandingBefore - 400e18);
    }

    function testPause_NonPauserReverts() public {
        bytes32 role = vault.PAUSER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        vault.pause();
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function testViews_AssetAndPoolAccounting() public {
        _register(agentOwner1);
        assertEq(address(vault.asset()), address(asset));

        _deposit(backer1, 1, 1000e18);
        assertEq(vault.poolAssets(1), 1000e18);
        assertEq(vault.totalShares(1), 1000e18);
        assertEq(vault.sharesOf(1, backer1), 1000e18);
        assertEq(vault.totalStakedFor(1), 1000e18);
    }

    function testReceiveYield_Accrues() public {
        asset.mint(address(router), 250e18);
        vm.prank(address(router));
        vault.receiveYield(250e18);
        assertEq(vault.yieldReserve(), 250e18);
    }

    function testReceiveYield_OnlyFeeRouter() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Spore_OnlyFeeRouter.selector, stranger));
        vault.receiveYield(1e18);
    }

    function testAllocateYield_HappyPath() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _pushYield(500e18);
        assertEq(vault.yieldReserve(), 500e18);

        vm.expectEmit(true, false, false, true, address(vault));
        emit YieldAllocated(1, 500e18);
        vault.allocateYield(1, 500e18);

        assertEq(vault.poolAssets(1), 1500e18);
        assertEq(vault.yieldReserve(), 0);
        assertEq(vault.stakedFor(1, backer1), 1500e18);
    }

    function testAllocateYield_EmptyPoolReverts() public {
        _register(agentOwner1);
        _register(agentOwner2);
        _pushYield(100e18);

        vm.expectRevert(abi.encodeWithSelector(Spore_EmptyPool.selector, uint256(2)));
        vault.allocateYield(2, 100e18);
    }

    function testAllocateYield_ExceedsReserveReverts() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _pushYield(100e18);

        uint256 reserve = vault.yieldReserve();
        vm.expectRevert(
            abi.encodeWithSelector(Spore_InsufficientVaultBalance.selector, reserve + 1, reserve)
        );
        vault.allocateYield(1, reserve + 1);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function testWithdrawableFor_Numbers() public {
        _register(agentOwner1);
        _deposit(backer1, 1, 1000e18);
        _issueLine1();
        _borrow1(400e18);

        assertEq(vault.withdrawableFor(1, backer1), 600e18);

        vm.startPrank(agentOwner1);
        asset.approve(address(manager), 440e18);
        manager.repay(1, 440e18);
        vm.stopPrank();

        assertEq(vault.withdrawableFor(1, backer1), 1000e18);
        assertEq(vault.encumberedFor(1), 0);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function testSetFeeRouter_SetOnce() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_AlreadySet.selector));
        vault.setFeeRouter(address(0xBEEF));
    }
}
