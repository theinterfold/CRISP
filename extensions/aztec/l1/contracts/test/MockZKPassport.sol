// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { IZKPassportHelper, IZKPassportVerifier } from "@crisp-e3/extension-core/contracts/interfaces/IZKPassport.sol";

/// @notice Stands in for ZKPassport's helper in tests of the registrar's own logic. It is NOT evidence that the real
/// verifier accepts anything: it reads `committedInputs = abi.encode(address sender, uint256 chainId, uint256 age,
/// string nationality)` and treats a second public input other than zero as the salted marker.
contract MockZKPassportHelper is IZKPassportHelper {
  function getBoundData(bytes calldata committedInputs) external pure returns (BoundData memory) {
    (address sender, uint256 chainId, , ) = abi.decode(committedInputs, (address, uint256, uint256, string));
    return BoundData(sender, chainId, "");
  }

  function isAgeAboveOrEqual(uint8 minAge, bytes calldata committedInputs) external pure returns (bool) {
    (, , uint256 age, ) = abi.decode(committedInputs, (address, uint256, uint256, string));
    return age >= minAge;
  }

  function isNationalityIn(string[] memory countryList, bytes calldata committedInputs) external pure returns (bool) {
    return _contains(countryList, committedInputs);
  }

  function isNationalityOut(string[] memory countryList, bytes calldata committedInputs) external pure returns (bool) {
    return !_contains(countryList, committedInputs);
  }

  function isFaceMatchVerified(FaceMatchMode, OS, bytes calldata) external pure returns (bool) {
    return true;
  }

  function enforceNullifierType(NullifierType, bytes32[] calldata publicInputs) external pure {
    require(publicInputs.length < 2 || publicInputs[1] == bytes32(0), "salted nullifier");
  }

  function _contains(string[] memory countryList, bytes calldata committedInputs) private pure returns (bool) {
    (, , , string memory nationality) = abi.decode(committedInputs, (address, uint256, uint256, string));
    for (uint256 i = 0; i < countryList.length; i++) {
      if (keccak256(bytes(countryList[i])) == keccak256(bytes(nationality))) return true;
    }
    return false;
  }
}

/// @notice Stands in for ZKPassport's root verifier: a proof verifies when its bytes are non-empty, the identifier is
/// the first public input, and the service configuration it was asked to verify with is recorded for the tests.
contract MockZKPassportVerifier is IZKPassportVerifier {
  IZKPassportHelper public immutable helper = new MockZKPassportHelper();

  ServiceConfig public lastServiceConfig;

  function verify(
    ProofVerificationParams calldata params
  ) external returns (bool verified, bytes32 uniqueIdentifier, IZKPassportHelper helper_) {
    lastServiceConfig = params.serviceConfig;
    return (params.proofVerificationData.proof.length != 0, params.proofVerificationData.publicInputs[0], helper);
  }
}
