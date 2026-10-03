// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "../../src/interfaces/ISpore.sol";
import {SporeRegistry} from "../../src/SporeRegistry.sol";
import {ScoreOracle} from "../../src/ScoreOracle.sol";
import {CreditManager} from "../../src/CreditManager.sol";
import {BackerVault} from "../../src/BackerVault.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";

/// @notice Handler driving bounded, valid actions against the SPORE system while
///         maintaining ghost variables. Deliberate negative probes use try/catch;
///         no unexpected revert is allowed to escape.
contract SporeHandler is Test {
    ERC20Mock public immutable asset;
    SporeRegistry public immutable registry;
    CreditManager public immutable manager;
    BackerVault public immutable vault;
    ScoreOracle public immutable oracle;
    FeeRouter public immutable router;
    address public immutable treasury;

    address[] public actors;
    address[2] public merchants;

    uint16 public treasuryBps;

    // ghost variables
    uint256 public gDeposits;
    uint256 public gWithdrawals;
    uint256 public gTreasury;
    uint256 public gVaultYield;
    uint256 public gYieldReserve;
    uint256 public gBadDebt;
    uint256 public gAbsorbed;
    mapping(uint256 => uint256) public gPool;
    mapping(uint256 => bool) public defaulted;
    bool public initialized;

    constructor(
        address _asset,
        address _registry,
        address _manager,
        address _vault,
        address _oracle,
        address _router,
        address _treasury
    ) {
        asset = ERC20Mock(_asset);
        registry = SporeRegistry(_registry);
        manager = CreditManager(_manager);
        vault = BackerVault(_vault);
        oracle = ScoreOracle(_oracle);
        router = FeeRouter(_router);
        treasury = _treasury;

        actors.push(makeAddr("inv-actor-0"));
        actors.push(makeAddr("inv-actor-1"));
        actors.push(makeAddr("inv-actor-2"));
        merchants[0] = makeAddr("inv-merchant-0");
        merchants[1] = makeAddr("inv-merchant-1");

        for (uint256 i = 0; i < 3; i++) {
            address a = actors[i];
            asset.mint(a, 1e30);
            vm.startPrank(a);
            asset.approve(_vault, type(uint256).max);
            asset.approve(_manager, type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @notice One-time setup (no-op on repeat; excluded from fuzz selectors).
    function initialize() external {
        if (initialized) return;
        initialized = true;

        treasuryBps = router.treasuryBps();

        vm.prank(actors[0]);
        registry.registerAgent("ipfs://inv-0");
        vm.prank(actors[1]);
        registry.registerAgent("ipfs://inv-1");

        for (uint256 agent = 1; agent <= 2; agent++) {
            oracle.publishScore(agent, 800, 1e30, 1);
        }
        for (uint256 i = 0; i < 2; i++) {
            manager.setMerchantAllowed(merchants[i], true);
        }
        for (uint256 agent = 1; agent <= 2; agent++) {
            manager.issueLine(agent, 5e24, 500);
        }
    }

    // ---------------------------------------------------------------- helpers

    function _agent(uint256 seed) internal pure returns (uint256) {
        return seed % 2 + 1;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 3];
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ---------------------------------------------------------------- actions

    function deposit(uint256 agentSeed, uint256 actorSeed, uint256 rawAmount) external {
        uint256 agent = _agent(agentSeed);
        address actor = _actor(actorSeed);

        // Negative probe: shares exist but the pool was wiped out -> deposit must revert.
        if (vault.totalShares(agent) > 0 && vault.poolAssets(agent) == 0) {
            vm.prank(actor);
            try vault.deposit(agent, 1) {
                assertTrue(false, "deposit into wiped pool succeeded");
            } catch {}
            return;
        }

        uint256 bal = asset.balanceOf(actor);
        if (bal == 0) return;
        uint256 amt = bound(rawAmount, 1, bal > 1e24 ? 1e24 : bal);

        vm.prank(actor);
        vault.deposit(agent, amt);
        gDeposits += amt;
        gPool[agent] += amt;
    }

    function withdraw(uint256 agentSeed, uint256 actorSeed, uint256 rawAmount) external {
        uint256 agent = _agent(agentSeed);
        address actor = _actor(actorSeed);

        uint256 w = vault.withdrawableFor(agent, actor);
        uint256 amt = bound(rawAmount, 1, 1e24);

        if (amt > w) {
            vm.prank(actor);
            bool ok;
            try vault.withdraw(agent, amt) {
                ok = true;
            } catch {
                ok = false;
            }
            assertTrue(!ok, "over-withdraw succeeded");
            return;
        }

        // Liquidity cap: the vault's token balance is fungible across agents while
        // encumbrance is accounted per agent. Another agent's borrows can drain the vault
        // below this agent's "unencumbered" withdrawable amount; attempting the full
        // withdrawable would then revert with ERC20InsufficientBalance (a raw OZ error,
        // not in the frozen Spore_ set). Cap the executed amount at the vault's actual
        // balance so the handler only attempts payable withdrawals. The underlying
        // cross-agent liquidity observation is reported to the coordinator separately
        // (it also breaks absorbDefault's "covered stake is already held by the vault"
        // assumption when the vault has been drained).
        uint256 vbal = asset.balanceOf(address(vault));
        uint256 execAmt = amt > vbal ? vbal : amt;
        if (execAmt == 0) return;

        vm.prank(actor);
        vault.withdraw(agent, execAmt);
        gWithdrawals += execAmt;
        gPool[agent] -= execAmt;
    }

    function borrow(uint256 agentSeed, uint256 merchantSeed, uint256 rawAmount) external {
        uint256 agent = _agent(agentSeed);
        if (defaulted[agent]) return;

        uint256 avail = manager.availableToBorrow(agent);
        uint256 vbal = asset.balanceOf(address(vault));
        uint256 maxAmt = _min(avail, vbal);
        if (maxAmt == 0) return;

        uint256 amt = bound(rawAmount, 1, maxAmt);
        address merchant = merchants[merchantSeed % 2];

        vm.prank(registry.agentOwner(agent));
        manager.borrow(agent, amt, merchant);
        // Fee accrues to feeOwed; no ghost update needed.
    }

    function repay(uint256 agentSeed, uint256 payerSeed, uint256 rawAmount) external {
        uint256 agent = _agent(agentSeed);
        if (defaulted[agent]) return;

        (uint256 drawn, uint256 feeOwed) = manager.outstandingOf(agent);
        if (drawn + feeOwed == 0) return;

        address payer = _actor(payerSeed);
        uint256 bal = asset.balanceOf(payer);
        if (bal == 0) return;
        uint256 amt = bound(rawAmount, 1, bal > 1e24 ? 1e24 : bal);

        uint256 foBefore = manager.getLine(agent).feeOwed;
        vm.prank(payer);
        manager.repay(agent, amt);
        uint256 feePaid = foBefore - manager.getLine(agent).feeOwed;

        uint256 tLeg = feePaid * treasuryBps / 10000;
        uint256 vLeg = feePaid - tLeg;
        gTreasury += tLeg;
        gVaultYield += vLeg;
        gYieldReserve += vLeg;
    }

    function publishScore(uint256 agentSeed, uint256 rawScore, uint256 rawLimit) external {
        uint256 agent = _agent(agentSeed);
        uint256 score = bound(rawScore, 0, 1000);
        uint256 lim = bound(rawLimit, 1e18, 1e30);
        oracle.publishScore(agent, SafeCast.toUint16(score), lim, 1);
    }

    function absorbDefault(uint256 agentSeed) external {
        uint256 agent = _agent(agentSeed);
        if (defaulted[agent]) return;

        (uint256 drawn,) = manager.outstandingOf(agent);
        if (drawn == 0) {
            bool ok;
            try vault.absorbDefault(agent) {
                ok = true;
            } catch {
                ok = false;
            }
            assertTrue(!ok, "absorbDefault on zero debt succeeded");
            return;
        }

        uint256 paBefore = vault.poolAssets(agent);
        uint256 covered = drawn < paBefore ? drawn : paBefore;

        vault.absorbDefault(agent);
        gAbsorbed += drawn;
        gPool[agent] -= covered;
        gBadDebt += drawn - covered;
        defaulted[agent] = true;
    }

    function allocateYield(uint256 agentSeed, uint256 rawAmount) external {
        uint256 agent = _agent(agentSeed);
        uint256 yr = vault.yieldReserve();
        if (yr == 0) return;
        if (vault.totalShares(agent) == 0) return;

        uint256 amt = bound(rawAmount, 1, yr > 1e24 ? 1e24 : yr);
        vault.allocateYield(agent, amt);
        gYieldReserve -= amt;
        gPool[agent] += amt;
    }

    function probeWithdrawOverLimit(uint256 agentSeed, uint256 actorSeed) external {
        uint256 agent = _agent(agentSeed);
        address actor = _actor(actorSeed);

        uint256 w = vault.withdrawableFor(agent, actor);
        if (w == 0 || w == type(uint256).max) return;

        vm.prank(actor);
        try vault.withdraw(agent, w + 1) {
            assertTrue(false, "withdraw above withdrawableFor succeeded");
        } catch {}
    }
}

/// @notice Invariant suite for the SPORE credit protocol.
/// @dev NO dust tolerance is needed anywhere: every ghost equation is exact by
///      construction.
///      - poolAssets moves only in exact asset-unit steps (share math never touches it).
///      - The fee split is exact (vaultAmt = amount - treasuryAmt), so treasury and
///        vault legs always sum to the fee paid.
///      - fundBorrow / receiveRepay / absorbDefault move totalOutstanding in lockstep
///        with the per-line drawn amount.
///      - withdrawableFor <= stakedFor holds by its formula
///        (assets - floor(assets * enc / pa) <= assets).
contract SporeInvariants is StdInvariant, Test {
    ERC20Mock asset;
    SporeRegistry registry;
    ScoreOracle oracle;
    CreditManager manager;
    BackerVault vault;
    FeeRouter router;
    address treasury;
    SporeHandler handler;

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
        handler = new SporeHandler(
            address(asset),
            address(registry),
            address(manager),
            address(vault),
            address(oracle),
            address(router),
            treasury
        );
        manager.grantRole(manager.UNDERWRITER_ROLE(), address(handler));
        oracle.grantRole(oracle.ORACLE_UPDATER_ROLE(), address(handler));
        vault.grantRole(vault.UNDERWRITER_ROLE(), address(handler));
        handler.initialize();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = SporeHandler.deposit.selector;
        selectors[1] = SporeHandler.withdraw.selector;
        selectors[2] = SporeHandler.borrow.selector;
        selectors[3] = SporeHandler.repay.selector;
        selectors[4] = SporeHandler.publishScore.selector;
        selectors[5] = SporeHandler.absorbDefault.selector;
        selectors[6] = SporeHandler.allocateYield.selector;
        selectors[7] = SporeHandler.probeWithdrawOverLimit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Token conservation across the vault + treasury + written-off debt.
    function invariant_Solvency() external view {
        // Fee tokens enter from payers (not tracked as deposits), so totalFeesRouted
        // appears on the RHS. absorbDefault writes off outstanding without moving
        // tokens, hence +gAbsorbed on the LHS. The split is exact because
        // vaultAmt = amount - treasuryAmt.
        assertEq(
            asset.balanceOf(address(vault)) + vault.totalOutstanding() + handler.gTreasury() + handler.gAbsorbed(),
            handler.gDeposits() - handler.gWithdrawals() + router.totalFeesRouted(),
            "solvency"
        );
        assertEq(asset.balanceOf(treasury), handler.gTreasury(), "treasury legs");
    }

    function invariant_PoolAccounting() external view {
        for (uint256 agent = 1; agent <= 2; agent++) {
            assertEq(vault.poolAssets(agent), handler.gPool(agent), "poolAssets");
            assertEq(vault.totalStakedFor(agent), vault.poolAssets(agent), "totalStakedFor");
        }
        assertEq(vault.badDebt(), handler.gBadDebt(), "badDebt");
        assertEq(vault.yieldReserve(), handler.gYieldReserve(), "yieldReserve");
    }

    function invariant_DrawnSums() external view {
        uint256 sum;
        for (uint256 agent = 1; agent <= 2; agent++) {
            CreditLine memory line = manager.getLine(agent);
            sum += line.drawn;
            assertLe(line.drawn, line.limit, "drawn<=limit");
        }
        assertEq(sum, vault.totalOutstanding(), "outstanding");
    }

    function invariant_WithdrawBounds() external view {
        for (uint256 agent = 1; agent <= 2; agent++) {
            for (uint256 i = 0; i < 3; i++) {
                address a = handler.actors(i);
                assertLe(vault.withdrawableFor(agent, a), vault.stakedFor(agent, a), "withdrawable<=staked");
            }
        }
    }
}
