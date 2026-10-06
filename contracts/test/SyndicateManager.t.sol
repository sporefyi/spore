// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SyndicateManager} from "../src/SyndicateManager.sol";
import {SporeRegistry} from "../src/SporeRegistry.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";

contract SyndicateManagerTest is Test {
    SyndicateManager synd;
    SporeRegistry registry;
    ERC20Mock usdg;

    address admin = address(0xA);
    address agentOwner = address(0xB);
    address backer1 = address(0xC);
    address backer2 = address(0xD);
    address backer3 = address(0xE);

    uint256 agentId;

    function setUp() public {
        usdg = new ERC20Mock();
        registry = new SporeRegistry(admin);
        synd = new SyndicateManager(address(usdg), address(registry), admin);

        vm.prank(agentOwner);
        agentId = registry.registerAgent("ipfs://agent1");

        // fund backers + borrower-side payer
        usdg.mint(backer1, 1_000_000_000);
        usdg.mint(backer2, 1_000_000_000);
        usdg.mint(backer3, 1_000_000_000);
        usdg.mint(agentOwner, 1_000_000_000);
    }

    function _propose() internal returns (uint256) {
        // target 600 USDG (6e8 units), 5% fee, 1-day funding, 7-day tenor
        return synd.propose(agentId, 600_000_000, 500, 1 days, 7 days, "H100 render job");
    }

    function test_full_lifecycle_repaid() public {
        uint256 loanId = _propose();

        vm.prank(backer1);
        usdg.approve(address(synd), 200_000_000);
        vm.prank(backer1);
        synd.fund(loanId, 200_000_000);

        vm.prank(backer2);
        usdg.approve(address(synd), 400_000_000);
        vm.prank(backer2);
        synd.fund(loanId, 400_000_000);

        uint256 borrowerBefore = usdg.balanceOf(agentOwner);
        synd.activate(loanId);
        assertEq(usdg.balanceOf(agentOwner) - borrowerBefore, 600_000_000);

        // repay principal + 5% fee = 630 USDG
        vm.prank(agentOwner);
        usdg.approve(address(synd), 630_000_000);
        vm.prank(agentOwner);
        synd.repay(loanId, 630_000_000);

        // claims: backer1 gets 1/3 of 630 = 210, backer2 gets 420
        uint256 b1Before = usdg.balanceOf(backer1);
        vm.prank(backer1);
        synd.claim(loanId);
        assertEq(usdg.balanceOf(backer1) - b1Before, 210_000_000);

        uint256 b2Before = usdg.balanceOf(backer2);
        vm.prank(backer2);
        synd.claim(loanId);
        assertEq(usdg.balanceOf(backer2) - b2Before, 420_000_000);
    }

    function test_partial_repay_then_default() public {
        uint256 loanId = _propose();

        vm.prank(backer1);
        usdg.approve(address(synd), 600_000_000);
        vm.prank(backer1);
        synd.fund(loanId, 600_000_000);
        synd.activate(loanId);

        // borrower repays only 300 of 630 owed
        vm.prank(agentOwner);
        usdg.approve(address(synd), 300_000_000);
        vm.prank(agentOwner);
        synd.repay(loanId, 300_000_000);

        // fast-forward past tenor
        vm.warp(block.timestamp + 8 days);
        synd.markDefault(loanId);

        // backer recovers pro-rata of 300
        uint256 before = usdg.balanceOf(backer1);
        vm.prank(backer1);
        synd.claim(loanId);
        assertEq(usdg.balanceOf(backer1) - before, 300_000_000);
    }

    function test_cancel_refunds() public {
        uint256 loanId = _propose();

        vm.prank(backer1);
        usdg.approve(address(synd), 100_000_000);
        vm.prank(backer1);
        synd.fund(loanId, 100_000_000);

        vm.warp(block.timestamp + 2 days);
        synd.cancel(loanId);

        uint256 before = usdg.balanceOf(backer1);
        vm.prank(backer1);
        synd.claim(loanId);
        assertEq(usdg.balanceOf(backer1) - before, 100_000_000);
    }

    function test_cannot_overfund() public {
        uint256 loanId = _propose();
        vm.prank(backer1);
        usdg.approve(address(synd), 700_000_000);
        vm.prank(backer1);
        vm.expectRevert("Syndicate: over target");
        synd.fund(loanId, 700_000_000);
    }

    function test_cannot_activate_underfunded() public {
        uint256 loanId = _propose();
        vm.prank(backer1);
        usdg.approve(address(synd), 100_000_000);
        vm.prank(backer1);
        synd.fund(loanId, 100_000_000);
        vm.expectRevert("Syndicate: target not reached");
        synd.activate(loanId);
    }

    function test_reject_unknown_agent() public {
        vm.expectRevert(abi.encodeWithSignature("Spore_AgentNotFound(uint256)", 9999));
        synd.propose(9999, 100_000_000, 500, 1 days, 7 days, "ghost loan");
    }

    function test_fee_cap() public {
        vm.expectRevert("Syndicate: fee too high");
        synd.propose(agentId, 100_000_000, 5001, 1 days, 7 days, "greedy");
    }

    function test_claimable_view() public {
        uint256 loanId = _propose();
        vm.prank(backer1);
        usdg.approve(address(synd), 600_000_000);
        vm.prank(backer1);
        synd.fund(loanId, 600_000_000);
        assertEq(synd.claimable(loanId, backer1), 0); // not claimable while funding
        synd.activate(loanId);
        assertEq(synd.claimable(loanId, backer1), 0); // not claimable while active
    }
}
