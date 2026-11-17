// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IE3Program } from "@interfold/contracts/contracts/interfaces/IE3Program.sol";
import { IInterfold } from "@interfold/contracts/contracts/interfaces/IInterfold.sol";
import { ICiphernodeRegistry } from "@interfold/contracts/contracts/interfaces/ICiphernodeRegistry.sol";
import { IOpenVmReceiptVerifier } from "@interfold/contracts/contracts/interfaces/IOpenVmReceiptVerifier.sol";
import { E3 } from "@interfold/contracts/contracts/interfaces/IE3.sol";
import { OpenVmComputeProof } from "@interfold/contracts/contracts/lib/OpenVmComputeProof.sol";
import { IDataAvailabilityVerifier, IE3ProgramDataAvailability } from "@interfold/contracts/contracts/interfaces/IDataAvailabilityVerifier.sol";
import { CRISPRemoteMessages } from "./CRISPRemoteMessages.sol";

interface IInterfoldProgramRegistry {
  function e3Programs(IE3Program e3Program) external view returns (bool);
}

interface IInterfoldRegistryView {
  function ciphernodeRegistry() external view returns (ICiphernodeRegistry);
}

/// @notice The BFV parameter blob Interfold passes to `validate` as `e3ProgramParams`.
/// @dev Field order must match `CRISPProgram.sol` and `encode_bfv_params` (`crates/fhe-params/src/encoding.rs`).
struct BfvParameters {
  uint256 degree;
  uint256 plaintextModulus;
  uint256[] moduli;
  string error1Variance;
}

