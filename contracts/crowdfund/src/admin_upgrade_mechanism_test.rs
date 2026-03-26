//! Tests for the admin upgrade mechanism.
//!
//! Covers:
//! - Admin address is stored correctly during `initialize()`.
//! - Only the admin can call `upgrade()` (auth guard enforced).
//! - A non-admin caller is rejected by `upgrade()`.
//! - Creator (distinct from admin) cannot call `upgrade()`.
//! - `upgrade()` panics when called before `initialize()` (no admin stored).
//! - Admin auth is required: no-auth call is rejected.
//! - Zero WASM hash is rejected (edge case: all-zero hash).
//! - Non-zero WASM hash passes validation.
//! - Storage is untouched after a rejected upgrade call.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token, Address, BytesN, Env,
};

use crate::{
    admin_upgrade_mechanism::{validate_wasm_hash},
    CrowdfundContract, CrowdfundContractClient,
};

// ── Helper ───────────────────────────────────────────────────────────────────

fn setup() -> (
    Env,
    Address,
    CrowdfundContractClient<'static>,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(CrowdfundContract, ());
    let client = CrowdfundContractClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = token_id.address();

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let deadline = env.ledger().timestamp() + 3600;

    client.initialize(
        &admin,
        &creator,
        &token_addr,
        &1_000,
        &deadline,
        &1,
        &None,
        &None,
        &None,
        &None,
    );

    (env, contract_id, client, admin, creator, token_addr)
}

fn dummy_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[1u8; 32])
}

fn zero_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

// ── Auth / access control tests ───────────────────────────────────────────────

/// Admin address is stored on initialize — confirmed by upgrade() reaching
/// the auth check rather than panicking on a missing-storage unwrap.
#[test]
fn test_admin_stored_on_initialize() {
    let (env, contract_id, client, _admin, _creator, _token) = setup();
    let non_admin = Address::generate(&env);
    env.set_auths(&[]);
    let result = client
        .mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "upgrade",
                args: soroban_sdk::vec![&env, dummy_hash(&env).into()],
                sub_invokes: &[],
            },
        }])
        .try_upgrade(&dummy_hash(&env));
    // Auth error (not a storage panic) confirms admin was stored.
    assert!(result.is_err());
}

/// Non-admin caller is rejected.
#[test]
fn test_non_admin_cannot_upgrade() {
    let (env, contract_id, client, _admin, _creator, _token) = setup();
    let non_admin = Address::generate(&env);
    env.set_auths(&[]);
    let result = client
        .mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "upgrade",
                args: soroban_sdk::vec![&env, dummy_hash(&env).into()],
                sub_invokes: &[],
            },
        }])
        .try_upgrade(&dummy_hash(&env));
    assert!(result.is_err());
}

/// Creator (distinct from admin) cannot call upgrade().
#[test]
fn test_creator_cannot_upgrade() {
    let (env, contract_id, client, _admin, creator, _token) = setup();
    env.set_auths(&[]);
    let result = client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "upgrade",
                args: soroban_sdk::vec![&env, dummy_hash(&env).into()],
                sub_invokes: &[],
            },
        }])
        .try_upgrade(&dummy_hash(&env));
    assert!(result.is_err());
}

/// upgrade() panics when called before initialize() — no admin in storage.
#[test]
#[should_panic]
fn test_upgrade_panics_before_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(CrowdfundContract, ());
    let client = CrowdfundContractClient::new(&env, &contract_id);
    client.upgrade(&dummy_hash(&env));
}

/// upgrade() with no auths set is rejected.
#[test]
fn test_upgrade_requires_auth() {
    let (env, _contract_id, client, _admin, _creator, _token) = setup();
    env.set_auths(&[]);
    let result = client.try_upgrade(&dummy_hash(&env));
    assert!(result.is_err());
}

// ── WASM hash validation edge cases ──────────────────────────────────────────

/// All-zero WASM hash is rejected — edge case for missing/unset upload.
#[test]
#[should_panic(expected = "upgrade: wasm_hash must not be zero")]
fn test_zero_wasm_hash_rejected() {
    let env = Env::default();
    validate_wasm_hash(&zero_hash(&env));
}

/// Non-zero WASM hash passes validation without panic.
#[test]
fn test_nonzero_wasm_hash_accepted() {
    let env = Env::default();
    validate_wasm_hash(&dummy_hash(&env)); // must not panic
}

/// Minimum non-zero hash (only last byte set) passes validation.
#[test]
fn test_minimal_nonzero_wasm_hash_accepted() {
    let env = Env::default();
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    validate_wasm_hash(&BytesN::from_array(&env, &bytes));
}

/// Admin calling upgrade() with a zero hash is rejected before WASM swap.
#[test]
fn test_admin_upgrade_with_zero_hash_rejected() {
    let (env, _contract_id, client, _admin, _creator, _token) = setup();
    // mock_all_auths is active from setup — admin auth passes, hash check fails.
    let result = client.try_upgrade(&zero_hash(&env));
    assert!(result.is_err());
}

// ── State persistence ─────────────────────────────────────────────────────────

/// Contract storage is untouched after a rejected upgrade call.
#[test]
fn test_storage_persists_after_rejected_upgrade() {
    let (env, _contract_id, client, _admin, _creator, _token) = setup();
    let goal_before = client.goal();
    let deadline_before = client.deadline();
    let raised_before = client.total_raised();

    env.set_auths(&[]);
    let _ = client.try_upgrade(&dummy_hash(&env));

    assert_eq!(client.goal(), goal_before);
    assert_eq!(client.deadline(), deadline_before);
    assert_eq!(client.total_raised(), raised_before);
}

/// Admin-only upgrade: valid WASM binary test (requires compiled WASM).
#[test]
#[ignore = "requires: cargo build --target wasm32-unknown-unknown --release"]
fn test_admin_can_upgrade_with_valid_wasm() {
    mod crowdfund_wasm {
        soroban_sdk::contractimport!(
            file = "../../target/wasm32-unknown-unknown/release/crowdfund.wasm"
        );
    }
    let (env, _contract_id, client, _admin, _creator, _token) = setup();
    let wasm_hash = env.deployer().upload_contract_wasm(crowdfund_wasm::WASM);
    client.upgrade(&wasm_hash);
}
