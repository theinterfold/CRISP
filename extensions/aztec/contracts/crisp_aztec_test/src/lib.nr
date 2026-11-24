// TXE tests of `CrispAztec` (the votes contract's are in `votes.nr`).
//
// TXE does not execute proof verification (`verify_honk_proof_non_zk` and the ZKPassport outer proof are no-ops), so
// these tests cover everything around the verifications: message consumption, the registry and capsule plumbing, the
// verification-key hash checks and the links between the three base proofs, the attestation signature, the parent /
// window / limit / replay rules, and the two trees against Solidity-produced roots. Real proof verification is
// exercised against a local network (see the README).

mod base_fixture;
mod vectors;
mod votes;

use crisp_aztec::{CrispAztec, messages::round_content, types::{Config, RoundConfig}};
use crisp_aztec_lib::{
    ballot::{pk_commitment, CT0_PUBLIC_INPUTS, CT1_PUBLIC_INPUTS},
    constants::{NATIONALITY_IN, NATIONALITY_NONE, NATIONALITY_OUT},
    hashing::key_content,
    types::InputEntry,
};
use crate::base_fixture::{CRISP_VK, CRISP_VK_HASH, CT0_VK, CT0_VK_HASH, CT1_VK, CT1_VK_HASH};
use crate::vectors::{
    APPEND_INPUT_ROOT, CENSUS_LEAVES, CENSUS_ROOTS, Cast, DOMAIN_SEPARATOR, FIRST_BALLOT, OTHER_SLOT_REVOTE, REVOTE,
    SECOND_REVOTE, SHORT_LIVED, SIGNER_X, SIGNER_Y, SLOT_1, SLOT_2, SLOT_3, WRONG_SIGNER,
};
use aztec::{
    oracle::capsules,
    protocol::{address::{AztecAddress, EthAddress}, traits::{FromField, ToField}},
    test::helpers::test_environment::TestEnvironment,
};
use poseidon::poseidon::bn254::hash_2;
use zkpassport::{
    commitments::{
        age_commitment, bind_user_address_commitment, nationality_exclusion_commitment, nationality_inclusion_commitment,
    },
    constants::{NULLIFIER_TYPE_NON_SALTED, PI_PARAMS_START, PROOF_CAPSULE_SLOT, PROOF_FIELDS, VK_FIELDS},
    fixtures::proof::{
        AGE_FIXTURE_BLOB, AGE_FIXTURE_CERT_ROOT, AGE_FIXTURE_CIRCUIT_ROOT,
        AGE_FIXTURE_CURRENT_DATE, AGE_FIXTURE_VK_HASH,
    },
};
use zkpassport_aztec_verifier::verify::scope_hash;
use zkpassport_registry_contract::local_network_registry::{
    deploy_local_network_registry, LOCAL_NETWORK_REGISTRY_ADDRESS, seed_local_network_registry,
};

global DAY: u64 = 86400;
global ROUND_ID: Field = 7;
global NUM_OPTIONS: Field = 3;
global CREDITS: Field = 100;
global L1_PROGRAM: EthAddress = EthAddress::from_field(0x1111111111111111111111111111111111111111);
global INTERFOLD: EthAddress = EthAddress::from_field(0xdfa59d66c173a00643ebe80e172af5a8cf244b30);
// packed("0.23.0"): the circuits release the ZKPassport age fixture was proved with.
global ZKPASSPORT_VERSION: Field = 0x0000001700000000000000000000000000000000000000000000000000000000;
// The ZKPassport fixture is future-dated; the TXE clock starts a day after its date, inside its validity period.
global T0: u64 = AGE_FIXTURE_CURRENT_DATE + DAY + 1;
global INPUT_START: u64 = T0 + 100;
global INPUT_END: u64 = T0 + 10000;
global LIMIT: u32 = 65536;
// Round bookkeeping is permissionless, so any address may send it.
global KEEPER: AztecAddress = AztecAddress::from_field(0xbee);
// The fixture's proof was made for the empty scope.
global FIXTURE_SCOPE: Field = 0;

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------

/// A TXE with the ZKPassport registry seeded for the age fixture and `CrispAztec` deployed, at time `T0`.
unconstrained fn deploy() -> (TestEnvironment, AztecAddress) {
    let mut env = TestEnvironment::new();
    let _ = deploy_local_network_registry(&mut env, "@zkpassport_registry_contract/ZKPassportRegistry");
    seed_local_network_registry(
        &mut env,
        ZKPASSPORT_VERSION,
        AGE_FIXTURE_CERT_ROOT,
        AGE_FIXTURE_CIRCUIT_ROOT,
        AGE_FIXTURE_VK_HASH,
        AGE_FIXTURE_CURRENT_DATE - 100,
    );
    let deployer = env.create_light_account();
    let crisp = env.deploy("@crisp_aztec/CrispAztec").with_public_initializer(
        deployer,
        CrispAztec::interface().constructor(
            L1_PROGRAM,
            INTERFOLD,
            DOMAIN_SEPARATOR,
            DOMAIN_SEPARATOR,
            SIGNER_X,
            SIGNER_Y,
            CT0_VK_HASH,
            CT1_VK_HASH,
            CRISP_VK_HASH,
            scope_hash("example.com"),
            ZKPASSPORT_VERSION,
            7 * DAY,
            LOCAL_NETWORK_REGISTRY_ADDRESS,
        ),
    );
    env.mine_block_at(T0);
    (env, crisp)
}

/// The rule-shaped part of a ROUND message: the age and the nationality rule.
struct Rules {
    min_age: u8,
    nationality_mode: u8,
    nationality_commitment: Field,
}

