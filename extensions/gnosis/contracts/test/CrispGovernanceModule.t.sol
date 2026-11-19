// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Test } from "forge-std/Test.sol";
import { Delay } from "../vendor/zodiac-modifier-delay/Delay.sol";
import { ModuleProxyFactory } from "@gnosis-guild/zodiac-core/contracts/factory/ModuleProxyFactory.sol";
import { GnosisSafe } from "../vendor/safe-contracts/GnosisSafe.sol";
import { GnosisSafeProxyFactory } from "../vendor/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import { MultiSendCallOnly } from "../vendor/safe-contracts/libraries/MultiSendCallOnly.sol";
import { Enum } from "../vendor/safe-contracts/common/Enum.sol";
import { CrispGovernanceModule } from "../contracts/chiado/CrispGovernanceModule.sol";
import { CrispDemoToken } from "../contracts/chiado/CrispDemoToken.sol";
import { MockCrispVoting } from "../contracts/test-mocks/MockCrispVoting.sol";

/// @notice The module on the real vendored Zodiac Delay and the real Safe 1.3.0 contracts, wired as in the design:
/// `Safe <- Delay <- CrispGovernanceModule`.
contract CrispGovernanceModuleTest is Test {
  uint256 internal constant ROUND_ID = 7;
  uint256 internal constant DIVISOR = 1e18;
  uint256 internal constant QUORUM = 100e18;
  uint16 internal constant APPROVAL_BPS = 5_000;
  uint64 internal constant EXPIRATION = 7 days;
  uint256 internal constant COOLDOWN = 300;
  uint256 internal constant DELAY_EXPIRATION = 3 days;

  address internal safeOwner = makeAddr("safe owner");
  address internal recipientA = makeAddr("recipient A");
  address internal recipientB = makeAddr("recipient B");

  GnosisSafe internal safe;
  MultiSendCallOnly internal multiSend;
  Delay internal delay;
  CrispGovernanceModule internal module;
  CrispGovernanceModule internal moduleMastercopy;
  MockCrispVoting internal voting;
  CrispDemoToken internal token;
  ModuleProxyFactory internal moduleFactory;
  bytes internal batch;

  function setUp() public {
    vm.warp(1_800_000_000);
    voting = new MockCrispVoting();
    token = new CrispDemoToken(safeOwner, 100e18, 1 days);
    multiSend = new MultiSendCallOnly();
    moduleFactory = new ModuleProxyFactory();

    // Safe 1.3.0 behind a proxy, one owner.
    GnosisSafeProxyFactory safeFactory = new GnosisSafeProxyFactory();
    address[] memory owners = new address[](1);
    owners[0] = safeOwner;
    safe = GnosisSafe(
      payable(
        address(
          safeFactory.createProxyWithNonce(
            address(new GnosisSafe()),
            abi.encodeCall(GnosisSafe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))),
            1
          )
        )
      )
    );
    vm.prank(safeOwner);
    token.mintTreasury(address(safe), 1_000e18);

    // Delay (avatar = target = owner = Safe), a module of the Safe.
    address delayMastercopy = address(new Delay(address(1), address(1), address(1), 0, 0));
    delay = Delay(
      moduleFactory.deployModule(
        delayMastercopy,
        abi.encodeCall(Delay.setUp, (abi.encode(address(safe), address(safe), address(safe), COOLDOWN, DELAY_EXPIRATION))),
        1
      )
    );
    _safeExec(address(safe), abi.encodeWithSignature("enableModule(address)", address(delay)));

    // The governance module (owner = avatar = Safe, target = Delay), a module of the Delay.
    moduleMastercopy = new CrispGovernanceModule(
      abi.encode(address(1), address(1), address(1), address(1), address(1), uint256(0), uint16(1), uint64(0))
    );
    module = CrispGovernanceModule(
      moduleFactory.deployModule(
        address(moduleMastercopy),
        abi.encodeCall(
          CrispGovernanceModule.setUp,
          (abi.encode(address(safe), address(safe), address(delay), address(voting), address(multiSend), QUORUM, APPROVAL_BPS, EXPIRATION))
        ),
        1
      )
    );
    _safeExec(address(delay), abi.encodeWithSignature("enableModule(address)", address(module)));

    // The proposal: two token transfers out of the Safe, as one packed MultiSend batch.
    batch = bytes.concat(
      _packed(address(token), abi.encodeCall(token.transfer, (recipientA, 100e18))),
      _packed(address(token), abi.encodeCall(token.transfer, (recipientB, 50e18)))
    );
    voting.setRound(ROUND_ID, keccak256(batch), DIVISOR);
  }

  // ---------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------

  function _packed(address to, bytes memory data) internal pure returns (bytes memory) {
    return abi.encodePacked(uint8(0), to, uint256(0), uint256(data.length), data);
  }

  /// @dev A Safe transaction signed by its owner through an "approved by sender" signature (`v = 1`).
  function _safeExec(address to, bytes memory data) internal {
    bytes memory signature = abi.encodePacked(bytes32(uint256(uint160(safeOwner))), bytes32(0), uint8(1));
    vm.prank(safeOwner);
    safe.execTransaction(to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);
  }

  function _result(uint256 forVotes, uint256 againstVotes, uint256 abstainVotes) internal {
    uint256[] memory tally = new uint256[](3);
    tally[0] = forVotes;
    tally[1] = againstVotes;
    tally[2] = abstainVotes;
    voting.setResult(ROUND_ID, tally, uint64(block.timestamp));
  }

  function _runQueued() internal {
    vm.warp(block.timestamp + COOLDOWN);
    delay.executeNextTx(address(multiSend), 0, abi.encodeWithSelector(multiSend.multiSend.selector, batch), Enum.Operation.DelegateCall);
  }

  // ---------------------------------------------------------------------------------------------
  // the whole path
  // ---------------------------------------------------------------------------------------------

  function test_aPassedProposalIsQueuedInTheDelayAndExecutedByTheSafe() public {
    _result(200, 100, 5);

    vm.expectEmit(true, false, false, true, address(module));
    emit CrispGovernanceModule.ProposalQueued(ROUND_ID, keccak256(batch), 200, 100, 5);
    vm.prank(makeAddr("anyone"));
    module.executeProposal(ROUND_ID, batch);

    assertTrue(module.executed(ROUND_ID));
    assertEq(delay.queueNonce(), 1);
    // Queued, not run: nothing moved yet and the cooldown applies.
    assertEq(token.balanceOf(recipientA), 0);
    vm.expectRevert("Transaction is still in cooldown");
    delay.executeNextTx(address(multiSend), 0, abi.encodeWithSelector(multiSend.multiSend.selector, batch), Enum.Operation.DelegateCall);

    // Anyone runs it once the cooldown is over.
    _runQueued();
    assertEq(token.balanceOf(recipientA), 100e18);
    assertEq(token.balanceOf(recipientB), 50e18);
    assertEq(token.balanceOf(address(safe)), 850e18);
  }

  function test_theDelayTopologyIsAsDesigned() public view {
    assertEq(delay.owner(), address(safe));
    assertEq(delay.avatar(), address(safe));
    assertEq(delay.target(), address(safe));
    assertEq(delay.txCooldown(), COOLDOWN);
    assertTrue(safe.isModuleEnabled(address(delay)));
    assertTrue(delay.isModuleEnabled(address(module)));
    assertFalse(safe.isModuleEnabled(address(module)));

    assertEq(module.owner(), address(safe));
    assertEq(module.avatar(), address(safe));
    assertEq(module.target(), address(delay));
    assertEq(address(module.voting()), address(voting));
    assertEq(module.multiSend(), address(multiSend));
    assertEq(module.quorum(), QUORUM);
    assertEq(module.approvalBps(), APPROVAL_BPS);
    assertEq(module.expiration(), EXPIRATION);
  }

  function test_theSafeOwnersCanVetoAQueuedProposal() public {
    _result(200, 100, 5);
    module.executeProposal(ROUND_ID, batch);

    _safeExec(address(delay), abi.encodeCall(Delay.setTxNonce, (delay.queueNonce())));
    vm.warp(block.timestamp + COOLDOWN);
    vm.expectRevert("Transaction queue is empty");
    delay.executeNextTx(address(multiSend), 0, abi.encodeWithSelector(multiSend.multiSend.selector, batch), Enum.Operation.DelegateCall);
    assertEq(token.balanceOf(recipientA), 0);
  }

  function test_aBatchThatFailsRevertsAsAWhole() public {
    // The second transfer exceeds the Safe's balance: the first must not stick either.
    bytes memory greedy = bytes.concat(
      _packed(address(token), abi.encodeCall(token.transfer, (recipientA, 100e18))),
      _packed(address(token), abi.encodeCall(token.transfer, (recipientB, 10_000e18)))
    );
    voting.setRound(ROUND_ID, keccak256(greedy), DIVISOR);
    _result(200, 100, 5);
    module.executeProposal(ROUND_ID, greedy);

    vm.warp(block.timestamp + COOLDOWN);
    vm.expectRevert("Module transaction failed");
    delay.executeNextTx(address(multiSend), 0, abi.encodeWithSelector(multiSend.multiSend.selector, greedy), Enum.Operation.DelegateCall);
    assertEq(token.balanceOf(recipientA), 0);
  }

  // ---------------------------------------------------------------------------------------------
  // execution rules
  // ---------------------------------------------------------------------------------------------

  function test_nothingExecutesWithoutAResult() public {
    vm.expectRevert(CrispGovernanceModule.NoResult.selector);
    module.executeProposal(ROUND_ID, batch);
    vm.expectRevert(CrispGovernanceModule.NoResult.selector);
    module.executeProposal(99, batch);
  }

  function test_theBatchMustMatchTheProposalHash() public {
    _result(200, 100, 5);
    bytes memory other = bytes.concat(batch, hex"00");
    vm.expectRevert(CrispGovernanceModule.HashMismatch.selector);
    module.executeProposal(ROUND_ID, other);

    // Same transfers in another order are another batch.
    bytes memory reordered = bytes.concat(
      _packed(address(token), abi.encodeCall(token.transfer, (recipientB, 50e18))),
      _packed(address(token), abi.encodeCall(token.transfer, (recipientA, 100e18)))
    );
    vm.expectRevert(CrispGovernanceModule.HashMismatch.selector);
    module.executeProposal(ROUND_ID, reordered);

    vm.expectRevert(CrispGovernanceModule.HashMismatch.selector);
    module.executeProposal(ROUND_ID, "");

    module.executeProposal(ROUND_ID, batch);
  }

  function test_aProposalExecutesOnlyOnce() public {
    _result(200, 100, 5);
    module.executeProposal(ROUND_ID, batch);
    vm.expectRevert(CrispGovernanceModule.AlreadyExecuted.selector);
    module.executeProposal(ROUND_ID, batch);
    assertEq(delay.queueNonce(), 1);
  }

  function test_quorumIsInclusiveAndCountsAbstentionsTimesTheDivisor() public {
    // Total 99 ballot units * 1e18 < 100e18.
    _result(60, 30, 9);
    vm.expectRevert(CrispGovernanceModule.QuorumNotMet.selector);
    module.executeProposal(ROUND_ID, batch);

    // Exactly the quorum, abstentions included.
    _result(60, 30, 10);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_quorumUsesTheRoundsDivisor() public {
    voting.setRound(ROUND_ID, keccak256(batch), 2e18);
    // 50 units * 2e18 = 100e18: met. 49 units: not.
    _result(30, 10, 9);
    vm.expectRevert(CrispGovernanceModule.QuorumNotMet.selector);
    module.executeProposal(ROUND_ID, batch);
    _result(30, 10, 10);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_approvalIsStrictlyAboveTheThreshold() public {
    // 50% threshold: a tie fails, one more vote for passes.
    _result(50, 50, 10);
    vm.expectRevert(CrispGovernanceModule.NotApproved.selector);
    module.executeProposal(ROUND_ID, batch);

    _result(51, 50, 10);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_abstentionsDoNotCountForOrAgainst() public {
    // 1 for, 0 against and a crowd of abstentions: approved (quorum met by the abstentions).
    _result(1, 0, 1_000);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_aTotallyAbstainedProposalFails() public {
    _result(0, 0, 1_000);
    vm.expectRevert(CrispGovernanceModule.NotApproved.selector);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_aHigherThresholdIsStrictToo() public {
    vm.prank(address(safe));
    module.setApprovalBps(6_667);
    // 2/3 = 66.67%: 2 for, 1 against is 6666.67 bps < 6667.
    _result(200, 100, 0);
    vm.expectRevert(CrispGovernanceModule.NotApproved.selector);
    module.executeProposal(ROUND_ID, batch);
    // 6667 for 3333 against = exactly 66.67%: a tie with the threshold fails.
    _result(6_667, 3_333, 0);
    vm.expectRevert(CrispGovernanceModule.NotApproved.selector);
    module.executeProposal(ROUND_ID, batch);
    _result(6_668, 3_332, 0);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_theHighestThresholdAlmostNeedsUnanimity() public {
    vm.prank(address(safe));
    module.setApprovalBps(9_999);
    _result(9_999, 1, 0);
    vm.expectRevert(CrispGovernanceModule.NotApproved.selector);
    module.executeProposal(ROUND_ID, batch);
    _result(10_000, 1, 0);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_aResultExpiresAfterTheConfiguredTime() public {
    _result(200, 100, 5);
    uint256 resolvedAt = block.timestamp;

    // The last accepted second is resolvedAt + expiration.
    vm.warp(resolvedAt + EXPIRATION + 1);
    vm.expectRevert(CrispGovernanceModule.ResultExpired.selector);
    module.executeProposal(ROUND_ID, batch);

    vm.warp(resolvedAt + EXPIRATION);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_zeroExpirationMeansNoLimit() public {
    vm.prank(address(safe));
    module.setExpiration(0);
    _result(200, 100, 5);
    vm.warp(block.timestamp + 3650 days);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_theModuleMustBeEnabledInTheDelay() public {
    CrispGovernanceModule stray = CrispGovernanceModule(
      moduleFactory.deployModule(
        address(moduleMastercopy),
        abi.encodeCall(
          CrispGovernanceModule.setUp,
          (abi.encode(address(safe), address(safe), address(delay), address(voting), address(multiSend), QUORUM, APPROVAL_BPS, EXPIRATION))
        ),
        2
      )
    );
    _result(200, 100, 5);
    vm.expectRevert();
    stray.executeProposal(ROUND_ID, batch);
  }

  // ---------------------------------------------------------------------------------------------
  // setUp and owner configuration
  // ---------------------------------------------------------------------------------------------

  function test_theProxyAndTheMastercopyCannotBeReinitialised() public {
    bytes memory params = abi.encode(address(1), address(2), address(3), address(4), address(5), uint256(0), uint16(1), uint64(0));
    vm.expectRevert();
    module.setUp(params);
    vm.expectRevert();
    moduleMastercopy.setUp(params);
  }

  function test_setUpRejectsInvalidParameters() public {
    bytes memory zeroAvatar = abi.encode(address(1), address(0), address(3), address(4), address(5), uint256(0), uint16(1), uint64(0));
    bytes memory zeroTarget = abi.encode(address(1), address(2), address(0), address(4), address(5), uint256(0), uint16(1), uint64(0));
    bytes memory zeroVoting = abi.encode(address(1), address(2), address(3), address(0), address(5), uint256(0), uint16(1), uint64(0));
    bytes memory zeroMultiSend = abi.encode(address(1), address(2), address(3), address(4), address(0), uint256(0), uint16(1), uint64(0));
    bytes memory zeroBps = abi.encode(address(1), address(2), address(3), address(4), address(5), uint256(0), uint16(0), uint64(0));
    bytes memory highBps = abi.encode(address(1), address(2), address(3), address(4), address(5), uint256(0), uint16(10_001), uint64(0));
    bytes memory fullBps = abi.encode(address(1), address(2), address(3), address(4), address(5), uint256(0), uint16(10_000), uint64(0));

    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    new CrispGovernanceModule(zeroAvatar);
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    new CrispGovernanceModule(zeroTarget);
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    new CrispGovernanceModule(zeroVoting);
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    new CrispGovernanceModule(zeroMultiSend);
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    new CrispGovernanceModule(zeroBps);
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    new CrispGovernanceModule(highBps);
    // 100% can never pass (the comparison is strict).
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    new CrispGovernanceModule(fullBps);
    // 99.99% is the highest threshold.
    new CrispGovernanceModule(abi.encode(address(1), address(2), address(3), address(4), address(5), uint256(0), uint16(9_999), uint64(0)));
  }

  function test_onlyTheSafeMayConfigureTheModule() public {
    address stranger = makeAddr("stranger");
    vm.startPrank(stranger);
    vm.expectRevert();
    module.setQuorum(1);
    vm.expectRevert();
    module.setApprovalBps(1);
    vm.expectRevert();
    module.setExpiration(1);
    vm.expectRevert();
    module.setVoting(address(1));
    vm.expectRevert();
    module.setMultiSend(address(1));
    vm.stopPrank();

    // Through the Safe: a governance change of the quorum takes effect on the next execution.
    _safeExec(address(module), abi.encodeCall(CrispGovernanceModule.setQuorum, (1_000e18)));
    assertEq(module.quorum(), 1_000e18);
    _result(200, 100, 5);
    vm.expectRevert(CrispGovernanceModule.QuorumNotMet.selector);
    module.executeProposal(ROUND_ID, batch);
  }

  function test_configurationRejectsInvalidValues() public {
    vm.startPrank(address(safe));
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    module.setApprovalBps(0);
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    module.setApprovalBps(10_000);
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    module.setVoting(address(0));
    vm.expectRevert(CrispGovernanceModule.InvalidParams.selector);
    module.setMultiSend(address(0));
    vm.stopPrank();
  }

  // ---------------------------------------------------------------------------------------------
  // fuzz
  // ---------------------------------------------------------------------------------------------

  /// @dev The pass condition against a reference computed in 256-bit math.
  function testFuzz_executionFollowsQuorumAndApproval(
    uint64 forVotes,
    uint64 againstVotes,
    uint64 abstainVotes,
    uint16 bps,
    uint64 quorumUnits
  ) public {
    bps = uint16(bound(bps, 1, 9_999));
    vm.prank(address(safe));
    module.setApprovalBps(bps);
    vm.prank(address(safe));
    module.setQuorum(uint256(quorumUnits) * DIVISOR);
    _result(forVotes, againstVotes, abstainVotes);

    uint256 total = uint256(forVotes) + againstVotes + abstainVotes;
    bool quorumMet = total >= quorumUnits;
    bool approved = uint256(forVotes) * 10_000 > uint256(bps) * (uint256(forVotes) + againstVotes);

    if (!quorumMet) vm.expectRevert(CrispGovernanceModule.QuorumNotMet.selector);
    else if (!approved) vm.expectRevert(CrispGovernanceModule.NotApproved.selector);
    module.executeProposal(ROUND_ID, batch);
    assertEq(module.executed(ROUND_ID), quorumMet && approved);
  }

  /// @dev No batch but the one the proposer fixed hashes to the proposal hash.
  function testFuzz_onlyTheProposedBatchExecutes(bytes calldata other) public {
    vm.assume(keccak256(other) != keccak256(batch));
    _result(200, 100, 5);
    vm.expectRevert(CrispGovernanceModule.HashMismatch.selector);
    module.executeProposal(ROUND_ID, other);
    assertFalse(module.executed(ROUND_ID));
  }

  /// @dev A proposal for round A cannot be executed with round B's result or hash.
  function testFuzz_roundsAreIndependent(uint256 otherRound) public {
    vm.assume(otherRound != ROUND_ID);
    _result(200, 100, 5);
    vm.expectRevert(CrispGovernanceModule.NoResult.selector);
    module.executeProposal(otherRound, batch);
  }
}
