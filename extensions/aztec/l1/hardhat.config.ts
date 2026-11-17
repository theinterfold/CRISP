// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import type { HardhatUserConfig } from 'hardhat/config'
import dotenv from 'dotenv'

import hardhatToolboxMochaEthersPlugin from '@nomicfoundation/hardhat-toolbox-mocha-ethers'

dotenv.config()

const mnemonic = process.env.MNEMONIC?.trim() || 'test test test test test test test test test test test junk'
const privateKey = process.env.PRIVATE_KEY?.trim()
const accounts = privateKey ? [privateKey] : { mnemonic }

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxMochaEthersPlugin],
  networks: {
    default: {
      accounts: { mnemonic },
      chainId: 31337,
      type: 'edr-simulated',
      chainType: 'l1',
      mining: { auto: true },
    },
    // The anvil L1 of `aztec start --local-network`.
    localhost: {
      accounts,
      chainId: 31337,
      type: 'http',
      url: process.env.LOCAL_RPC_URL ?? 'http://localhost:8545',
      timeout: 60000,
    },
    sepolia: {
      accounts,
      chainId: 11155111,
      type: 'http',
      url: process.env.RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
      chainType: 'l1',
    },
  },
  paths: {
    artifacts: './artifacts',
    cache: './cache',
    sources: './contracts',
    tests: './tests',
  },
  solidity: {
    version: '0.8.28',
    // Interfold's own mocks, built here so the tests can stand in for Interfold and the OpenVM and data-availability verifiers.
    npmFilesToBuild: ['@interfold/contracts/contracts/test/MockDataAvailabilityVerifier.sol'],
    settings: {
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 1 },
      metadata: { bytecodeHash: 'none' },
    },
  },
}

export default config