/// A round with an age rule and no nationality rule.
fn age_rules(min_age: u8) -> Rules {
    Rules { min_age, nationality_mode: 0, nationality_commitment: 0 }
}

unconstrained fn send_round_with(
    env: TestEnvironment,
    crisp: AztecAddress,
    scope: Field,
    rules: Rules,
    limit: u32,
) -> Field {
    env.send_l1_to_l2_message(
        round_content(
            ROUND_ID,
            NUM_OPTIONS,
            CREDITS,
            INPUT_START,
            INPUT_END,
            limit,
            scope,
            rules.min_age,
            true,
            rules.nationality_mode,
            rules.nationality_commitment,
        ),
        0,
        L1_PROGRAM,
        crisp,
    )
}

unconstrained fn send_round(
    env: TestEnvironment,
    crisp: AztecAddress,
    scope: Field,
    min_age: u8,
    limit: u32,
) -> Field {
    send_round_with(env, crisp, scope, age_rules(min_age), limit)
}

unconstrained fn open_round_with(
    env: TestEnvironment,
    crisp: AztecAddress,
    scope: Field,
    rules: Rules,
    limit: u32,
) {
    let leaf_index = send_round_with(env, crisp, scope, rules, limit);
    let keeper = KEEPER;
    let _ = env.call_public(
        keeper,
        CrispAztec::at(crisp).open_round(
            ROUND_ID,
            NUM_OPTIONS,
            CREDITS,
            INPUT_START,
            INPUT_END,
            limit,
            scope,
            rules.min_age,
            true,
            rules.nationality_mode,
            rules.nationality_commitment,
            leaf_index,
        ),
    );
}

unconstrained fn open_round(env: TestEnvironment, crisp: AztecAddress, scope: Field, min_age: u8, limit: u32) {
    open_round_with(env, crisp, scope, age_rules(min_age), limit);
}

unconstrained fn publish_key(env: TestEnvironment, crisp: AztecAddress) {
    let key = committee_key();
    let leaf_index = env.send_l1_to_l2_message(key_content(ROUND_ID, key), 0, L1_PROGRAM, crisp);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztec::at(crisp).publish_key(ROUND_ID, key, leaf_index));
}

/// A round with a committee key, no minimum age, and the fixture's scope.
unconstrained fn open(limit: u32) -> (TestEnvironment, AztecAddress) {
    let (env, crisp) = deploy();
    open_round(env, crisp, FIXTURE_SCOPE, 0, limit);
    publish_key(env, crisp);
    (env, crisp)
}

/// The base proofs' public inputs of an honest ballot. The commitments are arbitrary: TXE does not check the proofs,
/// and `cast` only links the values.
fn ct0_inputs() -> [Field; CT0_PUBLIC_INPUTS] {
    [0x1001, 0x1002, 0x1003, 0x1004] // pk0, ct0, k1, u
}

fn ct1_inputs() -> [Field; CT1_PUBLIC_INPUTS] {
    [0x2001, 0x2002, 0x1004] // pk1, ct1, u
}

/// The committee key of the test rounds, and the one an honest ballot is encrypted to: the commitment of its two
/// public-key halves.
fn committee_key() -> Field {
    pk_commitment(ct0_inputs(), ct1_inputs())
}

/// The ZKPassport age fixture (`outer_count_5`: `age(18)` and a bind) re-bound to `user`, with its unique identifier
/// moved by `identifier_offset` so one fixture stands for several documents. The fixture is bound to a fixed address
/// that TXE has no account for, and TXE does not check the proof, so the substitution is possible here and only here.
/// The same goes for the nullifier type: the fixture is the proof of a mock (ZKR) document, which the tests make an
/// ordinary (non-salted) one, so that rounds that do not allow mock documents accept it.
unconstrained fn age_proof(user: AztecAddress, identifier_offset: Field) -> [Field; 584] {
    let mut blob = AGE_FIXTURE_BLOB;
    let params = VK_FIELDS + PROOF_FIELDS + PI_PARAMS_START;
    for i in params..params + 2 {
        if blob[i] != age_commitment(18, 0) {
            blob[i] = bind_user_address_commitment(user.to_field());
        }
    }
    blob[params + 2] = NULLIFIER_TYPE_NON_SALTED as Field;
    blob[581] += identifier_offset;
    blob
}

/// The same proof for a query without an age check (`outer_count_4`: a bind alone).
unconstrained fn bind_proof(user: AztecAddress, identifier_offset: Field) -> [Field; 583] {
    let age = age_proof(user, identifier_offset);
    let mut blob = [0; 583];
    let params = VK_FIELDS + PROOF_FIELDS + PI_PARAMS_START;
    for i in 0..params {
        blob[i] = age[i];
    }
    blob[params] = bind_user_address_commitment(user.to_field());
    blob[params + 1] = age[params + 2];
    blob[params + 2] = age[params + 3];
    blob[params + 3] = age[params + 4];
    blob[params + 4] = age[params + 5];
    blob
}

/// An outer proof with `N` parameter commitments (`outer_count_{N + 3}`), made from the age fixture's header and
/// trailer (nullifier type, unique identifier moved by `identifier_offset`, OPRF key hash, verification method).
unconstrained fn proof_with<let N: u32>(identifier_offset: Field, commitments: [Field; N]) -> [Field; 582 + N] {
    let age = age_proof(AztecAddress::from_field(1), identifier_offset);
    let params = VK_FIELDS + PROOF_FIELDS + PI_PARAMS_START;
    let mut blob = [0; 582 + N];
    for i in 0..params {
        blob[i] = age[i];
    }
    for i in 0..N {
        blob[params + i] = commitments[i];
    }
    for i in 0..4 {
        blob[params + N + i] = age[params + 2 + i];
    }
    blob
}

