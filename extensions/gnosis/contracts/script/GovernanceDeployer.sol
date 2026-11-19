// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Script } from "forge-std/Script.sol";
import { ModuleProxyFactory } from "@gnosis-guild/zodiac-core/contracts/factory/ModuleProxyFactory.sol";
import { Delay } from "../vendor/zodiac-modifier-delay/Delay.sol";
import { GnosisSafe } from "../vendor/safe-contracts/GnosisSafe.sol";
import { GnosisSafeProxyFactory } from "../vendor/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import { Enum } from "../vendor/safe-contracts/common/Enum.sol";
import { CrispGovernanceModule } from "../contracts/chiado/CrispGovernanceModule.sol";

/// @notice The Chiado governance stack shared by the local and the Chiado deploy: a 1-of-1 Safe owned by the deployer, a Delay
/// (a module of the Safe, owned by it) and a {CrispGovernanceModule} (a module of the Delay, owned by the Safe).
/// @dev Run under `vm.startBroadcast()`: the deployer is the Safe's only owner and signs its transactions by being the sender.
abstract contract GovernanceDeployer is Script {
  struct GovernanceConfig {
    address deployer;
    address safeSingleton;
    address safeProxyFactory;
    address moduleProxyFactory;
    address multiSend;
    address voting;
    uint256 delayCooldown;
    uint256 delayExpiration;
    uint256 quorum;
    uint16 approvalBps;
    uint64 expiration;
  }

  struct Governance {
    address safe;
    address delayMastercopy;
    address delay;
    address moduleMastercopy;
    address module;
  }

  function _deployGovernance(GovernanceConfig memory c) internal returns (Governance memory g) {
    address[] memory owners = new address[](1);
    owners[0] = c.deployer;
    uint256 salt = uint256(keccak256(abi.encode(c.deployer, c.voting, block.chainid)));
    g.safe = address(
      GnosisSafeProxyFactory(c.safeProxyFactory).createProxyWithNonce(
        c.safeSingleton,
        abi.encodeCall(GnosisSafe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))),
        salt
      )
    );

    // Delay: owner = avatar = target = Safe. The mastercopy is initialised by its own constructor.
    g.delayMastercopy = address(new Delay(address(1), address(1), address(1), 0, 0));
    g.delay = ModuleProxyFactory(c.moduleProxyFactory).deployModule(
      g.delayMastercopy,
      abi.encodeCall(Delay.setUp, (abi.encode(g.safe, g.safe, g.safe, c.delayCooldown, c.delayExpiration))),
      salt
    );

    // Governance module: owner = avatar = Safe, target = Delay.
    g.moduleMastercopy = address(
      new CrispGovernanceModule(abi.encode(address(1), address(1), address(1), address(1), address(1), uint256(0), uint16(1), uint64(0)))
    );
    g.module = ModuleProxyFactory(c.moduleProxyFactory).deployModule(
      g.moduleMastercopy,
      abi.encodeCall(
        CrispGovernanceModule.setUp,
        (abi.encode(g.safe, g.safe, g.delay, c.voting, c.multiSend, c.quorum, c.approvalBps, c.expiration))
      ),
      salt
    );

    // The Safe enables the Delay; the Safe, as the Delay's owner, enables the governance module.
    _safeExec(g.safe, c.deployer, g.safe, abi.encodeWithSignature("enableModule(address)", g.delay));
    _safeExec(g.safe, c.deployer, g.delay, abi.encodeWithSignature("enableModule(address)", g.module));
  }

  /// @dev A Safe call approved by its owner being the sender (`v = 1` signature).
  function _safeExec(address safe, address owner, address to, bytes memory data) internal {
    bytes memory signature = abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
    GnosisSafe(payable(safe)).execTransaction(to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);
  }
}
