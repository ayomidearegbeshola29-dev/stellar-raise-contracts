# admin_upgrade_mechanism

Admin-gated WASM upgrade validation for the Stellar Raise crowdfund contract.

## Overview

This module handles the two validation steps that must pass before a contract upgrade is executed:

1. **Admin authorization** — only the address stored as `Admin` during `initialize()` may call `upgrade()`.
2. **WASM hash validation** — the supplied hash must be non-zero; an all-zero hash indicates a missing or malformed upload.

## Public API

### `validate_admin_upgrade(env) -> Address`

Reads `DataKey::Admin` from instance storage and calls `require_auth()` on it.  
**Panics** if no admin is stored (contract not initialized).

### `validate_wasm_hash(new_wasm_hash)`

Asserts the 32-byte hash is not all zeros.  
**Panics** with `"upgrade: wasm_hash must not be zero"` if the hash is `[0u8; 32]`.

### `perform_upgrade(env, new_wasm_hash)`

Calls `env.deployer().update_current_contract_wasm(new_wasm_hash)` to swap the WASM.  
Only called after both validation steps pass.

## Upgrade Flow

```
upgrade(env, new_wasm_hash)
  │
  ├─ validate_admin_upgrade(env)   → panics if not admin
  ├─ validate_wasm_hash(hash)      → panics if hash == [0; 32]
  ├─ perform_upgrade(env, hash)    → swaps WASM
  └─ env.events().publish(...)     → emits upgrade event
```

## Edge Cases

| Input | Outcome |
|---|---|
| Non-admin caller | Rejected by `require_auth()` |
| Creator (≠ admin) | Rejected by `require_auth()` |
| No admin stored (pre-init) | Panics on `expect("Admin not initialized")` |
| All-zero WASM hash | Panics with `"upgrade: wasm_hash must not be zero"` |
| Valid hash, valid admin | Upgrade proceeds |

## Security Considerations

- **Irreversibility**: upgrades cannot be rolled back. Test the new WASM thoroughly before uploading.
- **Admin key custody**: the admin address is set once at `initialize()` and cannot be changed without an upgrade.
- **State persistence**: all contract storage survives a WASM swap — the upgrade only replaces executable code.
- **Recommendation**: require at least two reviewers to approve upgrade PRs before merging.
