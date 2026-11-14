use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near};
const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/mandate-wasm/u01_mandate_proof.wasm"
));
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Entry {
    pub job: AccountId,
    pub owner: AccountId,
    pub amount: U128,
    pub state: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    entries: Vec<Entry>,
    max_jobs: u32,
}

#[near]
impl Factory {
    #[init]
    #[private]
    pub fn new(max_jobs: u32) -> Self {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "SELF_ONLY"
        );
        assert!(max_jobs > 0 && max_jobs <= 256, "CAPACITY");
        assert!(
            env::current_account_id().as_str().len() <= 30,
            "FACTORY_ID_LENGTH"
        );
        Self {
            entries: vec![],
            max_jobs,
        }
    }
    pub fn job_id(&self, owner: AccountId, job_label: String) -> AccountId {
        Self::derive(&owner, &job_label)
    }
    pub fn get_entry(&self, owner: AccountId, job_label: String) -> Option<Entry> {
        let job = Self::derive(&owner, &job_label);
        self.entries.iter().find(|e| e.job == job).cloned()
    }
    #[payable]
    pub fn create_job(
        &mut self,
        job_label: String,
        agent: AccountId,
        allowlist: Vec<AccountId>,
        cap: U128,
        deadline_ns: U64,
        operating_float: U128,
    ) -> Promise {
        let owner = env::predecessor_account_id();
        let job = Self::derive(&owner, &job_label);
        let amount = cap.0.checked_add(operating_float.0).expect("AMOUNT");
        assert!(cap.0 > 0 && operating_float.0 > 0, "FUNDING");
        assert_eq!(env::attached_deposit().as_yoctonear(), amount, "DEPOSIT");
        assert!(env::prepaid_gas() >= Gas::from_tgas(200), "GAS");
        assert!(self.entries.len() < self.max_jobs as usize, "CAPACITY");
        assert!(!self.entries.iter().any(|e| e.job == job), "DUPLICATE_JOB");
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "owner": owner, "agent": agent, "allowlist": allowlist,
            "cap": cap, "deadline_ns": deadline_ns
        }))
        .expect("ARGS");
        self.entries.push(Entry {
            job: job.clone(),
            owner,
            amount: U128(amount),
            state: "creating".into(),
        });
        Promise::new(job.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(operating_float.0))
            .deploy_contract(WASM.to_vec())
            .function_call(
                "new_from_factory".to_string(),
                args,
                NearToken::from_yoctonear(cap.0),
                Gas::from_tgas(80),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_create".to_string(),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"job": job})).unwrap(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(30),
            ))
    }
    #[private]
    pub fn on_create(&mut self, job: AccountId) -> bool {
        let ok = Self::callback();
        let e = self.entries.iter_mut().find(|e| e.job == job).expect("JOB");
        if e.state != "creating" {
            return false;
        }
        e.state = if ok { "ready" } else { "credit" }.into();
        ok
    }
    pub fn claim_creation_refund(&mut self, job_label: String) -> Promise {
        let owner = env::predecessor_account_id();
        let job = Self::derive(&owner, &job_label);
        assert!(env::prepaid_gas() >= Gas::from_tgas(80), "GAS");
        let e = self.entries.iter_mut().find(|e| e.job == job).expect("JOB");
        assert_eq!(e.owner, owner, "OWNER_ONLY");
        assert_eq!(e.state, "credit", "NO_CREDIT");
        e.state = "refunding".into();
        Promise::new(owner)
            .transfer(NearToken::from_yoctonear(e.amount.0))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_creation_refund".to_string(),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"job": job})).unwrap(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(30),
            ))
    }
    #[private]
    pub fn on_creation_refund(&mut self, job: AccountId) -> bool {
        let ok = Self::callback();
        let e = self.entries.iter_mut().find(|e| e.job == job).expect("JOB");
        if e.state != "refunding" {
            return false;
        }
        e.state = if ok { "refunded" } else { "credit" }.into();
        ok
    }
}

