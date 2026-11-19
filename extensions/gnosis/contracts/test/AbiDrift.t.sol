// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Test } from "forge-std/Test.sol";

/// @notice The tracked `abi/*.json` files (what the SDK, the keeper, the server and the app import) equal the compiled ABIs.
/// Regenerate with `pnpm export:abi` after `forge build`.
contract AbiDriftTest is Test {
  function _check(string memory name) internal view {
    string memory tracked = vm.readFile(string.concat("./abi/", name, ".json"));
    string memory artifact = vm.readFile(string.concat("./out/", name, ".sol/", name, ".json"));
    assertEq(vm.parseJson(tracked), vm.parseJson(artifact, ".abi"), string.concat("abi/", name, ".json is stale"));
  }

  function test_voting() public view {
    _check("CrispGnosisVoting");
  }

  function test_program() public view {
    _check("CRISPGnosisProgram");
  }

  function test_governanceModule() public view {
    _check("CrispGovernanceModule");
  }

  function test_token() public view {
    _check("CrispDemoToken");
  }

  function test_mockAmb() public view {
    _check("MockAMB");
  }

  function test_ambInterface() public view {
    _check("IAMB");
  }
}
