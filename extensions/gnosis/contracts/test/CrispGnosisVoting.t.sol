// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Vm } from "forge-std/Test.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IHonkVerifier } from "@crisp-e3/contracts/contracts/interfaces/IHonkVerifier.sol";
import { IVotesToken } from "@crisp-e3/contracts/contracts/interfaces/IVotesToken.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { CrispGnosisVoting } from "../contracts/chiado/CrispGnosisVoting.sol";
import { CRISPGnosisMessages } from "../contracts/lib/CRISPGnosisMessages.sol";
import { ICrispVoting } from "../contracts/interfaces/ICrispVoting.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";
import { IGnosisReceiver } from "../contracts/interfaces/IGnosisReceiver.sol";
import { MockAMB } from "../contracts/test-mocks/MockAMB.sol";
import { VotingBase } from "./VotingBase.sol";

/// @dev A votes token on the block-number clock: the voting contract must refuse it.
contract BlockNumberClockToken {
  function CLOCK_MODE() external pure returns (string memory) {
    return "mode=blocknumber";
  }

  function clock() external view returns (uint48) {
    return uint48(block.number);
  }
}

/// @dev A token with no ERC-6372 at all.
contract NoClockToken {
  function getPastVotes(address, uint256) external pure returns (uint256) {
    return 0;
  }
}

