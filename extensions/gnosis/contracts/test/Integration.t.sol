// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Vm } from "forge-std/Test.sol";
import { IInterfold } from "@interfold/contracts/contracts/interfaces/IInterfold.sol";
import { IE3Program } from "@interfold/contracts/contracts/interfaces/IE3Program.sol";
import { MockDataAvailabilityVerifier } from "@interfold/contracts/contracts/test/MockDataAvailabilityVerifier.sol";
import { MockOpenVmReceiptVerifier } from "@crisp-e3/contracts/contracts/test/MockOpenVmReceiptVerifier.sol";
import { ModuleProxyFactory } from "@gnosis-guild/zodiac-core/contracts/factory/ModuleProxyFactory.sol";
import { Delay } from "../vendor/zodiac-modifier-delay/Delay.sol";
import { GnosisSafe } from "../vendor/safe-contracts/GnosisSafe.sol";
import { GnosisSafeProxyFactory } from "../vendor/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import { MultiSendCallOnly } from "../vendor/safe-contracts/libraries/MultiSendCallOnly.sol";
import { Enum } from "../vendor/safe-contracts/common/Enum.sol";
import { CRISPGnosisProgram } from "../contracts/l1/CRISPGnosisProgram.sol";
import { CrispGovernanceModule } from "../contracts/chiado/CrispGovernanceModule.sol";
import { CRISPRemoteProgram } from "@crisp-e3/extension-core/contracts/CRISPRemoteProgram.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";
import { MockAMB } from "../contracts/test-mocks/MockAMB.sol";
import { MockInterfold } from "../contracts/test-mocks/MockInterfold.sol";
import { GovernanceDeployer } from "../script/GovernanceDeployer.sol";
import { VotingBase } from "./VotingBase.sol";

