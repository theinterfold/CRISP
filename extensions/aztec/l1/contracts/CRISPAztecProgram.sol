// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { IOpenVmReceiptVerifier } from "@interfold/contracts/contracts/interfaces/IOpenVmReceiptVerifier.sol";
import { IDataAvailabilityVerifier } from "@interfold/contracts/contracts/interfaces/IDataAvailabilityVerifier.sol";
import { CRISPRemoteProgram } from "@crisp-e3/extension-core/contracts/CRISPRemoteProgram.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { E3 } from "@interfold/contracts/contracts/interfaces/IE3.sol";
import { AztecDataStructures, IAztecInbox, IAztecOutbox } from "./interfaces/IAztecMessageBridge.sol";

/// @title CRISPAztecProgram
/// @notice CRISP E3 program whose ballots are cast on Aztec (see `extensions/aztec/contracts`).
/// @dev Transport and the ZKPassport round rules; round logic lives in {CRISPRemoteProgram}.
///
/// L1 -> L2: messages go through the Aztec Inbox to the `crisp_aztec` contract. The message content is
/// `sha256ToField(message)` and the secret hash is {SECRET_HASH}, the hash of secret `0`, so the L2 contract consumes
/// them in a public function that anyone may call: the content, not a secret, authenticates the message, because
/// only this program can make the Inbox record this sender.
///
/// L2 -> L1: when the L2 contract closes a round it emits a ROOT message to this program through the Aztec Outbox.
/// {submitInputRoot} consumes it; the Outbox only lets the message's recipient (this program) consume it, and the
/// message's sender is pinned to the L2 contract, so the root cannot come from anywhere else.
contract CRISPAztecProgram is CRISPRemoteProgram {
  /// @notice The secret hash every L1 -> L2 message carries: `computeSecretHash(Fr.ZERO)`.
  /// @dev Computed once with aztec.js 6.0.0: `computeSecretHash(Fr.ZERO)` from the `crypto` entry point and `Fr` from
  /// the `fields` entry point of the `aztec.js` package. The L2 contract consumes with the same secret `0`;
  /// `tests/aztec-program.test.ts` pins this value and the README gives the full command.
  bytes32 public constant SECRET_HASH = 0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250;
  /// @notice Largest accepted `minAge`: the ZKPassport `Query::age_min` the L2 contract applies asserts `min < 100`.
  uint256 public constant MAX_MIN_AGE = 99;
  /// @notice The most countries a nationality rule lists: ZKPassport commits a list into 600 bytes (200 alpha-3 codes).
  uint256 public constant MAX_COUNTRIES = 200;
  /// @notice The BN254 scalar field modulus: a nationality commitment is a field element.
  uint256 public constant FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

  /// @notice The decoded `customParams`.
  struct CustomParams {
    uint256 numOptions;
    uint256 credits;
    uint256 minAge;
    bool allowMockDocuments;
    uint8 nationalityMode;
    string[] countries;
    uint256 nationalityCommitment;
  }

  /// @notice Aztec Inbox (L1 -> L2).
  IAztecInbox public immutable inbox;
  /// @notice Aztec Outbox (L2 -> L1).
  IAztecOutbox public immutable outbox;
  /// @notice Rollup version both bridge contracts serve; part of every L2 actor.
  uint256 public immutable rollupVersion;
  /// @notice Aztec address of the `crisp_aztec` contract. Set once by the owner; it depends on this program's
  /// address (an immutable of the L2 contract), so it cannot be a constructor argument.
  bytes32 public l2Program;

  error InboxAddressZero();
  error OutboxAddressZero();
  error RollupVersionMismatch(uint256 expected, uint256 inboxVersion, uint256 outboxVersion);
  error L2ProgramAlreadySet();
  error L2ProgramNotSet();
  error InvalidL2Program();
  error InvalidNumOptions();
  error InvalidMinAge(uint256 minAge);
  error InvalidNationalityMode(uint256 mode);
  /// @notice A country list that is empty or too long for the mode, or holds an entry that is not three letters `A-Z`.
  error InvalidCountries();
  /// @notice Zero or not a field element with a nationality rule, or non-zero without one.
  error InvalidNationalityCommitment(uint256 commitment);
  error CreditsExceedPlaintextModulus(uint256 credits, uint256 plaintextModulus);

  event L2ProgramSet(bytes32 indexed l2Program);
  /// @notice Who may join a round: the decoded rules, for apps that recompute the nationality commitment and build the
  /// ZKPassport request (`nationalityCommitment` is zero iff `nationalityMode` is 0).
  event RoundRules(
    uint256 indexed e3Id,
    uint256 minAge,
    bool allowMockDocuments,
    uint8 nationalityMode,
    string[] countries,
    uint256 nationalityCommitment
  );
  /// @notice A message was inserted into the Aztec Inbox. `index` is the leaf index the L2 contract consumes it with.
  event L1ToL2MessageSent(uint256 indexed e3Id, bytes32 content, bytes32 leaf, uint256 index);

  /// @param _inbox Aztec Inbox of the target rollup.
  /// @param _outbox Aztec Outbox of the target rollup.
  /// @param _rollupVersion Rollup version; refused unless both bridge contracts report it.
  /// @dev Remaining parameters: see {CRISPRemoteProgram}.
  constructor(
    address _initialOwner,
    IOpenVmReceiptVerifier _openVmVerifier,
    bytes32 _imageId,
    IDataAvailabilityVerifier _dataAvailabilityVerifier,
    uint256 _minVotingDuration,
    uint256 _remoteFinalityWindow,
    IAztecInbox _inbox,
    IAztecOutbox _outbox,
    uint256 _rollupVersion
  ) CRISPRemoteProgram(_initialOwner, _openVmVerifier, _imageId, _dataAvailabilityVerifier, _minVotingDuration, _remoteFinalityWindow) {
    if (address(_inbox) == address(0)) revert InboxAddressZero();
    if (address(_outbox) == address(0)) revert OutboxAddressZero();
    uint256 inboxVersion = _inbox.VERSION();
    uint256 outboxVersion = _outbox.VERSION();
    if (inboxVersion != _rollupVersion || outboxVersion != _rollupVersion) {
      revert RollupVersionMismatch(_rollupVersion, inboxVersion, outboxVersion);
    }

    inbox = _inbox;
    outbox = _outbox;
    rollupVersion = _rollupVersion;
  }

  /// @notice Set the Aztec address of the `crisp_aztec` contract. One time.
  /// @dev Rounds cannot be requested until this is set, because `validate` sends the round to it.
  function setL2Program(bytes32 _l2Program) external onlyOwner {
    if (l2Program != bytes32(0)) revert L2ProgramAlreadySet();
    // An Aztec address is a field element.
    if (_l2Program == bytes32(0) || uint256(_l2Program) >= FIELD_MODULUS) revert InvalidL2Program();

    l2Program = _l2Program;
    emit L2ProgramSet(_l2Program);
  }

  /// @notice Consume the ROOT message the L2 contract sent for `e3Id` and record the root.
  /// @dev Permissionless. `epoch`, `numCheckpointsInEpoch`, `leafIndex` and `path` locate the message in the Outbox
  /// (the Aztec node's `getL2ToL1MembershipWitness`). The Outbox reverts unless this program is the recipient and
  /// the message was sent by {l2Program}; `inputRoot` and `numInputs` are bound by the message content.
  function submitInputRoot(
    uint256 e3Id,
    uint256 inputRoot,
    uint256 numInputs,
    uint256 epoch,
    uint256 numCheckpointsInEpoch,
    uint256 leafIndex,
    bytes32[] calldata path
  ) external {
    if (l2Program == bytes32(0)) revert L2ProgramNotSet();

    outbox.consume(
      AztecDataStructures.L2ToL1Msg({
        sender: AztecDataStructures.L2Actor({ actor: l2Program, version: rollupVersion }),
        recipient: AztecDataStructures.L1Actor({ actor: address(this), chainId: block.chainid }),
        content: sha256ToField(CRISPRemoteMessages.inputRoot(remoteRoundId(e3Id), inputRoot, numInputs))
      }),
      epoch,
      numCheckpointsInEpoch,
      leafIndex,
      path
    );

    _acceptInputRoot(e3Id, inputRoot, numInputs);
  }

  /// @notice `sha256(data)` with the top byte dropped, as a field element: Aztec's `sha256ToField` (Noir `sha256_to_field`).
  function sha256ToField(bytes memory data) public pure returns (bytes32) {
    return bytes32(uint256(sha256(data)) >> 8);
  }

  /// @notice Scope string a ZKPassport proof is bound to: `crisp-aztec:<chainId>:<lowercase program address>:<e3Id>`.
  function scopeOf(uint256 e3Id) public view override returns (string memory) {
    return
      string.concat("crisp-aztec:", Strings.toString(block.chainid), ":", Strings.toHexString(address(this)), ":", Strings.toString(e3Id));
  }

  function _sendToRemote(uint256 e3Id, bytes memory message) internal override returns (bytes32 content) {
    if (l2Program == bytes32(0)) revert L2ProgramNotSet();

    content = sha256ToField(message);
    (bytes32 leaf, uint256 index) = inbox.sendL2Message(
      AztecDataStructures.L2Actor({ actor: l2Program, version: rollupVersion }),
      content,
      SECRET_HASH
    );

    emit L1ToL2MessageSent(e3Id, content, leaf, index);
  }

  /// @notice Decode and validate `customParams` and build the 12-word ZKPassport ROUND message.
  /// @dev The input limit follows `CRISPProgram._initCredits` for constant credits (`(t - 1) / credits` keeps every option
  /// total below the plaintext modulus `t`), capped at {MAX_INPUTS_PER_ROUND}.
  function _initRound(
    uint256 e3Id,
    E3 memory e3,
    uint256 plaintextModulus,
    bytes calldata customParams
  ) internal override returns (bytes memory message, uint256 numOptions, uint256 inputLimit) {
    CustomParams memory params = _decodeCustomParams(customParams);
    CRISPRemoteMessages.RoundConfig memory config = _roundConfig(e3Id, e3, params, plaintextModulus);

    emit RoundRules(
      e3Id,
      params.minAge,
      params.allowMockDocuments,
      params.nationalityMode,
      params.countries,
      params.nationalityCommitment
    );

    return (CRISPRemoteMessages.round(config), config.numOptions, config.inputLimit);
  }

  /// @notice Decode and validate `customParams`.
  /// @dev `abi.encode(uint256 numOptions, uint256 credits, uint256 minAge, bool allowMockDocuments, uint8 nationalityMode,
  /// string[] countries, uint256 nationalityCommitment)`.
  ///
  /// - mode 0: no list and no commitment; mode 1 or 2: 1..{MAX_COUNTRIES} alpha-3 codes, three letters `A-Z` each.
  /// - with a nationality rule the L2 checks ZKPassport's commitment of the list, which L1 cannot recompute, so it only
  ///   checks that one is given (a wrong one makes the round unregistrable).
  function _decodeCustomParams(bytes calldata customParams) internal pure returns (CustomParams memory params) {
    (
      params.numOptions,
      params.credits,
      params.minAge,
      params.allowMockDocuments,
      params.nationalityMode,
      params.countries,
      params.nationalityCommitment
    ) = abi.decode(customParams, (uint256, uint256, uint256, bool, uint8, string[], uint256));

    // The circuit asserts `num_options <= MAX_OPTIONS`; a larger round would accept no ballot at all.
    if (params.numOptions < 2 || params.numOptions > MAX_VOTE_OPTIONS) revert InvalidNumOptions();
    if (params.minAge > MAX_MIN_AGE) revert InvalidMinAge(params.minAge);

    uint256 mode = params.nationalityMode;
    if (mode > 2) revert InvalidNationalityMode(mode);
    uint256 count = params.countries.length;
    if (mode == 0 ? count != 0 : (count == 0 || count > MAX_COUNTRIES)) revert InvalidCountries();
    for (uint256 i = 0; i < count; i++) {
      bytes memory code = bytes(params.countries[i]);
      if (code.length != 3) revert InvalidCountries();
      for (uint256 j = 0; j < 3; j++) {
        if (code[j] < "A" || code[j] > "Z") revert InvalidCountries();
      }
    }

    uint256 commitment = params.nationalityCommitment;
    if (mode != 0 ? (commitment == 0 || commitment >= FIELD_MODULUS) : commitment != 0) revert InvalidNationalityCommitment(commitment);
  }

  /// @notice Build the ROUND config from validated parameters.
  function _roundConfig(
    uint256 e3Id,
    E3 memory e3,
    CustomParams memory params,
    uint256 plaintextModulus
  ) internal view returns (CRISPRemoteMessages.RoundConfig memory config) {
    uint256 credits = params.credits;
    // One ballot of `t` credits or more wraps an option total on its own.
    if (credits != 0 && credits >= plaintextModulus) revert CreditsExceedPlaintextModulus(credits, plaintextModulus);

    uint256 limit = credits == 0 ? MAX_INPUTS_PER_ROUND : (plaintextModulus - 1) / credits;

    config = CRISPRemoteMessages.RoundConfig({
      roundId: remoteRoundId(e3Id),
      numOptions: params.numOptions,
      credits: credits,
      inputStart: e3.inputWindow[0],
      inputEnd: e3.inputWindow[1],
      inputLimit: limit < MAX_INPUTS_PER_ROUND ? limit : MAX_INPUTS_PER_ROUND,
      scopeHash: scopeHashOf(e3Id),
      minAge: params.minAge,
      allowMockDocuments: params.allowMockDocuments,
      nationalityMode: params.nationalityMode,
      nationalityCommitment: params.nationalityCommitment
    });
  }
}