contract CrispGnosisVotingTest is VotingBase {
  function setUp() public {
    _deployVoting(0);
  }

  // ---------------------------------------------------------------------------------------------
  // constructor
  // ---------------------------------------------------------------------------------------------

  function test_constructorRefusesUnusableDependencies() public {
    IAMB amb = IAMB(address(home));
    IVotesToken votes = IVotesToken(address(token));
    IHonkVerifier verifier = IHonkVerifier(address(honk));
    IVotesToken blockClock = IVotesToken(address(new BlockNumberClockToken()));
    IVotesToken noClock = IVotesToken(address(new NoClockToken()));

    vm.expectRevert(CrispGnosisVoting.InvalidAmb.selector);
    new CrispGnosisVoting(IAMB(address(0)), interfold, program, votes, verifier, signer, 0);
    vm.expectRevert(CrispGnosisVoting.InterfoldAddressZero.selector);
    new CrispGnosisVoting(amb, address(0), program, votes, verifier, signer, 0);
    vm.expectRevert(CrispGnosisVoting.ProgramAddressZero.selector);
    new CrispGnosisVoting(amb, interfold, address(0), votes, verifier, signer, 0);
    vm.expectRevert(CrispGnosisVoting.InvalidVerifier.selector);
    new CrispGnosisVoting(amb, interfold, program, votes, IHonkVerifier(address(0)), signer, 0);
    vm.expectRevert(CrispGnosisVoting.InputAvailabilitySignerAddressZero.selector);
    new CrispGnosisVoting(amb, interfold, program, votes, verifier, address(0), 0);
    vm.expectRevert(CrispGnosisVoting.InvalidToken.selector);
    new CrispGnosisVoting(amb, interfold, program, IVotesToken(makeAddr("eoa")), verifier, signer, 0);
    vm.expectRevert(CrispGnosisVoting.InvalidToken.selector);
    new CrispGnosisVoting(amb, interfold, program, blockClock, verifier, signer, 0);
    vm.expectRevert(CrispGnosisVoting.InvalidToken.selector);
    new CrispGnosisVoting(amb, interfold, program, noClock, verifier, signer, 0);
  }

  // ---------------------------------------------------------------------------------------------
  // receiveMessage: authentication
  // ---------------------------------------------------------------------------------------------

  function test_onlyTheHomeAmbMayDeliver() public {
    bytes memory message = CRISPGnosisMessages.round(_roundMessage(ROUND_ID));
    vm.expectRevert(CrispGnosisVoting.NotAMB.selector);
    voting.receiveMessage(message);

    vm.prank(program);
    vm.expectRevert(CrispGnosisVoting.NotAMB.selector);
    voting.receiveMessage(message);
  }

  function test_onlyTheProgramMayBeTheSender() public {
    bytes memory message = CRISPGnosisMessages.round(_roundMessage(ROUND_ID));
    _asAmb(makeAddr("impostor"));
    vm.expectRevert(CrispGnosisVoting.WrongRemoteSender.selector);
    voting.receiveMessage(message);

    // Through the bridge: the call reverts inside, the message is consumed with status = false and nothing opens.
    bytes memory encoded = abi.encode(
      bytes32(uint256(99)),
      makeAddr("impostor"),
      address(voting),
      uint256(1_000_000),
      abi.encodeCall(IGnosisReceiver.receiveMessage, (message))
    );
    home.executeAffirmation(encoded);
    assertEq(voting.roundOf(ROUND_ID).plaintextModulus, 0);
  }

  function test_receiveRefusesKindsThatAreNotForTheVotingContract() public {
    // 0 and unknown kinds, and ROOT (3), which only the program receives.
    uint256[4] memory kinds = [uint256(0), 3, 5, 100];
    for (uint256 i = 0; i < kinds.length; i++) {
      _asAmb(program);
      vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.InvalidKind.selector, kinds[i]));
      voting.receiveMessage(abi.encode(kinds[i], uint256(1), uint256(1)));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // ROUND
  // ---------------------------------------------------------------------------------------------

  function test_roundOpensTheRoundAndFixesTheElectorate() public {
    uint256 supply = token.getPastTotalSupply(T0 + 50);
    vm.expectEmit(true, false, false, true, address(voting));
    emit CrispGnosisVoting.RoundOpened(ROUND_ID, INPUT_START, INPUT_END, T0 + 50, supply / PLAINTEXT_MODULUS + 1, PROPOSAL_HASH, requester, CID);
    assertTrue(_deliver(CRISPGnosisMessages.round(_roundMessage(ROUND_ID))));

    ICrispVoting.Round memory round = voting.roundOf(ROUND_ID);
    assertEq(round.inputStart, INPUT_START);
    assertEq(round.inputEnd, INPUT_END);
    assertEq(round.inputLimit, 65_536);
    assertEq(round.numOptions, 3);
    assertEq(round.snapshot, T0 + 50);
    assertEq(round.divisor, supply / PLAINTEXT_MODULUS + 1);
    assertEq(round.plaintextModulus, PLAINTEXT_MODULUS);
    assertEq(round.committeeKey, bytes32(0));
    assertEq(round.proposalHash, PROPOSAL_HASH);
    assertEq(round.requester, requester);
    assertFalse(round.closed);
    assertEq(round.numInputs, 0);
    assertEq(round.metadataCid, CID);
    assertEq(voting.proposalHashOf(ROUND_ID), PROPOSAL_HASH);
    assertEq(voting.divisorOf(ROUND_ID), supply / PLAINTEXT_MODULUS + 1);
  }

  function test_aDuplicateRoundIsIgnored() public {
    assertTrue(_deliver(CRISPGnosisMessages.round(_roundMessage(ROUND_ID))));

    CRISPGnosisMessages.RoundMessage memory other = _roundMessage(ROUND_ID);
    other.proposalHash = keccak256("another batch");
    other.inputEnd += 1 days;
    // Authentic, accepted (no revert), and a no-op.
    assertTrue(_deliver(CRISPGnosisMessages.round(other)));

    assertEq(voting.proposalHashOf(ROUND_ID), PROPOSAL_HASH);
    assertEq(voting.roundOf(ROUND_ID).inputEnd, INPUT_END);
  }

  function test_theSnapshotIsClampedToThePastOfTheClock() public {
    // The AMB delivers before Chiado's clock passed the Sepolia timestamp (skew): `getPastTotalSupply` would revert.
    CRISPGnosisMessages.RoundMessage memory m = _roundMessage(ROUND_ID);
    m.snapshot = block.timestamp + 5 minutes;
    assertTrue(_deliver(CRISPGnosisMessages.round(m)));
    assertEq(voting.roundOf(ROUND_ID).snapshot, block.timestamp - 1);

    // A snapshot already in the past is kept.
    m = _roundMessage(8);
    m.snapshot = block.timestamp - 10;
    assertTrue(_deliver(CRISPGnosisMessages.round(m)));
    assertEq(voting.roundOf(8).snapshot, block.timestamp - 10);
  }

  function test_theDivisorIsSupplyOverTPlusOne() public {
    // Supply 15,000,000.5 tokens over t = 17,000,000: just under one token per ballot unit, plus one.
    assertTrue(_deliver(CRISPGnosisMessages.round(_roundMessage(ROUND_ID))));
    uint256 divisor = voting.divisorOf(ROUND_ID);
    assertEq(divisor, 15_000_001.5e18 / PLAINTEXT_MODULUS + 1);
    // The weights that follow: alice 10M / 0.88 ~ 11.3M units, bob 5.67M, carol 1, dave below the floor.
    assertEq(voting.votingPowerOf(_e3Id(ROUND_ID), alice), 10_000_000e18 / divisor);
    assertEq(voting.votingPowerOf(_e3Id(ROUND_ID), bob), 5_000_000e18 / divisor);
    assertEq(voting.votingPowerOf(_e3Id(ROUND_ID), carol), 1);
    assertEq(voting.votingPowerOf(_e3Id(ROUND_ID), dave), 0);
  }

  function test_aRoundWithoutAPlaintextModulusCannotOpen() public {
    CRISPGnosisMessages.RoundMessage memory m = _roundMessage(ROUND_ID);
    m.plaintextModulus = 0;
    // The program refuses to build it; if one arrived anyway it must not open a round that "does not exist" by sentinel.
    assertFalse(_deliver(CRISPGnosisMessages.round(m)));
    assertEq(voting.roundOf(ROUND_ID).plaintextModulus, 0);
  }

  // ---------------------------------------------------------------------------------------------
  // KEY and RESULT
  // ---------------------------------------------------------------------------------------------

  function test_keyIsStoredOnceAndTheFirstWins() public {
    assertTrue(_deliver(CRISPGnosisMessages.round(_roundMessage(ROUND_ID))));

    vm.expectEmit(true, false, false, true, address(voting));
    emit CrispGnosisVoting.CommitteeKeyPublished(ROUND_ID, COMMITTEE_KEY);
    assertTrue(_deliver(CRISPRemoteMessages.committeeKey(ROUND_ID, COMMITTEE_KEY)));
    assertEq(voting.roundOf(ROUND_ID).committeeKey, COMMITTEE_KEY);

    assertTrue(_deliver(CRISPRemoteMessages.committeeKey(ROUND_ID, keccak256("other"))));
    assertEq(voting.roundOf(ROUND_ID).committeeKey, COMMITTEE_KEY);
  }

  /// @dev The messages travel independently: a KEY that lands before its ROUND must not revert (it would be lost).
  function test_keyBeforeRoundIsKeptAndTheRoundBecomesVotable() public {
    vm.expectEmit(true, false, false, true, address(voting));
    emit CrispGnosisVoting.CommitteeKeyPublished(ROUND_ID, COMMITTEE_KEY);
    assertTrue(_deliver(CRISPRemoteMessages.committeeKey(ROUND_ID, COMMITTEE_KEY)));
    // Still not a round.
    assertEq(voting.roundOf(ROUND_ID).plaintextModulus, 0);

    assertTrue(_deliver(CRISPGnosisMessages.round(_roundMessage(ROUND_ID))));
    ICrispVoting.Round memory round = voting.roundOf(ROUND_ID);
    assertEq(round.committeeKey, COMMITTEE_KEY);
    assertEq(round.proposalHash, PROPOSAL_HASH);

    vm.warp(INPUT_START + 10);
    _publish(_e3Id(ROUND_ID), alice, 1);
    assertEq(voting.roundOf(ROUND_ID).numInputs, 1);

    // A later duplicate KEY changes nothing.
    assertTrue(_deliver(CRISPRemoteMessages.committeeKey(ROUND_ID, keccak256("other"))));
    assertEq(voting.roundOf(ROUND_ID).committeeKey, COMMITTEE_KEY);
  }

  function test_resultIsStoredOnceWithItsTimestamp() public {
    assertTrue(_deliver(CRISPGnosisMessages.round(_roundMessage(ROUND_ID))));
    uint256[] memory tally = new uint256[](3);
    tally[0] = 500;
    tally[1] = 300;
    tally[2] = 7;

    ICrispVoting.Result memory before_ = voting.resultOf(ROUND_ID);
    assertFalse(before_.resolved);

    vm.warp(INPUT_END + 123);
    vm.expectEmit(true, false, false, true, address(voting));
    emit CrispGnosisVoting.ResultReceived(ROUND_ID, tally);
    assertTrue(_deliver(CRISPGnosisMessages.result(ROUND_ID, tally)));

    ICrispVoting.Result memory result = voting.resultOf(ROUND_ID);
    assertTrue(result.resolved);
    assertEq(result.resolvedAt, INPUT_END + 123);
    assertEq(result.tally, tally);

    // A duplicate is ignored, not overwritten.
    vm.warp(INPUT_END + 999);
    uint256[] memory other = new uint256[](3);
    other[0] = 1;
    assertTrue(_deliver(CRISPGnosisMessages.result(ROUND_ID, other)));
    result = voting.resultOf(ROUND_ID);
    assertEq(result.resolvedAt, INPUT_END + 123);
    assertEq(result.tally, tally);
  }

  function test_resultForAnUnknownRoundReverts() public {
    uint256[] memory tally = new uint256[](3);
    _asAmb(program);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.UnknownRound.selector, ROUND_ID));
    voting.receiveMessage(CRISPGnosisMessages.result(ROUND_ID, tally));
  }

  // ---------------------------------------------------------------------------------------------
  // publishInput: round state and window
  // ---------------------------------------------------------------------------------------------

  function test_publishRequiresAKnownKeyedRound() public {
    uint256 e3Id = _e3Id(ROUND_ID);
    bytes memory data = _data(e3Id, alice, bytes32(uint256(1)), bytes32(uint256(2)), 0, uint64(T0 + 1 days), signerKey);

    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.UnknownRound.selector, ROUND_ID));
    voting.publishInput(e3Id, data);

    assertTrue(_deliver(CRISPGnosisMessages.round(_roundMessage(ROUND_ID))));
    vm.warp(INPUT_START + 10);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.KeyNotReceived.selector, ROUND_ID));
    voting.publishInput(e3Id, data);
  }

  function test_publishRejectsAnotherInterfoldsE3Id() public {
    _openAndStart();
    uint256 foreign = (uint256(uint160(makeAddr("other interfold"))) << 96) | ROUND_ID;
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.WrongInterfold.selector, foreign));
    voting.publishInput(foreign, hex"01");
    // A bare round id (no interfold prefix) is not an e3Id.
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.WrongInterfold.selector, ROUND_ID));
    voting.publishInput(ROUND_ID, hex"01");
  }

  function test_theInputWindowIsStartInclusiveEndExclusive() public {
    _openRound(ROUND_ID);
    uint256 e3Id = _e3Id(ROUND_ID);

    vm.warp(INPUT_START - 1);
    bytes memory early = _data(e3Id, alice, bytes32(uint256(1)), bytes32(uint256(2)), 0, uint64(INPUT_END + 1 days), signerKey);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.InputWindowNotOpen.selector, e3Id, INPUT_START));
    voting.publishInput(e3Id, early);

    vm.warp(INPUT_START);
    _publish(e3Id, alice, 1);

    vm.warp(INPUT_END - 1);
    _publish(e3Id, alice, 2);

    vm.warp(INPUT_END);
    bytes memory late = _data(e3Id, alice, bytes32(uint256(3)), bytes32(uint256(4)), 0, uint64(INPUT_END + 1 days), signerKey);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.InputWindowClosed.selector, e3Id, INPUT_END));
    voting.publishInput(e3Id, late);
  }

  function test_theInputLimitCountsEveryInput() public {
    CRISPGnosisMessages.RoundMessage memory m = _roundMessage(ROUND_ID);
    m.inputLimit = 2;
    assertTrue(_deliver(CRISPGnosisMessages.round(m)));
    assertTrue(_deliver(CRISPRemoteMessages.committeeKey(ROUND_ID, COMMITTEE_KEY)));
    vm.warp(INPUT_START + 10);
    uint256 e3Id = _e3Id(ROUND_ID);

    _publish(e3Id, alice, 1);
    _publish(e3Id, bob, 2);
    bytes memory third = _data(e3Id, carol, bytes32(uint256(5)), bytes32(uint256(6)), 0, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.InputLimitReached.selector, e3Id, 2));
    voting.publishInput(e3Id, third);
  }

  function test_emptyInputDataIsRefused() public {
    uint256 e3Id = _openAndStart();
    vm.expectRevert(CrispGnosisVoting.EmptyInputData.selector);
    voting.publishInput(e3Id, "");
  }

  // ---------------------------------------------------------------------------------------------
  // publishInput: attestation
  // ---------------------------------------------------------------------------------------------

  function test_attestationMustBeFromTheServerKey() public {
    uint256 e3Id = _openAndStart();
    bytes memory data = _data(e3Id, alice, bytes32(uint256(1)), bytes32(uint256(2)), 0, uint64(block.timestamp + 1 hours), 0xBAD);
    vm.expectRevert(CrispGnosisVoting.InvalidInputAvailabilityAttestation.selector);
    voting.publishInput(e3Id, data);
  }

  function test_attestationBindsTheInput() public {
    uint256 e3Id = _openAndStart();
    uint64 expiresAt = uint64(block.timestamp + 1 hours);
    // Signed for one commitment, presented with another.
    bytes32 id = voting.inputId(e3Id, bytes32(uint256(2)), bytes32(uint256(1)), alice, 0);
    bytes memory attestation = _attestation(e3Id, id, expiresAt, signerKey);
    bytes memory swapped = abi.encode(bytes("proof"), alice, bytes32(uint256(99)), bytes32(uint256(2)), uint40(0), expiresAt, attestation);
    vm.expectRevert(CrispGnosisVoting.InvalidInputAvailabilityAttestation.selector);
    voting.publishInput(e3Id, swapped);

    // Signed for another round.
    CRISPGnosisMessages.RoundMessage memory m = _roundMessage(8);
    assertTrue(_deliver(CRISPGnosisMessages.round(m)));
    bytes memory elsewhere = abi.encode(
      bytes("proof"),
      alice,
      bytes32(uint256(1)),
      bytes32(uint256(2)),
      uint40(0),
      expiresAt,
      _attestation(_e3Id(8), id, expiresAt, signerKey)
    );
    vm.expectRevert(CrispGnosisVoting.InvalidInputAvailabilityAttestation.selector);
    voting.publishInput(e3Id, elsewhere);
  }

  function test_expiredAttestationIsRefusedAtTheBoundary() public {
    uint256 e3Id = _openAndStart();
    uint64 expiresAt = uint64(block.timestamp + 100);
    bytes memory data = _data(e3Id, alice, bytes32(uint256(1)), bytes32(uint256(2)), 0, expiresAt, signerKey);

    vm.warp(expiresAt - 1);
    voting.publishInput(e3Id, data);

    bytes memory second = _data(e3Id, alice, bytes32(uint256(3)), bytes32(uint256(4)), 0, expiresAt, signerKey);
    vm.warp(expiresAt);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.InputAvailabilityAttestationExpired.selector, expiresAt));
    voting.publishInput(e3Id, second);
  }

  function test_malformedAttestationIsRefused() public {
    uint256 e3Id = _openAndStart();
    uint64 expiresAt = uint64(block.timestamp + 1 hours);
    bytes memory data = abi.encode(bytes("proof"), alice, bytes32(uint256(1)), bytes32(uint256(2)), uint40(0), expiresAt, bytes("short"));
    vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 5));
    voting.publishInput(e3Id, data);
  }

  function test_aZeroEncryptedVoteHashIsRefused() public {
    uint256 e3Id = _openAndStart();
    bytes memory data = _data(e3Id, alice, bytes32(uint256(1)), bytes32(0), 0, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(CrispGnosisVoting.ZeroEncryptedVoteHash.selector);
    voting.publishInput(e3Id, data);
  }

  function test_anInputCannotBePublishedTwice() public {
    uint256 e3Id = _openAndStart();
    bytes32 commitment = bytes32(uint256(1));
    bytes32 voteHash = bytes32(uint256(2));
    _publish(e3Id, alice, commitment, voteHash, 0);

    bytes32 id = voting.inputId(e3Id, voteHash, commitment, alice, 0);
    bytes memory again = _data(e3Id, alice, commitment, voteHash, 0, uint64(block.timestamp + 2 hours), signerKey);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.InputAlreadyCommitted.selector, id));
    voting.publishInput(e3Id, again);
    assertTrue(voting.isInputCommitted(e3Id, voteHash, commitment, alice, 0));
    assertFalse(voting.isInputCommitted(e3Id, voteHash, commitment, bob, 0));
  }

  // ---------------------------------------------------------------------------------------------
  // publishInput: eligibility (census)
  // ---------------------------------------------------------------------------------------------

  function test_aSlotBelowTheDivisorFloorIsNotEligible() public {
    uint256 e3Id = _openAndStart();
    bytes memory data = _data(e3Id, dave, bytes32(uint256(1)), bytes32(uint256(2)), 0, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(CrispGnosisVoting.SlotNotEligible.selector);
    voting.publishInput(e3Id, data);

    // Carol holds just over one divisor: one ballot unit.
    _publish(e3Id, carol, 1);
  }

  function test_theCensusIsThePastVotesAtTheSnapshot() public {
    // Round opens with its snapshot at T0 + 50; a holder who only gets tokens afterwards has no vote in it.
    vm.warp(T0 + 60);
    address latecomer = makeAddr("latecomer");
    _fund(latecomer, 1_000_000e18);
    // Alice moves everything away after the snapshot; she still votes with what she held at it.
    vm.prank(alice);
    token.transfer(latecomer, 10_000_000e18);

    vm.warp(T0 + 100);
    uint256 e3Id = _openAndStart();
    assertEq(voting.roundOf(ROUND_ID).snapshot, T0 + 50);

    bytes memory data = _data(e3Id, latecomer, bytes32(uint256(1)), bytes32(uint256(2)), 0, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(CrispGnosisVoting.SlotNotEligible.selector);
    voting.publishInput(e3Id, data);

    _publish(e3Id, alice, 2);
    assertEq(voting.votingPowerOf(e3Id, alice), 10_000_000e18 / voting.divisorOf(ROUND_ID));
    assertEq(voting.votingPowerOf(e3Id, latecomer), 0);
  }

  function test_undelegatedTokensHaveNoVotingPower() public {
    address undelegated = makeAddr("undelegated");
    vm.prank(owner);
    token.mintTreasury(undelegated, 5_000_000e18);
    vm.warp(T0 + 100);
    uint256 e3Id = _openAndStart();
    assertEq(voting.votingPowerOf(e3Id, undelegated), 0);
    bytes memory data = _data(e3Id, undelegated, bytes32(uint256(1)), bytes32(uint256(2)), 0, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(CrispGnosisVoting.SlotNotEligible.selector);
    voting.publishInput(e3Id, data);
  }

  function test_minVotingPowerRaisesTheFloor() public {
    _deployVoting(2e18);
    uint256 e3Id = _openAndStart();
    // Carol (1 token) has weight 1 without the floor and none with it; bob clears it.
    assertEq(voting.votingPowerOf(e3Id, carol), 0);
    assertGt(voting.votingPowerOf(e3Id, bob), 0);

    bytes memory data = _data(e3Id, carol, bytes32(uint256(1)), bytes32(uint256(2)), 0, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(CrispGnosisVoting.SlotNotEligible.selector);
    voting.publishInput(e3Id, data);
    _publish(e3Id, bob, 2);
  }

  function test_votingPowerIsZeroForUnknownRoundsAndForeignE3Ids() public {
    assertEq(voting.votingPowerOf(_e3Id(ROUND_ID), alice), 0);
    _openRound(ROUND_ID);
    assertGt(voting.votingPowerOf(_e3Id(ROUND_ID), alice), 0);
    assertEq(voting.votingPowerOf((uint256(uint160(makeAddr("x"))) << 96) | ROUND_ID, alice), 0);
  }

  // ---------------------------------------------------------------------------------------------
  // publishInput: parent chain, proof, public inputs
  // ---------------------------------------------------------------------------------------------

  function test_aParentMustBeAnEntryOfTheSameSlot() public {
    uint256 e3Id = _openAndStart();
    _publish(e3Id, alice, keccak256("alice first"), keccak256("alice first vote"), 0);

    // Index 0 belongs to alice; bob never wrote there.
    bytes memory bobs = _data(e3Id, bob, bytes32(uint256(7)), bytes32(uint256(8)), 1, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.UnknownParentInput.selector, 0));
    voting.publishInput(e3Id, bobs);

    // Alice naming an index she never wrote (1 is the next leaf, 5 is far).
    bytes memory ahead = _data(e3Id, alice, bytes32(uint256(7)), bytes32(uint256(8)), 5, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.UnknownParentInput.selector, 4));
    voting.publishInput(e3Id, ahead);

    // Naming no parent is always allowed, and so is naming her own entry.
    _publish(e3Id, alice, keccak256("alice again"), keccak256("alice again vote"), 0);
    _publish(e3Id, alice, keccak256("alice revote"), keccak256("alice revote vote"), 1);
  }

  function test_theProofIsCalledWithTheNineCircuitPublicInputs() public {
    uint256 e3Id = _openAndStart();
    bytes32 commitment = keccak256("c0");
    bytes32 voteHash = keccak256("v0");
    uint256 weight = voting.votingPowerOf(e3Id, alice);
    uint256 digest = uint256(voting.ballotDigest(e3Id, alice, commitment));

    bytes32[] memory publicInputs = new bytes32[](9);
    publicInputs[0] = bytes32(0); // no parent
    publicInputs[1] = bytes32(digest >> 128);
    publicInputs[2] = bytes32(digest & type(uint128).max);
    publicInputs[3] = bytes32(uint256(uint160(alice)));
    publicInputs[4] = bytes32(weight);
    publicInputs[5] = bytes32(uint256(1)); // first entry of the slot
    publicInputs[6] = bytes32(uint256(3));
    publicInputs[7] = commitment;
    publicInputs[8] = COMMITTEE_KEY;
    vm.expectCall(address(honk), abi.encodeCall(IHonkVerifier.verify, (bytes("noir proof"), publicInputs)));
    _publish(e3Id, alice, commitment, voteHash, 0);

    // A re-vote carries its parent's commitment and is not a first entry.
    bytes32 next = keccak256("c1");
    digest = uint256(voting.ballotDigest(e3Id, alice, next));
    publicInputs[0] = commitment;
    publicInputs[1] = bytes32(digest >> 128);
    publicInputs[2] = bytes32(digest & type(uint128).max);
    publicInputs[5] = bytes32(0);
    publicInputs[7] = next;
    vm.expectCall(address(honk), abi.encodeCall(IHonkVerifier.verify, (bytes("noir proof"), publicInputs)));
    _publish(e3Id, alice, next, keccak256("v1"), 1);
  }

  function test_aFailedProofIsRefused() public {
    uint256 e3Id = _openAndStart();
    // The mock rejects any key other than the expected one.
    honk.setExpectedPublicKey(keccak256("another key"));
    bytes memory data = _data(e3Id, alice, bytes32(uint256(1)), bytes32(uint256(2)), 0, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(CrispGnosisVoting.InvalidNoirProof.selector);
    voting.publishInput(e3Id, data);

    honk.setExpectedPublicKey(COMMITTEE_KEY);
    voting.publishInput(e3Id, data);
  }

  function test_anyoneMayRelayAnInput() public {
    uint256 e3Id = _openAndStart();
    bytes memory data = _data(e3Id, alice, bytes32(uint256(1)), bytes32(uint256(2)), 0, uint64(block.timestamp + 1 hours), signerKey);
    vm.prank(makeAddr("relayer"));
    voting.publishInput(e3Id, data);
    assertEq(voting.roundOf(ROUND_ID).numInputs, 1);
  }

  function test_publishRecordsTheInputAndEmitsIt() public {
    uint256 e3Id = _openAndStart();
    bytes32 commitment = keccak256("c0");
    bytes32 voteHash = keccak256("v0");
    bytes32 id = voting.inputId(e3Id, voteHash, commitment, alice, 0);

    vm.expectEmit(true, true, true, true, address(voting));
    emit CrispGnosisVoting.InputCommitted(e3Id, id, alice, commitment, voteHash, 0, 0);
    _publish(e3Id, alice, commitment, voteHash, 0);

    assertEq(voting.inputCommitmentOf(e3Id, alice, 0), commitment);
    assertEq(voting.inputCommitmentOf(e3Id, alice, 1), bytes32(0));
    assertEq(voting.roundOf(ROUND_ID).numInputs, 1);

    vm.expectEmit(true, true, true, true, address(voting));
    emit CrispGnosisVoting.InputCommitted(e3Id, voting.inputId(e3Id, keccak256("v1"), keccak256("c1"), bob, 0), bob, keccak256("c1"), keccak256("v1"), 0, 1);
    _publish(e3Id, bob, keccak256("c1"), keccak256("v1"), 0);
    assertEq(voting.roundOf(ROUND_ID).numInputs, 2);
  }

  function test_validateInputProofIsTheDryRunWithoutTheAttestation() public {
    uint256 e3Id = _openAndStart();
    assertTrue(voting.validateInputProof(e3Id, "noir proof", alice, bytes32(uint256(1)), bytes32(uint256(2)), 0));
    assertEq(voting.roundOf(ROUND_ID).numInputs, 0);

    vm.expectRevert(CrispGnosisVoting.SlotNotEligible.selector);
    voting.validateInputProof(e3Id, "noir proof", dave, bytes32(uint256(1)), bytes32(uint256(2)), 0);
    vm.expectRevert(CrispGnosisVoting.ZeroEncryptedVoteHash.selector);
    voting.validateInputProof(e3Id, "noir proof", alice, bytes32(uint256(1)), bytes32(0), 0);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.UnknownParentInput.selector, 2));
    voting.validateInputProof(e3Id, "noir proof", alice, bytes32(uint256(1)), bytes32(uint256(2)), 3);

    honk.setExpectedPublicKey(keccak256("another key"));
    vm.expectRevert(CrispGnosisVoting.InvalidNoirProof.selector);
    voting.validateInputProof(e3Id, "noir proof", alice, bytes32(uint256(1)), bytes32(uint256(2)), 0);
  }

  // ---------------------------------------------------------------------------------------------
  // digests
  // ---------------------------------------------------------------------------------------------

  function test_digestsAreEip712OverThisContract() public view {
    bytes32 domain = keccak256(
      abi.encode(
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        keccak256("CRISP"),
        keccak256("1"),
        block.chainid,
        address(voting)
      )
    );
    uint256 e3Id = _e3Id(ROUND_ID);
    bytes32 commitment = keccak256("c");

    bytes32 ballot = keccak256(abi.encode(keccak256("Ballot(uint256 e3Id,address slot,bytes32 ciphertextCommitment)"), e3Id, alice, commitment));
    assertEq(voting.ballotDigest(e3Id, alice, commitment), keccak256(abi.encodePacked("\x19\x01", domain, ballot)));

    bytes32 id = keccak256("id");
    bytes32 availability = keccak256(
      abi.encode(keccak256("InputAvailability(uint256 e3Id,bytes32 inputId,uint64 expiresAt)"), e3Id, id, uint64(1234))
    );
    assertEq(voting.inputAvailabilityDigest(e3Id, id, 1234), keccak256(abi.encodePacked("\x19\x01", domain, availability)));
  }

  function test_inputIdAndLeafMatchTheCrispProgramFormulas() public view {
    uint256 e3Id = _e3Id(ROUND_ID);
    bytes32 voteHash = keccak256("v");
    bytes32 commitment = keccak256("c");
    assertEq(voting.inputId(e3Id, voteHash, commitment, alice, 3), keccak256(abi.encode("CRISP_INPUT_V1", address(voting), e3Id, voteHash, commitment, alice, uint40(3))));
    // The leaf is SHA-256 over the packed fields, reduced into the field.
    uint256 leaf = uint256(sha256(abi.encodePacked(voteHash, commitment, alice, uint40(3))));
    assertEq(voting.inputLeaf(voteHash, commitment, alice, 3), leaf % 21888242871839275222246405745257275088548364400416034343698204186575808495617);
  }

  // ---------------------------------------------------------------------------------------------
  // closeRound
  // ---------------------------------------------------------------------------------------------

  function test_closeRoundSendsTheRootOfTheTreeToTheProgram() public {
    uint256 e3Id = _openAndStart();
    _publish(e3Id, alice, 1);
    _publish(e3Id, bob, 2);
    _publish(e3Id, carol, 3);

    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.InputWindowStillOpen.selector, ROUND_ID, INPUT_END));
    voting.closeRound(ROUND_ID);

    vm.warp(INPUT_END);
    vm.recordLogs();
    vm.prank(makeAddr("anyone"));
    voting.closeRound(ROUND_ID);
    Vm.Log[] memory logs = vm.getRecordedLogs();

    (uint256 root, uint256 numInputs) = _closed(logs);
    assertEq(numInputs, 3);
    assertGt(root, 0);
    assertTrue(voting.roundOf(ROUND_ID).closed);

    bool sent;
    for (uint256 i = 0; i < logs.length; i++) {
      if (logs[i].emitter == address(home) && logs[i].topics[0] == MockAMB.MockMessage.selector) {
        sent = true;
        assertEq(address(uint160(uint256(logs[i].topics[1]))), address(voting));
        assertEq(address(uint160(uint256(logs[i].topics[2]))), program);
        (bytes memory data, uint256 gas) = abi.decode(logs[i].data, (bytes, uint256));
        assertEq(gas, voting.ROOT_GAS());
        assertEq(data, abi.encodeCall(IGnosisReceiver.receiveMessage, (CRISPRemoteMessages.inputRoot(ROUND_ID, root, 3))));
      }
    }
    assertTrue(sent);

    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.RoundAlreadyClosed.selector, ROUND_ID));
    voting.closeRound(ROUND_ID);
  }

  function test_closeRoundRefusesUnknownAndEmptyRounds() public {
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.UnknownRound.selector, ROUND_ID));
    voting.closeRound(ROUND_ID);

    _openRound(ROUND_ID);
    vm.warp(INPUT_END);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.NoInputs.selector, ROUND_ID));
    voting.closeRound(ROUND_ID);
  }

  function test_theRootCommitsToTheLeavesInOrder() public {
    uint256 e3Id = _openAndStart();
    _publish(e3Id, alice, 1);
    _publish(e3Id, bob, 2);
    vm.warp(INPUT_END);
    vm.recordLogs();
    voting.closeRound(ROUND_ID);
    (uint256 rootAB, ) = _closed(vm.getRecordedLogs());

    _deployVoting(0);
    e3Id = _openAndStart();
    _publish(e3Id, bob, 2);
    _publish(e3Id, alice, 1);
    vm.warp(INPUT_END);
    vm.recordLogs();
    voting.closeRound(ROUND_ID);
    (uint256 rootBA, ) = _closed(vm.getRecordedLogs());

    assertTrue(rootAB != rootBA);
  }

  /// @dev A round is the full path: ROUND and KEY from Sepolia, votes, a ROOT back (carried by the mock AMB).
  function test_noBallotAfterTheRoundIsClosed() public {
    uint256 e3Id = _openAndStart();
    _publish(e3Id, alice, 1);
    vm.warp(INPUT_END);
    voting.closeRound(ROUND_ID);
    bytes memory data = _data(e3Id, alice, bytes32(uint256(100)), bytes32(uint256(101)), 0, uint64(block.timestamp + 1 hours), signerKey);
    vm.expectRevert(abi.encodeWithSelector(CrispGnosisVoting.InputWindowClosed.selector, e3Id, INPUT_END));
    voting.publishInput(e3Id, data);
  }
}
