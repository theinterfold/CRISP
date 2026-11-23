// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { CRISPRemoteProgram } from "@crisp-e3/extension-core/contracts/CRISPRemoteProgram.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { IOpenVmReceiptVerifier } from "@interfold/contracts/contracts/interfaces/IOpenVmReceiptVerifier.sol";
import { IDataAvailabilityVerifier } from "@interfold/contracts/contracts/interfaces/IDataAvailabilityVerifier.sol";
import { AztecDataStructures, IAztecInbox, IAztecOutbox } from "./interfaces/IAztecMessageBridge.sol";

/// @title CRISPAztecTransport
/// @notice The Aztec bridge shared by the CRISP programs whose ballots are cast on Aztec.
/// @dev L1 -> L2: messages go through the Aztec Inbox to the L2 program. The content is `sha256ToField(message)` and the
/// secret hash is {SECRET_HASH}, the hash of secret `0`, so the L2 contract consumes them in a public function that
/// anyone may call: the content, not a secret, authenticates the message, because only this program can make the
/// Inbox record this sender.
///
/// L2 -> L1: when the L2 contract closes a round it emits a ROOT message to this program through the Aztec Outbox.
/// {submitInputRoot} consumes it; the Outbox only lets the message's recipient (this program) consume it, and the
/// message's sender is pinned to the L2 contract, so the root cannot come from anywhere else.
abstract contract CRISPAztecTransport is CRISPRemoteProgram {
  /// @notice The secret hash every L1 -> L2 message carries: `computeSecretHash(Fr.ZERO)`.
  /// @dev Computed once with aztec.js 6.0.0: `computeSecretHash(Fr.ZERO)` from the `crypto` entry point and `Fr` from
  /// the `fields` entry point of the `aztec.js` package. The L2 contract consumes with the same secret `0`;
  /// `tests/aztec-program.test.ts` pins this value and the README gives the full command.
  bytes32 public constant SECRET_HASH = 0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250;
  /// @notice The BN254 scalar field modulus: a nationality commitment is a field element.
  uint256 public constant FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

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

  event L2ProgramSet(bytes32 indexed l2Program);
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

  function _sendToRemote(uint256 e3Id, bytes memory message) internal override returns (bytes32 content) {
    (content, ) = _sendToInbox(e3Id, message);
  }

  /// @dev Like {_sendToRemote}, and also returns the Inbox leaf index the L2 contract consumes the message with.
  function _sendToInbox(uint256 e3Id, bytes memory message) internal returns (bytes32 content, uint256 index) {
    if (l2Program == bytes32(0)) revert L2ProgramNotSet();

    content = sha256ToField(message);
    bytes32 leaf;
    (leaf, index) = inbox.sendL2Message(
      AztecDataStructures.L2Actor({ actor: l2Program, version: rollupVersion }),
      content,
      SECRET_HASH
    );

    emit L1ToL2MessageSent(e3Id, content, leaf, index);
  }
}
