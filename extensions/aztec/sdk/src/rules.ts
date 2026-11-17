// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { ProofType, getCountryParameterCommitment } from '@zkpassport/utils'
import { decodeAbiParameters, encodeAbiParameters, getAddress, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem'

import { SNARK_SCALAR_FIELD } from './constants'

/** `CRISPRemoteProgram.nationalityMode`: no nationality rule, nationality in the list, nationality not in the list. */
export const NATIONALITY_MODE = { NONE: 0, IN: 1, OUT: 2 } as const
export type NationalityMode = (typeof NATIONALITY_MODE)[keyof typeof NATIONALITY_MODE]

/** Most countries a rule lists (`CRISPRemoteProgram.MAX_COUNTRIES`, ZKPassport's list length). */
export const MAX_COUNTRIES = 200

/** Highest minimum age a round may require (`CRISPRemoteProgram.MAX_MIN_AGE`). */
export const MAX_MIN_AGE = 99n

/**
 * The rules of a round, as the poll creator passes them to `Interfold.request` in the program's custom parameters:
 * `abi.encode(numOptions, credits, minAge, allowMockDocuments, registrar, nationalityMode, countries, nationalityCommitment)`.
 */
export type RoundRules = {
  numOptions: bigint
  credits: bigint
  /** 0 for no age rule, else at most {@link MAX_MIN_AGE}. */
  minAge: bigint
  allowMockDocuments: boolean
  /**
   * The L1 `ZKPassportRegistrar` voters register through, or the zero address for a round whose voters register on Aztec.
   * A round uses one path, never both.
   */
  registrar: Address
  nationalityMode: NationalityMode
  /** ICAO alpha-3 codes (`DEU`, not the MRZ's `D<<`): 1 to {@link MAX_COUNTRIES} of them with a nationality rule, none without. */
  countries: string[]
  /**
   * Aztec path with a nationality rule: {@link nationalityCommitment} of the list, which the contract verifies the proof
   * against. Otherwise 0: the L1 registrar checks the list itself.
   */
  nationalityCommitment: bigint
}

const CUSTOM_PARAMS = parseAbiParameters(
  'uint256 numOptions, uint256 credits, uint256 minAge, bool allowMockDocuments, address registrar, uint8 nationalityMode, string[] countries, uint256 nationalityCommitment',
)

const COUNTRY = /^[A-Z]{3}$/

/** Check a nationality list the way the L1 program does: 1 to 200 codes of exactly three letters `A-Z`. */
export const assertCountries = (countries: readonly string[]): void => {
  if (countries.length === 0 || countries.length > MAX_COUNTRIES) throw new Error(`A nationality rule lists 1 to ${MAX_COUNTRIES} countries`)
  for (const country of countries)
    if (!COUNTRY.test(country)) throw new Error(`"${country}" is not an ICAO alpha-3 country code (three letters A-Z, e.g. DEU)`)
}

/**
 * ZKPassport's Poseidon2 parameter commitment of a nationality list: what the proof of a `nationality in` (mode 1) or
 * `nationality not in` (mode 2) request commits to, and what `open_round` of an Aztec-path round stores. An inclusion list
 * keeps the order given, an exclusion list is sorted the way ZKPassport sorts it, so any order works for mode 2.
 */
export const nationalityCommitment = async (mode: typeof NATIONALITY_MODE.IN | typeof NATIONALITY_MODE.OUT, countries: readonly string[]): Promise<bigint> => {
  assertCountries(countries)
  const exclusion = mode === NATIONALITY_MODE.OUT
  const commitment = await getCountryParameterCommitment(
    exclusion ? ProofType.NATIONALITY_EXCLUSION : ProofType.NATIONALITY_INCLUSION,
    [...countries] as Parameters<typeof getCountryParameterCommitment>[1],
    exclusion,
  )

  return commitment
}

/** Check the rules like `CRISPRemoteProgram.validate` does, so a poll the program would refuse is never requested. */
export const assertRules = (rules: RoundRules): void => {
  if (rules.minAge < 0n || rules.minAge > MAX_MIN_AGE) throw new Error(`The minimum age is at most ${MAX_MIN_AGE}`)
  if (rules.nationalityMode === NATIONALITY_MODE.NONE) {
    if (rules.countries.length !== 0 || rules.nationalityCommitment !== 0n) throw new Error('A round without a nationality rule lists no countries and no commitment')

    return
  }
  assertCountries(rules.countries)
  const l1Path = getAddress(rules.registrar) !== zeroAddress
  if (l1Path) {
    if (rules.nationalityCommitment !== 0n) throw new Error('A round that registers on L1 carries no nationality commitment: the registrar checks the list')
  } else if (rules.nationalityCommitment <= 0n || rules.nationalityCommitment >= SNARK_SCALAR_FIELD) {
    throw new Error('A round that registers on Aztec needs the list commitment (`nationalityCommitment`), below the field modulus')
  }
}

/** The program's custom parameters (`customParams` of `Interfold.request`) for a round with these rules. */
export const encodeCustomParams = (rules: RoundRules): Hex => {
  assertRules(rules)

  return encodeAbiParameters(CUSTOM_PARAMS, [
    rules.numOptions,
    rules.credits,
    rules.minAge,
    rules.allowMockDocuments,
    rules.registrar,
    rules.nationalityMode,
    rules.countries,
    rules.nationalityCommitment,
  ])
}

/** Inverse of {@link encodeCustomParams}; the rules are not re-validated (L1 did that when the round was requested). */
export const decodeCustomParams = (customParams: Hex): RoundRules => {
  const [numOptions, credits, minAge, allowMockDocuments, registrar, nationalityMode, countries, commitment] = decodeAbiParameters(CUSTOM_PARAMS, customParams)

  return {
    numOptions,
    credits,
    minAge,
    allowMockDocuments,
    registrar: getAddress(registrar),
    nationalityMode: nationalityMode as NationalityMode,
    countries: [...countries],
    nationalityCommitment: commitment,
  }
}

/** Whether voters of a round register on L1 (through its `ZKPassportRegistrar`) rather than on Aztec. */
export const registersOnL1 = (rules: Pick<RoundRules, 'registrar'>): boolean => getAddress(rules.registrar) !== zeroAddress

/**
 * Subproofs of the outer ZKPassport proof an Aztec-path round expects: the three every proof has, plus one each for the
 * age rule, the nationality rule and the binding to the voter's account. So 4 (bind), 5 (age or nationality) or 6 (both),
 * the outer circuit sizes `register`, `register_with_age` / `register_with_nationality` and
 * `register_with_age_and_nationality` verify.
 */
export const registrationSubproofs = (rules: { minAge: bigint; nationalityMode: number }): 4 | 5 | 6 =>
  (4 + (rules.minAge > 0n ? 1 : 0) + (rules.nationalityMode !== NATIONALITY_MODE.NONE ? 1 : 0)) as 4 | 5 | 6
