// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Test, Vm } from "forge-std/Test.sol";
import { IInterfold } from "@interfold/contracts/contracts/interfaces/IInterfold.sol";
import { E3 } from "@interfold/contracts/contracts/interfaces/IE3.sol";
import { IE3Program } from "@interfold/contracts/contracts/interfaces/IE3Program.sol";
import { MockDataAvailabilityVerifier } from "@interfold/contracts/contracts/test/MockDataAvailabilityVerifier.sol";
import { CRISPRemoteProgram } from "@crisp-e3/extension-core/contracts/CRISPRemoteProgram.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { CRISPGnosisProgram } from "../contracts/l1/CRISPGnosisProgram.sol";
import { CRISPGnosisMessages } from "../contracts/lib/CRISPGnosisMessages.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";
import { IGnosisReceiver } from "../contracts/interfaces/IGnosisReceiver.sol";
import { MockAMB } from "../contracts/test-mocks/MockAMB.sol";
import { MockInterfold } from "../contracts/test-mocks/MockInterfold.sol";
import { MockOpenVmReceiptVerifier } from "@crisp-e3/contracts/contracts/test/MockOpenVmReceiptVerifier.sol";

contract CRISPGnosisProgramTest is Test {
  uint256 internal constant MARGIN = 1800;
  uint256 internal constant KEY_TIME = 936 + 180 + 1200;
  uint256 internal constant T = 17_000_000;
  bytes32 internal constant PROPOSAL_HASH = keccak256("packed batch");
  string internal constant CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

  address internal owner = makeAddr("owner");
  address internal proposer = makeAddr("proposer");
  address internal remote = makeAddr("voting");

  MockInterfold internal interfold;
  MockAMB internal foreign;
  MockAMB internal home;
  CRISPGnosisProgram internal program;

  function setUp() public {
    vm.warp(1_800_000_000);
    interfold = new MockInterfold();
    interfold.setCommitteeSetupWindows(936, 180, 1200);
    interfold.setComputeWindow(7 days);
    foreign = new MockAMB(false, 4_000_000);
    home = new MockAMB(true, 2_000_000);
    MockOpenVmReceiptVerifier openVm = new MockOpenVmReceiptVerifier();

    program = new CRISPGnosisProgram(
      owner,
      openVm,
      openVm.imageId(),
      new MockDataAvailabilityVerifier(),
      1 hours,
      3600,
      IAMB(address(foreign)),
      MARGIN
    );
    interfold.registerE3Program(IE3Program(address(program)));
    vm.startPrank(owner);
    program.bindInterfold(IInterfold(address(interfold)));
    program.setRemote(remote);
    program.setProposer(proposer, true);
    vm.stopPrank();
  }

  // ---------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------

  function _params(bytes32 hash, string memory cid) internal pure returns (bytes memory) {
    return abi.encode(uint8(0), bytes32(0), uint256(0), hash, cid);
  }

  function _start() internal view returns (uint256) {
    return block.timestamp + KEY_TIME + MARGIN;
  }

  function _request(bytes memory customParams) internal returns (uint256 e3Id) {
    return _requestAt(_start(), _start() + 1 hours, customParams);
  }

  function _requestAt(uint256 start, uint256 end, bytes memory customParams) internal returns (uint256 e3Id) {
    vm.prank(proposer);
    return interfold.request(address(program), [start, end], customParams);
  }

  function _logs(address emitter, bytes32 topic0) internal returns (Vm.Log[] memory out) {
    Vm.Log[] memory all = vm.getRecordedLogs();
    uint256 n;
    for (uint256 i = 0; i < all.length; i++) if (all[i].emitter == emitter && all[i].topics[0] == topic0) n++;
    out = new Vm.Log[](n);
    n = 0;
    for (uint256 i = 0; i < all.length; i++) if (all[i].emitter == emitter && all[i].topics[0] == topic0) out[n++] = all[i];
  }

  function _plaintext(uint64 forVotes, uint64 againstVotes, uint64 abstainVotes) internal pure returns (bytes memory out) {
    out = new bytes(50 * 8);
    uint64[3] memory tally = [forVotes, againstVotes, abstainVotes];
    for (uint256 o = 0; o < 3; o++) for (uint256 j = 0; j < 8; j++) out[o * 8 + j] = bytes1(uint8(tally[o] >> (8 * j)));
  }

  /// @dev A message the remote contract sent through the Home AMB, as the Foreign AMB would be handed it.
  function _homeMessage(address sender, bytes memory message) internal returns (bytes memory encodedData) {
    vm.recordLogs();
    vm.prank(sender);
    home.requireToPassMessage(address(program), abi.encodeCall(IGnosisReceiver.receiveMessage, (message)), CRISPGnosisMessages.ROOT_GAS);
    Vm.Log[] memory logs = _logs(address(home), MockAMB.UserRequestForSignature.selector);
    encodedData = abi.decode(logs[0].data, (bytes));
  }

  function _deliverRoot(address sender, uint256 e3Id, uint256 root, uint256 numInputs) internal returns (bool status) {
    bytes memory encoded = _homeMessage(sender, CRISPRemoteMessages.inputRoot(uint256(uint96(e3Id)), root, numInputs));
    vm.recordLogs();
    foreign.executeSignatures(encoded, home.getSignatures(encoded));
    Vm.Log[] memory logs = _logs(address(foreign), MockAMB.RelayedMessage.selector);
    status = abi.decode(logs[0].data, (bool));
  }

  function _asAmb(address sender) internal {
    vm.mockCall(address(foreign), abi.encodeWithSelector(IAMB.messageSender.selector), abi.encode(sender));
    vm.prank(address(foreign));
  }

  // ---------------------------------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------------------------------

  function test_constructorRejectsAnAmbWithoutCode() public {
    MockOpenVmReceiptVerifier openVm = new MockOpenVmReceiptVerifier();
    MockDataAvailabilityVerifier da = new MockDataAvailabilityVerifier();
    bytes32 imageId = openVm.imageId();
    IAMB eoa = IAMB(makeAddr("eoa"));
    vm.expectRevert(CRISPGnosisProgram.InvalidAmb.selector);
    new CRISPGnosisProgram(owner, openVm, imageId, da, 1 hours, 3600, eoa, MARGIN);
  }

  function test_setRemoteIsOwnerOnlyAndOneShot() public {
    MockOpenVmReceiptVerifier openVm = new MockOpenVmReceiptVerifier();
    CRISPGnosisProgram fresh = new CRISPGnosisProgram(
      owner,
      openVm,
      openVm.imageId(),
      new MockDataAvailabilityVerifier(),
      1 hours,
      3600,
      IAMB(address(foreign)),
      MARGIN
    );

    vm.expectRevert();
    fresh.setRemote(remote);

    vm.startPrank(owner);
    vm.expectRevert(CRISPGnosisProgram.InvalidRemote.selector);
    fresh.setRemote(address(0));
    fresh.setRemote(remote);
    vm.expectRevert(CRISPGnosisProgram.RemoteAlreadySet.selector);
    fresh.setRemote(makeAddr("other"));
    vm.stopPrank();
    assertEq(fresh.remote(), remote);
  }

  function test_roundsCannotBeRequestedBeforeTheRemoteIsSet() public {
    MockOpenVmReceiptVerifier openVm = new MockOpenVmReceiptVerifier();
    CRISPGnosisProgram fresh = new CRISPGnosisProgram(
      owner,
      openVm,
      openVm.imageId(),
      new MockDataAvailabilityVerifier(),
      1 hours,
      3600,
      IAMB(address(foreign)),
      MARGIN
    );
    interfold.registerE3Program(IE3Program(address(fresh)));
    vm.startPrank(owner);
    fresh.bindInterfold(IInterfold(address(interfold)));
    fresh.setProposer(proposer, true);
    vm.stopPrank();

    vm.prank(proposer);
    vm.expectRevert(CRISPGnosisProgram.RemoteNotSet.selector);
    interfold.request(address(fresh), [_start(), _start() + 1 hours], _params(PROPOSAL_HASH, CID));
  }

  // ---------------------------------------------------------------------------------------------
  // proposer allowlist
  // ---------------------------------------------------------------------------------------------

  function test_onlyAllowedProposersMayRequest() public {
    address stranger = makeAddr("stranger");
    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(CRISPGnosisProgram.ProposerNotAllowed.selector, stranger));
    interfold.request(address(program), [_start(), _start() + 1 hours], _params(PROPOSAL_HASH, CID));

    vm.prank(proposer);
    interfold.request(address(program), [_start(), _start() + 1 hours], _params(PROPOSAL_HASH, CID));
  }

  function test_proposerAllowlistIsOwnerManaged() public {
    vm.expectRevert();
    program.setProposer(proposer, false);

    vm.expectEmit(true, false, false, true, address(program));
    emit CRISPGnosisProgram.ProposerSet(proposer, false);
    vm.prank(owner);
    program.setProposer(proposer, false);
    assertFalse(program.isProposer(proposer));

    vm.prank(proposer);
    vm.expectRevert(abi.encodeWithSelector(CRISPGnosisProgram.ProposerNotAllowed.selector, proposer));
    interfold.request(address(program), [_start(), _start() + 1 hours], _params(PROPOSAL_HASH, CID));
  }

  // ---------------------------------------------------------------------------------------------
  // validate: custom params, ROUND message
  // ---------------------------------------------------------------------------------------------

  function test_validateSendsTheRoundMessageThroughTheAmb() public {
    uint256 start = _start();
    uint256 end = start + 2 hours;
    vm.recordLogs();
    uint256 e3Id = _requestAt(start, end, _params(PROPOSAL_HASH, CID));

    CRISPGnosisMessages.RoundMessage memory m;
    m.roundId = uint96(e3Id);
    m.numOptions = 3;
    m.inputStart = start;
    m.inputEnd = end;
    m.inputLimit = 65_536;
    m.plaintextModulus = T;
    m.snapshot = block.timestamp - 1;
    m.proposalHash = PROPOSAL_HASH;
    m.requester = proposer;
    m.metadataCid = CID;
    bytes memory expected = CRISPGnosisMessages.round(m);

    Vm.Log[] memory all = vm.getRecordedLogs();
    // Order: ProposalCreated, then the AMB request, then RoundConfigSent.
    uint256 created;
    uint256 sent;
    uint256 configSent;
    bytes32 messageId;
    for (uint256 i = 0; i < all.length; i++) {
      if (all[i].emitter == address(program) && all[i].topics[0] == CRISPGnosisProgram.ProposalCreated.selector) {
        created = i + 1;
        assertEq(uint256(all[i].topics[1]), e3Id);
        assertEq(address(uint160(uint256(all[i].topics[2]))), proposer);
        (bytes32 hash, string memory cid) = abi.decode(all[i].data, (bytes32, string));
        assertEq(hash, PROPOSAL_HASH);
        assertEq(cid, CID);
      }
      if (all[i].emitter == address(foreign) && all[i].topics[0] == MockAMB.MockMessage.selector) {
        sent = i + 1;
        assertEq(address(uint160(uint256(all[i].topics[1]))), address(program));
        assertEq(address(uint160(uint256(all[i].topics[2]))), remote);
        (bytes memory data, uint256 gas) = abi.decode(all[i].data, (bytes, uint256));
        assertEq(gas, CRISPGnosisMessages.ROUND_GAS);
        assertEq(data, abi.encodeCall(IGnosisReceiver.receiveMessage, (expected)));
      }
      if (all[i].emitter == address(program) && all[i].topics[0] == CRISPRemoteProgram.RoundConfigSent.selector) {
        configSent = i + 1;
        messageId = abi.decode(all[i].data, (bytes32));
      }
    }
    assertTrue(created != 0 && sent != 0 && configSent != 0, "events");
    assertLt(created, sent);
    assertLt(sent, configSent);
    assertEq(messageId, bytes32(uint256(1)));

    CRISPRemoteProgram.Round memory round = program.getRound(e3Id);
    assertEq(round.numOptions, 3);
    assertEq(round.inputLimit, 65_536);
    assertEq(round.paramsHash, keccak256(interfold.e3ProgramParams()));
  }

  function test_validateRefusesPhaseTwoCensusFields() public {
    bytes memory modeOne = abi.encode(uint8(1), bytes32(0), uint256(0), PROPOSAL_HASH, CID);
    bytes memory rootSet = abi.encode(uint8(0), bytes32(uint256(1)), uint256(0), PROPOSAL_HASH, CID);
    bytes memory totalSet = abi.encode(uint8(0), bytes32(0), uint256(1), PROPOSAL_HASH, CID);

    vm.expectRevert(CRISPGnosisProgram.CensusModeNotSupported.selector);
    _request(modeOne);
    vm.expectRevert(CRISPGnosisProgram.CensusModeNotSupported.selector);
    _request(rootSet);
    vm.expectRevert(CRISPGnosisProgram.CensusModeNotSupported.selector);
    _request(totalSet);
  }

  function test_validateRequiresAProposalHashAndAMetadataCid() public {
    vm.expectRevert(CRISPGnosisProgram.InvalidProposalHash.selector);
    _request(_params(bytes32(0), CID));

    vm.expectRevert(CRISPGnosisProgram.InvalidMetadataCid.selector);
    _request(_params(PROPOSAL_HASH, ""));

    vm.expectRevert(CRISPGnosisProgram.InvalidMetadataCid.selector);
    _request(_params(PROPOSAL_HASH, string(new bytes(129))));

    _request(_params(PROPOSAL_HASH, string(new bytes(128))));
    _request(_params(PROPOSAL_HASH, "a"));
  }

  function test_validateRejectsMalformedCustomParams() public {
    vm.expectRevert();
    _request("");
    vm.expectRevert();
    _request(abi.encode(uint256(1), uint256(2)));
  }

  function test_validateCanBeCalledOnlyByInterfold() public {
    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    bytes memory e3Params = interfold.e3ProgramParams();
    vm.expectRevert(CRISPRemoteProgram.CallerNotAuthorized.selector);
    program.validate(e3Id, 0, e3Params, "", _params(PROPOSAL_HASH, CID));
  }

  // ---------------------------------------------------------------------------------------------
  // timing: the AMB latency margin
  // ---------------------------------------------------------------------------------------------

  function test_votingMustStartAfterTheKeyDeadlinePlusTheAmbMargin() public {
    uint256 latest = block.timestamp + KEY_TIME + MARGIN;
    bytes memory params = _params(PROPOSAL_HASH, CID);

    vm.expectRevert(
      abi.encodeWithSelector(CRISPRemoteProgram.VotingStartsBeforeKeyDeadline.selector, uint256(uint160(address(interfold))) << 96, latest, latest - 1)
    );
    _requestAt(latest - 1, latest - 1 + 1 hours, params);

    _requestAt(latest, latest + 1 hours, params);
  }

  function test_votingWindowMustLastAnHour() public {
    uint256 start = _start();
    vm.expectRevert(
      abi.encodeWithSelector(
        CRISPRemoteProgram.VotingWindowTooShort.selector,
        uint256(uint160(address(interfold))) << 96,
        start,
        start + 1 hours - 1,
        1 hours
      )
    );
    _requestAt(start, start + 1 hours - 1, _params(PROPOSAL_HASH, CID));
  }

  function test_earliestVotingStartIncludesTheMargin() public view {
    assertEq(program.earliestVotingStart(), block.timestamp + KEY_TIME + MARGIN);
  }

  function test_computeWindowMustCoverRemoteFinality() public {
    interfold.setComputeWindow(3599);
    vm.expectRevert();
    _request(_params(PROPOSAL_HASH, CID));
  }

  // ---------------------------------------------------------------------------------------------
  // KEY
  // ---------------------------------------------------------------------------------------------

  function test_publishCommitteeKeySendsKeyOnceWhenTheKeyIsPublished() public {
    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    bytes32 key = keccak256("committee key");

    vm.expectRevert(abi.encodeWithSelector(CRISPRemoteProgram.KeyNotPublished.selector, e3Id));
    program.publishCommitteeKey(e3Id);

    interfold.setStage(e3Id, IInterfold.E3Stage.KeyPublished);
    interfold.setCommitteePublicKey(e3Id, key);
    vm.recordLogs();
    program.publishCommitteeKey(e3Id);

    Vm.Log[] memory sent = _logs(address(foreign), MockAMB.MockMessage.selector);
    assertEq(sent.length, 1);
    (bytes memory data, uint256 gas) = abi.decode(sent[0].data, (bytes, uint256));
    assertEq(gas, CRISPGnosisMessages.KEY_GAS);
    assertEq(data, abi.encodeCall(IGnosisReceiver.receiveMessage, (abi.encode(uint256(2), uint256(uint96(e3Id)), key))));

    vm.expectRevert(abi.encodeWithSelector(CRISPRemoteProgram.CommitteeKeyAlreadyRelayed.selector, e3Id));
    program.publishCommitteeKey(e3Id);
  }

  // ---------------------------------------------------------------------------------------------
  // ROOT (Chiado -> Sepolia): authentication
  // ---------------------------------------------------------------------------------------------

  function test_rootFromTheRemoteThroughTheAmbIsRecorded() public {
    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    interfold.setStage(e3Id, IInterfold.E3Stage.KeyPublished);

    assertTrue(_deliverRoot(remote, e3Id, 1234, 4));

    CRISPRemoteProgram.Round memory round = program.getRound(e3Id);
    assertTrue(round.rootSubmitted);
    assertEq(round.inputRoot, 1234);
    assertEq(round.numInputs, 4);
  }

  function test_rootFromAnyOtherSenderIsNotAccepted() public {
    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    interfold.setStage(e3Id, IInterfold.E3Stage.KeyPublished);

    // Through the (mock) bridge: the call reverts inside, the bridge records status = false.
    assertFalse(_deliverRoot(makeAddr("impostor"), e3Id, 1234, 4));
    assertFalse(program.getRound(e3Id).rootSubmitted);

    // Directly, as the AMB would call it.
    _asAmb(makeAddr("impostor"));
    vm.expectRevert(CRISPGnosisProgram.WrongRemoteSender.selector);
    program.receiveMessage(CRISPRemoteMessages.inputRoot(uint256(uint96(e3Id)), 1234, 4));
  }

  function test_rootFromAnythingButTheAmbIsNotAccepted() public {
    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    interfold.setStage(e3Id, IInterfold.E3Stage.KeyPublished);
    bytes memory message = CRISPRemoteMessages.inputRoot(uint256(uint96(e3Id)), 1234, 4);

    // The remote itself, or anyone, calling directly: not the AMB.
    vm.prank(remote);
    vm.expectRevert(CRISPGnosisProgram.NotAMB.selector);
    program.receiveMessage(message);

    vm.expectRevert(CRISPGnosisProgram.NotAMB.selector);
    program.receiveMessage(message);

    // The wrong AMB: the Home mock is not the program's Foreign AMB.
    vm.prank(address(home));
    vm.expectRevert(CRISPGnosisProgram.NotAMB.selector);
    program.receiveMessage(message);
  }

  function test_aDuplicateRootReturnsSilently() public {
    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    interfold.setStage(e3Id, IInterfold.E3Stage.KeyPublished);
    assertTrue(_deliverRoot(remote, e3Id, 1234, 4));

    // An authentic duplicate (even with different content) does not revert and changes nothing: AMB messages are not replayable.
    assertTrue(_deliverRoot(remote, e3Id, 999, 1));
    CRISPRemoteProgram.Round memory round = program.getRound(e3Id);
    assertEq(round.inputRoot, 1234);
    assertEq(round.numInputs, 4);
  }

  function test_onlyRootIsAnAuthenticKindForTheProgram() public {
    for (uint256 kind = 0; kind < 6; kind++) {
      if (kind == CRISPGnosisMessages.KIND_ROOT) continue;
      _asAmb(remote);
      vm.expectRevert(abi.encodeWithSelector(CRISPGnosisProgram.InvalidKind.selector, kind));
      program.receiveMessage(abi.encode(kind, uint256(1), uint256(1), uint256(1)));
    }
  }

  function test_invalidRootsAreRefused() public {
    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    _asAmb(remote);
    // Not in KeyPublished.
    vm.expectRevert(abi.encodeWithSelector(CRISPRemoteProgram.KeyNotPublished.selector, e3Id));
    program.receiveMessage(CRISPRemoteMessages.inputRoot(uint256(uint96(e3Id)), 1234, 4));

    interfold.setStage(e3Id, IInterfold.E3Stage.KeyPublished);
    _asAmb(remote);
    vm.expectRevert(CRISPRemoteProgram.InvalidInputRoot.selector);
    program.receiveMessage(CRISPRemoteMessages.inputRoot(uint256(uint96(e3Id)), 0, 4));

    _asAmb(remote);
    vm.expectRevert(abi.encodeWithSelector(CRISPRemoteProgram.InputCountExceedsLimit.selector, e3Id, 65_537, 65_536));
    program.receiveMessage(CRISPRemoteMessages.inputRoot(uint256(uint96(e3Id)), 1234, 65_537));

    // A round this program never configured.
    uint256 unknown = (uint256(uint160(address(interfold))) << 96) | 999;
    _asAmb(remote);
    vm.expectRevert(abi.encodeWithSelector(CRISPRemoteProgram.E3NotAssignedToProgram.selector, unknown));
    program.receiveMessage(CRISPRemoteMessages.inputRoot(999, 1234, 4));
  }

  // ---------------------------------------------------------------------------------------------
  // RESULT (Sepolia -> Chiado)
  // ---------------------------------------------------------------------------------------------

  function test_relayResultSendsTheDecodedTallyOnceWhenComplete() public {
    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    interfold.setPlaintextOutput(e3Id, _plaintext(500, 300, 7));

    interfold.setStage(e3Id, IInterfold.E3Stage.CiphertextReady);
    vm.expectRevert(abi.encodeWithSelector(CRISPGnosisProgram.E3NotComplete.selector, e3Id, IInterfold.E3Stage.CiphertextReady));
    program.relayResult(e3Id);

    interfold.setStage(e3Id, IInterfold.E3Stage.Complete);
    uint256[] memory tally = new uint256[](3);
    tally[0] = 500;
    tally[1] = 300;
    tally[2] = 7;
    vm.expectEmit(true, false, false, true, address(program));
    emit CRISPGnosisProgram.ResultRelayed(e3Id, tally);
    vm.recordLogs();
    // Permissionless.
    vm.prank(makeAddr("anyone"));
    program.relayResult(e3Id);

    Vm.Log[] memory sent = _logs(address(foreign), MockAMB.MockMessage.selector);
    assertEq(sent.length, 1);
    (bytes memory data, uint256 gas) = abi.decode(sent[0].data, (bytes, uint256));
    assertEq(gas, CRISPGnosisMessages.RESULT_GAS);
    assertEq(data, abi.encodeCall(IGnosisReceiver.receiveMessage, (CRISPGnosisMessages.result(uint256(uint96(e3Id)), tally))));
    assertTrue(program.resultRelayed(e3Id));

    vm.expectRevert(abi.encodeWithSelector(CRISPGnosisProgram.ResultAlreadyRelayed.selector, e3Id));
    program.relayResult(e3Id);
  }

  function test_relayResultRefusesAnUnknownE3AndAFailedOne() public {
    uint256 unknown = (uint256(uint160(address(interfold))) << 96) | 999;
    vm.expectRevert(abi.encodeWithSelector(CRISPRemoteProgram.E3NotAssignedToProgram.selector, unknown));
    program.relayResult(unknown);

    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    interfold.setStage(e3Id, IInterfold.E3Stage.Failed);
    vm.expectRevert(abi.encodeWithSelector(CRISPGnosisProgram.E3NotComplete.selector, e3Id, IInterfold.E3Stage.Failed));
    program.relayResult(e3Id);
  }

  function test_decodeTallyIsTruncatedToThreeOptions() public {
    uint256 e3Id = _request(_params(PROPOSAL_HASH, CID));
    bytes memory plaintext = _plaintext(1, 2, 3);
    // A nonzero coefficient past the options (a mask padding, say) is not part of the tally.
    plaintext[3 * 8] = 0x09;
    interfold.setPlaintextOutput(e3Id, plaintext);

    uint256[] memory tally = program.decodeTally(e3Id);
    assertEq(tally.length, 3);
    assertEq(tally[0], 1);
    assertEq(tally[1], 2);
    assertEq(tally[2], 3);
  }

  function test_scopeAndInterfaces() public view {
    string memory scope = program.scopeOf(5);
    assertEq(bytes(scope)[0], bytes1("c"));
    assertTrue(program.supportsInterface(type(IE3Program).interfaceId));
  }
}
