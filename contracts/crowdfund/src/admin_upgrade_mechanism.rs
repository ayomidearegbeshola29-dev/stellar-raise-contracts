use soroban_sdk::{Address, BytesN, Env};

use crate::DataKey;

/// Validates that the caller is the authorized admin for contract upgrades.
///
/// ### Security Note
/// Uses `require_auth()` to ensure the transaction is signed by the admin
/// address stored during initialization.
///
/// ### Panics
/// - If no admin is stored (contract not yet initialized).
pub fn validate_admin_upgrade(env: &Env) -> Address {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Admin not initialized");
    admin.require_auth();
    admin
}

/// Validates that the WASM hash is non-zero (all-zero hash is invalid).
///
/// An all-zero hash is the default/unset value and would indicate a missing
/// or malformed upload. Rejecting it prevents accidental no-op upgrades.
///
/// ### Panics
/// - If `new_wasm_hash` is all zeros.
pub fn validate_wasm_hash(new_wasm_hash: &BytesN<32>) {
    assert!(
        new_wasm_hash.to_array() != [0u8; 32],
        "upgrade: wasm_hash must not be zero"
    );
}

/// Executes the WASM update.
pub fn perform_upgrade(env: &Env, new_wasm_hash: BytesN<32>) {
    env.deployer().update_current_contract_wasm(new_wasm_hash);
}