/// The proof for a query with a nationality rule and a bind (`outer_count_5`).
unconstrained fn nationality_proof(user: AztecAddress, identifier_offset: Field, commitment: Field) -> [Field; 584] {
    proof_with(identifier_offset, [commitment, bind_user_address_commitment(user.to_field())])
}

/// The proof for a query with an age check, a nationality rule and a bind (`outer_count_6`).
unconstrained fn age_nationality_proof(user: AztecAddress, identifier_offset: Field, commitment: Field) -> [Field; 585] {
    proof_with(
        identifier_offset,
        [age_commitment(18, 0), commitment, bind_user_address_commitment(user.to_field())],
    )
}

/// ZKPassport's parameter commitments of the lists the tests use; the SDK's `nationalityCommitment` returns the same.
fn inclusion_commitment() -> Field {
    nationality_inclusion_commitment(["FRA", "DEU", "ITA"])
}

fn exclusion_commitment() -> Field {
    nationality_exclusion_commitment(["PRK", "IRN", "SYR"])
}

fn nationality_rules(min_age: u8, mode: u8, commitment: Field) -> Rules {
    Rules { min_age, nationality_mode: mode, nationality_commitment: commitment }
}

/// A round with a committee key and the given rules.
unconstrained fn open_with(rules: Rules) -> (TestEnvironment, AztecAddress) {
    let (env, crisp) = deploy();
    open_round_with(env, crisp, FIXTURE_SCOPE, rules, LIMIT);
    publish_key(env, crisp);
    (env, crisp)
}

/// `open_round` with rule arguments as given, to reach its validation (no message is consumed before it).
unconstrained fn open_unchecked(
    env: TestEnvironment,
    crisp: AztecAddress,
    nationality_mode: u8,
    nationality_commitment: Field,
) {
    let _ = env.call_public(
        KEEPER,
        CrispAztec::at(crisp).open_round(
            ROUND_ID,
            NUM_OPTIONS,
            CREDITS,
            INPUT_START,
            INPUT_END,
            LIMIT,
            FIXTURE_SCOPE,
            0,
            true,
            nationality_mode,
            nationality_commitment,
            0,
        ),
    );
}

unconstrained fn deliver<let N: u32>(env: TestEnvironment, crisp: AztecAddress, user: AztecAddress, blob: [Field; N]) {
    env.utility_context_at(crisp, |_| { capsules::store(crisp, PROOF_CAPSULE_SLOT, blob, user); });
}

unconstrained fn register(
    env: TestEnvironment,
    crisp: AztecAddress,
    user: AztecAddress,
    slot: Field,
    identifier_offset: Field,
) {
    deliver(env, crisp, user, bind_proof(user, identifier_offset));
    env.call_private(user, CrispAztec::at(crisp).register(ROUND_ID, slot));
}

/// The three base proofs `cast` takes: verification keys, proofs (zeros: TXE does not check them) and public inputs.
struct BaseProofs {
    ct0_vk: [Field; 115],
    ct1_vk: [Field; 115],
    crisp_vk: [Field; 115],
    ct0_inputs: [Field; CT0_PUBLIC_INPUTS],
    ct1_inputs: [Field; CT1_PUBLIC_INPUTS],
}

fn honest_proofs() -> BaseProofs {
    BaseProofs { ct0_vk: CT0_VK, ct1_vk: CT1_VK, crisp_vk: CRISP_VK, ct0_inputs: ct0_inputs(), ct1_inputs: ct1_inputs() }
}

unconstrained fn cast_with(
    env: TestEnvironment,
    crisp: AztecAddress,
    from: AztecAddress,
    base: BaseProofs,
    c: Cast,
    census_root: Field,
) {
    env.call_private(
        from,
        CrispAztec::at(crisp).cast(
            ROUND_ID,
            base.ct0_vk,
            [0; 410],
            base.ct0_inputs,
            base.ct1_vk,
            [0; 410],
            base.ct1_inputs,
            base.crisp_vk,
            [0; 410],
            c.slot,
            c.ct_commitment,
            c.encrypted_vote_hash,
            c.parent_index_plus_one,
            c.prev_commitment,
            census_root,
            c.expires_at,
            c.signature,
        ),
    );
}

unconstrained fn cast(env: TestEnvironment, crisp: AztecAddress, from: AztecAddress, c: Cast, census_root: Field) {
    cast_with(env, crisp, from, honest_proofs(), c, census_root);
}

/// An open round with `SLOT_1` and `SLOT_2` registered, the input window open. Returns the census root.
unconstrained fn open_for_casting(limit: u32) -> (TestEnvironment, AztecAddress, AztecAddress, Field) {
    let (mut env, crisp) = open(limit);
    let voter_1 = env.create_light_account();
    let voter_2 = env.create_light_account();
    register(env, crisp, voter_1, SLOT_1, 1);
    register(env, crisp, voter_2, SLOT_2, 2);
    env.mine_block_at(INPUT_START);
    let census_root = hash_2([hash_2([SLOT_1, CREDITS]), hash_2([SLOT_2, CREDITS])]);
    (env, crisp, voter_1, census_root)
}

// ---------------------------------------------------------------------------------------------------------------------
// Deployment and L1 messages
// ---------------------------------------------------------------------------------------------------------------------

