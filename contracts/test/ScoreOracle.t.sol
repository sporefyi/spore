// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import "../src/interfaces/ISpore.sol";
import {SporeRegistry} from "../src/SporeRegistry.sol";
import {ScoreOracle} from "../src/ScoreOracle.sol";
import {CreditManager} from "../src/CreditManager.sol";
import {BackerVault} from "../src/BackerVault.sol";
import {FeeRouter} from "../src/FeeRouter.sol";

contract ScoreOracleTest is Test {
    event ScoreUpdated(uint256 indexed agentId, uint16 score, uint256 limit, uint8 modelVersion);

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

    // ---------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------

    function testPublishScore_ByUpdater() public {
        uint256 agentId = _register(agentOwner1);
        assertEq(agentId, 1);

        vm.expectEmit(true, false, false, true, address(oracle));
        emit ScoreUpdated(1, 750, 5000e18, 1);
        vm.prank(updater);
        oracle.publishScore(1, 750, 5000e18, 1);

        ScoreData memory d = oracle.getScore(1);
        assertEq(d.score, 750);
        assertEq(d.limit, 5000e18);
        assertEq(d.updatedAt, uint64(block.timestamp));
        assertEq(d.modelVersion, 1);
        assertTrue(oracle.hasScore(1));
        assertTrue(oracle.isFresh(1));
    }

    function testPublishScore_NonUpdaterReverts() public {
        _register(agentOwner1);
        bytes32 role = oracle.ORACLE_UPDATER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        oracle.publishScore(1, 750, 5000e18, 1);
    }

    function testPublishScore_ScoreAbove1000Reverts() public {
        _register(agentOwner1);
        vm.expectRevert(abi.encodeWithSelector(Spore_InvalidScore.selector, uint16(1001)));
        vm.prank(updater);
        oracle.publishScore(1, 1001, 5000e18, 1);

        // exactly 1000 is allowed
        vm.prank(updater);
        oracle.publishScore(1, 1000, 5000e18, 1);
        assertEq(oracle.getScore(1).score, 1000);
    }

    function testPublishScore_ZeroAgentIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_AgentNotFound.selector, uint256(0)));
        vm.prank(updater);
        oracle.publishScore(0, 750, 5000e18, 1);
    }

    function testPublishScore_Overwrites() public {
        _register(agentOwner1);
        vm.prank(updater);
        oracle.publishScore(1, 750, 5000e18, 1);
        uint64 firstAt = oracle.getScore(1).updatedAt;

        vm.warp(block.timestamp + 100);

        vm.prank(updater);
        oracle.publishScore(1, 400, 1000e18, 2);

        ScoreData memory d = oracle.getScore(1);
        assertEq(d.score, 400);
        assertEq(d.limit, 1000e18);
        assertEq(d.modelVersion, 2);
        assertEq(d.updatedAt, uint64(block.timestamp));
        assertGt(d.updatedAt, firstAt);
    }

    function testIsFresh_FalseWhenStale() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);
        assertTrue(oracle.isFresh(1));

        vm.warp(block.timestamp + STALE_PERIOD + 1);
        assertFalse(oracle.isFresh(1));

        // getScore does not enforce freshness
        ScoreData memory d = oracle.getScore(1);
        assertEq(d.score, 700);
        assertEq(d.limit, 5000e18);
        assertTrue(oracle.hasScore(1));
    }

    function testIsFresh_BoundaryInclusive() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);
        uint256 t = block.timestamp;

        vm.warp(t + STALE_PERIOD);
        assertTrue(oracle.isFresh(1));

        vm.warp(t + STALE_PERIOD + 1);
        assertFalse(oracle.isFresh(1));
    }

    function testIsFresh_NoScore() public view {
        assertFalse(oracle.isFresh(999));
        assertFalse(oracle.hasScore(999));
    }

    function testGetScore_MissingReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_NoOracleData.selector, uint256(999)));
        oracle.getScore(999);
    }

    function testPublishScore_ForUnregisteredAgentAllowed() public {
        // spec: scores may be published for any agentId > 0, even unregistered — harmless, unused
        vm.prank(updater);
        oracle.publishScore(999, 500, 1000e18, 1);
        assertTrue(oracle.hasScore(999));
        assertEq(oracle.getScore(999).score, 500);
    }

    function testSetMaxStalePeriod() public {
        _register(agentOwner1);
        _publishScore(1, 5000e18);
        uint256 t = block.timestamp;

        oracle.setMaxStalePeriod(2 days);
        assertEq(oracle.maxStalePeriod(), 2 days);

        // 1.5 days: stale under the old 1-day window, still fresh under 2 days
        vm.warp(t + 1.5 days);
        assertTrue(oracle.isFresh(1));

        vm.warp(t + 2 days);
        assertTrue(oracle.isFresh(1));

        vm.warp(t + 2 days + 1);
        assertFalse(oracle.isFresh(1));
    }

    function testSetMaxStalePeriod_NonAdminReverts() public {
        bytes32 role = oracle.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        oracle.setMaxStalePeriod(2 days);
    }
}
