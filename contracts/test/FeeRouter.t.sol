// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {FeeRouter} from "../src/FeeRouter.sol";
import {SporeRegistry} from "../src/SporeRegistry.sol";
import {ScoreOracle} from "../src/ScoreOracle.sol";
import {CreditManager} from "../src/CreditManager.sol";
import {BackerVault} from "../src/BackerVault.sol";
import {
    Revenue,
    CreditLine,
    Spore_OnlyCreditManager,
    Spore_SplitBpsInvalid,
    Spore_ZeroAmount,
    SPORE_REVENUE_TREASURY,
    SPORE_REVENUE_VAULT
} from "../src/interfaces/ISpore.sol";

contract FeeRouterTest is Test {
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

    /// @dev Register an agent owned by `owner_` with a dummy URI; returns the agentId.
    function _register(address owner_) internal returns (uint256) {
        vm.prank(owner_);
        return registry.registerAgent("ipfs://test/agent");
    }

    /// @dev Publish a fresh score for agentId with the given oracle limit (score 700, model v1).
    function _publishScore(uint256 agentId, uint256 limit_) internal {
        vm.prank(updater);
        oracle.publishScore(agentId, 700, limit_, 1);
    }

    /// @dev Mint asset directly into the vault so borrows have liquidity.
    function _fundVault(uint256 amount) internal {
        asset.mint(address(vault), amount);
    }

    /// @dev Backer deposits `amount` for agentId (with approval).
    function _deposit(address backer, uint256 agentId, uint256 amount) internal {
        vm.startPrank(backer);
        asset.approve(address(vault), amount);
        vault.deposit(agentId, amount);
        vm.stopPrank();
    }

    /// @dev Push `amount` to router then call collectFee as the manager.
    function _collect(uint256 agentId, uint256 amount) internal {
        asset.mint(address(router), amount);
        vm.prank(address(manager));
        router.collectFee(agentId, amount);
    }

    function testCollectFee_SplitMath() public {
        uint256 amount = 1000e18;
        asset.mint(address(router), amount);

        vm.expectEmit(true, true, true, true, address(router));
        emit Revenue(treasuryAcct, 100e18, SPORE_REVENUE_TREASURY);
        vm.expectEmit(true, true, true, true, address(router));
        emit Revenue(address(vault), 900e18, SPORE_REVENUE_VAULT);

        vm.prank(address(manager));
        router.collectFee(1, amount);

        assertEq(asset.balanceOf(treasuryAcct), 100e18);
        assertEq(asset.balanceOf(address(vault)), 900e18);
        assertEq(vault.yieldReserve(), 900e18);
        assertEq(router.totalFeesRouted(), 1000e18);
        assertEq(asset.balanceOf(address(router)), 0);
    }

    function testCollectFee_OnlyManager() public {
        asset.mint(address(router), 1000e18);
        vm.expectRevert(abi.encodeWithSelector(Spore_OnlyCreditManager.selector, stranger));
        vm.prank(stranger);
        router.collectFee(1, 1000e18);
    }

    function testCollectFee_ZeroAmountReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAmount.selector));
        vm.prank(address(manager));
        router.collectFee(1, 0);
    }

    function testCollectFee_RoundingDown() public {
        _collect(1, 999);

        assertEq(asset.balanceOf(treasuryAcct), 99);
        assertEq(asset.balanceOf(address(vault)), 900);
        assertEq(vault.yieldReserve(), 900);
        assertEq(router.totalFeesRouted(), 999);
        assertEq(asset.balanceOf(address(router)), 0);
    }

    function testSetSplit_CapEnforced() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_SplitBpsInvalid.selector, uint16(5001)));
        router.setSplit(5001);

        router.setSplit(5000);
        assertEq(router.treasuryBps(), 5000);
    }

    function testSetSplit_NonAdminReverts() public {
        bytes32 role = router.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        router.setSplit(100);
    }

    function testCollectFee_ZeroTreasuryLeg_NoTreasuryEvent() public {
        router.setSplit(0);
        uint256 amount = 1000e18;
        asset.mint(address(router), amount);

        vm.recordLogs();
        vm.prank(address(manager));
        router.collectFee(1, amount);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("Revenue(address,uint256,bytes32)");
        uint256 count;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) {
                count++;
            }
        }
        assertEq(count, 1);
        assertEq(asset.balanceOf(treasuryAcct), 0);
        assertEq(asset.balanceOf(address(vault)), 1000e18);
        assertEq(vault.yieldReserve(), 1000e18);
    }

    function testCollectFee_MaxSplit() public {
        router.setSplit(5000);
        uint256 amount = 1000e18;
        asset.mint(address(router), amount);

        vm.expectEmit(true, true, true, true, address(router));
        emit Revenue(treasuryAcct, 500e18, SPORE_REVENUE_TREASURY);
        vm.expectEmit(true, true, true, true, address(router));
        emit Revenue(address(vault), 500e18, SPORE_REVENUE_VAULT);

        vm.prank(address(manager));
        router.collectFee(1, amount);

        assertEq(asset.balanceOf(treasuryAcct), 500e18);
        assertEq(asset.balanceOf(address(vault)), 500e18);
        assertEq(vault.yieldReserve(), 500e18);
        assertEq(router.totalFeesRouted(), 1000e18);
    }

    function testEndToEnd_ViaCreditManagerRepay() public {
        uint256 agentId = _register(agentOwner1);
        assertEq(agentId, 1);
        _publishScore(agentId, 10_000e18);
        manager.issueLine(agentId, 5000e18, 1000);
        manager.setMerchantAllowed(merchant1, true);
        _deposit(backer1, agentId, 10_000e18);

        vm.prank(agentOwner1);
        manager.borrow(agentId, 2000e18, merchant1);

        vm.startPrank(agentOwner1);
        asset.approve(address(manager), 2200e18);
        manager.repay(agentId, 2200e18);
        vm.stopPrank();

        assertEq(asset.balanceOf(treasuryAcct), 20e18);
        assertEq(vault.yieldReserve(), 180e18);
        assertEq(router.totalFeesRouted(), 200e18);
        assertEq(asset.balanceOf(address(router)), 0);

        CreditLine memory line = manager.getLine(agentId);
        assertEq(line.drawn, 0);
        assertEq(line.feeOwed, 0);
    }

    function testViews_AssetCreditManagerTreasuryVault() public view {
        assertEq(address(router.asset()), address(asset));
        assertEq(router.creditManager(), address(manager));
        assertEq(router.treasury(), treasuryAcct);
        assertEq(router.vault(), address(vault));
        assertEq(router.treasuryBps(), TREASURY_BPS);
        assertEq(SPORE_REVENUE_TREASURY, 0x7472656173757279000000000000000000000000000000000000000000000000); // "treasury"
        assertEq(SPORE_REVENUE_VAULT, 0x6261636b65722d7969656c640000000000000000000000000000000000000000); // "backer-yield"
    }
}