#[test]
unconstrained fn constructor_stores_the_configuration() {
    let (env, crisp) = deploy();
    let config: Config = env.execute_utility(CrispAztec::at(crisp).get_config());
    assert_eq(config.l1_program, L1_PROGRAM);
    assert_eq(config.interfold, INTERFOLD);
    assert_eq(config.ct0_vk_hash, CT0_VK_HASH);
    assert_eq(config.ct1_vk_hash, CT1_VK_HASH);
    assert_eq(config.crisp_vk_hash, CRISP_VK_HASH);
    assert_eq(config.zkpassport_registry, LOCAL_NETWORK_REGISTRY_ADDRESS);
    assert_eq(config.zkpassport_domain, scope_hash("example.com"));
    assert_eq(config.zkpassport_validity_period, 7 * DAY);
}

#[test]
unconstrained fn open_round_consumes_the_round_message() {
    let (env, crisp) = deploy();
    open_round(env, crisp, FIXTURE_SCOPE, 18, 1000);
    let round: RoundConfig = env.execute_utility(CrispAztec::at(crisp).get_round(ROUND_ID));
    assert_eq(round.num_options, NUM_OPTIONS);
    assert_eq(round.credits, CREDITS);
    assert_eq(round.input_start, INPUT_START);
    assert_eq(round.input_end, INPUT_END);
    assert_eq(round.input_limit, 1000);
    assert_eq(round.min_age, 18);
    assert(round.allow_mock_documents);
    assert_eq(round.nationality_mode, 0);
    assert_eq(round.nationality_commitment, 0);
}

#[test(should_fail)]
unconstrained fn a_round_cannot_be_opened_twice() {
    let (env, crisp) = deploy();
    let leaf_index = send_round(env, crisp, FIXTURE_SCOPE, 0, LIMIT);
    let keeper = KEEPER;
    let call = CrispAztec::at(crisp).open_round(
        ROUND_ID,
        NUM_OPTIONS,
        CREDITS,
        INPUT_START,
        INPUT_END,
        LIMIT,
        FIXTURE_SCOPE,
        0,
        true,
        0,
        0,
        leaf_index,
    );
    let _ = env.call_public(keeper, call);
    let _ = env.call_public(keeper, call);
}

#[test(should_fail)]
unconstrained fn open_round_rejects_arguments_the_message_does_not_carry() {
    let (env, crisp) = deploy();
    let leaf_index = send_round(env, crisp, FIXTURE_SCOPE, 0, LIMIT);
    let keeper = KEEPER;
    // One credit more than L1 sent.
    let _ = env.call_public(
        keeper,
        CrispAztec::at(crisp).open_round(
            ROUND_ID,
            NUM_OPTIONS,
            CREDITS + 1,
            INPUT_START,
            INPUT_END,
            LIMIT,
            FIXTURE_SCOPE,
            0,
            true,
            0,
            0,
            leaf_index,
        ),
    );
}

#[test(should_fail_with = "input limit out of range")]
unconstrained fn open_round_rejects_a_limit_above_the_tree_capacity() {
    let (env, crisp) = deploy();
    open_round(env, crisp, FIXTURE_SCOPE, 0, 65537);
}

#[test(should_fail)]
unconstrained fn open_round_rejects_a_round_id_of_96_bits_or_more() {
    let (env, crisp) = deploy();
    let round_id = 0x1000000000000000000000000;
    let leaf_index = env.send_l1_to_l2_message(
        round_content(round_id, NUM_OPTIONS, CREDITS, INPUT_START, INPUT_END, LIMIT, FIXTURE_SCOPE, 0, true, 0, 0),
        0,
        L1_PROGRAM,
        crisp,
    );
    let _ = env.call_public(
        KEEPER,
        CrispAztec::at(crisp).open_round(
            round_id,
            NUM_OPTIONS,
            CREDITS,
            INPUT_START,
            INPUT_END,
            LIMIT,
            FIXTURE_SCOPE,
            0,
            true,
            0,
            0,
            leaf_index,
        ),
    );
}

#[test(should_fail_with = "empty input window")]
unconstrained fn open_round_rejects_an_empty_window() {
    let (env, crisp) = deploy();
    let keeper = KEEPER;
    let _ = env.call_public(
        keeper,
        CrispAztec::at(crisp).open_round(
            ROUND_ID,
            NUM_OPTIONS,
            CREDITS,
            INPUT_END,
            INPUT_START,
            LIMIT,
            FIXTURE_SCOPE,
            0,
            true,
            0,
            0,
            0,
        ),
    );
}

#[test]
unconstrained fn publish_key_stores_the_committee_key() {
    let (env, crisp) = open(LIMIT);
    let key: Field = env.execute_utility(CrispAztec::at(crisp).get_committee_key(ROUND_ID));
    assert_eq(key, committee_key());
}

#[test(should_fail)]
unconstrained fn the_committee_key_cannot_be_published_twice() {
    let (env, crisp) = open(LIMIT);
    let leaf_index = env.send_l1_to_l2_message(key_content(ROUND_ID, committee_key()), 0, L1_PROGRAM, crisp);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztec::at(crisp).publish_key(ROUND_ID, committee_key(), leaf_index));
}

#[test(should_fail)]
unconstrained fn publish_key_rejects_a_key_the_message_does_not_carry() {
    let (env, crisp) = deploy();
    let leaf_index = env.send_l1_to_l2_message(key_content(ROUND_ID, committee_key()), 0, L1_PROGRAM, crisp);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztec::at(crisp).publish_key(ROUND_ID, committee_key() + 1, leaf_index));
}

// ---------------------------------------------------------------------------------------------------------------------
// Registration (ZKPassport)
// ---------------------------------------------------------------------------------------------------------------------

