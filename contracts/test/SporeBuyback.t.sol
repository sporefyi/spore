// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {SporeBuyback, IDexRouter, Spore_RouterNotSet, Spore_InvalidKeeperBps, Spore_ProtectedToken} from
    "../src/SporeBuyback.sol";
import {Spore_ZeroAddress, Spore_ZeroAmount} from "../src/interfaces/ISpore.sol";

/// @title MockERC20
/// @notice Mintable ERC20 with configurable decimals for USDG/$SPORE stand-ins.
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title MockDexRouter
/// @notice Fixed-rate UniswapV2-style router. `failSwap` simulates no-liquidity reverts.
contract MockDexRouter is IDexRouter {
    /// @dev Output units of the last path token per unit of input token.
    uint256 public rate;
    /// @dev When true, the swap reverts.
    bool public failSwap;

    constructor(uint256 rate_) {
        rate = rate_;
    }

    function setFailSwap(bool fail_) external {
        failSwap = fail_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override returns (uint256[] memory amounts) {
        require(!failSwap, "MockDexRouter: no liquidity");
        require(path.length >= 2, "MockDexRouter: bad path");
        require(deadline >= block.timestamp, "MockDexRouter: expired");

        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * rate;
        require(out >= amountOutMin, "MockDexRouter: slippage");
        IERC20(path[path.length - 1]).transfer(to, out);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = out;
    }
}

contract SporeBuybackTest is Test {
    MockERC20 internal usdg; // 6 decimals
    MockERC20 internal spore; // 18 decimals
    MockERC20 internal other; // rescue-able token
    MockDexRouter internal router;
    SporeBuyback internal buyback;

    address internal admin = address(this);
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant RATE = 100; // 1 USDG-unit -> 100 SPORE-units
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    event BuybackExecuted(uint256 usdgIn, uint256 sporeBurned, address keeper, uint256 keeperFee);
    event BuybackPending(uint256 usdgAmount);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event KeeperBpsUpdated(uint16 oldBps, uint16 newBps);
    event UsdgSwept(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    function setUp() public {
        usdg = new MockERC20("USD Gold", "USDG", 6);
        spore = new MockERC20("Spore", "SPORE", 18);
        other = new MockERC20("Other", "OTH", 18);
        router = new MockDexRouter(RATE);
        buyback = new SporeBuyback(address(usdg), address(spore), admin, address(router));

        // Fund the router with $SPORE so it can pay out swaps.
        spore.mint(address(router), 1_000_000 * 1e18);
        // Fund the buyback contract with USDG fee share.
        usdg.mint(address(buyback), 1_000 * 1e6);
    }

    function _path() internal view returns (address[] memory) {
        address[] memory p = new address[](2);
        p[0] = address(usdg);
        p[1] = address(spore);
        return p;
    }

    // ---- happy path -------------------------------------------------------

    function test_BuybackExecutesBurnsAndPaysKeeper() public {
        uint256 usdgBalance = usdg.balanceOf(address(buyback)); // 1000 USDG (6dp)
        uint256 expectedFee = (usdgBalance * 100) / 10_000; // 1% = 10 USDG
        uint256 expectedSwap = usdgBalance - expectedFee;
        uint256 expectedSpore = expectedSwap * RATE;

        uint256 keeperUsdgBefore = usdg.balanceOf(keeper);
        uint256 deadBefore = spore.balanceOf(DEAD);

        vm.expectEmit(true, true, true, true);
        emit BuybackExecuted(expectedSwap, expectedSpore, keeper, expectedFee);
        vm.prank(keeper);
        buyback.executeBuyback(usdgBalance, _path());

        assertEq(spore.balanceOf(DEAD) - deadBefore, expectedSpore, "burn amount");
        assertEq(usdg.balanceOf(keeper) - keeperUsdgBefore, expectedFee, "keeper fee");
        assertEq(usdg.balanceOf(address(buyback)), 0, "contract drained");
        assertEq(buyback.totalUsdgSwapped(), expectedSwap, "totalUsdgSwapped");
        assertEq(buyback.totalSporeBurned(), expectedSpore, "totalSporeBurned");
    }

    function test_BuybackTakesMinOfRequestedAndBalance() public {
        // Request more than the balance: only the balance is used.
        uint256 huge = 1_000_000 * 1e6;
        uint256 bal = usdg.balanceOf(address(buyback));
        uint256 expectedFee = (bal * 100) / 10_000;
        uint256 expectedSwap = bal - expectedFee;

        vm.expectEmit(true, true, true, true);
        emit BuybackExecuted(expectedSwap, expectedSwap * RATE, keeper, expectedFee);
        vm.prank(keeper);
        buyback.executeBuyback(huge, _path());

        assertEq(usdg.balanceOf(address(buyback)), 0, "min(balance) consumed");
    }

    function test_BuybackPartialAmountLeavesRemainder() public {
        uint256 request = 400 * 1e6;
        uint256 bal = usdg.balanceOf(address(buyback));
        uint256 expectedFee = (request * 100) / 10_000;

        vm.prank(keeper);
        buyback.executeBuyback(request, _path());

        assertEq(usdg.balanceOf(address(buyback)), bal - request, "remainder stays");
        assertEq(usdg.balanceOf(keeper), expectedFee, "keeper paid on partial");
    }

    // ---- failure modes -----------------------------------------------------

    function test_SwapRevertEmitsBuybackPendingFundsStay() public {
        router.setFailSwap(true);
        uint256 bal = usdg.balanceOf(address(buyback));

        vm.expectEmit(true, true, true, true);
        emit BuybackPending(bal);
        vm.prank(keeper);
        buyback.executeBuyback(bal, _path());

        assertEq(usdg.balanceOf(address(buyback)), bal, "USDG stays in contract");
        assertEq(usdg.balanceOf(keeper), 0, "no keeper fee on failed swap");
        assertEq(spore.balanceOf(DEAD), 0, "nothing burned");
    }

    function test_ZeroBalanceReverts() public {
        // Documented choice: zero amount / zero balance REVERTS (no-op would be
        // ambiguous and cheaper to surface as an error).
        vm.expectRevert(Spore_ZeroAmount.selector);
        buyback.executeBuyback(0, _path());

        SporeBuyback empty = new SporeBuyback(address(usdg), address(spore), admin, address(router));
        vm.expectRevert(Spore_ZeroAmount.selector);
        empty.executeBuyback(100 * 1e6, _path());
    }

    function test_RouterNotSetReverts() public {
        SporeBuyback noRouter = new SporeBuyback(address(usdg), address(spore), admin, address(0));
        usdg.mint(address(noRouter), 100 * 1e6);
        vm.expectRevert(Spore_RouterNotSet.selector);
        vm.prank(keeper);
        noRouter.executeBuyback(100 * 1e6, _path());
    }

    // ---- admin setters -----------------------------------------------------

    function test_SetRouter() public {
        address newRouter = makeAddr("newRouter");
        vm.expectEmit(true, true, true, true);
        emit RouterUpdated(address(router), newRouter);
        buyback.setRouter(newRouter);
        assertEq(buyback.router(), newRouter, "router updated");
    }

    function test_NonAdminCannotSetRouter() public {
        bytes32 adminRole = buyback.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        buyback.setRouter(makeAddr("evil"));
    }

    function test_SetRouterZeroReverts() public {
        vm.expectRevert(Spore_ZeroAddress.selector);
        buyback.setRouter(address(0));
    }

    function test_SetKeeperBps() public {
        vm.expectEmit(true, true, true, true);
        emit KeeperBpsUpdated(100, 250);
        buyback.setKeeperBps(250);
        assertEq(buyback.keeperBps(), 250, "keeperBps updated");
    }

    function test_KeeperBpsCapEnforced() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_InvalidKeeperBps.selector, 501));
        buyback.setKeeperBps(501);
        vm.expectRevert(abi.encodeWithSelector(Spore_InvalidKeeperBps.selector, 10_000));
        buyback.setKeeperBps(10_000);
        // Cap boundary (500 = 5%) is allowed.
        buyback.setKeeperBps(500);
        assertEq(buyback.keeperBps(), 500, "cap boundary ok");
    }

    function test_NonAdminCannotSetKeeperBps() public {
        bytes32 adminRole = buyback.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        buyback.setKeeperBps(200);
    }

    // ---- emergency / rescue ------------------------------------------------

    function test_SweepUsdg() public {
        uint256 sweep = 250 * 1e6;
        vm.expectEmit(true, true, true, true);
        emit UsdgSwept(recipient, sweep);
        buyback.sweepUsdg(recipient, sweep);
        assertEq(usdg.balanceOf(recipient), sweep, "swept to recipient");
    }

    function test_NonAdminCannotSweepUsdg() public {
        bytes32 adminRole = buyback.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        buyback.sweepUsdg(stranger, 1);
    }

    function test_RescueTokenRejectsProtected() public {
        vm.expectRevert(abi.encodeWithSelector(Spore_ProtectedToken.selector, address(usdg)));
        buyback.rescueToken(address(usdg), recipient, 1);
        vm.expectRevert(abi.encodeWithSelector(Spore_ProtectedToken.selector, address(spore)));
        buyback.rescueToken(address(spore), recipient, 1);
    }

    function test_RescueTokenWorksForOtherTokens() public {
        other.mint(address(buyback), 42 ether);
        vm.expectEmit(true, true, true, true);
        emit TokenRescued(address(other), recipient, 42 ether);
        buyback.rescueToken(address(other), recipient, 42 ether);
        assertEq(other.balanceOf(recipient), 42 ether, "rescued");
    }

    function test_NonAdminCannotRescue() public {
        other.mint(address(buyback), 1 ether);
        bytes32 adminRole = buyback.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        buyback.rescueToken(address(other), stranger, 1 ether);
    }
}