/// @title CRISPRemoteProgram
/// @notice A CRISP E3 program whose ballots are collected on another chain (an L2).
/// @dev Interfold only talks to L1, so this contract is the L1 face of a round that lives on an L2:
///
/// - `validate` configures the round on L1 and hands the same configuration to the L2 ({_sendToRemote});
/// - the committee key is relayed to the L2 once Interfold has published it ({publishCommitteeKey});
/// - when the L2 closes the round it reports the root of the input tree back, and the adapter delivers it to
///   {_acceptInputRoot} after authenticating it through the L2's own bridge;
/// - `verify` checks the OpenVM compute proof against that delivered root, exactly as `CRISPProgram.verify` does
///   against its on-chain tree.
///
/// The tree the L2 builds MUST be byte-identical to `CRISPProgram`'s input tree, because the compute side (OpenVM
/// guest, program server) is shared; see `extensions/README.md`. This contract has no input tree and takes no
/// inputs on L1, so `publishInput` always reverts.
///
/// An adapter supplies only transport: {_sendToRemote}, {scopeOf}, and an entry point that authenticates the L2's
/// root message and calls {_acceptInputRoot}. Everything else is chain-agnostic.
abstract contract CRISPRemoteProgram is IE3Program, IE3ProgramDataAvailability, IERC165, Ownable {
  /// @notice Per-round state kept on L1.
  struct Round {
    bytes32 paramsHash;
    uint256 numOptions;
    /// @notice The most inputs the L2 contract accepts for this round.
    uint256 inputLimit;
    bool keyRelayed;
    bool rootSubmitted;
    uint256 inputRoot;
    uint256 numInputs;
  }

  /// @notice Encryption scheme ID used for the CRISP program.
  bytes32 public constant ENCRYPTION_SCHEME_ID = keccak256("fhe.rs:BFV");
  /// @notice Minimum time available to vote after a worst-case key setup.
  uint256 public constant MIN_VOTING_DURATION = 1 hours;
  /// @notice Number of leading plaintext coefficients that carry the tally.
  /// @dev Must stay aligned with `CRISPProgram` and `@crisp-e3/sdk` (`MAX_MSG_NON_ZERO_COEFFS`).
  uint256 public constant MAX_MSG_NON_ZERO_COEFFS = 50;
  /// @notice Maximum number of vote options a round may configure (`circuits/lib/src/constants.nr`).
  uint256 public constant MAX_VOTE_OPTIONS = 10;
  /// @notice The most inputs a remote round accepts.
  /// @dev Bounds the L2 input tree (2^16 leaves): each L2 insert recomputes at most 16 Poseidon hashes, which is what
  /// fits a transaction on Aztec. Below `CRISPProgram.MAX_INPUTS_PER_ROUND`, so the BFV noise budget still holds.
  uint256 public constant MAX_INPUTS_PER_ROUND = 65_536;
  /// @notice Largest accepted `minAge`: the ZKPassport `Query::age_min` the L2 contract applies asserts `min < 100`.
  uint256 public constant MAX_MIN_AGE = 99;

  /// @notice The Interfold controller. Zero until {bindInterfold}.
  IInterfold public interfold;
  /// @notice Receipt verifier for the OpenVM compute proof.
  IOpenVmReceiptVerifier public immutable openVmVerifier;
  /// @notice The receipt identity `openVmVerifier` accepts.
  bytes32 public immutable imageId;
  /// @notice Receipt verifier for the aggregate ciphertext output, same one `CRISPProgram` uses.
  IDataAvailabilityVerifier public immutable dataAvailabilityVerifier;
  /// @notice Shortest voting window accepted, and the switch for the key-deadline check. Zero disables both timing
  /// checks, which is only for a local network whose rounds last minutes; production deployments set
  /// {MIN_VOTING_DURATION}.
  uint256 public immutable minVotingDuration;
  /// @notice Time the remote chain needs between the end of voting and the input root being deliverable to L1
  /// (closing the round, then finality of that transaction on the remote chain's settlement). `validate` refuses a
  /// round whose Interfold compute window is shorter, because the root could then arrive after the compute deadline
  /// and the round would fail as a requester-paid compute timeout. Zero disables the check.
  uint256 public immutable remoteFinalityWindow;

  mapping(uint256 e3Id => Round) internal rounds;

  error CallerNotAuthorized();
  error E3AlreadyInitialized();
  error E3NotAssignedToProgram(uint256 e3Id);
  /// @notice The E3 id does not carry the bound Interfold address in its high 160 bits, so it has no remote round id.
  error E3NotOfBoundInterfold(uint256 e3Id);
  error InterfoldAddressZero();
  error InterfoldAlreadyBound();
  error InterfoldNotContract();
  error ProgramNotRegistered();
  error OpenVmVerifierAddressZero();
  error InvalidImageId();
  error InvalidDataAvailabilityVerifier();
  error InvalidMinVotingDuration(uint256 minVotingDuration);
  /// @notice The compute window leaves no budget for the remote chain to finalize the round's input root.
  error ComputeWindowTooShort(uint256 e3Id, uint256 computeWindow, uint256 required);
  error InvalidNumOptions();
  error InvalidMinAge(uint256 minAge);
  error CreditsExceedPlaintextModulus(uint256 credits, uint256 plaintextModulus);
  error VotingStartsBeforeKeyDeadline(uint256 e3Id, uint256 earliestStart, uint256 actualStart);
  error VotingWindowTooShort(uint256 e3Id, uint256 votingStartsAt, uint256 votingEndsAt, uint256 required);
  error KeyNotPublished(uint256 e3Id);
  error CommitteeKeyAlreadyRelayed(uint256 e3Id);
  error InputRootAlreadySubmitted(uint256 e3Id);
  error InputRootNotSubmitted(uint256 e3Id);
  error InvalidInputRoot();
  error InputCountExceedsLimit(uint256 e3Id, uint256 numInputs, uint256 limit);
  error InvalidComputeContext();
  error InvalidRoundId(uint256 roundId);
  error InvalidTallyLength();
  error DataAvailabilityHashMismatch(bytes32 expected, bytes32 actual);
  /// @notice Inputs live on the remote chain; there is nothing to publish on L1.
  error InputsLiveOnRemoteChain();

  event InterfoldBound(address indexed interfold);
  /// @notice The round configuration was handed to the remote chain. `content` is what the bridge carries.
  event RoundConfigSent(uint256 indexed e3Id, bytes32 content);
  /// @notice The committee key was handed to the remote chain.
  event CommitteeKeyRelayed(uint256 indexed e3Id, bytes32 committeePublicKey);
  /// @notice The remote chain's input root was authenticated and recorded.
  event InputRootSubmitted(uint256 indexed e3Id, uint256 inputRoot, uint256 numInputs);

  /// @param _initialOwner Account that wires this program (bind Interfold, set the remote contract).
  /// @param _openVmVerifier OpenVM receipt verifier.
  /// @param _imageId Receipt identity; refused unless it equals `_openVmVerifier.imageId()`, because `verify` would
  /// otherwise reject every proof.
  /// @param _dataAvailabilityVerifier Verifier for the aggregate ciphertext output.
  /// @param _minVotingDuration 0 or {MIN_VOTING_DURATION}-or-more seconds; see {minVotingDuration}.
  /// @param _remoteFinalityWindow Seconds; see {remoteFinalityWindow}.
  constructor(
    address _initialOwner,
    IOpenVmReceiptVerifier _openVmVerifier,
    bytes32 _imageId,
    IDataAvailabilityVerifier _dataAvailabilityVerifier,
    uint256 _minVotingDuration,
    uint256 _remoteFinalityWindow
  ) Ownable(_initialOwner) {
    if (address(_openVmVerifier) == address(0)) revert OpenVmVerifierAddressZero();
    if (_imageId != _openVmVerifier.imageId()) revert InvalidImageId();
    if (address(_dataAvailabilityVerifier).code.length == 0) revert InvalidDataAvailabilityVerifier();
    if (_minVotingDuration != 0 && _minVotingDuration < MIN_VOTING_DURATION) revert InvalidMinVotingDuration(_minVotingDuration);

    openVmVerifier = _openVmVerifier;
    imageId = _imageId;
    dataAvailabilityVerifier = _dataAvailabilityVerifier;
    minVotingDuration = _minVotingDuration;
    remoteFinalityWindow = _remoteFinalityWindow;
  }

  // ---------------------------------------------------------------------------------------------
  // Adapter hooks
  // ---------------------------------------------------------------------------------------------

  /// @notice Deliver `message` (one of the {CRISPRemoteMessages} layouts) to the remote contract.
  /// @return content The value the bridge carries for this message; reported in events.
  function _sendToRemote(uint256 e3Id, bytes memory message) internal virtual returns (bytes32 content);

  /// @notice The scope string a voter's identity proof is bound to for this round.
  /// @dev Must be unique per program, chain, and round so a proof cannot be replayed into another round.
  function scopeOf(uint256 e3Id) public view virtual returns (string memory);

  // ---------------------------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------------------------

  /// @notice Bind this program to its permanent Interfold controller.
  /// @dev Interfold must register this program before the owner calls this function.
  function bindInterfold(IInterfold _interfold) external onlyOwner {
    if (address(interfold) != address(0)) revert InterfoldAlreadyBound();
    if (address(_interfold) == address(0)) revert InterfoldAddressZero();
    if (address(_interfold).code.length == 0) revert InterfoldNotContract();
    if (!IInterfoldProgramRegistry(address(_interfold)).e3Programs(IE3Program(address(this)))) revert ProgramNotRegistered();

    interfold = _interfold;
    emit InterfoldBound(address(_interfold));
  }

  // ---------------------------------------------------------------------------------------------
  // Round lifecycle
  // ---------------------------------------------------------------------------------------------

  /// @inheritdoc IE3Program
  /// @dev Sends the round configuration to the remote chain inside the requester's transaction, so the requester
  /// pays the bridge fee and no further L1 action is needed to open the round.
  function validate(
    uint256 e3Id,
    uint256,
    bytes calldata e3ProgramParams,
    bytes calldata,
    bytes calldata customParams
  ) external returns (bytes32) {
    if (msg.sender != address(interfold)) revert CallerNotAuthorized();
    Round storage round = rounds[e3Id];
    if (round.paramsHash != bytes32(0)) revert E3AlreadyInitialized();
    // Interfold stores the provisional E3 before calling `validate`; refuse one assigned to another program.
    E3 memory e3 = interfold.getE3(e3Id);
    if (address(e3.e3Program) != address(this)) revert E3NotAssignedToProgram(e3Id);
    // The remote chain keys a round by its low 96 bits: that is only unambiguous for ids this Interfold issued.
    if (e3Id >> 96 != uint256(uint160(address(interfold)))) revert E3NotOfBoundInterfold(e3Id);

    _validateInputTiming(e3Id, e3);

    CRISPRemoteMessages.RoundConfig memory config = _roundConfig(
      e3Id,
      e3,
      customParams,
      abi.decode(e3ProgramParams, (BfvParameters)).plaintextModulus
    );

    round.paramsHash = keccak256(e3ProgramParams);
    round.numOptions = config.numOptions;
    round.inputLimit = config.inputLimit;

    emit RoundConfigSent(e3Id, _sendToRemote(e3Id, CRISPRemoteMessages.round(config)));

    return ENCRYPTION_SCHEME_ID;
  }

  /// @notice Relay the committee public key to the remote chain once Interfold has published it.
  /// @dev Permissionless: the key is read from Interfold, so the caller cannot influence it. Only while the E3 is in
  /// `KeyPublished`, because the key is useless to the remote chain after the output stage.
  function publishCommitteeKey(uint256 e3Id) external {
    Round storage round = rounds[e3Id];
    if (round.paramsHash == bytes32(0)) revert E3NotAssignedToProgram(e3Id);
    if (round.keyRelayed) revert CommitteeKeyAlreadyRelayed(e3Id);
    if (interfold.getE3Stage(e3Id) != IInterfold.E3Stage.KeyPublished) revert KeyNotPublished(e3Id);

    bytes32 committeePublicKey = interfold.getE3(e3Id).committeePublicKey;
    round.keyRelayed = true;
    _sendToRemote(e3Id, CRISPRemoteMessages.committeeKey(remoteRoundId(e3Id), committeePublicKey));

    emit CommitteeKeyRelayed(e3Id, committeePublicKey);
  }

  /// @notice Record the input root the remote chain reported for a round.
  /// @dev Adapter entry points call this only after the bridge has authenticated that the remote contract sent
  /// exactly `CRISPRemoteMessages.inputRoot(e3Id, root, numInputs)`.
  function _acceptInputRoot(uint256 e3Id, uint256 root, uint256 numInputs) internal {
    Round storage round = rounds[e3Id];
    if (round.paramsHash == bytes32(0)) revert E3NotAssignedToProgram(e3Id);
    if (round.rootSubmitted) revert InputRootAlreadySubmitted(e3Id);
    if (root == 0) revert InvalidInputRoot();
    if (numInputs > round.inputLimit) revert InputCountExceedsLimit(e3Id, numInputs, round.inputLimit);
    // A root arriving after the round left `KeyPublished` is useless and would only mask a failed round.
    if (interfold.getE3Stage(e3Id) != IInterfold.E3Stage.KeyPublished) revert KeyNotPublished(e3Id);

    round.rootSubmitted = true;
    round.inputRoot = root;
    round.numInputs = numInputs;

    emit InputRootSubmitted(e3Id, root, numInputs);
  }

  /// @inheritdoc IE3Program
  /// @dev Inputs are collected on the remote chain.
  function publishInput(uint256, bytes memory) external pure {
    revert InputsLiveOnRemoteChain();
  }

  /// @inheritdoc IE3Program
  function verify(
    uint256 e3Id,
    bytes32 ciphertextOutputHash,
    bytes32 ciphertextCommitment,
    bytes memory proof
  ) external view override returns (bool) {
    Round storage round = rounds[e3Id];
    if (!round.rootSubmitted) revert InputRootNotSubmitted(e3Id);

    E3 memory e3 = interfold.getE3(e3Id);
    bytes32 paramsHash = round.paramsHash;
    bytes32 root = bytes32(round.inputRoot);
    OpenVmComputeProof.Proof memory computeProof = OpenVmComputeProof.decode(proof);
    if (computeProof.paramsHash != paramsHash || computeProof.inputRoot != root) revert InvalidComputeContext();

    bytes memory journal = OpenVmComputeProof.journal(
      bytes32(block.chainid),
      bytes32(uint256(uint160(address(interfold)))),
      bytes32(e3Id),
      e3.encryptionSchemeId,
      e3.committeePublicKey,
      ciphertextOutputHash,
      ciphertextCommitment,
      paramsHash,
      root
    );

    openVmVerifier.verify(computeProof.seal, imageId, sha256(journal));
    return true;
  }

  /// @notice Verify availability of an aggregate ciphertext for Interfold.
  /// @dev Interfold independently checks the returned content hash before recording it.
  function verifyDataAvailability(
    bytes32 expectedContentHash,
    bytes calldata proof
  ) external view returns (IDataAvailabilityVerifier.DataReference memory receipt) {
    receipt = dataAvailabilityVerifier.verifyDataAvailability(expectedContentHash, proof);
    if (receipt.contentHash != expectedContentHash) revert DataAvailabilityHashMismatch(expectedContentHash, receipt.contentHash);
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  /// @notice The id the remote chain knows a round by: the low 96 bits of the E3 id.
  /// @dev Interfold issues `e3Id = uint160(interfold) << 96 | sequence`, which does not fit a field element. A remote
  /// contract serves one program, which serves one Interfold, so the sequence alone is unambiguous.
  function remoteRoundId(uint256 e3Id) public pure returns (uint256) {
    return uint256(uint96(e3Id));
  }

  /// @notice The inverse of {remoteRoundId} for the bound Interfold: `uint160(interfold) << 96 | roundId`.
  function e3IdOf(uint256 roundId) public view returns (uint256) {
    if (roundId >> 96 != 0) revert InvalidRoundId(roundId);
    return (uint256(uint160(address(interfold))) << 96) | roundId;
  }

  /// @notice `uint256(sha256(bytes(scopeOf(e3Id)))) >> 8`: the scope string as a BN254 field element.
  function scopeHashOf(uint256 e3Id) public view returns (uint256) {
    return uint256(sha256(bytes(scopeOf(e3Id)))) >> 8;
  }

  /// @notice The L1 record of a round. All zero for an unknown E3.
  function getRound(uint256 e3Id) external view returns (Round memory) {
    return rounds[e3Id];
  }

  /// @notice Params hash of an E3: `keccak256(e3ProgramParams)`.
  function getParamsHash(uint256 e3Id) external view returns (bytes32) {
    return rounds[e3Id].paramsHash;
  }

  /// @notice Earliest voting start under the current committee timeouts.
  /// @dev The E3 request snapshots these settings. Add time for the transaction to be mined when picking a fixed start.
  function earliestVotingStart() external view returns (uint256) {
    return block.timestamp + _committeeReservation(interfold.getTimeoutConfig());
  }

  /// @notice Decode the tally from the plaintext output.
  /// @dev Coefficient `o` is the total weight on option `o`, as one little-endian uint64.
  function decodeTally(uint256 e3Id) public view returns (uint256[] memory votes) {
    bytes memory output = interfold.getE3(e3Id).plaintextOutput;
    uint256 numOptions = rounds[e3Id].numOptions;

    // A round that was never configured has nothing to decode.
    if (numOptions == 0) return new uint256[](0);

    if (output.length % 8 != 0 || output.length < MAX_MSG_NON_ZERO_COEFFS * 8) revert InvalidTallyLength();

    votes = new uint256[](numOptions);
    for (uint256 o = 0; o < numOptions; o++) {
      for (uint256 j = 0; j < 8; j++) votes[o] |= uint256(uint8(output[o * 8 + j])) << (j * 8);
    }
  }

  /// @inheritdoc IERC165
  /// @dev Interfold probes these interfaces before it registers a program.
  function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
    return
      interfaceId == type(IE3Program).interfaceId ||
      interfaceId == type(IE3ProgramDataAvailability).interfaceId ||
      interfaceId == type(IERC165).interfaceId;
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  /// @notice Decode and validate the round parameters.
  /// @dev `customParams = abi.encode(uint256 numOptions, uint256 credits, uint256 minAge, bool allowMockDocuments)`.
  /// The input limit follows `CRISPProgram._initCredits` for constant credits (`(t - 1) / credits` keeps every option
  /// total below the plaintext modulus `t`), capped at {MAX_INPUTS_PER_ROUND}.
  function _roundConfig(
    uint256 e3Id,
    E3 memory e3,
    bytes calldata customParams,
    uint256 plaintextModulus
  ) internal view returns (CRISPRemoteMessages.RoundConfig memory config) {
    (uint256 numOptions, uint256 credits, uint256 minAge, bool allowMockDocuments) = abi.decode(
      customParams,
      (uint256, uint256, uint256, bool)
    );

    // The circuit asserts `num_options <= MAX_OPTIONS`; a larger round would accept no ballot at all.
    if (numOptions < 2 || numOptions > MAX_VOTE_OPTIONS) revert InvalidNumOptions();
    if (minAge > MAX_MIN_AGE) revert InvalidMinAge(minAge);
    // One ballot of `t` credits or more wraps an option total on its own.
    if (credits != 0 && credits >= plaintextModulus) revert CreditsExceedPlaintextModulus(credits, plaintextModulus);

    uint256 limit = credits == 0 ? MAX_INPUTS_PER_ROUND : (plaintextModulus - 1) / credits;

    config = CRISPRemoteMessages.RoundConfig({
      roundId: remoteRoundId(e3Id),
      numOptions: numOptions,
      credits: credits,
      inputStart: e3.inputWindow[0],
      inputEnd: e3.inputWindow[1],
      inputLimit: limit < MAX_INPUTS_PER_ROUND ? limit : MAX_INPUTS_PER_ROUND,
      scopeHash: scopeHashOf(e3Id),
      minAge: minAge,
      allowMockDocuments: allowMockDocuments
    });
  }

  /// @notice The worst-case time from an E3 request to its published committee key.
  function _committeeReservation(IInterfold.E3TimeoutConfig memory timeouts) internal view returns (uint256) {
    ICiphernodeRegistry registry = IInterfoldRegistryView(address(interfold)).ciphernodeRegistry();
    return registry.randomnessRequestTimeout() + registry.sortitionSubmissionWindow() + timeouts.dkgWindow;
  }

  /// @notice Refuse a round that starts before the worst-case key deadline, leaves less than {minVotingDuration} to vote,
  /// or leaves the remote chain less than {remoteFinalityWindow} to deliver the input root.
  /// @dev Same rules as `CRISPProgram`, with the remote finality tail in place of its availability-finalization tail:
  /// ballots are accepted by the remote chain until `inputWindow[1]`, and the root can only be submitted on L1 after
  /// the remote chain has closed the round and settled. Interfold derives `computeDeadline` from `inputWindow[1]`, so
  /// the compute window is the whole budget for that.
  function _validateInputTiming(uint256 e3Id, E3 memory e3) internal view {
    IInterfold.E3TimeoutConfig memory timeouts = interfold.getE3TimeoutConfig(e3Id);
    if (timeouts.computeWindow < remoteFinalityWindow) {
      revert ComputeWindowTooShort(e3Id, timeouts.computeWindow, remoteFinalityWindow);
    }
    if (minVotingDuration == 0) return;

    uint256 latestKeyAt = e3.requestBlock + _committeeReservation(timeouts);
    uint256 votingStartsAt = e3.inputWindow[0];
    if (votingStartsAt < latestKeyAt) revert VotingStartsBeforeKeyDeadline(e3Id, latestKeyAt, votingStartsAt);
    if (e3.inputWindow[1] < votingStartsAt + minVotingDuration) {
      revert VotingWindowTooShort(e3Id, votingStartsAt, e3.inputWindow[1], minVotingDuration);
    }
  }
}