#[test]
unconstrained fn register_adds_the_slot_to_the_census() {
    let (mut env, crisp) = open(LIMIT);
    let user = env.create_light_account();
    register(env, crisp, user, SLOT_1, 0);
    assert(env.execute_utility(CrispAztec::at(crisp).is_slot_registered(ROUND_ID, SLOT_1)));
    assert_eq(env.execute_utility(CrispAztec::at(crisp).get_census_count(ROUND_ID)), 1);
    assert_eq(env.execute_utility(CrispAztec::at(crisp).get_census_root(ROUND_ID)), hash_2([SLOT_1, CREDITS]));
}

#[test]
unconstrained fn register_with_age_accepts_the_age_fixture() {
    let (mut env, crisp) = deploy();
    open_round(env, crisp, FIXTURE_SCOPE, 18, LIMIT);
    let user = env.create_light_account();
    deliver(env, crisp, user, age_proof(user, 0));
    env.call_private(user, CrispAztec::at(crisp).register_with_age(ROUND_ID, SLOT_1));
    assert_eq(env.execute_utility(CrispAztec::at(crisp).get_census_count(ROUND_ID)), 1);
}

#[test(should_fail_with = "round requires an age proof")]
unconstrained fn register_rejects_a_round_with_a_minimum_age() {
    let (mut env, crisp) = deploy();
    open_round(env, crisp, FIXTURE_SCOPE, 18, LIMIT);
    let user = env.create_light_account();
    register(env, crisp, user, SLOT_1, 0);
}

