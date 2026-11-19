use crate::types::{
    MODE_LATEST_AND_PREVIOUS, MODE_LATEST_ONLY, MODE_VALID_AT_TIMESTAMP, MODE_VALID_WITHIN_WINDOW,
    REGISTRY_CERTIFICATE, REGISTRY_CIRCUIT, REGISTRY_SANCTIONS,
};
use aztec::protocol::address::AztecAddress;

pub fn assert_valid_registry_id(registry_id: Field) {
    let ok = (registry_id == REGISTRY_CERTIFICATE)
        | (registry_id == REGISTRY_CIRCUIT)
        | (registry_id == REGISTRY_SANCTIONS);
    assert(ok, "unknown registry id");
}

pub fn assert_valid_mode(mode: u8) {
    let ok = (mode == MODE_LATEST_ONLY)
        | (mode == MODE_LATEST_AND_PREVIOUS)
        | (mode == MODE_VALID_AT_TIMESTAMP)
        | (mode == MODE_VALID_WITHIN_WINDOW);
    assert(ok, "unknown validation mode");
}

pub fn assert_admin(sender: AztecAddress, admin: AztecAddress) {
    assert(sender == admin, "caller is not admin");
}

pub fn assert_admin_or_operator(sender: AztecAddress, admin: AztecAddress, operator: AztecAddress) {
    assert((sender == admin) | (sender == operator), "caller is not admin or operator");
}

pub fn assert_address_not_zero<let N: u32>(address: AztecAddress, msg: str<N>) {
    assert(!address.is_zero(), msg);
}
