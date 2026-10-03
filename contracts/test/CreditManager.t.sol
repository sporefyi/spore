// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CreditManager} from "../src/CreditManager.sol";
import {SporeRegistry} from "../src/SporeRegistry.sol";
import {ScoreOracle} from "../src/ScoreOracle.sol";
import {BackerVault} from "../src/BackerVault.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import "../src/interfaces/ISpore.sol";

contract CreditManagerTest is Test {
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

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

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

    function _issueLine(uint256 agentId, uint256 limit_, uint16 feeBps) internal {
        manager.issueLine(agentId, limit_, feeBps);
    }

    /// @dev Canonical flow: agent 1, oracle limit 5000e18, line 3000e18 @ 1000 bps, merchant1 allowed, vault funded.
    function _canonical() internal {
        uint256 id = _register(agentOwner1);
        assertEq(id, 1);
        _publishScore(1, 5000e18);
        _issueLine(1, 3000e18, 1000);
        manager.setMerchantAllowed(merchant1, true);
        _fundVault(100_000e18);
    }

    function _borrow(uint256 amount) internal {
        vm.prank(agentOwner1);
        manager.borrow(1, amount, merchant1);
    }

    function _repayAs(address payer, uint256 amount) internal {
        vm.startPrank(payer);
        asset.approve(address(manager), amount);
        manager.repay(1, amount);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              ISSUE LINE
    //////////////////////////////////////////////////////////////*/

    function testIssueLine_HappyPath() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);

        vm.expectEmit(true, false, false, true, address(manager));
        emit CreditIssued(1, 3000e18, 1000);
        _issueLine(1, 3000e18, 1000);

        CreditLine memory line = manager.getLine(1);
        assertEq(line.limit, 3000e18);
        assertEq(line.drawn, 0);
        assertEq(line.feeOwed, 0);
        assertEq(line.feeBps, 1000);
        assertTrue(line.active);
        assertFalse(line.defaulted);
        assertEq(line.issuedAt, uint64(block.timestamp));
    }

    function testIssueLine_DoubleIssueReverts() public {
        _canonical();
        vm.expectRevert(abi.encodeWithSelector(Spore_LineAlreadyActive.selector, uint256(1)));
        manager.issueLine(1, 1000e18, 500);
    }

    function testIssueLine_FeeBpsTooHighReverts() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);
        vm.expectRevert(abi.encodeWithSelector(Spore_FeeBpsTooHigh.selector, uint16(2001)));
        manager.issueLine(1, 1000e18, 2001);

        // exactly the cap is OK
        manager.issueLine(1, 1000e18, 2000);
        assertEq(manager.getLine(1).feeBps, 2000);
    }

    function testIssueLine_ZeroLimitReverts() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);
        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAmount.selector));
        manager.issueLine(1, 0, 1000);
    }

    function testIssueLine_ExceedsOracleLimitReverts() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);
        vm.expectRevert(
            abi.encodeWithSelector(Spore_ExceedsOracleLimit.selector, uint256(1), uint256(6000e18), uint256(5000e18))
        );
        manager.issueLine(1, 6000e18, 1000);
    }

    function testIssueLine_NonUnderwriterReverts() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);
        bytes32 role = manager.UNDERWRITER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        manager.issueLine(1, 3000e18, 1000);
    }

    /*//////////////////////////////////////////////////////////////
                                BORROW
    //////////////////////////////////////////////////////////////*/

    function testBorrow_HappyPath() public {
        _canonical();

        vm.expectEmit(true, false, false, true, address(manager));
        emit Borrow(1, 1000e18, 100e18);
        vm.expectEmit(true, true, false, true, address(manager));
        emit Payment(1, merchant1, 1000e18);
        _borrow(1000e18);

        CreditLine memory line = manager.getLine(1);
        assertEq(line.drawn, 1000e18);
        assertEq(line.feeOwed, 100e18);
        assertEq(asset.balanceOf(merchant1), 1000e18);
        assertEq(vault.totalOutstanding(), 1000e18);
        assertEq(manager.availableToBorrow(1), 2000e18);
    }

    function testBorrow_ByNonOwnerReverts() public {
        _canonical();
        vm.expectRevert(abi.encodeWithSelector(Spore_NotAgentOwner.selector, uint256(1), stranger));
        vm.prank(stranger);
        manager.borrow(1, 1000e18, merchant1);
    }

    function testBorrow_OverLimitReverts() public {
        _canonical();
        _borrow(600e18);
        vm.expectRevert(
            abi.encodeWithSelector(Spore_ExceedsLimit.selector, uint256(1), uint256(2500e18), uint256(2400e18))
        );
        vm.prank(agentOwner1);
        manager.borrow(1, 2500e18, merchant1);
    }

    function testBorrow_UnlistedMerchantReverts() public {
        _canonical();
        vm.expectRevert(abi.encodeWithSelector(Spore_MerchantNotAllowed.selector, merchant2));
        vm.prank(agentOwner1);
        manager.borrow(1, 1000e18, merchant2);
    }

    function testBorrow_ZeroAmountReverts() public {
        _canonical();
        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAmount.selector));
        vm.prank(agentOwner1);
        manager.borrow(1, 0, merchant1);
    }

    function testBorrow_StaleOracleReverts() public {
        _canonical();
        uint64 updatedAt = oracle.getScore(1).updatedAt;
        vm.warp(block.timestamp + STALE_PERIOD + 1);
        vm.expectRevert(abi.encodeWithSelector(Spore_StaleOracleData.selector, uint256(1), updatedAt));
        vm.prank(agentOwner1);
        manager.borrow(1, 1000e18, merchant1);
    }

    function testBorrow_BootstrapModeNoOracleRecord() public {
        uint256 id = _register(agentOwner2);
        assertFalse(oracle.hasScore(id));
        manager.setMerchantAllowed(merchant1, true);
        _fundVault(100_000e18);

        _issueLine(id, 2000e18, 500);

        vm.prank(agentOwner2);
        manager.borrow(id, 1000e18, merchant1);

        CreditLine memory line = manager.getLine(id);
        assertEq(line.drawn, 1000e18);
        assertEq(line.feeOwed, 50e18);
        assertEq(asset.balanceOf(merchant1), 1000e18);
    }

    /*//////////////////////////////////////////////////////////////
                                REPAY
    //////////////////////////////////////////////////////////////*/

    function testRepay_SplitsFeeThenPrincipal() public {
        _canonical();
        _borrow(1000e18);

        uint256 vaultBefore = asset.balanceOf(address(vault));

        // repay() emits several token Transfer logs before Repay; capture all logs
        // and decode the Repay event explicitly instead of relying on expectEmit ordering.
        vm.recordLogs();
        _repayAs(agentOwner1, 600e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 repaySig = keccak256("Repay(uint256,address,uint256,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(manager) && logs[i].topics.length == 3 && logs[i].topics[0] == repaySig) {
                found = true;
                assertEq(uint256(logs[i].topics[1]), 1);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), agentOwner1);
                (uint256 amount, uint256 feePortion) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(amount, 600e18);
                assertEq(feePortion, 100e18);
            }
        }
        assertTrue(found);

        CreditLine memory line = manager.getLine(1);
        assertEq(line.feeOwed, 0);
        assertEq(line.drawn, 500e18);
        assertEq(asset.balanceOf(treasuryAcct), 10e18);
        assertEq(vault.yieldReserve(), 90e18);
        // 500e18 principal + 90e18 backer-yield fee leg
        assertEq(asset.balanceOf(address(vault)) - vaultBefore, 590e18);
    }

    function testRepay_ByThirdParty() public {
        _canonical();
        _borrow(1000e18);

        uint256 strangerBefore = asset.balanceOf(stranger);
        _repayAs(stranger, 300e18);

        CreditLine memory line = manager.getLine(1);
        assertEq(line.feeOwed, 0);
        assertEq(line.drawn, 800e18);
        assertEq(strangerBefore - asset.balanceOf(stranger), 300e18);
    }

    function testRepay_OverRepayRefundsExcess() public {
        _canonical();
        _borrow(1000e18);

        uint256 balanceBefore = asset.balanceOf(agentOwner1);
        _repayAs(agentOwner1, 1500e18);
        uint256 balanceAfter = asset.balanceOf(agentOwner1);

        CreditLine memory line = manager.getLine(1);
        assertEq(line.drawn, 0);
        assertEq(line.feeOwed, 0);
        assertEq(balanceBefore - balanceAfter, 1100e18);
    }

    function testRepay_ZeroAmountReverts() public {
        _canonical();
        _borrow(1000e18);
        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAmount.selector));
        vm.prank(agentOwner1);
        manager.repay(1, 0);
    }

    /*//////////////////////////////////////////////////////////////
                               SET LIMIT
    //////////////////////////////////////////////////////////////*/

    function testSetLimit_EmitsAndUpdates() public {
        _canonical();
        vm.expectEmit(true, false, false, true, address(manager));
        emit CreditLimitChanged(1, 3000e18, 4000e18);
        manager.setLimit(1, 4000e18);
        assertEq(manager.getLine(1).limit, 4000e18);
    }

    function testSetLimit_OracleCapEnforced() public {
        _canonical();
        vm.expectRevert(
            abi.encodeWithSelector(Spore_ExceedsOracleLimit.selector, uint256(1), uint256(6000e18), uint256(5000e18))
        );
        manager.setLimit(1, 6000e18);
    }

    /*//////////////////////////////////////////////////////////////
                              CLOSE LINE
    //////////////////////////////////////////////////////////////*/

    function testCloseLine_WithDebtReverts() public {
        _canonical();
        _borrow(100e18);
        vm.expectRevert(abi.encodeWithSelector(Spore_LineHasDebt.selector, uint256(1), uint256(100e18)));
        manager.closeLine(1);
    }

    function testCloseLine_AfterFullRepay() public {
        _canonical();
        _borrow(1000e18);
        _repayAs(agentOwner1, 1100e18);

        manager.closeLine(1);
        assertFalse(manager.getLine(1).active);

        vm.expectRevert(abi.encodeWithSelector(Spore_NoActiveLine.selector, uint256(1)));
        vm.prank(agentOwner1);
        manager.borrow(1, 100e18, merchant1);
    }

    /*//////////////////////////////////////////////////////////////
                             MARK DEFAULTED
    //////////////////////////////////////////////////////////////*/

    function testMarkDefaulted_OnlyVault() public {
        _canonical();

        vm.expectRevert(abi.encodeWithSelector(Spore_OnlyBackerVault.selector, stranger));
        vm.prank(stranger);
        manager.markDefaulted(1, 0, 500e18);

        _borrow(500e18);

        vm.expectEmit(true, false, false, true, address(manager));
        emit Default(1, 500e18, 0, 500e18);
        vault.absorbDefault(1);

        CreditLine memory line = manager.getLine(1);
        assertTrue(line.defaulted);
        assertFalse(line.active); // default is terminal: active=false per amended spec
        assertEq(line.drawn, 0);
        assertEq(line.feeOwed, 0);
    }

    function testMarkDefaulted_MismatchReverts() public {
        _canonical();
        _borrow(500e18);

        // covered + shortfall (200e18) != drawn (500e18)
        vm.expectRevert(
            abi.encodeWithSelector(
                Spore_DefaultMismatch.selector, uint256(1), uint256(500e18), uint256(100e18), uint256(100e18)
            )
        );
        vm.prank(address(vault));
        manager.markDefaulted(1, 100e18, 100e18);
    }

    /// @dev SPEC GAP (reported to coordinator): amended spec requires issueLine
    ///      to revert Spore_LineDefaulted if the line was EVER defaulted, but
    ///      CreditManager.issueLine has no such check — re-issuing currently
    ///      succeeds and silently overwrites the defaulted line record. This
    ///      test documents the required behavior and currently FAILS against
    ///      the implementation; it should pass once the impl lane adds the guard.
    function testIssueLine_AfterDefaultReverts() public {
        _canonical();
        _borrow(500e18);
        vault.absorbDefault(1);

        // default is terminal — the line can never be re-issued
        vm.expectRevert(abi.encodeWithSelector(Spore_LineDefaulted.selector, uint256(1)));
        manager.issueLine(1, 1000e18, 500);
    }

    function testIssueLine_ZeroFeeBpsAllowed() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);
        manager.setMerchantAllowed(merchant1, true);
        _fundVault(100_000e18);

        manager.issueLine(1, 3000e18, 0);

        vm.prank(agentOwner1);
        manager.borrow(1, 1000e18, merchant1);
        assertEq(manager.getLine(1).feeOwed, 0);
    }

    function testMaxFeeBps_Constant() public view {
        assertEq(manager.MAX_FEE_BPS(), 2000);
    }

    /*//////////////////////////////////////////////////////////////
                          SET LIMIT (AMENDED)
    //////////////////////////////////////////////////////////////*/

    function testSetLimit_DecreaseAlwaysAllowed() public {
        _canonical();
        _borrow(1000e18);

        // decrease below the drawn amount is allowed by the contract
        manager.setLimit(1, 500e18);
        assertEq(manager.getLine(1).limit, 500e18);
    }

    function testSetLimit_DecreaseToZeroAllowed() public {
        _canonical();
        vm.expectEmit(true, false, false, true, address(manager));
        emit CreditLimitChanged(1, 3000e18, 0);
        manager.setLimit(1, 0);
        assertEq(manager.getLine(1).limit, 0);
        assertEq(manager.availableToBorrow(1), 0);
    }

    function testSetLimit_DecreaseOnStaleOracleAllowed() public {
        _canonical();
        vm.warp(block.timestamp + STALE_PERIOD + 1);

        // decreases skip the oracle gate entirely, even on stale data
        manager.setLimit(1, 2000e18);
        assertEq(manager.getLine(1).limit, 2000e18);
    }

    function testSetLimit_IncreaseOnStaleOracleReverts() public {
        _canonical();
        uint64 updatedAt = oracle.getScore(1).updatedAt;
        vm.warp(block.timestamp + STALE_PERIOD + 1);

        vm.expectRevert(abi.encodeWithSelector(Spore_StaleOracleData.selector, uint256(1), updatedAt));
        manager.setLimit(1, 4000e18);
    }

    /*//////////////////////////////////////////////////////////////
                                PAUSE
    //////////////////////////////////////////////////////////////*/

    function testPause_BlocksIssueSetLimitBorrow() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);
        manager.pause();
        assertTrue(manager.paused());

        vm.expectRevert(Pausable.EnforcedPause.selector);
        manager.issueLine(1, 3000e18, 1000);

        // issue a line first via unpause, then check setLimit/borrow are blocked
        manager.unpause();
        manager.issueLine(1, 3000e18, 1000);
        manager.setMerchantAllowed(merchant1, true);
        _fundVault(100_000e18);
        manager.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        manager.setLimit(1, 2000e18);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(agentOwner1);
        manager.borrow(1, 100e18, merchant1);
    }

    function testPause_RepayAndDefaultStayOpen() public {
        _canonical();
        _borrow(500e18);
        manager.pause();

        // repay stays open under pause
        _repayAs(agentOwner1, 100e18);
        assertEq(manager.getLine(1).drawn, 450e18);

        // defaults stay resolvable under pause
        vault.absorbDefault(1);
        assertTrue(manager.getLine(1).defaulted);

        manager.unpause();
        assertFalse(manager.paused());
    }

    function testPause_NonPauserReverts() public {
        bytes32 role = manager.PAUSER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        manager.pause();
    }

    /*//////////////////////////////////////////////////////////////
                          WIRING / VIEWS
    //////////////////////////////////////////////////////////////*/

    function testViews_Wiring() public view {
        assertEq(address(manager.asset()), address(asset));
        assertEq(manager.vault(), address(vault));
        assertEq(manager.feeRouter(), address(router));
        assertEq(manager.oracle(), address(oracle));
        assertEq(address(manager.registry()), address(registry));
    }

    function testWiring_ZeroAddressReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAddress.selector));
        manager.setVault(address(0));

        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAddress.selector));
        manager.setFeeRouter(address(0));

        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAddress.selector));
        manager.setOracle(address(0));

        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAddress.selector));
        manager.setRegistry(address(0));

        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAddress.selector));
        manager.setMerchantAllowed(address(0), true);
    }
}
