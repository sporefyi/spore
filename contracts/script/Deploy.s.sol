// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {SporeRegistry} from "../src/SporeRegistry.sol";
import {ScoreOracle} from "../src/ScoreOracle.sol";
import {CreditManager} from "../src/CreditManager.sol";
import {BackerVault} from "../src/BackerVault.sol";
import {FeeRouter} from "../src/FeeRouter.sol";

/// @title DeployScript — SPORE credit protocol v1
/// @notice Deploys the five core contracts in the frozen order and performs
///         the admin wiring (manager.setVault / manager.setFeeRouter /
///         vault.setFeeRouter).
/// @dev SIMULATION-SAFE BY DESIGN: this foundry nightly's `--private-key`
///      flags are broken, so this script never takes keys or `--broadcast`
///      flags. Running `forge script script/Deploy.s.sol` (no flags, no keys)
///      performs a pure dry simulation. Broadcasting is entered ONLY when the
///      env var `SPORE_BROADCAST=true` is set, and only via an explicit
///      `vm.startBroadcast()` / `vm.stopBroadcast()` pair.
///
///      Parameter defaults are LOCAL-SIMULATION values only. Production values
///      are set at the real ceremony (see DEPLOY.md).
contract DeployScript is Script {
    struct Params {
        address admin;
        address updater;
        address treasury;
        address asset; // address(0) == UNSET -> deploy ERC20Mock (simulation only)
        uint16 treasuryBps;
        uint64 maxStalePeriod;
    }

    struct Deployed {
        address asset;
        SporeRegistry registry;
        ScoreOracle oracle;
        CreditManager manager;
        BackerVault vault;
        FeeRouter router;
    }

    function run() external {
        Params memory p = _loadParams();
        // Production values are set at the real ceremony; these defaults are
        // placeholders for local simulation only.
        bool doBroadcast = vm.envOr("SPORE_BROADCAST", false);

        console.log("=== SPORE v1 deploy ===");
        console.log("Broadcast enabled:", doBroadcast);
        console.log("ADMIN:", p.admin);
        console.log("UPDATER:", p.updater);
        console.log("TREASURY:", p.treasury);
        console.log("TREASURY_BPS:", uint256(p.treasuryBps));
        console.log("MAX_STALE_PERIOD (s):", uint256(p.maxStalePeriod));

        if (doBroadcast) {
            // The mock asset must never reach a real chain.
            require(p.asset != address(0), "Deploy: ASSET must be set when broadcasting");
            console.log(
                "Broadcasting: deploy AND wiring are sent from the broadcast signer -",
                "ADMIN must be that signer, otherwise wiring reverts on-chain (fail-safe)."
            );
            vm.startBroadcast();
        }

        Deployed memory d = _deploy(p);
        _wire(p, d, doBroadcast);
        _verify(p, d);

        if (doBroadcast) {
            vm.stopBroadcast();
        }

        console.log("=== Deploy complete ===");
        console.log("REMINDER: role grants (UNDERWRITER_ROLE, PAUSER_ROLE) are separate ceremony steps.");
        console.log("REMINDER: DEPLOY.md post-deploy verification is a separate ceremony step.");
    }

    /// @dev Reads parameters from the environment with local-simulation defaults.
    function _loadParams() internal view returns (Params memory p) {
        p.admin = vm.envOr("ADMIN", address(1));
        p.updater = vm.envOr("UPDATER", address(2));
        p.treasury = vm.envOr("TREASURY", address(3));
        p.asset = vm.envOr("ASSET", address(0));

        uint256 bps = vm.envOr("TREASURY_BPS", uint256(2000)); // 20%
        require(bps <= 10_000, "Deploy: TREASURY_BPS > 10000");
        // SafeCast (checked, reverts on overflow) instead of a narrowing typecast.
        p.treasuryBps = SafeCast.toUint16(bps);

        uint256 stale = vm.envOr("MAX_STALE_PERIOD", uint256(7 days));
        // SafeCast reverts on overflow — no unchecked narrowing cast.
        p.maxStalePeriod = SafeCast.toUint64(stale);
    }

    /// @dev Frozen deploy order: registry -> oracle -> manager -> vault -> router.
    function _deploy(Params memory p) internal returns (Deployed memory d) {
        if (p.asset == address(0)) {
            ERC20Mock mock = new ERC20Mock();
            d.asset = address(mock);
            console.log("!!! SIMULATION ONLY: ASSET unset - deployed ERC20Mock as settlement asset:", d.asset);
            console.log("!!! This mock MUST NEVER be presented as the real asset.");
        } else {
            d.asset = p.asset;
            console.log("Settlement asset (from env):", d.asset);
        }

        d.registry = new SporeRegistry(p.admin);
        console.log("SporeRegistry:", address(d.registry));

        d.oracle = new ScoreOracle(p.admin, p.updater, p.maxStalePeriod);
        console.log("ScoreOracle:", address(d.oracle));

        d.manager = new CreditManager(
            d.asset, address(d.registry), address(d.oracle), p.admin, p.maxStalePeriod
        );
        console.log("CreditManager:", address(d.manager));

        d.vault = new BackerVault(d.asset, address(d.registry), address(d.manager), p.admin);
        console.log("BackerVault:", address(d.vault));

        d.router = new FeeRouter(
            d.asset, p.treasury, address(d.vault), address(d.manager), p.treasuryBps, p.admin
        );
        console.log("FeeRouter:", address(d.router));
    }

    /// @dev Wiring setters are DEFAULT_ADMIN_ROLE-gated and ADMIN is typically
    ///      not the script runner, so in simulation they run under a prank.
    ///      When broadcasting, the broadcast signer IS the admin and the calls
    ///      go out as real transactions (no prank during broadcast). In a real
    ///      ceremony with a multisig ADMIN, wiring is performed by the admin
    ///      separately instead.
    function _wire(Params memory p, Deployed memory d, bool doBroadcast) internal {
        if (!doBroadcast) {
            vm.startPrank(p.admin);
        }

        console.log("Wiring 1/3: manager.setVault(vault)");
        d.manager.setVault(address(d.vault));

        console.log("Wiring 2/3: manager.setFeeRouter(router)");
        d.manager.setFeeRouter(address(d.router));

        console.log("Wiring 3/3: vault.setFeeRouter(router)");
        d.vault.setFeeRouter(address(d.router));

        if (!doBroadcast) {
            vm.stopPrank();
        }
    }

    /// @dev Read-back checks on the wiring and key parameters.
    function _verify(Params memory p, Deployed memory d) internal view {
        require(d.manager.vault() == address(d.vault), "Verify: manager.vault mismatch");
        require(d.manager.feeRouter() == address(d.router), "Verify: manager.feeRouter mismatch");
        require(d.vault.feeRouter() == address(d.router), "Verify: vault.feeRouter mismatch");
        require(d.router.treasury() == p.treasury, "Verify: router.treasury mismatch");
        require(d.router.treasuryBps() == p.treasuryBps, "Verify: router.treasuryBps mismatch");
        require(d.router.vault() == address(d.vault), "Verify: router.vault mismatch");
        require(d.router.creditManager() == address(d.manager), "Verify: router.creditManager mismatch");
        require(d.oracle.maxStalePeriod() == p.maxStalePeriod, "Verify: oracle.maxStalePeriod mismatch");
        console.log("Read-back checks passed.");
    }
}
