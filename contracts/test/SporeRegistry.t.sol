// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/interfaces/ISpore.sol";
import {SporeRegistry} from "../src/SporeRegistry.sol";
import {ScoreOracle} from "../src/ScoreOracle.sol";
import {CreditManager} from "../src/CreditManager.sol";
import {BackerVault} from "../src/BackerVault.sol";
import {FeeRouter} from "../src/FeeRouter.sol";

contract SporeRegistryTest is Test {
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

    /*//////////////////////////////////////////////////////////////
                              registerAgent
    //////////////////////////////////////////////////////////////*/

    function testRegisterAgent_FirstIdIsOneAndEmitsEvent() public {
        vm.warp(1000);

        vm.expectEmit(true, true, false, true, address(registry));
        emit AgentRegistered(1, agentOwner1, "ipfs://test/1");

        vm.prank(agentOwner1);
        uint256 id = registry.registerAgent("ipfs://test/1");

        assertEq(id, 1);
        assertEq(registry.agentCount(), 1);

        AgentRecord memory rec = registry.getAgent(1);
        assertEq(rec.owner, agentOwner1);
        assertTrue(rec.active);
        assertEq(rec.metadataURI, "ipfs://test/1");
        assertEq(uint256(rec.registeredAt), block.timestamp);
    }

    function testRegisterAgent_IdsIncrement() public {
        vm.prank(agentOwner1);
        uint256 id1 = registry.registerAgent("ipfs://test/1");
        vm.prank(agentOwner2);
        uint256 id2 = registry.registerAgent("ipfs://test/2");

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(registry.agentCount(), 2);
        assertEq(registry.agentOwner(1), agentOwner1);
        assertEq(registry.agentOwner(2), agentOwner2);
    }

    function testRegisterAgent_EmptyUriReverts() public {
        vm.expectRevert(abi.encodeWithSelector(SporeRegistry.Spore_EmptyMetadataURI.selector));
        vm.prank(agentOwner1);
        registry.registerAgent("");
    }

    /*//////////////////////////////////////////////////////////////
                              setMetadataURI
    //////////////////////////////////////////////////////////////*/

    function testSetMetadataURI_ByOwner() public {
        uint256 id = _register(agentOwner1);

        vm.prank(agentOwner1);
        registry.setMetadataURI(id, "ipfs://test/updated");

        assertEq(registry.getAgent(id).metadataURI, "ipfs://test/updated");
    }

    function testSetMetadataURI_ByOperator() public {
        uint256 id = _register(agentOwner1);
        bytes32 operatorRole = registry.OPERATOR_ROLE();
        registry.grantRole(operatorRole, stranger);

        vm.prank(stranger);
        registry.setMetadataURI(id, "ipfs://test/by-operator");

        assertEq(registry.getAgent(id).metadataURI, "ipfs://test/by-operator");
        assertEq(registry.agentOwner(id), agentOwner1);
    }

    function testSetMetadataURI_ByStrangerReverts() public {
        uint256 id = _register(agentOwner1);

        vm.expectRevert(abi.encodeWithSelector(Spore_NotAgentOwner.selector, id, stranger));
        vm.prank(stranger);
        registry.setMetadataURI(id, "ipfs://test/evil");
    }

    function testSetMetadataURI_EmptyUriReverts() public {
        uint256 id = _register(agentOwner1);

        vm.expectRevert(abi.encodeWithSelector(SporeRegistry.Spore_EmptyMetadataURI.selector));
        vm.prank(agentOwner1);
        registry.setMetadataURI(id, "");
    }

    function testSetMetadataURI_UnknownAgentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_AgentNotFound.selector, uint256(999)));
        vm.prank(agentOwner1);
        registry.setMetadataURI(999, "ipfs://test/999");
    }

    /*//////////////////////////////////////////////////////////////
                         deactivate / reactivate
    //////////////////////////////////////////////////////////////*/

    function testDeactivateAgent_ByOperator() public {
        uint256 id = _register(agentOwner1);
        assertTrue(registry.isActiveAgent(id));

        registry.deactivateAgent(id);

        assertFalse(registry.isActiveAgent(id));
        assertFalse(registry.getAgent(id).active);
    }

    function testDeactivateAgent_ByStrangerReverts() public {
        uint256 id = _register(agentOwner1);
        bytes32 operatorRole = registry.OPERATOR_ROLE();

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, operatorRole)
        );
        vm.prank(stranger);
        registry.deactivateAgent(id);
    }

    function testReactivateAgent() public {
        uint256 id = _register(agentOwner1);

        registry.deactivateAgent(id);
        assertFalse(registry.isActiveAgent(id));

        registry.reactivateAgent(id);
        assertTrue(registry.isActiveAgent(id));
        assertTrue(registry.getAgent(id).active);
    }

    function testDeactivateAgent_UnknownAgentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_AgentNotFound.selector, uint256(999)));
        registry.deactivateAgent(999);
    }

    /*//////////////////////////////////////////////////////////////
                              setAgentOwner
    //////////////////////////////////////////////////////////////*/

    function testSetAgentOwner_ByOwner() public {
        uint256 id = _register(agentOwner1);

        vm.prank(agentOwner1);
        registry.setAgentOwner(id, agentOwner2);

        assertEq(registry.agentOwner(id), agentOwner2);
        assertEq(registry.getAgent(id).owner, agentOwner2);

        vm.expectRevert(abi.encodeWithSelector(Spore_NotAgentOwner.selector, id, agentOwner1));
        vm.prank(agentOwner1);
        registry.setMetadataURI(id, "ipfs://test/old-owner");
    }

    function testSetAgentOwner_ByAdmin() public {
        uint256 id = _register(agentOwner1);
        assertTrue(admin != agentOwner1);

        registry.setAgentOwner(id, agentOwner2);

        assertEq(registry.agentOwner(id), agentOwner2);
    }

    function testSetAgentOwner_ByStrangerReverts() public {
        uint256 id = _register(agentOwner1);

        vm.expectRevert(abi.encodeWithSelector(Spore_NotAgentOwner.selector, id, stranger));
        vm.prank(stranger);
        registry.setAgentOwner(id, stranger);
    }

    function testSetAgentOwner_ZeroAddressReverts() public {
        uint256 id = _register(agentOwner1);

        vm.expectRevert(abi.encodeWithSelector(Spore_ZeroAddress.selector));
        vm.prank(agentOwner1);
        registry.setAgentOwner(id, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                 getters
    //////////////////////////////////////////////////////////////*/

    function testGetAgent_UnknownReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_AgentNotFound.selector, uint256(999)));
        registry.getAgent(999);

        vm.expectRevert(abi.encodeWithSelector(Spore_AgentNotFound.selector, uint256(999)));
        registry.agentOwner(999);
    }
}
