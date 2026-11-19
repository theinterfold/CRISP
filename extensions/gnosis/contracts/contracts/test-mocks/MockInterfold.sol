// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { IInterfold } from "@interfold/contracts/contracts/interfaces/IInterfold.sol";
import { E3 } from "@interfold/contracts/contracts/interfaces/IE3.sol";
import { IE3Program } from "@interfold/contracts/contracts/interfaces/IE3Program.sol";
import { IDecryptionVerifier } from "@interfold/contracts/contracts/interfaces/IDecryptionVerifier.sol";
import { IPkVerifier } from "@interfold/contracts/contracts/interfaces/IPkVerifier.sol";
import { ICiphernodeRegistry } from "@interfold/contracts/contracts/interfaces/ICiphernodeRegistry.sol";
import { BfvParameters } from "@crisp-e3/extension-core/contracts/CRISPRemoteProgram.sol";

/// @notice The part of Interfold that `CRISPRemoteProgram` reads, with the E3 state set by the test or the local deploy script.
/// @dev `request` mirrors `Interfold.request`: it stores the provisional E3, then calls `validate`.
contract MockInterfold {
  uint256 public constant PLAINTEXT_MODULUS = 17_000_000;

  address public owner = msg.sender;

  /// @dev Like Interfold: `e3Id = uint160(interfold) << 96 | sequence`.
  uint256 public nextE3Id = uint256(uint160(address(this))) << 96;
  mapping(uint256 => E3) internal e3s;
  mapping(uint256 => IInterfold.E3Stage) public stages;
  mapping(IE3Program => bool) public e3Programs;

  uint256 public randomnessRequestTimeout;
  uint256 public sortitionSubmissionWindow;
  uint256 public dkgWindow;
  uint256 public computeWindow = 100;

  function getCiphertextVerifier(bytes32) external pure returns (address) {
    return address(1);
  }

  function registerE3Program(IE3Program program) external {
    e3Programs[program] = true;
  }

  /// @dev Lets a test request an E3 whose id this mock did not issue.
  function setNextE3Id(uint256 id) external {
    nextE3Id = id;
  }

  function setComputeWindow(uint256 window) external {
    computeWindow = window;
  }

  function setCommitteeSetupWindows(uint256 randomness, uint256 sortition, uint256 dkg) external {
    randomnessRequestTimeout = randomness;
    sortitionSubmissionWindow = sortition;
    dkgWindow = dkg;
  }

  function e3ProgramParams() public pure returns (bytes memory) {
    uint256[] memory moduli = new uint256[](3);
    moduli[0] = 0x0000000007fffd81;
    moduli[1] = 0x0000000007fff801;
    moduli[2] = 0x0000000007fff781;
    return abi.encode(BfvParameters({ degree: 64, plaintextModulus: PLAINTEXT_MODULUS, moduli: moduli, error1Variance: "12617929386" }));
  }

  function request(address program, uint256[2] calldata inputWindow, bytes calldata customParams) external returns (uint256 e3Id) {
    e3Id = nextE3Id++;
    E3 storage e3 = e3s[e3Id];
    e3.requestBlock = block.timestamp;
    e3.inputWindow = inputWindow;
    e3.e3Program = IE3Program(program);
    e3.customParams = customParams;
    e3.requester = msg.sender;

    e3.encryptionSchemeId = IE3Program(program).validate(e3Id, 0, e3ProgramParams(), "", customParams);
    stages[e3Id] = IInterfold.E3Stage.Requested;
  }

  function setStage(uint256 e3Id, IInterfold.E3Stage stage) external {
    stages[e3Id] = stage;
  }

  function setCommitteePublicKey(uint256 e3Id, bytes32 key) external {
    e3s[e3Id].committeePublicKey = key;
  }

  function setPlaintextOutput(uint256 e3Id, bytes calldata plaintext) external {
    e3s[e3Id].plaintextOutput = plaintext;
  }

  /// @dev Lets a test point an E3 at another program, as a hostile `Interfold` state would.
  function setE3Program(uint256 e3Id, address program) external {
    e3s[e3Id].e3Program = IE3Program(program);
  }

  function getE3(uint256 e3Id) external view returns (E3 memory) {
    return e3s[e3Id];
  }

  function getE3Stage(uint256 e3Id) external view returns (IInterfold.E3Stage) {
    return stages[e3Id];
  }

  function getTimeoutConfig() public view returns (IInterfold.E3TimeoutConfig memory) {
    return IInterfold.E3TimeoutConfig({ dkgWindow: dkgWindow, computeWindow: computeWindow, decryptionWindow: 100 });
  }

  function getE3TimeoutConfig(uint256) external view returns (IInterfold.E3TimeoutConfig memory) {
    return getTimeoutConfig();
  }

  function ciphernodeRegistry() external view returns (ICiphernodeRegistry) {
    return ICiphernodeRegistry(address(this));
  }
}
