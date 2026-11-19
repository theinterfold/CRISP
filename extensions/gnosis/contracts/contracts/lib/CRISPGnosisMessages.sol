// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";

/// @notice Byte layouts of the messages exchanged between `CRISPGnosisProgram` (Sepolia) and `CrispGnosisVoting` (Chiado),
/// and the gas the AMB is asked to execute each of them with.
/// @dev Every message is `abi.encode(...)` of 256-bit words and word 0 is the kind. KEY (2) and ROOT (3) are the
/// `CRISPRemoteMessages` layouts, unchanged; ROUND (1) is NOT `CRISPRemoteMessages.round` (the Aztec/ZKPassport
/// layout): kind 1 is namespaced per adapter. RESULT (4) exists only here. Off-chain encoders (`extensions/gnosis/sdk`)
/// hand-copy these layouts, so a change is a protocol change: `test/fixtures/message-vectors.json` pins them.
library CRISPGnosisMessages {
  /// @notice Sepolia -> Chiado: round configuration, sent while the round is requested.
  uint256 internal constant KIND_ROUND = CRISPRemoteMessages.KIND_ROUND;
  /// @notice Sepolia -> Chiado: the committee public key.
  uint256 internal constant KIND_KEY = CRISPRemoteMessages.KIND_KEY;
  /// @notice Chiado -> Sepolia: the root and size of the ballot tree.
  uint256 internal constant KIND_ROOT = CRISPRemoteMessages.KIND_ROOT;
  /// @notice Sepolia -> Chiado: the decrypted tally.
  uint256 internal constant KIND_RESULT = 4;

  /// @notice Options of every round: 0 = For, 1 = Against, 2 = Abstain.
  uint256 internal constant NUM_OPTIONS = 3;

  /// @notice AMB gas limits: at least 2x the gas measured for the receiving call (`test/GasMeasurement.t.sol` fails below
  /// it), because a message that runs out of gas on the receiving side is not replayable. Measured: ROUND 273,722 (a
  /// 128-byte CID, 200 supply checkpoints), KEY 26,385, ROOT 73,604, RESULT 118,154.
  uint256 internal constant ROUND_GAS = 550_000;
  uint256 internal constant KEY_GAS = 55_000;
  uint256 internal constant ROOT_GAS = 150_000;
  uint256 internal constant RESULT_GAS = 240_000;

  /// @notice The ROUND message, in `abi.encode` word order.
  /// @dev `kind` is always {KIND_ROUND}; it is a field only so the struct encodes to the flat 14-word layout.
  struct RoundMessage {
    uint256 kind;
    uint256 roundId;
    uint256 numOptions;
    uint256 inputStart;
    uint256 inputEnd;
    uint256 inputLimit;
    uint256 plaintextModulus;
    /// @dev `e3.requestBlock - 1`: a Sepolia timestamp, see `CrispGnosisVoting`.
    uint256 snapshot;
    uint256 censusMode;
    bytes32 censusRoot;
    uint256 censusTotal;
    bytes32 proposalHash;
    address requester;
    string metadataCid;
  }

  /// @notice `abi.encode(1, roundId, numOptions, inputStart, inputEnd, inputLimit, plaintextModulus, snapshot, censusMode, censusRoot,
  /// censusTotal, proposalHash, requester, metadataCid)`: 13 static words, then the string offset (`0x1c0`), its length and data.
  /// @dev Encoding the struct would prefix one extra offset word (`0x20`); the assembly drops it by moving the memory
  /// pointer one word forward and overwriting that word with the shortened length.
  function round(RoundMessage memory m) internal pure returns (bytes memory encoded) {
    m.kind = KIND_ROUND;
    encoded = abi.encode(m);
    assembly {
      let length := mload(encoded)
      encoded := add(encoded, 0x20)
      mstore(encoded, sub(length, 0x20))
    }
  }

  /// @notice Decode a ROUND message. Reverts unless it is exactly the layout of {round}.
  function decodeRound(bytes memory message) internal pure returns (RoundMessage memory) {
    return abi.decode(bytes.concat(bytes32(uint256(0x20)), message), (RoundMessage));
  }

  /// @notice `abi.encode(4, roundId, tally)`.
  function result(uint256 roundId, uint256[] memory tally) internal pure returns (bytes memory) {
    return abi.encode(KIND_RESULT, roundId, tally);
  }

  /// @notice Decode a RESULT message.
  function decodeResult(bytes memory message) internal pure returns (uint256 roundId, uint256[] memory tally) {
    uint256 kind;
    (kind, roundId, tally) = abi.decode(message, (uint256, uint256, uint256[]));
  }

  /// @notice The kind word of a message.
  function kindOf(bytes memory message) internal pure returns (uint256) {
    return abi.decode(message, (uint256));
  }
}
