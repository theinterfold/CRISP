// TXE tests of `CrispAztec`.
//
// TXE does not execute proof verification (`verify_honk_proof` and the ZKPassport outer proof are no-ops), so these
// tests cover everything around the verifications: message consumption, the registry and capsule plumbing, the
// verification-key hash check, the attestation signature, the parent / window / limit / replay rules, and the two trees
// against Solidity-produced roots. Real proof verification is exercised against a local network (see the README).

mod fold_fixture;
mod vectors;

use crisp_aztec::{
    CrispAztec,
    hashing::{key_content, round_content},
    types::{Config, InputEntry, RoundConfig},
};
use crate::fold_fixture::{FOLD_PROOF, FOLD_VK, FOLD_VK_HASH};
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
    commitments::{age_commitment, bind_user_address_commitment},
    constants::{PI_PARAMS_START, PROOF_CAPSULE_SLOT, PROOF_FIELDS, VK_FIELDS},
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
global COMMITTEE_KEY: Field = 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20;
global L1_PROGRAM: EthAddress = EthAddress::from_field(0x1111111111111111111111111111111111111111);
global INTERFOLD: EthAddress = EthAddress::from_field(0xdfa59d66c173a00643ebe80e172af5a8cf244b30);
// packed("0.22.0"), the circuits release the ZKPassport age fixture was proved with.
global ZKPASSPORT_VERSION: Field = 0x0000001600000000000000000000000000000000000000000000000000000000;
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
            FOLD_VK_HASH,
            scope_hash("example.com"),
            ZKPASSPORT_VERSION,
            7 * DAY,
            LOCAL_NETWORK_REGISTRY_ADDRESS,
        ),
    );
    env.mine_block_at(T0);
    (env, crisp)
}

unconstrained fn send_round(
    env: TestEnvironment,
    crisp: AztecAddress,
    scope: Field,
    min_age: u8,
    limit: u32,
) -> Field {
    env.send_l1_to_l2_message(
        round_content(ROUND_ID, NUM_OPTIONS, CREDITS, INPUT_START, INPUT_END, limit, scope, min_age, true),
        0,
        L1_PROGRAM,
        crisp,
    )
}

unconstrained fn open_round(env: TestEnvironment, crisp: AztecAddress, scope: Field, min_age: u8, limit: u32) {
    let leaf_index = send_round(env, crisp, scope, min_age, limit);
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
            min_age,
            true,
            leaf_index,
        ),
    );
}

unconstrained fn publish_key(env: TestEnvironment, crisp: AztecAddress) {
    let leaf_index = env.send_l1_to_l2_message(key_content(ROUND_ID, COMMITTEE_KEY), 0, L1_PROGRAM, crisp);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztec::at(crisp).publish_key(ROUND_ID, COMMITTEE_KEY, leaf_index));
}

/// A round with a committee key, no minimum age, and the fixture's scope.
unconstrained fn open(limit: u32) -> (TestEnvironment, AztecAddress) {
    let (env, crisp) = deploy();
    open_round(env, crisp, FIXTURE_SCOPE, 0, limit);
    publish_key(env, crisp);
    (env, crisp)
}

/// The ZKPassport age fixture (`outer_count_5`: `age(18)` and a bind) re-bound to `user`, with its unique identifier
/// moved by `identifier_offset` so one fixture stands for several documents. The fixture is bound to a fixed address
/// that TXE has no account for, and TXE does not check the proof, so the substitution is possible here and only here.
unconstrained fn age_proof(user: AztecAddress, identifier_offset: Field) -> [Field; 583] {
    let mut blob = AGE_FIXTURE_BLOB;
    let params = VK_FIELDS + PROOF_FIELDS + PI_PARAMS_START;
    for i in params..params + 2 {
        if blob[i] != age_commitment(18, 0) {
            blob[i] = bind_user_address_commitment(user.to_field());
        }
    }
    blob[581] += identifier_offset;
    blob
}

/// The same proof for a query without an age check (`outer_count_4`: a bind alone).
unconstrained fn bind_proof(user: AztecAddress, identifier_offset: Field) -> [Field; 582] {
    let age = age_proof(user, identifier_offset);
    let mut blob = [0; 582];
    let params = VK_FIELDS + PROOF_FIELDS + PI_PARAMS_START;
    for i in 0..params {
        blob[i] = age[i];
    }
    blob[params] = bind_user_address_commitment(user.to_field());
    blob[params + 1] = age[params + 2];
    blob[params + 2] = age[params + 3];
    blob[params + 3] = age[params + 4];
    blob
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

unconstrained fn cast_with_vk(
    env: TestEnvironment,
    crisp: AztecAddress,
    from: AztecAddress,
    vk: [Field; 115],
    c: Cast,
    census_root: Field,
) {
    env.call_private(
        from,
        CrispAztec::at(crisp).cast(
            ROUND_ID,
            vk,
            FOLD_PROOF,
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
    cast_with_vk(env, crisp, from, FOLD_VK, c, census_root);
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
    assert_eq(config.fold_vk_hash, FOLD_VK_HASH);
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
        round_content(round_id, NUM_OPTIONS, CREDITS, INPUT_START, INPUT_END, LIMIT, FIXTURE_SCOPE, 0, true),
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
        ),
    );
}

#[test]
unconstrained fn publish_key_stores_the_committee_key() {
    let (env, crisp) = open(LIMIT);
    let key: Field = env.execute_utility(CrispAztec::at(crisp).get_committee_key(ROUND_ID));
    assert_eq(key, COMMITTEE_KEY);
}

#[test(should_fail)]
unconstrained fn the_committee_key_cannot_be_published_twice() {
    let (env, crisp) = open(LIMIT);
    let leaf_index = env.send_l1_to_l2_message(key_content(ROUND_ID, COMMITTEE_KEY), 0, L1_PROGRAM, crisp);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztec::at(crisp).publish_key(ROUND_ID, COMMITTEE_KEY, leaf_index));
}

#[test(should_fail)]
unconstrained fn publish_key_rejects_a_key_the_message_does_not_carry() {
    let (env, crisp) = deploy();
    let leaf_index = env.send_l1_to_l2_message(key_content(ROUND_ID, COMMITTEE_KEY), 0, L1_PROGRAM, crisp);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztec::at(crisp).publish_key(ROUND_ID, COMMITTEE_KEY + 1, leaf_index));
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

#[test(should_fail_with = "unexpected fold verification key")]
unconstrained fn cast_rejects_another_verification_key() {
    let (env, crisp, voter, census_root) = open_for_casting(LIMIT);
    let mut vk = FOLD_VK;
    vk[3] += 1;
    cast_with_vk(env, crisp, voter, vk, FIRST_BALLOT, census_root);
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
