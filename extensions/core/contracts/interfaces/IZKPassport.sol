// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.8.27;

/// @notice The ABI of ZKPassport's root verifier, deployed at the same address on every network
///         ZKPassport supports (0x1D000001000EFD9a6371f4d90bB8920D5431c0D8).
/// @dev Tuple layouts mirror ZKPassport's `Types.sol` exactly.
interface IZKPassportVerifier {
  struct ProofVerificationParams {
    bytes32 version;
    ProofVerificationData proofVerificationData;
    bytes committedInputs;
    ServiceConfig serviceConfig;
  }

  struct ProofVerificationData {
    bytes32 vkeyHash;
    bytes proof;
    bytes32[] publicInputs;
  }

  struct ServiceConfig {
    uint256 validityPeriodInSeconds;
    string domain;
    string scope;
    bool devMode;
  }

  /// @notice Verifies a proof with the sub-verifier registered for `params.version`.
  /// @return verified Whether the proof is valid.
  /// @return uniqueIdentifier The document's identifier for the proof's domain and scope.
  /// @return helper The helper, for the same version, that reads the proof's committed inputs.
  function verify(
    ProofVerificationParams calldata params
  ) external returns (bool verified, bytes32 uniqueIdentifier, IZKPassportHelper helper);
}

/// @notice The ZKPassport helper functions this app reads a verified proof with.
interface IZKPassportHelper {
  struct BoundData {
    address senderAddress;
    uint256 chainId;
    string customData;
  }

  enum NullifierType {
    NON_SALTED_NULLIFIER,
    SALTED_NULLIFIER,
    NON_SALTED_MOCK_NULLIFIER,
    SALTED_MOCK_NULLIFIER,
    NONE_NULLIFIER
  }

  enum FaceMatchMode {
    NONE,
    REGULAR,
    STRICT
  }

  enum OS {
    ANY,
    IOS,
    ANDROID
  }

  function getBoundData(bytes calldata committedInputs) external view returns (BoundData memory);

  function isAgeAboveOrEqual(uint8 minAge, bytes calldata committedInputs) external view returns (bool);

  /// @dev `countryList` must equal the list the proof committed to, entry by entry.
  function isNationalityIn(string[] memory countryList, bytes calldata committedInputs) external view returns (bool);

  /// @dev `countryList` must equal the (sorted) list the proof committed to, entry by entry.
  function isNationalityOut(string[] memory countryList, bytes calldata committedInputs) external view returns (bool);

  function isFaceMatchVerified(FaceMatchMode faceMatchMode, OS os, bytes calldata committedInputs) external view returns (bool);

  /// @notice Reverts unless the proof's identifier has `expected` type. A mock type matches its
  ///         real counterpart; the sub-verifier only accepts mock proofs in dev mode.
  function enforceNullifierType(NullifierType expected, bytes32[] calldata publicInputs) external view;
}