#[test(should_fail_with = "round has no age requirement")]
unconstrained fn register_with_age_rejects_a_round_without_a_minimum_age() {
    let (mut env, crisp) = open(LIMIT);
    let user = env.create_light_account();
    deliver(env, crisp, user, age_proof(user, 0));
    env.call_private(user, CrispAztec::at(crisp).register_with_age(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "missing zkpassport proof capsule")]
unconstrained fn register_needs_the_proof_capsule() {
    let (mut env, crisp) = open(LIMIT);
    let user = env.create_light_account();
    env.call_private(user, CrispAztec::at(crisp).register(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "param commitment mismatch")]
unconstrained fn register_rejects_a_proof_bound_to_another_account() {
    let (mut env, crisp) = open(LIMIT);
    let owner = env.create_light_account();
    let thief = env.create_light_account();
    // The thief runs the owner's proof from its own PXE.
    deliver(env, crisp, thief, bind_proof(owner, 0));
    env.call_private(thief, CrispAztec::at(crisp).register(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "wrong service scope")]
unconstrained fn register_rejects_a_proof_made_for_another_scope() {
    let (mut env, crisp) = deploy();
    // A round with the scope hash L1 would send; the fixture proof was made for the empty scope.
    open_round(env, crisp, 0x008dd59c13f83565652b01b900ad3b985b618143457c2ed863ced895ab444b46, 0, LIMIT);
    let user = env.create_light_account();
    register(env, crisp, user, SLOT_1, 0);
}

#[test(should_fail)]
unconstrained fn one_document_registers_once_per_round() {
    let (mut env, crisp) = open(LIMIT);
    let user = env.create_light_account();
    register(env, crisp, user, SLOT_1, 0);
    // The same document under another slot: its uniqueness nullifier is spent.
    register(env, crisp, user, SLOT_2, 0);
}

#[test(should_fail_with = "slot already registered")]
unconstrained fn a_slot_registers_once() {
    let (mut env, crisp) = open(LIMIT);
    let first = env.create_light_account();
    let second = env.create_light_account();
    register(env, crisp, first, SLOT_1, 1);
    // A different document asking for the same slot.
    register(env, crisp, second, SLOT_1, 2);
}

#[test(should_fail_with = "registration closed")]
unconstrained fn registration_closes_with_the_input_window() {
    let (mut env, crisp) = open(LIMIT);
    env.mine_block_at(INPUT_END);
    let user = env.create_light_account();
    register(env, crisp, user, SLOT_1, 0);
}

#[test(should_fail)]
unconstrained fn registration_needs_an_open_round() {
    let (mut env, crisp) = deploy();
    let user = env.create_light_account();
    register(env, crisp, user, SLOT_1, 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Registration with a nationality rule
// ---------------------------------------------------------------------------------------------------------------------

#[test]
unconstrained fn the_nationality_commitment_helper_matches_the_zkpassport_fixture() {
    // ZKPassport's own anchor (`vendor/zkpassport/core/src/fixtures.nr`, NATIONALITY_INCLUSION_COMMITMENT): the SDK's
    // `nationalityCommitment(1, ["FRA", "DEU", "ITA"])` is pinned to the same value.
    assert_eq(inclusion_commitment(), 0x2dc5e592e38eeb5eee6d4a8b977465cfda38f3f278567b46a50a8d1a6fc0a5b4);
    assert_eq(exclusion_commitment(), 0x2837d9da8e0b7bf3895bdd5acaeb4aef29a4114c2621e9d046f2db11c599ccec);
}

#[test]
unconstrained fn register_with_nationality_accepts_an_inclusion_proof() {
    let (mut env, crisp) = open_with(nationality_rules(0, NATIONALITY_IN, inclusion_commitment()));
    let user = env.create_light_account();
    deliver(env, crisp, user, nationality_proof(user, 0, inclusion_commitment()));
    env.call_private(user, CrispAztec::at(crisp).register_with_nationality(ROUND_ID, SLOT_1));
    assert_eq(env.execute_utility(CrispAztec::at(crisp).get_census_count(ROUND_ID)), 1);
    assert_eq(env.execute_utility(CrispAztec::at(crisp).get_census_root(ROUND_ID)), hash_2([SLOT_1, CREDITS]));
}

#[test]
unconstrained fn register_with_nationality_accepts_an_exclusion_proof() {
    let (mut env, crisp) = open_with(nationality_rules(0, NATIONALITY_OUT, exclusion_commitment()));
    let user = env.create_light_account();
    deliver(env, crisp, user, nationality_proof(user, 0, exclusion_commitment()));
    env.call_private(user, CrispAztec::at(crisp).register_with_nationality(ROUND_ID, SLOT_1));
    assert_eq(env.execute_utility(CrispAztec::at(crisp).get_census_count(ROUND_ID)), 1);
}

#[test(should_fail_with = "param commitment mismatch")]
unconstrained fn register_with_nationality_rejects_a_proof_for_another_list() {
    let (mut env, crisp) = open_with(nationality_rules(0, NATIONALITY_IN, inclusion_commitment()));
    let user = env.create_light_account();
    deliver(env, crisp, user, nationality_proof(user, 0, exclusion_commitment()));
    env.call_private(user, CrispAztec::at(crisp).register_with_nationality(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "param commitment mismatch")]
unconstrained fn register_with_nationality_rejects_a_proof_bound_to_another_account() {
    let (mut env, crisp) = open_with(nationality_rules(0, NATIONALITY_IN, inclusion_commitment()));
    let owner = env.create_light_account();
    let thief = env.create_light_account();
    deliver(env, crisp, thief, nationality_proof(owner, 0, inclusion_commitment()));
    env.call_private(thief, CrispAztec::at(crisp).register_with_nationality(ROUND_ID, SLOT_1));
}

#[test]
unconstrained fn register_with_age_and_nationality_accepts_both_proofs() {
    let (mut env, crisp) = open_with(nationality_rules(18, NATIONALITY_IN, inclusion_commitment()));
    let user = env.create_light_account();
    deliver(env, crisp, user, age_nationality_proof(user, 0, inclusion_commitment()));
    env.call_private(user, CrispAztec::at(crisp).register_with_age_and_nationality(ROUND_ID, SLOT_1));
    assert_eq(env.execute_utility(CrispAztec::at(crisp).get_census_count(ROUND_ID)), 1);
}

#[test(should_fail_with = "param commitment mismatch")]
unconstrained fn register_with_age_and_nationality_rejects_another_age_bound() {
    let (mut env, crisp) = open_with(nationality_rules(21, NATIONALITY_IN, inclusion_commitment()));
    let user = env.create_light_account();
    // The proof shows 18+, the round asks for 21+.
    deliver(env, crisp, user, age_nationality_proof(user, 0, inclusion_commitment()));
    env.call_private(user, CrispAztec::at(crisp).register_with_age_and_nationality(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "round requires a nationality proof")]
unconstrained fn register_rejects_a_round_with_a_nationality_rule() {
    let (mut env, crisp) = open_with(nationality_rules(0, NATIONALITY_IN, inclusion_commitment()));
    let user = env.create_light_account();
    env.call_private(user, CrispAztec::at(crisp).register(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "round requires a nationality proof")]
unconstrained fn register_with_age_rejects_a_round_with_a_nationality_rule() {
    let (mut env, crisp) = open_with(nationality_rules(18, NATIONALITY_IN, inclusion_commitment()));
    let user = env.create_light_account();
    env.call_private(user, CrispAztec::at(crisp).register_with_age(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "round has no nationality requirement")]
unconstrained fn register_with_nationality_rejects_a_round_without_a_nationality_rule() {
    let (mut env, crisp) = open(LIMIT);
    let user = env.create_light_account();
    env.call_private(user, CrispAztec::at(crisp).register_with_nationality(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "round requires an age proof")]
unconstrained fn register_with_nationality_rejects_a_round_with_a_minimum_age() {
    let (mut env, crisp) = open_with(nationality_rules(18, NATIONALITY_IN, inclusion_commitment()));
    let user = env.create_light_account();
    env.call_private(user, CrispAztec::at(crisp).register_with_nationality(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "round has no age requirement")]
unconstrained fn register_with_age_and_nationality_rejects_a_round_without_a_minimum_age() {
    let (mut env, crisp) = open_with(nationality_rules(0, NATIONALITY_IN, inclusion_commitment()));
    let user = env.create_light_account();
    env.call_private(user, CrispAztec::at(crisp).register_with_age_and_nationality(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "round has no nationality requirement")]
unconstrained fn register_with_age_and_nationality_rejects_a_round_without_a_nationality_rule() {
    let (mut env, crisp) = deploy();
    open_round(env, crisp, FIXTURE_SCOPE, 18, LIMIT);
    let user = env.create_light_account();
    env.call_private(user, CrispAztec::at(crisp).register_with_age_and_nationality(ROUND_ID, SLOT_1));
}

#[test(should_fail_with = "unexpected nationality commitment")]
unconstrained fn open_round_rejects_a_commitment_without_a_nationality_rule() {
    let (env, crisp) = deploy();
    open_unchecked(env, crisp, NATIONALITY_NONE, 1);
}

#[test(should_fail_with = "missing nationality commitment")]
unconstrained fn open_round_rejects_a_nationality_rule_without_a_commitment() {
    let (env, crisp) = deploy();
    open_unchecked(env, crisp, NATIONALITY_IN, 0);
}

#[test(should_fail_with = "invalid nationality mode")]
unconstrained fn open_round_rejects_an_unknown_nationality_mode() {
    let (env, crisp) = deploy();
    open_unchecked(env, crisp, 3, 1);
}

#[test]
unconstrained fn open_round_stores_the_nationality_rule() {
    let (env, crisp) = deploy();
    open_round_with(env, crisp, FIXTURE_SCOPE, nationality_rules(18, NATIONALITY_OUT, exclusion_commitment()), LIMIT);
    let round: RoundConfig = env.execute_utility(CrispAztec::at(crisp).get_round(ROUND_ID));
    assert_eq(round.nationality_mode, NATIONALITY_OUT);
    assert_eq(round.nationality_commitment, exclusion_commitment());
}

// ---------------------------------------------------------------------------------------------------------------------
// Census tree
// ---------------------------------------------------------------------------------------------------------------------

#[test]
unconstrained fn the_census_root_matches_the_sdk_tree() {
    let (mut env, crisp) = open(LIMIT);
    let slots = [SLOT_1, SLOT_2, SLOT_3];
    for i in 0..3 {
        let user = env.create_light_account();
        register(env, crisp, user, slots[i], 1 + i as Field);
        let root: Field = env.execute_utility(CrispAztec::at(crisp).get_census_root(ROUND_ID));
        assert_eq(root, CENSUS_ROOTS[i]);
        assert_eq(hash_2([slots[i], CREDITS]), CENSUS_LEAVES[i]);
    }
    assert_eq(env.execute_utility(CrispAztec::at(crisp).get_census_count(ROUND_ID)), 3);
}

#[test]
unconstrained fn every_past_census_root_stays_known() {
    let (mut env, crisp) = open(LIMIT);
    let slots = [SLOT_1, SLOT_2, SLOT_3];
    for i in 0..3 {
        let user = env.create_light_account();
        register(env, crisp, user, slots[i], 1 + i as Field);
    }
    for i in 0..3 {
        assert(env.execute_utility(CrispAztec::at(crisp).is_census_root_known(ROUND_ID, CENSUS_ROOTS[i])));
    }
    assert(!env.execute_utility(CrispAztec::at(crisp).is_census_root_known(ROUND_ID, CENSUS_ROOTS[0] + 1)));
}

// ---------------------------------------------------------------------------------------------------------------------
// Ballots
// ---------------------------------------------------------------------------------------------------------------------

#[test]
unconstrained fn casts_build_the_input_tree_the_l1_program_builds() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);

    cast(env, crisp, voter, FIRST_BALLOT, census_root);
    cast(env, crisp, voter, REVOTE, census_root);
    cast(env, crisp, voter, SECOND_REVOTE, census_root);

    assert_eq(env.execute_utility(CrispAztec::at(crisp).get_input_count(ROUND_ID)), 3);
    let entry: InputEntry = env.execute_utility(CrispAztec::at(crisp).get_input(ROUND_ID, 1));
    assert_eq(entry.slot, SLOT_1);
    assert_eq(entry.commitment, REVOTE.ct_commitment);

    // The same three inputs, in the same order, gave this root in the real CRISPProgram.
    env.mine_block_at(INPUT_END);
    let root = env.call_public(voter, CrispAztec::at(crisp).close_round(ROUND_ID));
    assert_eq(root, APPEND_INPUT_ROOT);
}

#[test(should_fail_with = "unexpected ct0 verification key")]
unconstrained fn cast_rejects_another_ct0_verification_key() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut base = honest_proofs();
    base.ct0_vk[3] += 1;
    cast_with(env, crisp, voter, base, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "unexpected ct1 verification key")]
unconstrained fn cast_rejects_another_ct1_verification_key() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut base = honest_proofs();
    base.ct1_vk[3] += 1;
    cast_with(env, crisp, voter, base, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "unexpected crisp verification key")]
unconstrained fn cast_rejects_another_crisp_verification_key() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut base = honest_proofs();
    base.crisp_vk[3] += 1;
    cast_with(env, crisp, voter, base, FIRST_BALLOT, census_root);
}

// A proof passed in another proof's place carries that circuit's key, which the position pins.
#[test(should_fail_with = "unexpected ct0 verification key")]
unconstrained fn cast_rejects_the_ct1_proof_in_the_ct0_place() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut base = honest_proofs();
    base.ct0_vk = CT1_VK;
    cast_with(env, crisp, voter, base, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "unexpected crisp verification key")]
unconstrained fn cast_rejects_the_ct0_proof_in_the_crisp_place() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut base = honest_proofs();
    base.crisp_vk = CT0_VK;
    cast_with(env, crisp, voter, base, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "ct0 and ct1 commit to different u")]
unconstrained fn cast_rejects_encryption_proofs_made_with_different_randomness() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut base = honest_proofs();
    base.ct1_inputs[2] += 1;
    cast_with(env, crisp, voter, base, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "ballot is encrypted to another committee key")]
unconstrained fn cast_rejects_a_ballot_encrypted_to_another_pk0() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut base = honest_proofs();
    base.ct0_inputs[0] += 1;
    cast_with(env, crisp, voter, base, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "ballot is encrypted to another committee key")]
unconstrained fn cast_rejects_a_ballot_encrypted_to_another_pk1() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut base = honest_proofs();
    base.ct1_inputs[0] += 1;
    cast_with(env, crisp, voter, base, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "ballot is encrypted to another committee key")]
unconstrained fn cast_rejects_the_pk_commitment_of_the_halves_swapped() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut base = honest_proofs();
    let pk0 = base.ct0_inputs[0];
    base.ct0_inputs[0] = base.ct1_inputs[0];
    base.ct1_inputs[0] = pk0;
    cast_with(env, crisp, voter, base, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "invalid availability attestation")]
unconstrained fn cast_rejects_an_attestation_from_another_signer() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    cast(env, crisp, voter, WRONG_SIGNER, census_root);
}

