// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem'

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
 * `abi.encode(numOptions, credits, minAge, allowMockDocuments, nationalityMode, countries, nationalityCommitment)`.
 */
export type RoundRules = {
  numOptions: bigint
  credits: bigint
  /** 0 for no age rule, else at most {@link MAX_MIN_AGE}. */
  minAge: bigint
  allowMockDocuments: boolean
  nationalityMode: NationalityMode
  /** ICAO alpha-3 codes (`DEU`, not the MRZ's `D<<`): 1 to {@link MAX_COUNTRIES} of them with a nationality rule, none without. */
  countries: string[]
  /**
   * With a nationality rule: {@link nationalityCommitment} of the list, which the contract verifies the proof
   * against. Otherwise 0.
   */
  nationalityCommitment: bigint
}

const CUSTOM_PARAMS = parseAbiParameters(
  'uint256 numOptions, uint256 credits, uint256 minAge, bool allowMockDocuments, uint8 nationalityMode, string[] countries, uint256 nationalityCommitment',
)

const COUNTRY = /^[A-Z]{3}$/

/** Check a nationality list the way the L1 program does: 1 to 200 codes of exactly three letters `A-Z`. */
export const assertCountries = (countries: readonly string[]): void => {
  if (countries.length === 0 || countries.length > MAX_COUNTRIES) throw new Error(`A nationality rule lists 1 to ${MAX_COUNTRIES} countries`)
  for (const country of countries)
    if (!COUNTRY.test(country)) throw new Error(`"${country}" is not an ICAO alpha-3 country code (three letters A-Z, e.g. DEU)`)
}

/** Check the rules like `CRISPRemoteProgram.validate` does, so a poll the program would refuse is never requested. */
export const assertRules = (rules: RoundRules): void => {
  if (rules.minAge < 0n || rules.minAge > MAX_MIN_AGE) throw new Error(`The minimum age is at most ${MAX_MIN_AGE}`)
  if (rules.nationalityMode === NATIONALITY_MODE.NONE) {
    if (rules.countries.length !== 0 || rules.nationalityCommitment !== 0n) throw new Error('A round without a nationality rule lists no countries and no commitment')

    return
  }
  assertCountries(rules.countries)
  if (rules.nationalityCommitment <= 0n || rules.nationalityCommitment >= SNARK_SCALAR_FIELD) {
    throw new Error('A round with a nationality rule needs the list commitment (`nationalityCommitment`), below the field modulus')
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
    rules.nationalityMode,
    rules.countries,
    rules.nationalityCommitment,
  ])
}

/** Inverse of {@link encodeCustomParams}; the rules are not re-validated (L1 did that when the round was requested). */
export const decodeCustomParams = (customParams: Hex): RoundRules => {
  const [numOptions, credits, minAge, allowMockDocuments, nationalityMode, countries, commitment] = decodeAbiParameters(CUSTOM_PARAMS, customParams)

  return {
    numOptions,
    credits,
    minAge,
    allowMockDocuments,
    nationalityMode: nationalityMode as NationalityMode,
    countries: [...countries],
    nationalityCommitment: commitment,
  }
}

/**
 * Subproofs of the outer ZKPassport proof a round expects: the three every proof has, plus one each for the
 * age rule, the nationality rule and the binding to the voter's account. So 4 (bind), 5 (age or nationality) or 6 (both),
 * the outer circuit sizes `register`, `register_with_age` / `register_with_nationality` and
 * `register_with_age_and_nationality` verify.
 */
export const registrationSubproofs = (rules: { minAge: bigint; nationalityMode: number }): 4 | 5 | 6 =>
  (4 + (rules.minAge > 0n ? 1 : 0) + (rules.nationalityMode !== NATIONALITY_MODE.NONE ? 1 : 0)) as 4 | 5 | 6
