use near_sdk::near;

// Toolchain fixture only: not the U01 mandate or a payment implementation.
#[near(contract_state)]
#[derive(Default)]
pub struct Probe {}

#[near]
impl Probe {
    pub fn answer(&self) -> u32 {
        42
    }
}
