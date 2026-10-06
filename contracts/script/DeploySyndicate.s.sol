// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SyndicateManager} from "../src/SyndicateManager.sol";

/// @notice Deploys SyndicateManager to Robinhood Chain.
/// @dev Production deploy: set env vars and broadcast with a funded deployer key.
///
///      SYNDICATE_ASSET     USDG on Robinhood Chain (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168)
///      SYNDICATE_REGISTRY  SporeRegistry (0x6902670409c4FA3a75C39A734c69beAEEBcF9729)
///      SYNDICATE_ADMIN     admin / pauser (deployer wallet)
///
///      Simulation (no broadcast):
///        forge script script/DeploySyndicate.s.sol
///      Production:
///        forge script script/DeploySyndicate.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///          --broadcast --private-key $DEPLOYER_KEY
contract DeploySyndicateScript is Script {
    function run() external {
        address asset = vm.envAddress("SYNDICATE_ASSET");
        address registry = vm.envAddress("SYNDICATE_REGISTRY");
        address admin = vm.envAddress("SYNDICATE_ADMIN");

        require(asset != address(0), "DeploySyndicate: SYNDICATE_ASSET unset");
        require(registry != address(0), "DeploySyndicate: SYNDICATE_REGISTRY unset");
        require(admin != address(0), "DeploySyndicate: SYNDICATE_ADMIN unset");

        console.log("=== SyndicateManager deploy ===");
        console.log("ASSET:", asset);
        console.log("REGISTRY:", registry);
        console.log("ADMIN:", admin);

        vm.startBroadcast();
        SyndicateManager synd = new SyndicateManager(asset, registry, admin);
        vm.stopBroadcast();

        console.log("SyndicateManager deployed at:", address(synd));
    }
}
