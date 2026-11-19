// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC6372 } from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import { LazyIMTData, InternalLazyIMT } from "@zk-kit/lazy-imt.sol/InternalLazyIMT.sol";
import { SNARK_SCALAR_FIELD } from "@zk-kit/lazy-imt.sol/Constants.sol";
import { IHonkVerifier } from "@crisp-e3/contracts/contracts/interfaces/IHonkVerifier.sol";
import { IVotesToken } from "@crisp-e3/contracts/contracts/interfaces/IVotesToken.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { CRISPGnosisMessages } from "../lib/CRISPGnosisMessages.sol";
import { IAMB } from "../interfaces/IAMB.sol";
import { IGnosisReceiver } from "../interfaces/IGnosisReceiver.sol";
import { ICrispVoting } from "../interfaces/ICrispVoting.sol";

/// @title CrispGnosisVoting
/// @notice The Chiado half of a CRISP DAO vote: it holds the ballots of rounds whose E3 (committee, compute, decryption)
/// lives on Sepolia, and carries the Gnosis AMB messages in both directions (see `CRISPGnosisProgram`).
/// @dev The input rules are copied from `CRISPProgram` (without its Interfold, data-availability and OpenVM machinery):
/// {ballotDigest}, {inputAvailabilityDigest}, {inputId}, {inputLeaf}, the LazyIMT, the slot parent chain, the replay guard
/// and the ONCHAIN census (`getPastVotes`, divisor `supply / t + 1`). Because the tree library and the leaf formula are the
/// same, the root is byte-identical to the one the server recomputes from the `InputCommitted` logs.
///
/// Census = voting power of the demo token at `snapshot`, the Sepolia request timestamp minus one: deterministic, not chosen
/// by the proposer, and fixed when the proposal becomes public. Voting power is public (slot and weight are public inputs);
/// only the choice is encrypted.
///
/// Both receivers are idempotent and must not revert on an authentic message, because the AMB does not replay a failed one.
contract CrispGnosisVoting is EIP712, IGnosisReceiver, ICrispVoting {
  using InternalLazyIMT for LazyIMTData;

  /// @dev Round state; `round.numInputs` is filled in by {roundOf} from the tree.
  struct RoundState {
    Round round;
    LazyIMTData votes;
    /// @dev A history per slot, not one head: see `CRISPProgram.RoundData.inputCommitment`.
    mapping(address slot => mapping(uint40 index => bytes32 commitment)) inputCommitment;
    /// @dev {inputId} => tree index plus one. Also the replay guard.
    mapping(bytes32 id => uint40 indexPlusOne) inputs;
  }

  /// @notice The depth of the input Merkle tree.
  uint8 public constant TREE_DEPTH = 20;
  /// @notice AMB gas for the ROOT message sent by {closeRound} (see {CRISPGnosisMessages}).
  uint256 public constant ROOT_GAS = CRISPGnosisMessages.ROOT_GAS;
  bytes32 public constant INPUT_AVAILABILITY_TYPEHASH = keccak256("InputAvailability(uint256 e3Id,bytes32 inputId,uint64 expiresAt)");
  /// @dev The EIP-712 type a voter signs to authorise one ballot; same as `CRISPProgram`.
  bytes32 private constant BALLOT_TYPEHASH = keccak256("Ballot(uint256 e3Id,address slot,bytes32 ciphertextCommitment)");

  /// @notice The Home AMB (Chiado).
  IAMB public immutable amb;
  /// @notice The Sepolia Interfold: only used to rebuild `e3Id = (uint160(interfold) << 96) | roundId`; never called.
  address public immutable interfold;
  /// @notice The Sepolia `CRISPGnosisProgram`: the only sender {receiveMessage} accepts.
  address public immutable program;
  /// @notice The votes token ballots are weighed with.
  IVotesToken public immutable token;
  /// @notice Verifier of the `fold_onchain` Honk proof (`CRISPOnchainVerifier`).
  IHonkVerifier public immutable onchainVerifier;
  /// @notice The server key whose attestation proves the ciphertext of an input is stored.
  address public immutable inputAvailabilitySigner;
  /// @notice The least raw voting power that may cast an input. The effective floor is `max(minVotingPower, divisor)`,
  /// so a slot that clears it always carries at least one ballot unit (and masks stay indistinguishable).
  uint256 public immutable minVotingPower;

  mapping(uint256 roundId => RoundState) internal rounds;
  mapping(uint256 roundId => Result) internal results;

  error NotAMB();
  error WrongRemoteSender();
  error InvalidKind(uint256 kind);
  error InvalidAmb();
  error InterfoldAddressZero();
  error ProgramAddressZero();
  error InvalidToken();
  error InvalidVerifier();
  error InputAvailabilitySignerAddressZero();
  error UnknownRound(uint256 roundId);
  error WrongInterfold(uint256 e3Id);
  error KeyNotReceived(uint256 roundId);
  error InputWindowNotOpen(uint256 e3Id, uint256 inputStart);
  error InputWindowClosed(uint256 e3Id, uint256 inputEnd);
  error InputLimitReached(uint256 e3Id, uint256 limit);
  error EmptyInputData();
  error ZeroEncryptedVoteHash();
  error InputAlreadyCommitted(bytes32 inputId);
  error InputAvailabilityAttestationExpired(uint64 expiresAt);
  error InvalidInputAvailabilityAttestation();
  error SlotNotEligible();
  error UnknownParentInput(uint40 parentIndex);
  error InvalidNoirProof();
  error RoundAlreadyClosed(uint256 roundId);
  error InputWindowStillOpen(uint256 roundId, uint256 inputEnd);
  error NoInputs(uint256 roundId);

  event RoundOpened(
    uint256 indexed roundId,
    uint256 inputStart,
    uint256 inputEnd,
    uint256 snapshot,
    uint256 divisor,
    bytes32 proposalHash,
    address requester,
    string metadataCid
  );
  event CommitteeKeyPublished(uint256 indexed roundId, bytes32 key);
  /// @notice A ballot was accepted into the tree. Same event as `CRISPProgram.InputCommitted`.
  event InputCommitted(
    uint256 indexed e3Id,
    bytes32 indexed inputId,
    address indexed slotAddress,
    bytes32 encryptedVoteCommitment,
    bytes32 encryptedVoteHash,
    uint40 parentIndexPlusOne,
    uint40 index
  );
  event RoundClosed(uint256 indexed roundId, uint256 root, uint256 numInputs);
  event ResultReceived(uint256 indexed roundId, uint256[] tally);

  /// @param _amb Home AMB.
  /// @param _interfold Sepolia Interfold (for e3Id reconstruction only).
  /// @param _program Sepolia `CRISPGnosisProgram`.
  /// @param _token Votes token on the ERC-6372 timestamp clock (checked here).
  /// @param _onchainVerifier `CRISPOnchainVerifier` (linked ZKTranscriptLib and RelationsLib).
  /// @param _inputAvailabilitySigner Address of the server's attestation key.
  /// @param _minVotingPower See {minVotingPower}.
  constructor(
    IAMB _amb,
    address _interfold,
    address _program,
    IVotesToken _token,
    IHonkVerifier _onchainVerifier,
    address _inputAvailabilitySigner,
    uint256 _minVotingPower
  ) EIP712("CRISP", "1") {
    if (address(_amb).code.length == 0) revert InvalidAmb();
    if (_interfold == address(0)) revert InterfoldAddressZero();
    if (_program == address(0)) revert ProgramAddressZero();
    if (address(_onchainVerifier).code.length == 0) revert InvalidVerifier();
    if (_inputAvailabilitySigner == address(0)) revert InputAvailabilitySignerAddressZero();
    // The snapshot is a Sepolia timestamp, so the token must count time, and `clock()` must answer.
    if (address(_token).code.length == 0) revert InvalidToken();
    try IERC6372(address(_token)).CLOCK_MODE() returns (string memory mode) {
      if (keccak256(bytes(mode)) != keccak256("mode=timestamp")) revert InvalidToken();
    } catch {
      revert InvalidToken();
    }
    try IERC6372(address(_token)).clock() returns (uint48) {} catch {
      revert InvalidToken();
    }

    amb = _amb;
    interfold = _interfold;
    program = _program;
    token = _token;
    onchainVerifier = _onchainVerifier;
    inputAvailabilitySigner = _inputAvailabilitySigner;
    minVotingPower = _minVotingPower;
  }

  // ---------------------------------------------------------------------------------------------
  // Inbound (AMB)
  // ---------------------------------------------------------------------------------------------

  /// @notice Receive a message `CRISPGnosisProgram` sent through the AMB: ROUND (1), KEY (2) or RESULT (4).
  /// @dev Only the Home AMB may call, and it must report the program as the Sepolia sender. A duplicate message is ignored;
  /// a kind that is none of the three cannot be authentic.
  function receiveMessage(bytes calldata message) external {
    if (msg.sender != address(amb)) revert NotAMB();
    if (amb.messageSender() != program) revert WrongRemoteSender();

    uint256 kind = abi.decode(message, (uint256));
    if (kind == CRISPGnosisMessages.KIND_ROUND) _openRound(message);
    else if (kind == CRISPGnosisMessages.KIND_KEY) _storeKey(message);
    else if (kind == CRISPGnosisMessages.KIND_RESULT) _storeResult(message);
    else revert InvalidKind(kind);
  }

  /// @dev Records the round and fixes its electorate: the snapshot is clamped to `clock() - 1`, because the AMB (or skew
  /// between the chains) can deliver the message before Chiado's clock has passed the Sepolia timestamp, and `getPast*`
  /// reverts for a timepoint that is not in the past.
  function _openRound(bytes calldata message) internal {
    CRISPGnosisMessages.RoundMessage memory m = CRISPGnosisMessages.decodeRound(message);
    RoundState storage state = rounds[m.roundId];
    if (state.round.plaintextModulus != 0) return;

    uint256 latest = IERC6372(address(token)).clock() - 1;
    uint256 snapshot = m.snapshot < latest ? m.snapshot : latest;
    uint256 divisor = token.getPastTotalSupply(snapshot) / m.plaintextModulus + 1;

    Round storage round = state.round;
    round.inputStart = m.inputStart;
    round.inputEnd = m.inputEnd;
    round.inputLimit = m.inputLimit;
    round.numOptions = m.numOptions;
    round.snapshot = snapshot;
    round.divisor = divisor;
    round.plaintextModulus = m.plaintextModulus;
    round.proposalHash = m.proposalHash;
    round.requester = m.requester;
    round.metadataCid = m.metadataCid;
    state.votes._init(TREE_DEPTH);

    emit RoundOpened(m.roundId, m.inputStart, m.inputEnd, snapshot, divisor, m.proposalHash, m.requester, m.metadataCid);
  }

  function _storeKey(bytes calldata message) internal {
    (, uint256 roundId, bytes32 key) = abi.decode(message, (uint256, uint256, bytes32));
    // Stored even if the ROUND has not arrived: the two messages travel independently and a failed one is not replayable.
    Round storage round = rounds[roundId].round;
    if (round.committeeKey != bytes32(0)) return;

    round.committeeKey = key;
    emit CommitteeKeyPublished(roundId, key);
  }

  function _storeResult(bytes calldata message) internal {
    (uint256 roundId, uint256[] memory tally) = CRISPGnosisMessages.decodeResult(message);
    if (rounds[roundId].round.plaintextModulus == 0) revert UnknownRound(roundId);
    Result storage result = results[roundId];
    if (result.resolved) return;

    result.resolved = true;
    result.resolvedAt = uint64(block.timestamp);
    result.tally = tally;
    emit ResultReceived(roundId, tally);
  }

  // ---------------------------------------------------------------------------------------------
  // Ballots
  // ---------------------------------------------------------------------------------------------

  /// @notice Accept one ballot (a vote, a re-vote or a mask) into the round's tree. Anyone may submit: the proof, the
  /// voter's signature inside it, and the server's attestation authorise the input, not the caller.
  /// @dev Same name and `data` layout as `CRISPProgram.publishInput`, so the relay code is reused:
  /// `abi.encode(bytes noirProof, address slot, bytes32 encryptedVoteCommitment, bytes32 encryptedVoteHash,
  /// uint40 parentIndexPlusOne, uint64 attestationExpiresAt, bytes attestation)`, the attestation being the 65-byte
  /// `r || s || v` ECDSA signature of {inputAvailabilityDigest}.
  ///
  /// Order: window and key, attestation, replay, eligibility, parent, proof; then the leaf is appended. A mask is
  /// indistinguishable from a vote here: every input runs the same digest and the same checks.
  function publishInput(uint256 e3Id, bytes calldata data) external {
    RoundState storage state = _votableRound(e3Id);
    if (data.length == 0) revert EmptyInputData();

    (
      bytes memory noirProof,
      address slotAddress,
      bytes32 commitment,
      bytes32 voteHash,
      uint40 parentIndexPlusOne,
      uint64 expiresAt,
      bytes memory attestation
    ) = abi.decode(data, (bytes, address, bytes32, bytes32, uint40, uint64, bytes));

    bytes32 id = inputId(e3Id, voteHash, commitment, slotAddress, parentIndexPlusOne);
    if (block.timestamp >= expiresAt) revert InputAvailabilityAttestationExpired(expiresAt);
    if (ECDSA.recover(inputAvailabilityDigest(e3Id, id, expiresAt), attestation) != inputAvailabilitySigner) {
      revert InvalidInputAvailabilityAttestation();
    }
    _verifyInput(e3Id, state, id, noirProof, slotAddress, commitment, voteHash, parentIndexPlusOne);

    // Append-only: see `CRISPProgram._processVote`.
    uint40 index = state.votes.numberOfLeaves;
    state.votes._insert(inputLeaf(voteHash, commitment, slotAddress, parentIndexPlusOne));
    state.inputCommitment[slotAddress][index] = commitment;
    state.inputs[id] = index + 1;

    emit InputCommitted(e3Id, id, slotAddress, commitment, voteHash, parentIndexPlusOne, index);
  }

  /// @notice Dry-run of {publishInput} without the attestation: window, limit, replay, eligibility, parent and the full
  /// proof. The server's spam gate, via `eth_call`; changes no state.
  function validateInputProof(
    uint256 e3Id,
    bytes calldata noirProof,
    address slotAddress,
    bytes32 encryptedVoteCommitment,
    bytes32 encryptedVoteHash,
    uint40 parentIndexPlusOne
  ) external view returns (bool) {
    RoundState storage state = _votableRound(e3Id);
    bytes32 id = inputId(e3Id, encryptedVoteHash, encryptedVoteCommitment, slotAddress, parentIndexPlusOne);
    _verifyInput(e3Id, state, id, noirProof, slotAddress, encryptedVoteCommitment, encryptedVoteHash, parentIndexPlusOne);
    return true;
  }

  /// @dev The round of `e3Id`, if it accepts a ballot now: ours, opened, keyed, inside its window and under its limit.
  function _votableRound(uint256 e3Id) internal view returns (RoundState storage state) {
    if (e3Id >> 96 != uint256(uint160(interfold))) revert WrongInterfold(e3Id);
    uint256 roundId = uint96(e3Id);
    state = rounds[roundId];
    Round storage round = state.round;
    if (round.plaintextModulus == 0) revert UnknownRound(roundId);
    if (round.committeeKey == bytes32(0)) revert KeyNotReceived(roundId);
    if (block.timestamp < round.inputStart) revert InputWindowNotOpen(e3Id, round.inputStart);
    if (block.timestamp >= round.inputEnd) revert InputWindowClosed(e3Id, round.inputEnd);
    // Every input, vote or mask, counts toward the limit.
    if (state.votes.numberOfLeaves >= round.inputLimit) revert InputLimitReached(e3Id, round.inputLimit);
  }

  /// @dev Replay, eligibility, parent and proof checks shared by {publishInput} and {validateInputProof}.
  function _verifyInput(
    uint256 e3Id,
    RoundState storage state,
    bytes32 id,
    bytes memory noirProof,
    address slotAddress,
    bytes32 commitment,
    bytes32 voteHash,
    uint40 parentIndexPlusOne
  ) internal view {
    // A zero content hash matches an Avail padding leaf; refused on every path, as in `CRISPProgram`.
    if (voteHash == bytes32(0)) revert ZeroEncryptedVoteHash();
    if (state.inputs[id] != 0) revert InputAlreadyCommitted(id);

    Round storage round = state.round;
    uint256 weight = _weight(round, slotAddress);
    if (weight == 0) revert SlotNotEligible();

    bytes32[] memory publicInputs = new bytes32[](9);
    publicInputs[0] = _parentCommitment(state, slotAddress, parentIndexPlusOne);
    // A Keccak digest does not fit one field element, so it enters the circuit as its two 16-byte halves.
    {
      uint256 digest = uint256(ballotDigest(e3Id, slotAddress, commitment));
      publicInputs[1] = bytes32(digest >> 128);
      publicInputs[2] = bytes32(digest & type(uint128).max);
    }
    publicInputs[3] = bytes32(uint256(uint160(slotAddress)));
    publicInputs[4] = bytes32(weight);
    publicInputs[5] = bytes32(uint256(parentIndexPlusOne == 0 ? 1 : 0));
    publicInputs[6] = bytes32(round.numOptions);
    publicInputs[7] = commitment;
    publicInputs[8] = round.committeeKey;

    if (!onchainVerifier.verify(noirProof, publicInputs)) revert InvalidNoirProof();
  }

  /// @dev The weight a slot may carry: raw voting power at the snapshot over the divisor, or zero below the floor
  /// `max(minVotingPower, divisor)`. The floor is compared against RAW power; the weight is the ballot-unit bound the
  /// circuit enforces.
  function _weight(Round storage round, address slotAddress) internal view returns (uint256) {
    uint256 power = token.getPastVotes(slotAddress, round.snapshot);
    uint256 divisor = round.divisor;
    uint256 floor = minVotingPower > divisor ? minVotingPower : divisor;
    return power < floor ? 0 : power / divisor;
  }

  /// @dev The commitment of the entry an input names as its parent, or zero for none. Same rule as
  /// `CRISPProgram._parentCommitment`: naming no parent is always allowed; naming one the slot never wrote reverts.
  function _parentCommitment(RoundState storage state, address slotAddress, uint40 parentIndexPlusOne) internal view returns (bytes32) {
    if (parentIndexPlusOne == 0) return bytes32(0);

    bytes32 commitment = state.inputCommitment[slotAddress][parentIndexPlusOne - 1];
    if (commitment == bytes32(0)) revert UnknownParentInput(parentIndexPlusOne - 1);
    return commitment;
  }

  // ---------------------------------------------------------------------------------------------
  // Close
  // ---------------------------------------------------------------------------------------------

  /// @notice Close a round after its window and send the ROOT of its tree to Sepolia. Permissionless, once.
  /// @dev A round without inputs cannot be closed: no ROOT is sent, the E3 times out, and the module never executes.
  /// The ROOT is delivered by a keeper (`executeSignatures` on the Foreign AMB).
  function closeRound(uint256 roundId) external {
    RoundState storage state = rounds[roundId];
    Round storage round = state.round;
    if (round.plaintextModulus == 0) revert UnknownRound(roundId);
    if (round.closed) revert RoundAlreadyClosed(roundId);
    if (block.timestamp < round.inputEnd) revert InputWindowStillOpen(roundId, round.inputEnd);
    uint256 numInputs = state.votes.numberOfLeaves;
    if (numInputs == 0) revert NoInputs(roundId);

    round.closed = true;
    uint256 root = state.votes._root();
    amb.requireToPassMessage(
      program,
      abi.encodeCall(IGnosisReceiver.receiveMessage, (CRISPRemoteMessages.inputRoot(roundId, root, numInputs))),
      ROOT_GAS
    );

    emit RoundClosed(roundId, root, numInputs);
  }

  // ---------------------------------------------------------------------------------------------
  // Digests (the SDK reads these; never recompute them client-side)
  // ---------------------------------------------------------------------------------------------

  /// @notice The EIP-712 digest a voter signs to authorise one ballot: binds round, slot and this exact ciphertext.
  function ballotDigest(uint256 e3Id, address slot, bytes32 ciphertextCommitment) public view returns (bytes32) {
    return _hashTypedDataV4(keccak256(abi.encode(BALLOT_TYPEHASH, e3Id, slot, ciphertextCommitment)));
  }

  /// @notice The EIP-712 digest the server signs after it stored the ciphertext of input `id`.
  function inputAvailabilityDigest(uint256 e3Id, bytes32 id, uint64 expiresAt) public view returns (bytes32) {
    return _hashTypedDataV4(keccak256(abi.encode(INPUT_AVAILABILITY_TYPEHASH, e3Id, id, expiresAt)));
  }

  /// @notice Identifier of one input, domain-separated by this contract and the round. Same as `CRISPProgram.inputId`.
  function inputId(
    uint256 e3Id,
    bytes32 encryptedVoteHash,
    bytes32 commitment,
    address slotAddress,
    uint40 parentIndexPlusOne
  ) public view returns (bytes32) {
    return keccak256(abi.encode("CRISP_INPUT_V1", address(this), e3Id, encryptedVoteHash, commitment, slotAddress, parentIndexPlusOne));
  }

  /// @notice The input tree leaf: binds the ciphertext bytes, its commitment, the slot and the parent.
  /// Same as `CRISPProgram.inputLeaf`; SHA-256 because the zkVM accelerates it inline.
  function inputLeaf(
    bytes32 encryptedVoteHash,
    bytes32 commitment,
    address slotAddress,
    uint40 parentIndexPlusOne
  ) public pure returns (uint256) {
    return uint256(sha256(abi.encodePacked(encryptedVoteHash, commitment, slotAddress, parentIndexPlusOne))) % SNARK_SCALAR_FIELD;
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  /// @notice The weight `slot` may carry in the round of `e3Id`, in ballot units (already divided by the divisor); zero when
  /// the round is unknown or the slot is below the floor.
  function votingPowerOf(uint256 e3Id, address slot) external view returns (uint256 weight) {
    Round storage round = rounds[uint96(e3Id)].round;
    if (e3Id >> 96 != uint256(uint160(interfold)) || round.plaintextModulus == 0) return 0;
    return _weight(round, slot);
  }

  /// @notice The commitment of the input at `index` of `slot`, or zero when the slot never wrote there.
  function inputCommitmentOf(uint256 e3Id, address slot, uint256 index) external view returns (bytes32) {
    return rounds[uint96(e3Id)].inputCommitment[slot][uint40(index)];
  }

  /// @notice Whether this exact input was accepted. Lets a relay recover idempotently after a restart.
  function isInputCommitted(
    uint256 e3Id,
    bytes32 encryptedVoteHash,
    bytes32 commitment,
    address slotAddress,
    uint40 parentIndexPlusOne
  ) external view returns (bool) {
    return rounds[uint96(e3Id)].inputs[inputId(e3Id, encryptedVoteHash, commitment, slotAddress, parentIndexPlusOne)] != 0;
  }

  /// @inheritdoc ICrispVoting
  /// @dev All zero for an unknown round (`plaintextModulus == 0`).
  function roundOf(uint256 roundId) external view returns (Round memory round) {
    RoundState storage state = rounds[roundId];
    round = state.round;
    round.numInputs = state.votes.numberOfLeaves;
  }

  /// @inheritdoc ICrispVoting
  function resultOf(uint256 roundId) external view returns (Result memory) {
    return results[roundId];
  }

  /// @inheritdoc ICrispVoting
  function proposalHashOf(uint256 roundId) external view returns (bytes32) {
    return rounds[roundId].round.proposalHash;
  }

  /// @inheritdoc ICrispVoting
  function divisorOf(uint256 roundId) external view returns (uint256) {
    return rounds[roundId].round.divisor;
  }
}