#[test(should_fail_with = "invalid availability attestation")]
unconstrained fn cast_rejects_an_attestation_for_another_ballot() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    // The first ballot's attestation, on a different ciphertext commitment.
    let mut tampered = FIRST_BALLOT;
    tampered.ct_commitment = REVOTE.ct_commitment;
    cast(env, crisp, voter, tampered, census_root);
}

#[test(should_fail_with = "availability attestation expired")]
unconstrained fn cast_rejects_an_expired_attestation() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    env.mine_block_at(SHORT_LIVED.expires_at + 1);
    cast(env, crisp, voter, SHORT_LIVED, census_root);
}

#[test(should_fail_with = "input already committed")]
unconstrained fn a_ballot_cannot_be_replayed() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    cast(env, crisp, voter, FIRST_BALLOT, census_root);
    cast(env, crisp, voter, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "unknown census root")]
unconstrained fn cast_rejects_a_census_root_the_contract_never_had() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    cast(env, crisp, voter, FIRST_BALLOT, census_root + 1);
}

#[test]
unconstrained fn cast_accepts_an_older_census_root() {
    let (mut env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let late = env.create_light_account();
    register(env, crisp, late, SLOT_3, 3);
    // A proof made when two members were registered still counts.
    cast(env, crisp, voter, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "parent does not match")]
unconstrained fn a_revote_must_extend_an_input_of_its_own_slot() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    cast(env, crisp, voter, FIRST_BALLOT, census_root);
    // Parent index 0 holds SLOT_1's ballot; SLOT_2 cannot extend it.
    cast(env, crisp, voter, OTHER_SLOT_REVOTE, census_root);
}

