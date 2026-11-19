// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { IOpenVmReceiptVerifier } from "@interfold/contracts/contracts/interfaces/IOpenVmReceiptVerifier.sol";
import { IDataAvailabilityVerifier } from "@interfold/contracts/contracts/interfaces/IDataAvailabilityVerifier.sol";
import { IInterfold } from "@interfold/contracts/contracts/interfaces/IInterfold.sol";
import { E3 } from "@interfold/contracts/contracts/interfaces/IE3.sol";
import { CRISPRemoteProgram } from "@crisp-e3/extension-core/contracts/CRISPRemoteProgram.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { CRISPGnosisMessages } from "../lib/CRISPGnosisMessages.sol";
import { IAMB } from "../interfaces/IAMB.sol";
import { IGnosisReceiver } from "../interfaces/IGnosisReceiver.sol";

/// @title CRISPGnosisProgram
/// @notice CRISP E3 program whose ballots are cast on Gnosis Chain (see `CrispGnosisVoting`): the Interfold side of a
/// DAO proposal vote, with the Gnosis Arbitrary Message Bridge (AMB) as the transport.
/// @dev Transport and the proposal rules; round logic lives in {CRISPRemoteProgram}.
///
/// Sepolia -> Chiado (automatic, validators affirm): ROUND from {validate}, KEY from `publishCommitteeKey`, RESULT from
/// {relayResult}. Chiado -> Sepolia: ROOT arrives through {receiveMessage}, which only the Foreign AMB may call, and only
/// for a message the Chiado voting contract sent ({remote}). Someone must deliver it (`executeSignatures`).
///
/// A message that fails on the receiving side is NOT replayable, so {receiveMessage} returns silently for a duplicate ROOT.
contract CRISPGnosisProgram is CRISPRemoteProgram, IGnosisReceiver {
  /// @dev `customParams` is `abi.encode(uint8 censusMode, bytes32 censusRoot, uint256 censusTotal, bytes32 proposalHash,
  /// string metadataCid)`. Phase 1 has no census root: `censusMode`, `censusRoot` and `censusTotal` are reserved at zero. They
  /// already travel in ROUND so a later phase changes neither the custom params nor the message.

  /// @notice Longest accepted `metadataCid`, in bytes.
  uint256 public constant MAX_METADATA_CID_LENGTH = 128;
  /// @notice AMB gas for each message kind (see {CRISPGnosisMessages}).
  uint256 public constant ROUND_GAS = CRISPGnosisMessages.ROUND_GAS;
  uint256 public constant KEY_GAS = CRISPGnosisMessages.KEY_GAS;
  uint256 public constant RESULT_GAS = CRISPGnosisMessages.RESULT_GAS;

  /// @notice The Foreign AMB (on the Interfold chain).
  IAMB public immutable foreignAmb;
  /// @notice Extra time added to the worst-case time-to-key, so the KEY message can reach Chiado before voting opens.
  uint256 public immutable ambLatencyMargin;
  /// @notice The `CrispGnosisVoting` contract on Chiado. Set once by the owner; it depends on this program's address (an
  /// immutable of the voting contract), so it cannot be a constructor argument.
  address public remote;
  /// @notice Who may request a proposal round. Owner-managed.
  mapping(address proposer => bool) public isProposer;
  /// @notice Whether the RESULT of an E3 was sent.
  mapping(uint256 e3Id => bool) public resultRelayed;

  error InvalidAmb();
  error RemoteAlreadySet();
  error RemoteNotSet();
  error InvalidRemote();
  error ProposerNotAllowed(address requester);
  /// @notice Phase 1 only supports `censusMode == 0` with `censusRoot == 0` and `censusTotal == 0`.
  error CensusModeNotSupported();
  error InvalidProposalHash();
  error InvalidMetadataCid();
  error InvalidPlaintextModulus();
  error NotAMB();
  error WrongRemoteSender();
  error InvalidKind(uint256 kind);
  error ResultAlreadyRelayed(uint256 e3Id);
  error E3NotComplete(uint256 e3Id, IInterfold.E3Stage stage);

  event RemoteSet(address indexed remote);
  event ProposerSet(address indexed proposer, bool allowed);
  /// @notice A proposal was requested. The batch itself is off-chain: `proposalHash = keccak256(packed MultiSend batch)`
  /// and `metadataCid` points at `{title, description, packedTransactions}`.
  event ProposalCreated(uint256 indexed e3Id, address indexed requester, bytes32 proposalHash, string metadataCid);
  /// @notice The decrypted tally was handed to the AMB for Chiado.
  event ResultRelayed(uint256 indexed e3Id, uint256[] tally);
  /// @notice A message was handed to the AMB.
  event AmbMessageSent(uint256 indexed e3Id, uint256 indexed kind, bytes32 messageId);

  /// @param _foreignAmb The Foreign AMB of the Interfold chain.
  /// @param _ambLatencyMargin Seconds added to the key deadline; see {ambLatencyMargin}.
  /// @dev Remaining parameters: see {CRISPRemoteProgram}.
  constructor(
    address _initialOwner,
    IOpenVmReceiptVerifier _openVmVerifier,
    bytes32 _imageId,
    IDataAvailabilityVerifier _dataAvailabilityVerifier,
    uint256 _minVotingDuration,
    uint256 _remoteFinalityWindow,
    IAMB _foreignAmb,
    uint256 _ambLatencyMargin
  ) CRISPRemoteProgram(_initialOwner, _openVmVerifier, _imageId, _dataAvailabilityVerifier, _minVotingDuration, _remoteFinalityWindow) {
    if (address(_foreignAmb).code.length == 0) revert InvalidAmb();

    foreignAmb = _foreignAmb;
    ambLatencyMargin = _ambLatencyMargin;
  }

  /// @notice Set the `CrispGnosisVoting` contract on Chiado. One time.
  /// @dev Rounds cannot be requested until this is set, because `validate` sends the round to it.
  function setRemote(address _remote) external onlyOwner {
    if (remote != address(0)) revert RemoteAlreadySet();
    if (_remote == address(0)) revert InvalidRemote();

    remote = _remote;
    emit RemoteSet(_remote);
  }

  /// @notice Allow or forbid an account to request proposal rounds. Voting stays open to everyone.
  function setProposer(address proposer, bool allowed) external onlyOwner {
    isProposer[proposer] = allowed;
    emit ProposerSet(proposer, allowed);
  }

  /// @notice Receive a message the Chiado voting contract sent through the AMB: the ROOT of a closed round.
  /// @dev Both checks are what authenticate the message: only the Foreign AMB calls, and it reports the sender it saw on
  /// Chiado. A duplicate ROOT returns silently; any other kind cannot be authentic.
  function receiveMessage(bytes calldata message) external {
    if (msg.sender != address(foreignAmb)) revert NotAMB();
    if (foreignAmb.messageSender() != remote) revert WrongRemoteSender();

    uint256 kind = abi.decode(message, (uint256));
    if (kind != CRISPGnosisMessages.KIND_ROOT) revert InvalidKind(kind);

    (, uint256 roundId, uint256 root, uint256 numInputs) = abi.decode(message, (uint256, uint256, uint256, uint256));
    uint256 e3Id = e3IdOf(roundId);
    if (rounds[e3Id].rootSubmitted) return;

    _acceptInputRoot(e3Id, root, numInputs);
  }

  /// @notice Send the decrypted tally of a completed E3 to Chiado. Permissionless, once.
  /// @dev `Complete` means Interfold's decryption verifier accepted the plaintext, so the tally is chain-derived and the
  /// caller cannot influence it.
  function relayResult(uint256 e3Id) external {
    if (rounds[e3Id].paramsHash == bytes32(0)) revert E3NotAssignedToProgram(e3Id);
    if (resultRelayed[e3Id]) revert ResultAlreadyRelayed(e3Id);
    IInterfold.E3Stage stage = interfold.getE3Stage(e3Id);
    if (stage != IInterfold.E3Stage.Complete) revert E3NotComplete(e3Id, stage);

    resultRelayed[e3Id] = true;
    uint256[] memory tally = decodeTally(e3Id);
    _sendToRemote(e3Id, CRISPGnosisMessages.result(remoteRoundId(e3Id), tally));

    emit ResultRelayed(e3Id, tally);
  }

  /// @notice Scope string; the Gnosis adapter has no identity proofs, so it is informational: `crisp-gnosis:<chainId>:<program>:<e3Id>`.
  function scopeOf(uint256 e3Id) public view override returns (string memory) {
    return
      string.concat("crisp-gnosis:", Strings.toString(block.chainid), ":", Strings.toHexString(address(this)), ":", Strings.toString(e3Id));
  }

  /// @notice Decode and validate the proposal's `customParams` and build the ROUND message.
  /// @dev Reverts before any fee is spent: the requester must be allowed, the census fields must be the phase 1 zeros,
  /// and the proposal must be bound to a hash and a metadata pointer.
  function _initRound(
    uint256 e3Id,
    E3 memory e3,
    uint256 plaintextModulus,
    bytes calldata customParams
  ) internal override returns (bytes memory message, uint256 numOptions, uint256 inputLimit) {
    CRISPGnosisMessages.RoundMessage memory m;
    // Decoded as uint256: any value but zero is refused below, whatever its width.
    (m.censusMode, m.censusRoot, m.censusTotal, m.proposalHash, m.metadataCid) = abi.decode(
      customParams,
      (uint256, bytes32, uint256, bytes32, string)
    );

    if (!isProposer[e3.requester]) revert ProposerNotAllowed(e3.requester);
    if (m.censusMode != 0 || m.censusRoot != bytes32(0) || m.censusTotal != 0) revert CensusModeNotSupported();
    if (m.proposalHash == bytes32(0)) revert InvalidProposalHash();
    if (bytes(m.metadataCid).length == 0 || bytes(m.metadataCid).length > MAX_METADATA_CID_LENGTH) revert InvalidMetadataCid();
    // The voting contract divides by it.
    if (plaintextModulus == 0) revert InvalidPlaintextModulus();

    m.roundId = remoteRoundId(e3Id);
    m.numOptions = CRISPGnosisMessages.NUM_OPTIONS;
    m.inputStart = e3.inputWindow[0];
    m.inputEnd = e3.inputWindow[1];
    m.inputLimit = MAX_INPUTS_PER_ROUND;
    m.plaintextModulus = plaintextModulus;
    m.snapshot = e3.requestBlock - 1;
    m.requester = e3.requester;

    emit ProposalCreated(e3Id, e3.requester, m.proposalHash, m.metadataCid);

    message = CRISPGnosisMessages.round(m);
    numOptions = CRISPGnosisMessages.NUM_OPTIONS;
    inputLimit = MAX_INPUTS_PER_ROUND;
  }

  /// @dev The AMB is told to deliver to {remote}'s {IGnosisReceiver.receiveMessage}; `content` is the AMB message id.
  function _sendToRemote(uint256 e3Id, bytes memory message) internal override returns (bytes32 content) {
    if (remote == address(0)) revert RemoteNotSet();

    uint256 kind = CRISPGnosisMessages.kindOf(message);
    uint256 gas = kind == CRISPGnosisMessages.KIND_ROUND
      ? ROUND_GAS
      : kind == CRISPGnosisMessages.KIND_KEY
        ? KEY_GAS
        : RESULT_GAS;
    content = foreignAmb.requireToPassMessage(remote, abi.encodeCall(IGnosisReceiver.receiveMessage, (message)), gas);

    emit AmbMessageSent(e3Id, kind, content);
  }

  /// @notice The worst-case time from an E3 request to the committee key reaching Chiado: Interfold's key deadline
  /// plus {ambLatencyMargin}. {earliestVotingStart} reads the same value.
  function _committeeReservation(IInterfold.E3TimeoutConfig memory timeouts) internal view override returns (uint256) {
    return super._committeeReservation(timeouts) + ambLatencyMargin;
  }
}
