// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BridgedToken} from "../src/BridgedToken.sol";
import {NadcabBridge} from "../src/NadcabBridge.sol";

contract NadcabBridgeTest is Test {
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 constant OTHER = 56;

    function deploy(uint8 mode, uint16 fee, uint256 supply) internal returns (NadcabBridge) {
        uint256[] memory routes = new uint256[](1);
        routes[0] = OTHER;
        return new NadcabBridge(mode, relayer, fee, routes, "Nadcab Coin", "NDC", supply);
    }

    function release(NadcabBridge bridge, bytes32 id, address to, uint256 origin, uint256 amount) internal {
        vm.prank(relayer);
        bridge.release(id, OTHER, to, origin, amount, "Wrapped BNB", "WBNB");
    }

    function testLockMintNativeOutAndBack() public {
        NadcabBridge bridge = deploy(0, 30, 0);
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        bytes32 id = bridge.bridgeNative{value: 1 ether}(OTHER, bob);
        assertEq(bridge.nonce(), 1);
        assertEq(id, keccak256(abi.encode(block.chainid, address(bridge), uint64(1))));
        assertEq(bridge.feesNative(), 0.003 ether);
        assertEq(bridge.lockedNative(), 0.997 ether);

        release(bridge, keccak256("back"), bob, block.chainid, 0.5 ether);
        assertEq(bob.balance, 0.5 ether);
        assertEq(bridge.lockedNative(), 0.497 ether);

        vm.prank(relayer);
        vm.expectRevert(NadcabBridge.InsufficientLiquidity.selector);
        bridge.release(keccak256("too much"), OTHER, bob, block.chainid, 1 ether, "", "");
    }

    function testLockMintWrappedMintAndBurn() public {
        NadcabBridge bridge = deploy(0, 100, 0);
        release(bridge, keccak256("in"), alice, OTHER, 5 ether);
        BridgedToken wrapped = BridgedToken(bridge.wrapped(OTHER));
        assertEq(wrapped.symbol(), "WBNB");
        assertEq(wrapped.balanceOf(alice), 5 ether);
        assertEq(bridge.originOf(address(wrapped)), OTHER);

        vm.startPrank(alice);
        wrapped.approve(address(bridge), 2 ether);
        bridge.bridgeToken(address(wrapped), OTHER, bob, 2 ether);
        vm.stopPrank();
        assertEq(wrapped.balanceOf(alice), 3 ether);
        assertEq(wrapped.balanceOf(address(bridge)), 0.02 ether);
        assertEq(wrapped.totalSupply(), 3.02 ether);
    }

    function testReplayAndAuth() public {
        NadcabBridge bridge = deploy(0, 0, 0);
        release(bridge, keccak256("x"), alice, OTHER, 1 ether);
        vm.prank(relayer);
        vm.expectRevert(NadcabBridge.AlreadyProcessed.selector);
        bridge.release(keccak256("x"), OTHER, alice, OTHER, 1 ether, "", "");

        vm.prank(alice);
        vm.expectRevert(NadcabBridge.OnlyRelayer.selector);
        bridge.release(keccak256("y"), OTHER, alice, OTHER, 1 ether, "", "");
    }

    function testRoutesAndPause() public {
        NadcabBridge bridge = deploy(0, 0, 0);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(NadcabBridge.BadRoute.selector);
        bridge.bridgeNative{value: 1}(137, bob);

        bridge.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(NadcabBridge.Paused.selector);
        bridge.bridgeNative{value: 1}(OTHER, bob);

        vm.prank(alice);
        vm.expectRevert(NadcabBridge.OnlyOwner.selector);
        bridge.setPaused(false);
    }

    function testBurnMint() public {
        NadcabBridge bridge = deploy(1, 50, 1000 ether);
        BridgedToken coin = BridgedToken(bridge.token());
        assertEq(coin.balanceOf(address(this)), 1000 ether);
        assertEq(coin.minter(), address(bridge));

        coin.approve(address(bridge), 100 ether);
        bridge.bridgeToken(address(coin), OTHER, bob, 100 ether);
        assertEq(coin.totalSupply(), 900.5 ether);

        release(bridge, keccak256("in"), bob, 0, 7 ether);
        assertEq(coin.balanceOf(bob), 7 ether);

        vm.expectRevert(NadcabBridge.BadMode.selector);
        bridge.bridgeNative{value: 1}(OTHER, bob);
    }

    function testPool() public {
        NadcabBridge bridge = deploy(2, 10, 0);
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        bridge.addLiquidity{value: 4 ether}();
        assertEq(bridge.poolLiquidity(), 4 ether);

        vm.prank(alice);
        bridge.bridgeNative{value: 1 ether}(OTHER, bob);
        assertEq(bridge.feesNative(), 0.001 ether);
        assertEq(bridge.poolLiquidity(), 4.999 ether);

        release(bridge, keccak256("in"), bob, OTHER, 2 ether);
        assertEq(bob.balance, 2 ether);

        bridge.removeLiquidity(alice, 1 ether);
        assertEq(bridge.poolLiquidity(), 1.999 ether);
        vm.expectRevert(NadcabBridge.InsufficientLiquidity.selector);
        bridge.removeLiquidity(alice, 2 ether);

        uint256 before = address(this).balance;
        bridge.withdrawFees(address(this));
        assertEq(address(this).balance - before, 0.001 ether);
    }

    function testFeeCap() public {
        uint256[] memory routes = new uint256[](0);
        vm.expectRevert(NadcabBridge.FeeTooHigh.selector);
        new NadcabBridge(0, relayer, 1001, routes, "", "", 0);
    }

    receive() external payable {}
}