/// @notice A whole proposal, design 11.2 / 1.2: Sepolia program (with `MockInterfold`) and Chiado voting contract joined by two
/// `MockAMB`s, then the governance module on a real Safe and Delay, deployed by the same `GovernanceDeployer` the scripts use.
/// The AMB legs are carried the way the keeper carries them on the real bridge.
contract IntegrationTest is VotingBase, GovernanceDeployer {
  MockInterfold internal sepolia;
  MockAMB internal foreign;
  CRISPGnosisProgram internal gnosisProgram;
  MultiSendCallOnly internal multiSend;

  address internal safeOwner = makeAddr("safe owner");
  address internal recipient = makeAddr("recipient");

  function setUp() public {
    sepolia = new MockInterfold();
    foreign = new MockAMB(false, 4_000_000);
    MockOpenVmReceiptVerifier openVm = new MockOpenVmReceiptVerifier();
    gnosisProgram = new CRISPGnosisProgram(
      owner,
      openVm,
      openVm.imageId(),
      new MockDataAvailabilityVerifier(),
      1 hours,
      0,
      IAMB(address(foreign)),
      0
    );
    sepolia.registerE3Program(IE3Program(address(gnosisProgram)));
    vm.prank(owner);
    gnosisProgram.bindInterfold(IInterfold(address(sepolia)));

    // The Chiado side is built against the real program and Interfold addresses.
    program = address(gnosisProgram);
    interfold = address(sepolia);
    _deployVoting(0);
    vm.startPrank(owner);
    gnosisProgram.setRemote(address(voting));
    gnosisProgram.setProposer(requester, true);
    vm.stopPrank();
  }

  /// @dev Carries every AMB request found in `logs` across: Foreign -> Home by affirmation, Home -> Foreign by the
  /// keeper's `getSignatures` + `executeSignatures`. Returns how many were carried.
  function _carry(Vm.Log[] memory logs) internal returns (uint256 carried) {
    for (uint256 i = 0; i < logs.length; i++) {
      if (logs[i].emitter == address(foreign) && logs[i].topics[0] == MockAMB.UserRequestForAffirmation.selector) {
        home.executeAffirmation(abi.decode(logs[i].data, (bytes)));
        carried++;
      } else if (logs[i].emitter == address(home) && logs[i].topics[0] == MockAMB.UserRequestForSignature.selector) {
        bytes memory encoded = abi.decode(logs[i].data, (bytes));
        foreign.executeSignatures(encoded, home.getSignatures(encoded));
        carried++;
      }
    }
  }

  function test_aProposalFromRequestToExecution() public {
    // The proposal: move 250 dCOW from the Safe to `recipient`, as the batch the proposer commits to.
    bytes memory batch = abi.encodePacked(
      uint8(0),
      address(token),
      uint256(0),
      uint256(68),
      abi.encodeCall(token.transfer, (recipient, 250e18))
    );

    // 1. Request (Sepolia): ROUND is sent in the requester's transaction.
    vm.recordLogs();
    vm.prank(requester);
    uint256 e3Id = sepolia.request(
      address(gnosisProgram),
      [block.timestamp + 100, block.timestamp + 100 + 1 hours],
      abi.encode(uint8(0), bytes32(0), uint256(0), keccak256(batch), CID)
    );
    assertEq(_carry(vm.getRecordedLogs()), 1);
    uint256 roundId = uint96(e3Id);
    assertEq(voting.proposalHashOf(roundId), keccak256(batch));
    assertEq(voting.roundOf(roundId).snapshot, block.timestamp - 1);

    // 2. The committee key (Sepolia -> Chiado).
    sepolia.setStage(e3Id, IInterfold.E3Stage.KeyPublished);
    sepolia.setCommitteePublicKey(e3Id, COMMITTEE_KEY);
    vm.recordLogs();
    gnosisProgram.publishCommitteeKey(e3Id);
    assertEq(_carry(vm.getRecordedLogs()), 1);
    assertEq(voting.roundOf(roundId).committeeKey, COMMITTEE_KEY);

    // 3. Three voters.
    vm.warp(voting.roundOf(roundId).inputStart + 1);
    _publish(e3Id, alice, 1);
    _publish(e3Id, bob, 2);
    _publish(e3Id, carol, 3);

    // 4. Close (Chiado -> Sepolia): the root reaches the program through the Foreign AMB.
    vm.warp(voting.roundOf(roundId).inputEnd);
    vm.recordLogs();
    voting.closeRound(roundId);
    Vm.Log[] memory closeLogs = vm.getRecordedLogs();
    (uint256 root, uint256 numInputs) = _closed(closeLogs);
    assertEq(_carry(closeLogs), 1);
    CRISPRemoteProgram.Round memory round = gnosisProgram.getRound(e3Id);
    assertTrue(round.rootSubmitted);
    assertEq(round.inputRoot, root);
    assertEq(round.numInputs, numInputs);

    // 5. Compute and decryption happen on Sepolia (out of scope here); the tally is relayed back.
    uint256[] memory tally = new uint256[](3);
    tally[0] = 500;
    tally[1] = 300;
    tally[2] = 7;
    bytes memory plaintext = new bytes(400);
    // Little-endian u64 coefficients: 500 = 0x01f4, 300 = 0x012c, 7.
    plaintext[0] = 0xf4;
    plaintext[1] = 0x01;
    plaintext[8] = 0x2c;
    plaintext[9] = 0x01;
    plaintext[16] = 0x07;
    sepolia.setPlaintextOutput(e3Id, plaintext);
    sepolia.setStage(e3Id, IInterfold.E3Stage.Complete);
    vm.recordLogs();
    gnosisProgram.relayResult(e3Id);
    assertEq(_carry(vm.getRecordedLogs()), 1);
    assertTrue(voting.resultOf(roundId).resolved);
    assertEq(voting.resultOf(roundId).tally, tally);

    // 6. The module queues the batch in the Delay; the Safe runs it after the cooldown.
    Governance memory gov = _governanceStack();
    CrispGovernanceModule module = CrispGovernanceModule(gov.module);
    module.executeProposal(roundId, batch);

    vm.warp(block.timestamp + 300);
    Delay(gov.delay).executeNextTx(
      address(multiSend),
      0,
      abi.encodeWithSelector(MultiSendCallOnly.multiSend.selector, batch),
      Enum.Operation.DelegateCall
    );
    assertEq(token.balanceOf(recipient), 250e18);
    assertEq(token.balanceOf(gov.safe), 750e18);
  }

  /// @dev The Safe + Delay + module the deploy scripts build, with 1,000 dCOW in the Safe.
  function _governanceStack() internal returns (Governance memory gov) {
    multiSend = new MultiSendCallOnly();
    GnosisSafeProxyFactory safeFactory = new GnosisSafeProxyFactory();
    GnosisSafe singleton = new GnosisSafe();
    ModuleProxyFactory moduleFactory = new ModuleProxyFactory();

    vm.startPrank(safeOwner);
    gov = _deployGovernance(
      GovernanceConfig({
        deployer: safeOwner,
        safeSingleton: address(singleton),
        safeProxyFactory: address(safeFactory),
        moduleProxyFactory: address(moduleFactory),
        multiSend: address(multiSend),
        voting: address(voting),
        delayCooldown: 300,
        delayExpiration: 3600,
        quorum: 100e18,
        approvalBps: 5_000,
        expiration: 7 days
      })
    );
    vm.stopPrank();

    vm.prank(owner);
    token.mintTreasury(gov.safe, 1_000e18);
  }
}
