// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { IHonkVerifier } from "@crisp-e3/contracts/contracts/interfaces/IHonkVerifier.sol";
import { IVotesToken } from "@crisp-e3/contracts/contracts/interfaces/IVotesToken.sol";
import { HonkVerifier } from "@crisp-e3/contracts/contracts/verifiers/CRISPOnchainVerifier.sol";
import { MockOpenVmReceiptVerifier } from "@crisp-e3/contracts/contracts/test/MockOpenVmReceiptVerifier.sol";
import { IOpenVmReceiptVerifier } from "@interfold/contracts/contracts/interfaces/IOpenVmReceiptVerifier.sol";
import { IDataAvailabilityVerifier } from "@interfold/contracts/contracts/interfaces/IDataAvailabilityVerifier.sol";
import { IInterfold } from "@interfold/contracts/contracts/interfaces/IInterfold.sol";
import { MockDataAvailabilityVerifier } from "@interfold/contracts/contracts/test/MockDataAvailabilityVerifier.sol";
import { GnosisSafe } from "../vendor/safe-contracts/GnosisSafe.sol";
import { GnosisSafeProxyFactory } from "../vendor/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import { MultiSendCallOnly } from "../vendor/safe-contracts/libraries/MultiSendCallOnly.sol";
import { ModuleProxyFactory } from "@gnosis-guild/zodiac-core/contracts/factory/ModuleProxyFactory.sol";
import { CRISPGnosisProgram } from "../contracts/l1/CRISPGnosisProgram.sol";
import { CrispGnosisVoting } from "../contracts/chiado/CrispGnosisVoting.sol";
import { CrispDemoToken } from "../contracts/chiado/CrispDemoToken.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";
import { MockAMB } from "../contracts/test-mocks/MockAMB.sol";
import { GovernanceDeployer } from "./GovernanceDeployer.sol";

/// @dev The Interfold admin calls a local deploy makes when the deployer owns the Interfold.
interface IInterfoldAdmin {
  function owner() external view returns (address);

  function registerE3Program(address program) external;

  function e3Programs(address program) external view returns (bool);
}

interface IImageId {
  function imageId() external view returns (bytes32);
}

