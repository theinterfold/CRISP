// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { CrispDemoToken } from "../contracts/chiado/CrispDemoToken.sol";

contract CrispDemoTokenTest is Test {
  uint256 internal constant AMOUNT = 100e18;
  uint256 internal constant COOLDOWN = 1 days;

  address internal owner = makeAddr("owner");
  address internal faucet = makeAddr("faucet");
  address internal alice = makeAddr("alice");
  address internal bob = makeAddr("bob");
  CrispDemoToken internal token;

  function setUp() public {
    vm.warp(1_800_000_000);
    token = new CrispDemoToken(owner, AMOUNT, COOLDOWN);
    vm.prank(owner);
    token.setFaucet(faucet);
  }

  function test_metadataAndClock() public {
    assertEq(token.name(), "CRISP Demo COW");
    assertEq(token.symbol(), "dCOW");
    assertEq(token.decimals(), 18);
    assertEq(token.CLOCK_MODE(), "mode=timestamp");
    assertEq(token.clock(), 1_800_000_000);
    vm.warp(1_800_000_123);
    assertEq(token.clock(), 1_800_000_123);
  }

  function test_onlyTheFaucetMayMint() public {
    vm.expectRevert(abi.encodeWithSelector(CrispDemoToken.NotFaucet.selector, alice));
    vm.prank(alice);
    token.faucetMint(alice);

    vm.expectRevert(abi.encodeWithSelector(CrispDemoToken.NotFaucet.selector, owner));
    vm.prank(owner);
    token.faucetMint(alice);
  }

  function test_theFaucetMintsAndSelfDelegates() public {
    vm.prank(faucet);
    token.faucetMint(alice);

    assertEq(token.balanceOf(alice), AMOUNT);
    assertEq(token.delegates(alice), alice);
    assertEq(token.getVotes(alice), AMOUNT);
    assertEq(token.lastFaucetMintAt(alice), block.timestamp);
  }

  function test_theFaucetKeepsAnExistingDelegate() public {
    vm.prank(alice);
    token.delegate(bob);

    vm.prank(faucet);
    token.faucetMint(alice);
    assertEq(token.delegates(alice), bob);
    assertEq(token.getVotes(bob), AMOUNT);
    assertEq(token.getVotes(alice), 0);
  }

  function test_theFaucetCooldownIsPerRecipient() public {
    vm.prank(faucet);
    token.faucetMint(alice);

    vm.prank(faucet);
    vm.expectRevert(abi.encodeWithSelector(CrispDemoToken.FaucetCooldown.selector, alice, block.timestamp + COOLDOWN));
    token.faucetMint(alice);

    // Another recipient is not held back.
    vm.prank(faucet);
    token.faucetMint(bob);

    vm.warp(block.timestamp + COOLDOWN - 1);
    vm.prank(faucet);
    vm.expectRevert();
    token.faucetMint(alice);

    vm.warp(block.timestamp + 1);
    vm.prank(faucet);
    token.faucetMint(alice);
    assertEq(token.balanceOf(alice), 2 * AMOUNT);
    assertEq(token.getVotes(alice), 2 * AMOUNT);
  }

  function test_treasuryMintCarriesNoVotesButCountsInTheSupply() public {
    address safe = makeAddr("safe");
    vm.prank(owner);
    token.mintTreasury(safe, 1_000e18);
    assertEq(token.balanceOf(safe), 1_000e18);
    assertEq(token.getVotes(safe), 0);
    assertEq(token.delegates(safe), address(0));

    vm.warp(block.timestamp + 1);
    assertEq(token.getPastTotalSupply(block.timestamp - 1), 1_000e18);
  }

  function test_mintTreasuryAndSetFaucetAreOwnerOnly() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vm.prank(alice);
    token.mintTreasury(alice, 1);

    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vm.prank(alice);
    token.setFaucet(alice);
  }

  /// @dev The census reads `getPastVotes(slot, snapshot)` with a Sepolia timestamp: it returns the value after the last
  /// checkpoint at or before that timepoint.
  function test_checkpointsFollowTheTimestampClock() public {
    uint256 t = block.timestamp;
    vm.prank(faucet);
    token.faucetMint(alice);

    vm.warp(t + 10);
    assertEq(token.getPastVotes(alice, t - 1), 0);
    assertEq(token.getPastVotes(alice, t), AMOUNT);
    assertEq(token.getPastTotalSupply(t), AMOUNT);

    // A transfer later does not rewrite the past.
    vm.prank(alice);
    token.delegate(bob);
    vm.warp(t + 20);
    assertEq(token.getPastVotes(alice, t + 5), AMOUNT);
    assertEq(token.getPastVotes(alice, t + 10), 0);
    assertEq(token.getPastVotes(bob, t + 10), AMOUNT);

    // A timepoint that is not in the past cannot be read.
    vm.expectRevert();
    token.getPastVotes(alice, block.timestamp);
  }
}