impl Factory {
    fn derive(owner: &AccountId, label: &str) -> AccountId {
        assert!(
            !label.is_empty()
                && label.len() <= 32
                && label.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'_'
                    || b == b'-'),
            "LABEL"
        );
        let bytes = env::sha256(format!("{}:{}", owner, label).as_bytes());
        let digest: String = bytes[..16].iter().map(|b| format!("{b:02x}")).collect();
        format!("j{}.{}", digest, env::current_account_id())
            .parse()
            .expect("JOB_ID")
    }
    fn callback() -> bool {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "PRIVATE"
        );
        assert_eq!(env::promise_results_count(), 1, "RESULT_COUNT");
        match env::promise_result_checked(0, 1024) {
            Ok(_) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => panic!("RESULT_TOO_LONG"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{Gas, NearToken, PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};
    use std::collections::HashMap;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    const ONE: u128 = 1_000_000_000_000_000_000_000_000;
    const END: u64 = 1_000_000_000_000;
    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn ctx(current: &str, predecessor: &str, deposit: u128, gas: u64, results: Vec<PromiseResult>) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id(current))
            .predecessor_account_id(id(predecessor))
            .signer_account_id(id("unrelated.testnet"))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(10000))
            .block_timestamp(1)
            .prepaid_gas(Gas::from_tgas(gas));
        testing_env!(
            b.build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            HashMap::new(),
            results
        );
    }
    fn rejects(f: impl FnOnce()) {
        assert!(catch_unwind(AssertUnwindSafe(f)).is_err());
    }
    fn fresh() -> Factory {
        ctx("factory.testnet", "factory.testnet", 0, 300, vec![]);
        Factory::new(4)
    }
    fn create(f: &mut Factory, label: &str) {
        drop(f.create_job(
            label.into(),
            id("agent.testnet"),
            vec![id("vendor.testnet")],
            U128(10 * ONE),
            U64(END),
            U128(5 * ONE),
        ));
    }
    #[test]
    fn f02_creation_binds_predecessor_and_atomic_keyless_batch() {
        use near_sdk::mock::MockAction;
        use near_sdk::test_utils::get_created_receipts;
        for owner in ["owner.testnet", &"a".repeat(64)] {
            let mut f = fresh();
            ctx("factory.testnet", owner, 15 * ONE, 300, vec![]);
            create(&mut f, "job_1");
            let e = f
                .get_entry(id(owner), "job_1".into())
                .expect("creation must be recorded");
            assert_eq!(e.owner, id(owner));
            assert_eq!(e.amount.0, 15 * ONE);
            assert_eq!(e.state, "creating");
            assert_eq!(e.job, f.job_id(id(owner), "job_1".into()));
            assert_ne!(e.job, f.job_id(id("unrelated.testnet"), "job_1".into()));
            assert!(e.job.as_str().len() <= 64);
            let receipts = get_created_receipts();
            assert_eq!(receipts.len(), 2);
            let child = &receipts[0];
            assert_eq!(child.receiver_id, e.job);
            assert_eq!(child.actions.len(), 4);
            assert!(matches!(child.actions[0], MockAction::CreateAccount { .. }));
            assert!(
                matches!(&child.actions[1],MockAction::Transfer { deposit, .. } if deposit.as_yoctonear()==5*ONE)
            );
            assert!(
                matches!(&child.actions[2],MockAction::DeployContract { code, .. } if code==WASM)
            );
            match &child.actions[3] {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    ..
                } => {
                    assert_eq!(method_name, b"new_from_factory");
                    assert_eq!(attached_deposit.as_yoctonear(), 10 * ONE);
                    assert_eq!(*prepaid_gas, Gas::from_tgas(80));
                    let v: near_sdk::serde_json::Value =
                        near_sdk::serde_json::from_slice(args).unwrap();
                    assert_eq!(
                        v,
                        near_sdk::serde_json::json!({"owner":owner,"agent":"agent.testnet",
                        "allowlist":["vendor.testnet"],"cap":(10*ONE).to_string(),"deadline_ns":END.to_string()})
                    );
                }
                _ => panic!("initializer action"),
            }
            assert_eq!(receipts[1].receiver_id, id("factory.testnet"));
            assert_eq!(receipts[1].receipt_indices.len(), 1);
            assert_eq!(f.entries.len(), 1);
            ctx("factory.testnet", owner, 15 * ONE, 300, vec![]);
            rejects(|| create(&mut f, "job_1"));
            assert_eq!(f.entries.len(), 1);
        }
    }
    #[test]
    fn f03_creation_admission_is_bounded_before_mutation() {
        for (label, cap, float, deposit, gas, full) in [
            ("", 10 * ONE, 5 * ONE, 15 * ONE, 300, false),
            ("bad.id", 10 * ONE, 5 * ONE, 15 * ONE, 300, false),
            ("UPPER", 10 * ONE, 5 * ONE, 15 * ONE, 300, false),
            (
                "012345678901234567890123456789012",
                10 * ONE,
                5 * ONE,
                15 * ONE,
                300,
                false,
            ),
            ("valid", 0, 5 * ONE, 5 * ONE, 300, false),
            ("valid", 10 * ONE, 0, 10 * ONE, 300, false),
            ("valid", 10 * ONE, 5 * ONE, 15 * ONE + 1, 300, false),
            ("valid", 10 * ONE, 5 * ONE, 15 * ONE - 1, 300, false),
            ("valid", u128::MAX, 1, 0, 300, false),
            ("valid", 10 * ONE, 5 * ONE, 15 * ONE, 199, false),
            ("valid", 10 * ONE, 5 * ONE, 15 * ONE, 300, true),
        ] {
            let mut f = fresh();
            // VM-only closed-capacity fixture; lifetime count includes failed attempts.
            if full {
                f.max_jobs = 0;
            }
            ctx("factory.testnet", "owner.testnet", deposit, gas, vec![]);
            rejects(|| {
                drop(f.create_job(
                    label.into(),
                    id("agent.testnet"),
                    vec![id("vendor.testnet")],
                    U128(cap),
                    U64(END),
                    U128(float),
                ));
            });
            assert!(f.entries.is_empty());
            assert!(near_sdk::test_utils::get_created_receipts().is_empty());
        }
    }
    fn pending() -> (Factory, AccountId) {
        let mut f = fresh();
        ctx("factory.testnet", "owner.testnet", 15 * ONE, 300, vec![]);
        create(&mut f, "job");
        let job = f.job_id(id("owner.testnet"), "job".into());
        (f, job)
    }
    #[test]
    fn f04_create_callback_private_result_bound_and_stale() {
        for (caller, results) in [
            ("owner.testnet", vec![PromiseResult::Successful(vec![])]),
            ("factory.testnet", vec![]),
            (
                "factory.testnet",
                vec![PromiseResult::Failed, PromiseResult::Failed],
            ),
            (
                "factory.testnet",
                vec![PromiseResult::Successful(vec![1; 1025])],
            ),
        ] {
            let (mut f, job) = pending();
            ctx("factory.testnet", caller, 0, 100, results);
            rejects(|| {
                f.on_create(job);
            });
            assert_eq!(f.entries[0].state, "creating");
        }
        for success in [true, false] {
            let (mut f, job) = pending();
            assert_eq!(f.entries[0].state, "creating"); // missing callback never creates credit
            ctx(
                "factory.testnet",
                "factory.testnet",
                0,
                100,
                vec![if success {
                    PromiseResult::Successful(vec![])
                } else {
                    PromiseResult::Failed
                }],
            );
            assert_eq!(f.on_create(job.clone()), success);
            assert_eq!(f.entries[0].state, if success { "ready" } else { "credit" });
            assert!(!f.on_create(job.clone()));
            assert_eq!(f.entries[0].state, if success { "ready" } else { "credit" });
            ctx("factory.testnet", "owner.testnet", 15 * ONE, 300, vec![]);
            rejects(|| create(&mut f, "job"));
        }
    }
    fn credit() -> (Factory, AccountId) {
        let (mut f, job) = pending();
        ctx(
            "factory.testnet",
            "factory.testnet",
            0,
            100,
            vec![PromiseResult::Failed],
        );
        assert!(!f.on_create(job.clone()));
        assert_eq!(f.entries[0].state, "credit");
        (f, job)
    }
    #[test]
    fn f05_refund_only_credit_owner_exact_amount_once() {
        for (caller, gas, state) in [
            ("intruder.testnet", 100, "credit"),
            ("owner.testnet", 79, "credit"),
            ("owner.testnet", 100, "creating"),
            ("owner.testnet", 100, "ready"),
            ("owner.testnet", 100, "refunding"),
            ("owner.testnet", 100, "refunded"),
        ] {
            let (mut f, _) = credit();
            f.entries[0].state = state.into();
            ctx("factory.testnet", caller, 0, gas, vec![]);
            rejects(|| {
                drop(f.claim_creation_refund("job".into()));
            });
            assert_eq!(f.entries[0].state, state);
        }
        let (mut f, _) = credit();
        ctx("factory.testnet", "owner.testnet", 0, 100, vec![]);
        drop(f.claim_creation_refund("job".into()));
        assert_eq!(f.entries[0].state, "refunding");
        let receipts = near_sdk::test_utils::get_created_receipts();
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[0].receiver_id, id("owner.testnet"));
        assert!(
            matches!(&receipts[0].actions[..], [near_sdk::mock::MockAction::Transfer{deposit,..}] if deposit.as_yoctonear()==15*ONE)
        );
        // Missing callback retains refunding, not spendable credit.
        rejects(|| {
            drop(f.claim_creation_refund("job".into()));
        });
        assert_eq!(f.entries[0].state, "refunding");
    }
    #[test]
    fn f06_refund_callback_failure_retry_and_stale() {
        for (caller, results) in [
            ("owner.testnet", vec![PromiseResult::Successful(vec![])]),
            ("factory.testnet", vec![]),
            (
                "factory.testnet",
                vec![PromiseResult::Failed, PromiseResult::Failed],
            ),
            (
                "factory.testnet",
                vec![PromiseResult::Successful(vec![0; 1025])],
            ),
        ] {
            let (mut f, job) = credit();
            ctx("factory.testnet", "owner.testnet", 0, 100, vec![]);
            drop(f.claim_creation_refund("job".into()));
            ctx("factory.testnet", caller, 0, 100, results);
            rejects(|| {
                f.on_creation_refund(job);
            });
            assert_eq!(f.entries[0].state, "refunding");
        }
        let (mut f, job) = credit();
        ctx("factory.testnet", "owner.testnet", 0, 100, vec![]);
        drop(f.claim_creation_refund("job".into()));
        ctx(
            "factory.testnet",
            "factory.testnet",
            0,
            100,
            vec![PromiseResult::Failed],
        );
        assert!(!f.on_creation_refund(job.clone()));
        assert_eq!(f.entries[0].state, "credit");
        assert!(!f.on_creation_refund(job.clone()));
        assert_eq!(f.entries[0].state, "credit");
        ctx("factory.testnet", "owner.testnet", 0, 100, vec![]);
        drop(f.claim_creation_refund("job".into()));
        ctx(
            "factory.testnet",
            "factory.testnet",
            0,
            100,
            vec![PromiseResult::Successful(vec![])],
        );
        assert!(f.on_creation_refund(job.clone()));
        assert_eq!(f.entries[0].state, "refunded");
        assert!(!f.on_creation_refund(job));
        assert_eq!(f.entries[0].state, "refunded");
        ctx("factory.testnet", "owner.testnet", 0, 300, vec![]);
        rejects(|| {
            drop(f.claim_creation_refund("job".into()));
        });
        ctx("factory.testnet", "owner.testnet", 15 * ONE, 300, vec![]);
        rejects(|| create(&mut f, "job"));
        assert_eq!(f.entries.len(), 1);
    }
    #[test]
    fn f07_lifetime_capacity_counts_failed_tombstones() {
        let mut f = fresh();
        for i in 0..4 {
            ctx("factory.testnet", "owner.testnet", 15 * ONE, 300, vec![]);
            create(&mut f, &format!("job{i}"));
            let job = f.job_id(id("owner.testnet"), format!("job{i}"));
            ctx(
                "factory.testnet",
                "factory.testnet",
                0,
                100,
                vec![PromiseResult::Failed],
            );
            assert!(!f.on_create(job));
        }
        assert_eq!(f.entries.len(), 4);
        assert!(f.entries.iter().all(|e| e.state == "credit"));
        ctx("factory.testnet", "other.testnet", 15 * ONE, 300, vec![]);
        rejects(|| create(&mut f, "job-new"));
        assert_eq!(f.entries.len(), 4);
    }
    #[test]
    fn f01_initializer_authority_and_bounds() {
        let f = fresh();
        assert_eq!(f.max_jobs, 4);
        for (current, predecessor, capacity) in [
            ("factory.testnet", "intruder.testnet", 4),
            ("factory.testnet", "factory.testnet", 0),
            ("factory.testnet", "factory.testnet", 257),
            (
                "0123456789012345678901234567890.testnet",
                "0123456789012345678901234567890.testnet",
                4,
            ),
        ] {
            ctx(current, predecessor, 0, 300, vec![]);
            rejects(|| {
                Factory::new(capacity);
            });
        }
    }
}
