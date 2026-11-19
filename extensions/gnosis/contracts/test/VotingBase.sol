// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Test, Vm } from "forge-std/Test.sol";
import { IHonkVerifier } from "@crisp-e3/contracts/contracts/interfaces/IHonkVerifier.sol";
import { IVotesToken } from "@crisp-e3/contracts/contracts/interfaces/IVotesToken.sol";
import { MockHonkVerifier } from "@crisp-e3/contracts/contracts/Mocks/MockHonkVerifier.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { CrispGnosisVoting } from "../contracts/chiado/CrispGnosisVoting.sol";
import { CrispDemoToken } from "../contracts/chiado/CrispDemoToken.sol";
import { CRISPGnosisMessages } from "../contracts/lib/CRISPGnosisMessages.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";
import { IGnosisReceiver } from "../contracts/interfaces/IGnosisReceiver.sol";
import { MockAMB } from "../contracts/test-mocks/MockAMB.sol";

/// @notice A Chiado deployment with a demo token, a Home AMB mock and a mock Honk verifier, plus the helpers to open a
/// round and cast ballots. The Sepolia side is a bare address: tests deliver its messages as the AMB would.
abstract contract VotingBase is Test {
  uint256 internal constant T0 = 1_800_000_000;
  uint256 internal constant PLAINTEXT_MODULUS = 17_000_000;
  uint256 internal constant ROUND_ID = 7;
  uint256 internal constant INPUT_START = T0 + 1000;
  uint256 internal constant INPUT_END = T0 + 1000 + 1 hours;
  bytes32 internal constant PROPOSAL_HASH = keccak256("packed batch");
  bytes32 internal constant COMMITTEE_KEY = keccak256("committee key");
  string internal constant CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

  address internal owner = makeAddr("owner");
  address internal interfold = makeAddr("interfold");
  address internal program = makeAddr("program");
  address internal requester = makeAddr("proposer");
  address internal alice = makeAddr("alice");
  address internal bob = makeAddr("bob");
  address internal carol = makeAddr("carol");
  address internal dave = makeAddr("dave");
  uint256 internal signerKey = 0xA11CE;
  address internal signer = vm.addr(0xA11CE);

  CrispDemoToken internal token;
  MockAMB internal home;
  MockHonkVerifier internal honk;
  CrispGnosisVoting internal voting;
  uint256 internal messageNonce;

  /// @dev Balances at the snapshot: alice 10M, bob 5M, carol 1 token (just over the divisor), dave half a token (below it).
  function _deployVoting(uint256 minVotingPower) internal {
    vm.warp(T0);
    token = new CrispDemoToken(owner, 100e18, 1 days);
    home = new MockAMB(true, 2_000_000);
    honk = new MockHonkVerifier();
    voting = new CrispGnosisVoting(
      IAMB(address(home)),
      interfold,
      program,
      IVotesToken(address(token)),
      IHonkVerifier(address(honk)),
      signer,
      minVotingPower
    );

    _fund(alice, 10_000_000e18);
    _fund(bob, 5_000_000e18);
    _fund(carol, 1e18);
    _fund(dave, 0.5e18);
    vm.warp(T0 + 100);
  }

  function _fund(address to, uint256 amount) internal {
    vm.prank(owner);
    token.mintTreasury(to, amount);
    vm.prank(to);
    token.delegate(to);
  }

  function _e3Id(uint256 roundId) internal view returns (uint256) {
    return (uint256(uint160(interfold)) << 96) | roundId;
  }

  function _roundMessage(uint256 roundId) internal view returns (CRISPGnosisMessages.RoundMessage memory m) {
    m.roundId = roundId;
    m.numOptions = 3;
    m.inputStart = INPUT_START;
    m.inputEnd = INPUT_END;
    m.inputLimit = 65_536;
    m.plaintextModulus = PLAINTEXT_MODULUS;
    m.snapshot = T0 + 50;
    m.proposalHash = PROPOSAL_HASH;
    m.requester = requester;
    m.metadataCid = CID;
  }

  /// @dev Delivers `message` as the Home AMB would after the program sent it; returns whether the receiver accepted it.
  function _deliver(bytes memory message) internal returns (bool status) {
    bytes memory encoded = abi.encode(
      bytes32(++messageNonce),
      program,
      address(voting),
      uint256(1_000_000),
      abi.encodeCall(IGnosisReceiver.receiveMessage, (message))
    );
    vm.recordLogs();
    home.executeAffirmation(encoded);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    for (uint256 i = 0; i < logs.length; i++) {
      if (logs[i].emitter == address(home) && logs[i].topics[0] == MockAMB.RelayedMessage.selector) {
        status = abi.decode(logs[i].data, (bool));
      }
    }
  }

  function _openRound(uint256 roundId) internal {
    assertTrue(_deliver(CRISPGnosisMessages.round(_roundMessage(roundId))));
    assertTrue(_deliver(CRISPRemoteMessages.committeeKey(roundId, COMMITTEE_KEY)));
  }

  /// @dev Opens round `ROUND_ID` with its key and moves to the middle of its input window.
  function _openAndStart() internal returns (uint256 e3Id) {
    _openRound(ROUND_ID);
    vm.warp(INPUT_START + 10);
    return _e3Id(ROUND_ID);
  }

  function _asAmb(address sender) internal {
    vm.mockCall(address(home), abi.encodeWithSelector(IAMB.messageSender.selector), abi.encode(sender));
    vm.prank(address(home));
  }

  function _attestation(uint256 e3Id, bytes32 id, uint64 expiresAt, uint256 key) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, voting.inputAvailabilityDigest(e3Id, id, expiresAt));
    return abi.encodePacked(r, s, v);
  }

  function _data(
    uint256 e3Id,
    address slot,
    bytes32 commitment,
    bytes32 voteHash,
    uint40 parent,
    uint64 expiresAt,
    uint256 attestKey
  ) internal view returns (bytes memory) {
    bytes32 id = voting.inputId(e3Id, voteHash, commitment, slot, parent);
    return abi.encode(bytes("noir proof"), slot, commitment, voteHash, parent, expiresAt, _attestation(e3Id, id, expiresAt, attestKey));
  }

  function _publish(uint256 e3Id, address slot, bytes32 commitment, bytes32 voteHash, uint40 parent) internal {
    voting.publishInput(e3Id, _data(e3Id, slot, commitment, voteHash, parent, uint64(block.timestamp + 1 hours), signerKey));
  }

  function _publish(uint256 e3Id, address slot, uint256 n) internal {
    _publish(e3Id, slot, keccak256(abi.encode("commitment", n)), keccak256(abi.encode("vote", n)), 0);
  }

  /// @dev Reads the `RoundClosed` event of the last recorded logs.
  function _closed(Vm.Log[] memory logs) internal view returns (uint256 root, uint256 numInputs) {
    for (uint256 i = 0; i < logs.length; i++) {
      if (logs[i].emitter == address(voting) && logs[i].topics[0] == CrispGnosisVoting.RoundClosed.selector) {
        return abi.decode(logs[i].data, (uint256, uint256));
      }
    }
    revert("RoundClosed not emitted");
  }
}