#[test(should_fail_with = "parent does not match")]
unconstrained fn a_revote_must_name_its_parents_commitment() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    cast(env, crisp, voter, FIRST_BALLOT, census_root);
    let mut wrong = REVOTE;
    wrong.prev_commitment = REVOTE.ct_commitment;
    cast(env, crisp, voter, wrong, census_root);
}

#[test(should_fail_with = "parent does not match")]
unconstrained fn a_revote_cannot_name_a_parent_that_does_not_exist() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    cast(env, crisp, voter, REVOTE, census_root);
}

#[test(should_fail_with = "first ballot names a parent commitment")]
unconstrained fn a_first_ballot_names_no_parent_commitment() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut first = FIRST_BALLOT;
    first.prev_commitment = 1;
    cast(env, crisp, voter, first, census_root);
}

#[test(should_fail_with = "input limit reached")]
unconstrained fn the_input_limit_is_enforced() {
    let (env, crisp, voter, census_root) = open_for_casting(1);
    cast(env, crisp, voter, FIRST_BALLOT, census_root);
    cast(env, crisp, voter, REVOTE, census_root);
}

#[test(should_fail_with = "outside the input window")]
unconstrained fn cast_rejects_a_ballot_before_the_window() {
    let (mut env, crisp) = open(LIMIT);
    let voter = env.create_light_account();
    register(env, crisp, voter, SLOT_1, 1);
    let census_root = hash_2([SLOT_1, CREDITS]);
    // Registration is open from the start; ballots only from `INPUT_START`.
    cast(env, crisp, voter, FIRST_BALLOT, census_root);
}

#[test(should_fail_with = "outside the input window")]
unconstrained fn cast_rejects_a_ballot_after_the_window() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    env.mine_block_at(INPUT_END);
    cast(env, crisp, voter, FIRST_BALLOT, census_root);
}

#[test(should_fail)]
unconstrained fn cast_needs_the_committee_key() {
    let (mut env, crisp) = deploy();
    open_round(env, crisp, FIXTURE_SCOPE, 0, LIMIT);
    let voter = env.create_light_account();
    register(env, crisp, voter, SLOT_1, 1);
    env.mine_block_at(INPUT_START);
    cast(env, crisp, voter, FIRST_BALLOT, hash_2([SLOT_1, CREDITS]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------------------------------------------------

#[test(should_fail_with = "input window still open")]
unconstrained fn close_round_waits_for_the_window() {
    let (env, crisp, voter, _) = open_for_casting(LIMIT);
    let _ = env.call_public(voter, CrispAztec::at(crisp).close_round(ROUND_ID));
}

#[test(should_fail_with = "round already closed")]
unconstrained fn a_round_closes_once() {
    let (env, crisp, voter, _) = open_for_casting(LIMIT);
    env.mine_block_at(INPUT_END);
    let _ = env.call_public(voter, CrispAztec::at(crisp).close_round(ROUND_ID));
    let _ = env.call_public(voter, CrispAztec::at(crisp).close_round(ROUND_ID));
}

#[test]
unconstrained fn an_empty_round_closes_with_the_empty_tree_root() {
    let (env, crisp, voter, _) = open_for_casting(LIMIT);
    env.mine_block_at(INPUT_END);
    let root = env.call_public(voter, CrispAztec::at(crisp).close_round(ROUND_ID));
    // InternalLazyIMT._root() of an empty tree: the empty depth-1 root, `Z_1`.
    assert_eq(root, 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864);
    assert(env.execute_utility(CrispAztec::at(crisp).is_closed(ROUND_ID)));
}

#[test(should_fail)]
unconstrained fn only_an_opened_round_closes() {
    let (env, crisp) = deploy();
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztec::at(crisp).close_round(ROUND_ID));
}