/// @notice Both chains on ONE local anvil: two `MockAMB` (Foreign = "Sepolia", Home = "Chiado"), the program, the voting
/// contract, the demo token, the real `CRISPOnchainVerifier`, and the Safe + Delay + governance module. It runs design
/// 11.2 through step 6 and writes `deployments/localhost.json`.
///
/// Run (the deployer owns the local Interfold, so it registers and binds the program, and is the Safe's only owner):
///
///   INTERFOLD=0x.. INPUT_SIGNER=0x.. FAUCET=0x.. PROPOSER=0x.. \
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $KEY
///
/// Optional: OPENVM_VERIFIER and DA_VERIFIER (mocks are deployed when absent), ONCHAIN_VERIFIER (a `HonkVerifier` is deployed
/// when absent), MIN_VOTING_DURATION, REMOTE_FINALITY_WINDOW, AMB_LATENCY_MARGIN (0: local rounds last minutes), MIN_VOTING_POWER,
/// FAUCET_AMOUNT, FAUCET_COOLDOWN, TREASURY, QUORUM, APPROVAL_BPS, DELAY_COOLDOWN, DELAY_EXPIRATION, PROPOSAL_EXPIRATION.
contract DeployLocal is GovernanceDeployer {
  struct Env {
    address interfold;
    address inputSigner;
    address faucet;
    address proposer;
  }

  struct Core {
    address foreignAmb;
    address homeAmb;
    address token;
    address onchainVerifier;
    address program;
    address voting;
    address multiSend;
    address safeSingleton;
    address safeProxyFactory;
    address moduleProxyFactory;
  }

  function run() external {
    Env memory env = Env({
      interfold: vm.envAddress("INTERFOLD"),
      inputSigner: vm.envAddress("INPUT_SIGNER"),
      faucet: vm.envAddress("FAUCET"),
      proposer: vm.envAddress("PROPOSER")
    });
    // A lower bound for log scans: every contract below is deployed in this block or later.
    uint256 deployBlock = block.number;

    vm.startBroadcast();
    (, address deployer, ) = vm.readCallers();

    Core memory core = _deployCore(env, deployer);
    GovernanceDeployer.Governance memory gov = _deployGovernanceStack(core, deployer);
    // The treasury the proposals spend: minted to the Safe, which does not delegate, so it carries no votes.
    CrispDemoToken(core.token).mintTreasury(gov.safe, vm.envOr("TREASURY", uint256(1_000_000e18)));
    vm.stopBroadcast();

    vm.writeFile("./deployments/localhost.json", _json(env.interfold, core, gov, deployBlock));
  }

  function _deployCore(Env memory env, address deployer) internal returns (Core memory core) {
    core.foreignAmb = address(new MockAMB(false, 4_000_000));
    core.homeAmb = address(new MockAMB(true, 2_000_000));

    CrispDemoToken token = new CrispDemoToken(deployer, vm.envOr("FAUCET_AMOUNT", uint256(1_000e18)), vm.envOr("FAUCET_COOLDOWN", uint256(1 days)));
    token.setFaucet(env.faucet);
    core.token = address(token);

    core.onchainVerifier = vm.envOr("ONCHAIN_VERIFIER", address(0));
    if (core.onchainVerifier == address(0)) core.onchainVerifier = address(new HonkVerifier());

    address openVm = vm.envOr("OPENVM_VERIFIER", address(0));
    if (openVm == address(0)) openVm = address(new MockOpenVmReceiptVerifier());
    address da = vm.envOr("DA_VERIFIER", address(0));
    if (da == address(0)) da = address(new MockDataAvailabilityVerifier());

    CRISPGnosisProgram program = new CRISPGnosisProgram(
      deployer,
      IOpenVmReceiptVerifier(openVm),
      IImageId(openVm).imageId(),
      IDataAvailabilityVerifier(da),
      vm.envOr("MIN_VOTING_DURATION", uint256(0)),
      vm.envOr("REMOTE_FINALITY_WINDOW", uint256(0)),
      IAMB(core.foreignAmb),
      vm.envOr("AMB_LATENCY_MARGIN", uint256(0))
    );
    core.program = address(program);

    CrispGnosisVoting voting = new CrispGnosisVoting(
      IAMB(core.homeAmb),
      env.interfold,
      core.program,
      IVotesToken(core.token),
      IHonkVerifier(core.onchainVerifier),
      env.inputSigner,
      vm.envOr("MIN_VOTING_POWER", uint256(0))
    );
    core.voting = address(voting);

    program.setRemote(core.voting);
    program.setProposer(env.proposer, true);

    // The deployer owns the local Interfold: register the program and bind it.
    IInterfoldAdmin interfold = IInterfoldAdmin(env.interfold);
    require(interfold.owner() == deployer, "deployer must own the local Interfold");
    interfold.registerE3Program(core.program);
    program.bindInterfold(IInterfold(env.interfold));
  }

  function _deployGovernanceStack(Core memory core, address deployer) internal returns (GovernanceDeployer.Governance memory gov) {
    core.safeSingleton = address(new GnosisSafe());
    core.safeProxyFactory = address(new GnosisSafeProxyFactory());
    core.multiSend = address(new MultiSendCallOnly());
    core.moduleProxyFactory = address(new ModuleProxyFactory());

    gov = _deployGovernance(
      GovernanceDeployer.GovernanceConfig({
        deployer: deployer,
        safeSingleton: core.safeSingleton,
        safeProxyFactory: core.safeProxyFactory,
        moduleProxyFactory: core.moduleProxyFactory,
        multiSend: core.multiSend,
        voting: core.voting,
        delayCooldown: vm.envOr("DELAY_COOLDOWN", uint256(300)),
        delayExpiration: vm.envOr("DELAY_EXPIRATION", uint256(7200)),
        // 1,000 dCOW per faucet claim: two voters' worth clears it.
        quorum: vm.envOr("QUORUM", uint256(2_000e18)),
        approvalBps: uint16(vm.envOr("APPROVAL_BPS", uint256(5_000))),
        expiration: uint64(vm.envOr("PROPOSAL_EXPIRATION", uint256(7 days)))
      })
    );
  }

  /// @dev `ambHelper` is the Home AMB itself: the mock serves `getSignatures` there.
  function _json(
    address interfold,
    Core memory core,
    GovernanceDeployer.Governance memory gov,
    uint256 deployBlock
  ) internal view returns (string memory json) {
    json = string.concat(
      '{\n  "chainId": ', vm.toString(block.chainid),
      ',\n  "deployBlock": ', vm.toString(deployBlock),
      ',\n  "interfold": "', vm.toString(interfold),
      '",\n  "program": "', vm.toString(core.program),
      '",\n  "foreignAmb": "', vm.toString(core.foreignAmb),
      '",\n  "homeAmb": "', vm.toString(core.homeAmb),
      '",\n  "ambHelper": "', vm.toString(core.homeAmb)
    );
    json = string.concat(
      json,
      '",\n  "voting": "', vm.toString(core.voting),
      '",\n  "token": "', vm.toString(core.token),
      '",\n  "onchainVerifier": "', vm.toString(core.onchainVerifier),
      '",\n  "safe": "', vm.toString(gov.safe),
      '",\n  "safeSingleton": "', vm.toString(core.safeSingleton),
      '",\n  "safeProxyFactory": "', vm.toString(core.safeProxyFactory)
    );
    json = string.concat(
      json,
      '",\n  "delayMastercopy": "', vm.toString(gov.delayMastercopy),
      '",\n  "delay": "', vm.toString(gov.delay),
      '",\n  "moduleMastercopy": "', vm.toString(gov.moduleMastercopy),
      '",\n  "module": "', vm.toString(gov.module),
      '",\n  "moduleProxyFactory": "', vm.toString(core.moduleProxyFactory),
      '",\n  "multiSend": "', vm.toString(core.multiSend),
      '",\n  "multiSendCallOnly": "', vm.toString(core.multiSend),
      '"\n}\n'
    );
  }
}
