// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import "../../src/interfaces/ISpore.sol";
import {SporeRegistry} from "../../src/SporeRegistry.sol";
import {ScoreOracle} from "../../src/ScoreOracle.sol";
import {CreditManager} from "../../src/CreditManager.sol";
import {BackerVault} from "../../src/BackerVault.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";

/// @notice End-to-end lifecycle tests wiring registry, oracle, manager, vault and fee router together.
/// @dev Foundry re-runs setUp before each test, so agent ids start at 1 in every test function.
contract LifecycleTest is Test {
    ERC20Mock internal asset;
    SporeRegistry internal registry;
    ScoreOracle internal oracle;
    CreditManager internal manager;
    BackerVault internal vault;
    FeeRouter internal router;

    address internal treasury;
    address internal backer1;
    address internal backer2;
    address internal agentOwner;
    address internal agentOwner2;
    address internal merchant1;
    address internal merchant2;
    address internal payer;

    function setUp() public {
        asset = new ERC20Mock();
        registry = new SporeRegistry(address(this));
        oracle = new ScoreOracle(address(this), address(this), 7 days);
        manager = new CreditManager(address(asset), address(registry), address(oracle), address(this), 7 days);
        vault = new BackerVault(address(asset), address(registry), address(manager), address(this));
        treasury = makeAddr("treasury");
        router = new FeeRouter(address(asset), treasury, address(vault), address(manager), 2000, address(this));

        manager.setVault(address(vault));
        manager.setFeeRouter(address(router));
        vault.setFeeRouter(address(router));

        manager.grantRole(manager.UNDERWRITER_ROLE(), address(this));
        manager.grantRole(manager.PAUSER_ROLE(), address(this));

        backer1 = makeAddr("backer1");
        backer2 = makeAddr("backer2");
        agentOwner = makeAddr("agentOwner");
        agentOwner2 = makeAddr("agentOwner2");
        merchant1 = makeAddr("merchant1");
        merchant2 = makeAddr("merchant2");
        payer = makeAddr("payer");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _register(address owner_) internal {
        vm.prank(owner_);
        registry.registerAgent("ipfs://agent-metadata");
    }

    function _fundAndApprove(address who, address spender, uint256 amount) internal {
        asset.mint(who, amount);
        vm.prank(who);
        asset.approve(spender, type(uint256).max);
    }

    function _deposit(address backer, uint256 agentId, uint256 amount) internal {
        _fundAndApprove(backer, address(vault), amount);
        vm.prank(backer);
        vault.deposit(agentId, amount);
    }

    function _countLogs(Vm.Log[] memory logs, address emitter, bytes32 sig) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == sig) n++;
        }
    }

    // ------------------------------------------------------------------
    // 1. Happy path: vouch -> score -> issue -> borrow -> repay -> yield
    // ------------------------------------------------------------------

    function test_HappyPath() public {
        // Register agent -> id 1
        vm.expectEmit(true, true, true, true, address(registry));
        emit AgentRegistered(1, agentOwner, "ipfs://agent-metadata");
        vm.prank(agentOwner);
        uint256 id = registry.registerAgent("ipfs://agent-metadata");
        assertEq(id, 1);

        // Backers sponsor
        _fundAndApprove(backer1, address(vault), 1000e18);
        vm.expectEmit(true, true, true, true, address(vault));
        emit Sponsor(1, backer1, 1000e18);
        vm.prank(backer1);
        vault.deposit(1, 1000e18);

        // backer2 also needs funds to repay later (400e18) on top of deposit
        _fundAndApprove(backer2, address(vault), 500e18);
        vm.prank(backer2);
        vault.deposit(1, 500e18);
        // approve manager for third-party repayment and top up balance
        _fundAndApprove(backer2, address(manager), 400e18);

        // Oracle + allowlist + line
        oracle.publishScore(1, 800, 10000e18, 1);
        manager.setMerchantAllowed(merchant1, true);

        vm.expectEmit(true, true, true, true, address(manager));
        emit CreditIssued(1, 2000e18, 500);
        manager.issueLine(1, 2000e18, 500);

        // Borrow 800 -> fee 5% = 40
        vm.expectEmit(true, true, true, true, address(manager));
        emit Borrow(1, 800e18, 40e18);
        vm.expectEmit(true, true, true, true, address(manager));
        emit Payment(1, merchant1, 800e18);
        vm.prank(agentOwner);
        manager.borrow(1, 800e18, merchant1);

        assertEq(manager.getLine(1).drawn, 800e18);
        assertEq(manager.getLine(1).feeOwed, 40e18);
        assertEq(asset.balanceOf(merchant1), 800e18);

        // Third-party partial repay of 400 by backer2: 40 fee + 360 principal
        vm.recordLogs();
        vm.prank(backer2);
        manager.repay(1, 400e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogs(logs, address(manager), Repay.selector), 1);
        // Both Revenue legs emitted by the router (treasury + vault)
        assertEq(_countLogs(logs, address(router), Revenue.selector), 2);

        assertEq(manager.getLine(1).feeOwed, 0);
        assertEq(manager.getLine(1).drawn, 440e18);
        // 40 fee, 20% treasury = 8, 80% vault = 32
        assertEq(asset.balanceOf(treasury), 8e18);
        assertEq(vault.yieldReserve(), 32e18);
        assertEq(router.totalFeesRouted(), 40e18);

        // Full repayment of the remaining principal
        _fundAndApprove(agentOwner, address(manager), 440e18);
        vm.prank(agentOwner);
        manager.repay(1, 440e18);

        CreditLine memory lineAfter = manager.getLine(1);
        assertEq(lineAfter.drawn, 0);
        assertEq(lineAfter.feeOwed, 0);
        assertEq(manager.availableToBorrow(1), 2000e18); // line drawable again

        // Vault is made whole
        assertEq(asset.balanceOf(address(vault)), 1532e18);
        assertEq(vault.totalOutstanding(), 0);

        // Yield allocation raises backer claims pro-rata
        uint256 wBefore = vault.withdrawableFor(1, backer1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit YieldAllocated(1, 32e18);
        vault.allocateYield(1, 32e18);

        assertEq(vault.poolAssets(1), 1532e18);
        uint256 expected = (uint256(1000e18) * uint256(1532e18)) / uint256(1500e18);
        assertEq(vault.withdrawableFor(1, backer1), expected);
        assertGt(expected, wBefore);
    }

    // ------------------------------------------------------------------
    // 2. Default path: full draw, absorbed by stake, terminal state
    // ------------------------------------------------------------------

    /// @notice Default path: full draw, default absorbed by the vault, terminal state enforced.
    function test_DefaultPath() public {
        _register(agentOwner);
        _deposit(backer1, 1, 1000e18);
        // A second agent's stake tops up the vault's fungible balance so the
        // 1500e18 borrow can be funded while agent 1's own pool stays 1000e18
        // (which is what creates the 500e18 shortfall at default).
        _register(agentOwner2);
        _deposit(backer2, 2, 1000e18);
        oracle.publishScore(1, 800, 10000e18, 1);
        manager.setMerchantAllowed(merchant1, true);
        manager.issueLine(1, 1500e18, 500);

        // Full draw; 75e18 fee accrues and is written off at default
        vm.prank(agentOwner);
        manager.borrow(1, 1500e18, merchant1);

        // Default: 1500 drawn, 1000 pool assets absorb, 500 bad debt
        vm.expectEmit(true, true, true, true, address(manager));
        emit Default(1, 1500e18, 1000e18, 500e18);
        vault.absorbDefault(1);

        CreditLine memory line = manager.getLine(1);
        assertEq(line.drawn, 0);
        assertEq(line.feeOwed, 0);
        assertTrue(line.defaulted);
        assertFalse(line.active);

        assertEq(vault.poolAssets(1), 0);
        assertEq(vault.badDebt(), 500e18);
        assertEq(vault.totalOutstanding(), 0);
        assertEq(vault.stakedFor(1, backer1), 0); // pro-rata write-down of the single backer

        // Terminality: no borrowing, no re-issuing, no second absorption
        vm.expectRevert(abi.encodeWithSelector(Spore_NoActiveLine.selector, 1));
        vm.prank(agentOwner);
        manager.borrow(1, 100e18, merchant1);

        vm.expectRevert(abi.encodeWithSelector(Spore_LineDefaulted.selector, 1));
        manager.issueLine(1, 1500e18, 500);

        vm.expectRevert(abi.encodeWithSelector(Spore_NoActiveLine.selector, 1));
        vault.absorbDefault(1);
    }

    // ------------------------------------------------------------------
    // 3. Yield path: fees become vault yield, allocation appreciates shares
    // ------------------------------------------------------------------

    /// @notice Fees routed on repay become vault yield, and allocation appreciates shares.
    function test_YieldPath() public {
        _register(agentOwner); // id 1
        _deposit(backer1, 1, 2000e18);
        oracle.publishScore(1, 800, 10000e18, 1);
        manager.setMerchantAllowed(merchant1, true);
        manager.issueLine(1, 3000e18, 1000);

        vm.prank(agentOwner);
        manager.borrow(1, 1000e18, merchant1);

        _fundAndApprove(payer, address(manager), 1100e18);
        vm.prank(payer);
        manager.repay(1, 1100e18);

        assertEq(asset.balanceOf(treasury), 20e18);
        assertEq(vault.yieldReserve(), 80e18);
        assertEq(router.totalFeesRouted(), 100e18);
        CreditLine memory line = manager.getLine(1);
        assertEq(line.drawn, 0);
        assertEq(line.feeOwed, 0);

        uint256 w0 = vault.withdrawableFor(1, backer1);
        uint256 s0 = vault.sharesOf(1, backer1);

        vm.expectEmit(true, true, true, true, address(vault));
        emit YieldAllocated(1, 80e18);
        vault.allocateYield(1, 80e18);

        assertGt(vault.withdrawableFor(1, backer1), w0);
        assertEq(vault.sharesOf(1, backer1), s0);

        vm.prank(backer1);
        vault.withdraw(1, 500e18);
        assertEq(asset.balanceOf(backer1), 500e18);
    }

    // ------------------------------------------------------------------
    // 4. Pause behavior on both contracts
    // ------------------------------------------------------------------

    /// @notice Manager pause blocks issuance/borrow but not repay; vault pause blocks
    ///         deposit/withdraw/fundBorrow but not default absorption.
    function test_PauseBehavior() public {
        _register(agentOwner); // id 1
        _deposit(backer1, 1, 1000e18);
        oracle.publishScore(1, 800, 10000e18, 1);
        manager.setMerchantAllowed(merchant1, true);
        manager.issueLine(1, 2000e18, 500);

        _register(agentOwner2); // id 2
        oracle.publishScore(2, 800, 10000e18, 1);

        // Borrow before pausing (fee 25e18)
        vm.prank(agentOwner);
        manager.borrow(1, 500e18, merchant1);

        // Part A: manager pause blocks risk-increasing actions
        manager.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        manager.issueLine(2, 1000e18, 500);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        manager.setLimit(1, 1000e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(agentOwner);
        manager.borrow(1, 100e18, merchant1);

        // Part B: repay stays open while paused
        _fundAndApprove(payer, address(manager), 525e18);
        vm.prank(payer);
        manager.repay(1, 525e18);
        CreditLine memory line = manager.getLine(1);
        assertEq(line.drawn, 0);

        manager.unpause();

        // Part C: vault pause
        vm.prank(agentOwner);
        manager.borrow(1, 800e18, merchant1);

        vault.pause();

        _fundAndApprove(backer2, address(vault), 100e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(backer2);
        vault.deposit(1, 100e18);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(backer1);
        vault.withdraw(1, 100e18);

        // fundBorrow is pause-guarded: borrows fail while the vault is paused
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(agentOwner);
        manager.borrow(1, 100e18, merchant1);

        // absorbDefault stays open while the vault is paused
        vault.absorbDefault(1);
        line = manager.getLine(1);
        assertTrue(line.defaulted);

        vault.unpause();

        vm.prank(backer2);
        vault.deposit(1, 100e18);
    }

    // ------------------------------------------------------------------
    // 5. Zero-amount policy
    // ------------------------------------------------------------------

    /// @notice Zero amounts revert with Spore_ZeroAmount.
    function test_ZeroAmountsRevert() public {
        _register(agentOwner); // id 1
        _deposit(backer1, 1, 1000e18);
        oracle.publishScore(1, 800, 10000e18, 1);
        manager.setMerchantAllowed(merchant1, true);
        manager.issueLine(1, 2000e18, 500);

        vm.expectRevert(Spore_ZeroAmount.selector);
        vm.prank(backer1);
        vault.deposit(1, 0);

        vm.expectRevert(Spore_ZeroAmount.selector);
        vm.prank(backer1);
        vault.withdraw(1, 0);

        vm.expectRevert(Spore_ZeroAmount.selector);
        vm.prank(agentOwner);
        manager.borrow(1, 0, merchant1);

        vm.expectRevert(Spore_ZeroAmount.selector);
        vm.prank(backer1);
        manager.repay(1, 0);
    }

    // ------------------------------------------------------------------
    // 6. Overpayment is refunded, not reverted
    // ------------------------------------------------------------------

    /// @notice Excess repayment is refunded to the payer.
    function test_OverpaymentRefunded() public {
        _register(agentOwner); // id 1
        _deposit(backer1, 1, 1000e18);
        oracle.publishScore(1, 800, 10000e18, 1);
        manager.setMerchantAllowed(merchant1, true);
        manager.issueLine(1, 2000e18, 500);

        vm.prank(agentOwner);
        manager.borrow(1, 500e18, merchant1); // fee 25e18

        _fundAndApprove(payer, address(manager), 1000e18);
        vm.prank(payer);
        manager.repay(1, 1000e18);

        CreditLine memory line = manager.getLine(1);
        assertEq(line.drawn, 0);
        assertEq(line.feeOwed, 0);
        assertEq(asset.balanceOf(payer), 475e18);
        assertEq(router.totalFeesRouted(), 25e18);
        assertEq(vault.totalOutstanding(), 0);
    }
}
