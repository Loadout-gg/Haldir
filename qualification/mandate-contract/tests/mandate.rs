use near_sdk::json_types::{U64, U128};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{
    AccountId, Gas, NearToken, PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env,
};
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use u01_mandate_proof::{Mandate, OrderState};

const ONE: u128 = 1_000_000_000_000_000_000_000_000;
const END: u64 = 1_000_000_000_000;
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn ctx(predecessor: &str, deposit: u128, now: u64, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("mandate.test"))
        .predecessor_account_id(id(predecessor))
        .signer_account_id(id("unrelated.test"))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1000))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(100));
    testing_env!(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::new(),
        results
    );
}
fn fresh() -> Mandate {
    ctx("owner.test", 10 * ONE, 1, vec![]);
    Mandate::new(
        id("owner.test"),
        id("agent.test"),
        vec![id("vendor.test"), id("missing.test")],
        U128(10 * ONE),
        U64(END),
    )
}
fn ledger(m: &Mandate, spent: u128, refunded: u128, reserved: u128, free: u128) {
    let s = m.get_status();
    assert_eq!(
        (s.spent.0, s.refunded.0, s.reserved.0, s.free.0),
        (spent, refunded, reserved, free)
    );
    assert_eq!(s.cap.0, spent + refunded + reserved + free);
}
fn rejects(f: impl FnOnce()) {
    assert!(catch_unwind(AssertUnwindSafe(f)).is_err());
}

#[test]
fn u01_initialization() {
    let m = fresh();
    ledger(&m, 0, 0, 0, 10 * ONE);
    let s = m.get_status();
    assert_eq!(s.owner, id("owner.test"));
    assert_eq!(s.agent, id("agent.test"));
    assert_eq!(s.deadline_ns.0, END);
    assert!(!s.stopped && !s.expired);
    assert_eq!(s.allowlist, vec![id("vendor.test"), id("missing.test")]);
    ctx("intruder.test", 10 * ONE, 1, vec![]);
    rejects(|| {
        Mandate::new(
            id("owner.test"),
            id("agent.test"),
            vec![id("vendor.test")],
            U128(10 * ONE),
            U64(END),
        );
    });
    ctx("owner.test", 11 * ONE, 1, vec![]);
    rejects(|| {
        Mandate::new(
            id("owner.test"),
            id("agent.test"),
            vec![id("vendor.test")],
            U128(10 * ONE),
            U64(END),
        );
    });

    for (owner, agent, allowlist, cap, deadline) in [
        (
            "owner.test",
            "owner.test",
            vec![id("vendor.test")],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "mandate.test",
            vec![id("vendor.test")],
            10 * ONE,
            END,
        ),
        ("owner.test", "agent.test", vec![], 10 * ONE, END),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test"); 5],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test"); 2],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("mandate.test")],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("owner.test")],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("agent.test")],
            10 * ONE,
            END,
        ),
        ("owner.test", "agent.test", vec![id("vendor.test")], 0, END),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test")],
            101 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test")],
            10 * ONE,
            1,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test")],
            10 * ONE,
            8 * 24 * 60 * 60 * 1_000_000_000,
        ),
    ] {
        ctx(owner, cap, 1, vec![]);
        rejects(|| {
            Mandate::new(id(owner), id(agent), allowlist, U128(cap), U64(deadline));
        });
    }
}

fn pay(m: &mut Mandate, key: &str, amount: u128) {
    ctx("agent.test", 0, 2, vec![]);
    drop(m.pay(key.into(), id("vendor.test"), U128(amount)));
}
// VM-only admission fixtures use the contract's explicit Borsh field order.
// This creates closed/full states without implementing stop or callbacks early.
fn admission_fixture(stopped: bool, full: bool) -> Mandate {
    let s = fresh().get_status();
    let orders = if full {
        (0..16)
            .map(|i| u01_mandate_proof::Order {
                order_id: format!("existing-{i}"),
                recipient: id("vendor.test"),
                amount: U128(1),
                state: OrderState::Failed,
            })
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    let bytes = near_sdk::borsh::to_vec(&(
        s.owner,
        s.agent,
        s.allowlist,
        s.cap.0,
        s.deadline_ns.0,
        0u128,
        0u128,
        stopped,
        orders,
        None::<(String, u128, bool)>,
        0u64,
    ))
    .unwrap();
    near_sdk::borsh::from_slice(&bytes).unwrap()
}

#[test]
fn u02_admission_and_reservation() {
    let mut admitted = vec![];
    for (case, caller, key, recipient, amount, deposit, now, stopped, full) in [
        (
            "owner",
            "owner.test",
            "denied".to_string(),
            "vendor.test",
            ONE,
            0,
            2,
            false,
            false,
        ),
        (
            "intruder",
            "intruder.test",
            "denied".to_string(),
            "vendor.test",
            ONE,
            0,
            2,
            false,
            false,
        ),
        (
            "excluded",
            "agent.test",
            "denied".to_string(),
            "excluded.test",
            ONE,
            0,
            2,
            false,
            false,
        ),
        (
            "budget",
            "agent.test",
            "denied".to_string(),
            "vendor.test",
            11 * ONE,
            0,
            2,
            false,
            false,
        ),
        (
            "zero",
            "agent.test",
            "denied".to_string(),
            "vendor.test",
            0,
            0,
            2,
            false,
            false,
        ),
        (
            "deposit",
            "agent.test",
            "denied".to_string(),
            "vendor.test",
            ONE,
            ONE,
            2,
            false,
            false,
        ),
        (
            "one-yocto",
            "agent.test",
            "denied".to_string(),
            "vendor.test",
            ONE,
            1,
            2,
            false,
            false,
        ),
        (
            "expiry",
            "agent.test",
            "denied".to_string(),
            "vendor.test",
            ONE,
            0,
            END,
            false,
            false,
        ),
        (
            "empty-id",
            "agent.test",
            "".to_string(),
            "vendor.test",
            ONE,
            0,
            2,
            false,
            false,
        ),
        (
            "long-id",
            "agent.test",
            "x".repeat(65),
            "vendor.test",
            ONE,
            0,
            2,
            false,
            false,
        ),
        (
            "invalid-id",
            "agent.test",
            "bad/id".to_string(),
            "vendor.test",
            ONE,
            0,
            2,
            false,
            false,
        ),
        (
            "stopped",
            "agent.test",
            "denied".to_string(),
            "vendor.test",
            ONE,
            0,
            2,
            true,
            false,
        ),
        (
            "order-limit",
            "agent.test",
            "denied".to_string(),
            "vendor.test",
            ONE,
            0,
            2,
            false,
            true,
        ),
    ] {
        let mut m = admission_fixture(stopped, full);
        ctx(caller, deposit, now, vec![]);
        if catch_unwind(AssertUnwindSafe(|| {
            drop(m.pay(key, id(recipient), U128(amount)));
        }))
        .is_ok()
        {
            admitted.push(case);
        }
        ledger(&m, 0, 0, 0, 10 * ONE);
        assert_eq!(m.get_status().orders.len(), if full { 16 } else { 0 });
    }
    let mut low_gas = fresh();
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("mandate.test"))
        .predecessor_account_id(id("agent.test"))
        .signer_account_id(id("unrelated.test"))
        .account_balance(NearToken::from_near(1000))
        .block_timestamp(2)
        .prepaid_gas(Gas::from_tgas(79));
    testing_env!(b.build());
    if catch_unwind(AssertUnwindSafe(|| {
        drop(low_gas.pay("gas".into(), id("vendor.test"), U128(ONE)));
    }))
    .is_ok()
    {
        admitted.push("gas");
    }
    ledger(&low_gas, 0, 0, 0, 10 * ONE);
    assert!(
        admitted.is_empty(),
        "admitted forbidden cases: {admitted:?}"
    );

    let mut m = fresh();
    pay(&mut m, "one", 3 * ONE);
    ledger(&m, 0, 0, 3 * ONE, 7 * ONE);
    assert_eq!(m.get_status().orders[0].state, OrderState::Pending);
    ctx("agent.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.pay("two".into(), id("vendor.test"), U128(ONE)));
    });
    ledger(&m, 0, 0, 3 * ONE, 7 * ONE);
    for caller in ["owner.test", "intruder.test"] {
        ctx(caller, 0, 2, vec![]);
        rejects(|| {
            drop(m.pay("bad".into(), id("vendor.test"), U128(ONE)));
        });
    }
    assert_eq!(m.get_status().orders.len(), 1);
}

fn payment(m: &mut Mandate, key: &str, success: bool) -> bool {
    ctx(
        "mandate.test",
        0,
        3,
        vec![if success {
            PromiseResult::Successful(vec![])
        } else {
            PromiseResult::Failed
        }],
    );
    m.on_payment(key.into())
}
#[test]
fn u03_payment_settlement_once() {
    let mut accepted = vec![];
    for (case, caller, deposit, results) in [
        (
            "private",
            "agent.test",
            0,
            vec![PromiseResult::Successful(vec![])],
        ),
        ("no-result", "mandate.test", 0, vec![]),
        (
            "multiple-results",
            "mandate.test",
            0,
            vec![
                PromiseResult::Successful(vec![]),
                PromiseResult::Successful(vec![]),
            ],
        ),
        (
            "deposit",
            "mandate.test",
            1,
            vec![PromiseResult::Successful(vec![])],
        ),
        (
            "nonempty-result",
            "mandate.test",
            0,
            vec![PromiseResult::Successful(vec![1])],
        ),
    ] {
        let mut m = fresh();
        pay(&mut m, "one", 3 * ONE);
        ctx(caller, deposit, 2, results);
        if catch_unwind(AssertUnwindSafe(|| {
            m.on_payment("one".into());
        }))
        .is_ok()
        {
            accepted.push(case);
        }
        ledger(&m, 0, 0, 3 * ONE, 7 * ONE);
    }
    assert!(
        accepted.is_empty(),
        "accepted invalid callbacks: {accepted:?}"
    );

    let mut m = fresh();
    pay(&mut m, "one", 3 * ONE);
    assert!(!payment(&mut m, "wrong", true));
    ledger(&m, 0, 0, 3 * ONE, 7 * ONE);
    assert!(payment(&mut m, "one", true));
    ledger(&m, 3 * ONE, 0, 0, 7 * ONE);
    assert!(!payment(&mut m, "one", true));
    ledger(&m, 3 * ONE, 0, 0, 7 * ONE);
    ctx("agent.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.pay("one".into(), id("vendor.test"), U128(ONE)));
    });
    pay(&mut m, "failure", 2 * ONE);
    assert!(!payment(&mut m, "one", false));
    ledger(&m, 3 * ONE, 0, 2 * ONE, 5 * ONE);
    assert!(!payment(&mut m, "failure", false));
    ledger(&m, 3 * ONE, 0, 0, 7 * ONE);
    assert_eq!(m.get_status().orders[1].state, OrderState::Failed);
    ctx("agent.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.pay("failure".into(), id("vendor.test"), U128(ONE)));
    });
}

fn close(m: &mut Mandate) {
    ctx("owner.test", 0, 2, vec![]);
    m.stop();
}
#[test]
fn u04_stop_does_not_cancel_committed_payment() {
    let mut m = fresh();
    ctx("agent.test", 0, 2, vec![]);
    rejects(|| {
        m.stop();
    });
    ctx("owner.test", 1, 2, vec![]);
    rejects(|| {
        m.stop();
    });

    let mut m = fresh();
    pay(&mut m, "pending", 3 * ONE);
    close(&mut m);
    assert!(m.get_status().stopped);
    ctx("agent.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.pay("new".into(), id("vendor.test"), U128(ONE)));
    });
    assert!(payment(&mut m, "pending", true));
    ledger(&m, 3 * ONE, 0, 0, 7 * ONE);
    close(&mut m);
    assert!(m.get_status().stopped);
}

fn withdraw(m: &mut Mandate) {
    ctx("owner.test", 0, 2, vec![]);
    drop(m.withdraw());
}
#[test]
fn u05_only_owner_settled_free_principal() {
    let mut empty = fresh();
    pay(&mut empty, "all", 10 * ONE);
    assert!(payment(&mut empty, "all", true));
    close(&mut empty);
    ctx("owner.test", 0, 2, vec![]);
    rejects(|| {
        drop(empty.withdraw());
    });
    ledger(&empty, 10 * ONE, 0, 0, 0);
    let mut deposit = fresh();
    close(&mut deposit);
    ctx("owner.test", 1, 2, vec![]);
    rejects(|| {
        drop(deposit.withdraw());
    });
    ledger(&deposit, 0, 0, 0, 10 * ONE);

    let mut m = fresh();
    ctx("owner.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.withdraw());
    });
    pay(&mut m, "pending", 3 * ONE);
    close(&mut m);
    ctx("owner.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.withdraw());
    });
    assert!(payment(&mut m, "pending", true));
    ctx("agent.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.withdraw());
    });
    withdraw(&mut m);
    ledger(&m, 3 * ONE, 0, 7 * ONE, 0);
    assert_eq!(m.get_status().refund_nonce.0, 1);
    ctx("owner.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.withdraw());
    });
}

fn refund(m: &mut Mandate, nonce: u64, success: bool) -> bool {
    ctx(
        "mandate.test",
        0,
        3,
        vec![if success {
            PromiseResult::Successful(vec![])
        } else {
            PromiseResult::Failed
        }],
    );
    m.on_refund(U64(nonce))
}
#[test]
fn u06_refund_failure_retry_and_stale_nonce() {
    let mut accepted = vec![];
    for (case, caller, deposit, results) in [
        (
            "private",
            "agent.test",
            0,
            vec![PromiseResult::Successful(vec![])],
        ),
        ("no-result", "mandate.test", 0, vec![]),
        (
            "multiple-results",
            "mandate.test",
            0,
            vec![
                PromiseResult::Successful(vec![]),
                PromiseResult::Successful(vec![]),
            ],
        ),
        (
            "deposit",
            "mandate.test",
            1,
            vec![PromiseResult::Successful(vec![])],
        ),
        (
            "nonempty-result",
            "mandate.test",
            0,
            vec![PromiseResult::Successful(vec![1])],
        ),
    ] {
        let mut m = fresh();
        close(&mut m);
        withdraw(&mut m);
        ctx(caller, deposit, 2, results);
        if catch_unwind(AssertUnwindSafe(|| {
            m.on_refund(U64(1));
        }))
        .is_ok()
        {
            accepted.push(case);
        }
        ledger(&m, 0, 0, 10 * ONE, 0);
    }
    assert!(
        accepted.is_empty(),
        "accepted invalid callbacks: {accepted:?}"
    );

    let mut m = fresh();
    close(&mut m);
    withdraw(&mut m);
    assert!(!refund(&mut m, 1, false));
    ledger(&m, 0, 0, 0, 10 * ONE);
    withdraw(&mut m);
    assert_eq!(m.get_status().refund_nonce.0, 2);
    assert!(!refund(&mut m, 1, true));
    ledger(&m, 0, 0, 10 * ONE, 0);
    assert!(refund(&mut m, 2, true));
    ledger(&m, 0, 10 * ONE, 0, 0);
    assert!(!refund(&mut m, 2, true));
    ledger(&m, 0, 10 * ONE, 0, 0);
    ctx("owner.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.withdraw());
    });
}

#[test]
fn u07_callback_boundary() {
    let mut m = fresh();
    pay(&mut m, "one", 3 * ONE);
    ctx("agent.test", 0, 2, vec![PromiseResult::Successful(vec![])]);
    rejects(|| {
        m.on_payment("one".into());
    });
    ctx("mandate.test", 0, 2, vec![]);
    rejects(|| {
        m.on_payment("one".into());
    });
    ctx(
        "mandate.test",
        0,
        2,
        vec![
            PromiseResult::Successful(vec![]),
            PromiseResult::Successful(vec![]),
        ],
    );
    rejects(|| {
        m.on_payment("one".into());
    });
    ctx(
        "mandate.test",
        1,
        2,
        vec![PromiseResult::Successful(vec![])],
    );
    rejects(|| {
        m.on_payment("one".into());
    });
    ctx(
        "mandate.test",
        0,
        2,
        vec![PromiseResult::Successful(vec![1])],
    );
    rejects(|| {
        m.on_payment("one".into());
    });
    ledger(&m, 0, 0, 3 * ONE, 7 * ONE);
    assert!(!refund(&mut m, 1, true));
    ledger(&m, 0, 0, 3 * ONE, 7 * ONE);
    assert!(payment(&mut m, "one", true));
    close(&mut m);
    withdraw(&mut m);
    ctx("owner.test", 0, 2, vec![PromiseResult::Successful(vec![])]);
    rejects(|| {
        m.on_refund(U64(1));
    });
    assert!(!payment(&mut m, "one", true));
    ledger(&m, 3 * ONE, 0, 7 * ONE, 0);
}

#[test]
fn u08_bounds_expiry_and_deposits() {
    let mut m = fresh();
    for (key, recipient, amount, deposit, now) in [
        ("excluded".to_string(), "excluded.test", ONE, 0, 2),
        ("budget".to_string(), "vendor.test", 11 * ONE, 0, 2),
        ("zero".to_string(), "vendor.test", 0, 0, 2),
        ("deposit".to_string(), "vendor.test", ONE, ONE, 2),
        ("expiry".to_string(), "vendor.test", ONE, 0, END),
        ("".to_string(), "vendor.test", ONE, 0, 2),
        ("x".repeat(65), "vendor.test", ONE, 0, 2),
        ("bad/id".to_string(), "vendor.test", ONE, 0, 2),
    ] {
        ctx("agent.test", deposit, now, vec![]);
        rejects(|| {
            drop(m.pay(key, id(recipient), U128(amount)));
        });
        ledger(&m, 0, 0, 0, 10 * ONE);
    }
    ctx("agent.test", 0, 2, vec![]);
    rejects(|| {
        m.stop();
    });
    ctx("owner.test", 1, 2, vec![]);
    rejects(|| {
        m.stop();
    });
    ctx("owner.test", 0, END, vec![]);
    assert!(m.get_status().expired);
    drop(m.withdraw());
    ledger(&m, 0, 0, 10 * ONE, 0);
    ctx("owner.test", 1, END, vec![]);
    rejects(|| {
        drop(m.withdraw());
    });
    let mut m = fresh();
    for i in 0..16 {
        pay(&mut m, &format!("o{i}"), 1);
        assert!(payment(&mut m, &format!("o{i}"), true));
    }
    ctx("agent.test", 0, 2, vec![]);
    rejects(|| {
        drop(m.pay("overflow".into(), id("vendor.test"), U128(1)));
    });
    assert_eq!(m.get_status().orders.len(), 16);
}

fn factory_context(predecessor: &str, signer: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("job.factory.testnet"))
        .predecessor_account_id(id(predecessor))
        .signer_account_id(id(signer))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1000))
        .block_timestamp(1)
        .prepaid_gas(Gas::from_tgas(100));
    testing_env!(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::new(),
        vec![]
    );
}

#[test]
fn u10_factory_initializer_rejects_nonparent_predecessor() {
    for predecessor in [
        "intruder.testnet",
        "owner.testnet",
        "factory.testnet.evil",
        "testnet",
    ] {
        factory_context(predecessor, "factory.testnet", 10 * ONE);
        rejects(|| {
            Mandate::new_from_factory(
                id("owner.testnet"),
                id("agent.testnet"),
                vec![id("vendor.testnet")],
                U128(10 * ONE),
                U64(END),
            );
        });
    }
}

#[test]
fn u11_factory_shared_validation_and_owner_authority() {
    for owner in ["owner.testnet", &"a".repeat(64)] {
        factory_context("factory.testnet", "unrelated.testnet", 10 * ONE);
        let mut m = Mandate::new_from_factory(
            id(owner),
            id("agent.testnet"),
            vec![id("vendor.testnet")],
            U128(10 * ONE),
            U64(END),
        );
        assert_eq!(m.get_status().owner, id(owner));
        ledger(&m, 0, 0, 0, 10 * ONE);
        factory_context("factory.testnet", owner, 0);
        rejects(|| m.stop());
        factory_context(owner, "unrelated.testnet", 0);
        m.stop();
        assert!(m.get_status().stopped);
    }
    factory_context("factory.testnet", "owner.testnet", 10 * ONE);
    rejects(|| {
        Mandate::new(
            id("owner.testnet"),
            id("agent.testnet"),
            vec![id("vendor.testnet")],
            U128(10 * ONE),
            U64(END),
        );
    });
    for (agent, cap, deposit, allowlist, deadline) in [
        (
            "owner.testnet",
            10 * ONE,
            10 * ONE,
            vec![id("vendor.testnet")],
            END,
        ),
        (
            "job.factory.testnet",
            10 * ONE,
            10 * ONE,
            vec![id("vendor.testnet")],
            END,
        ),
        ("agent.testnet", 0, 0, vec![id("vendor.testnet")], END),
        (
            "agent.testnet",
            101 * ONE,
            101 * ONE,
            vec![id("vendor.testnet")],
            END,
        ),
        (
            "agent.testnet",
            10 * ONE,
            11 * ONE,
            vec![id("vendor.testnet")],
            END,
        ),
        ("agent.testnet", 10 * ONE, 10 * ONE, vec![], END),
        (
            "agent.testnet",
            10 * ONE,
            10 * ONE,
            vec![id("vendor.testnet"); 5],
            END,
        ),
        (
            "agent.testnet",
            10 * ONE,
            10 * ONE,
            vec![id("vendor.testnet"); 2],
            END,
        ),
        (
            "agent.testnet",
            10 * ONE,
            10 * ONE,
            vec![id("owner.testnet")],
            END,
        ),
        (
            "agent.testnet",
            10 * ONE,
            10 * ONE,
            vec![id("agent.testnet")],
            END,
        ),
        (
            "agent.testnet",
            10 * ONE,
            10 * ONE,
            vec![id("job.factory.testnet")],
            END,
        ),
        (
            "agent.testnet",
            10 * ONE,
            10 * ONE,
            vec![id("vendor.testnet")],
            1,
        ),
        (
            "agent.testnet",
            10 * ONE,
            10 * ONE,
            vec![id("vendor.testnet")],
            8 * 24 * 60 * 60 * 1_000_000_000,
        ),
    ] {
        factory_context("factory.testnet", "unrelated.testnet", deposit);
        rejects(|| {
            Mandate::new_from_factory(
                id("owner.testnet"),
                id(agent),
                allowlist,
                U128(cap),
                U64(deadline),
            );
        });
    }
}

// Storage contexts start without a STATE record, just like a fresh deployment.
fn storage_context(factory: bool, float: u128, code_bytes: u64) {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("job.factory.testnet"))
        .predecessor_account_id(id(if factory {
            "factory.testnet"
        } else {
            "owner.testnet"
        }))
        .attached_deposit(NearToken::from_yoctonear(10 * ONE))
        // VMContext balance is BEFORE the attached deposit is credited.
        .account_balance(NearToken::from_yoctonear(float))
        .storage_usage(code_bytes + 100)
        .block_timestamp(1)
        .prepaid_gas(Gas::from_tgas(100));
    testing_env!(b.build());
}
fn storage_init(factory: bool) -> Mandate {
    let init = if factory {
        Mandate::new_from_factory
    } else {
        Mandate::new
    };
    init(
        id("owner.testnet"),
        id("agent.testnet"),
        vec![id("vendor.testnet")],
        U128(10 * ONE),
        U64(END),
    )
}
#[test]
fn u12_principal_cannot_back_storage_in_either_constructor() {
    for factory in [false, true] {
        storage_context(factory, 1, 140_000);
        rejects(|| {
            storage_init(factory);
        });
    }
}

// Independent oracle serializes the complete largest reachable state, rather
// than copying the constructor's incremental byte arithmetic.
fn maximal_state_bytes(m: &Mandate) -> u64 {
    let s = m.get_status();
    let recipient = s
        .allowlist
        .iter()
        .max_by_key(|a| a.as_str().len())
        .unwrap()
        .clone();
    let orders: Vec<_> = (0..16)
        .map(|i| u01_mandate_proof::Order {
            order_id: format!("{i:064}"),
            recipient: recipient.clone(),
            amount: U128(1),
            state: OrderState::Pending,
        })
        .collect();
    near_sdk::borsh::to_vec(&(
        s.owner,
        s.agent,
        s.allowlist,
        s.cap.0,
        s.deadline_ns.0,
        0u128,
        0u128,
        false,
        orders,
        Some(("x".repeat(64), 1u128, false)),
        u64::MAX,
    ))
    .unwrap()
    .len() as u64
}
#[test]
fn u13_exact_storage_boundary_reserves_all_future_orders_and_flight() {
    let price = near_sdk::env::storage_byte_cost().as_yoctonear();
    for code_bytes in [0, 140_000, 280_000] {
        for factory in [false, true] {
            storage_context(factory, 10 * ONE, code_bytes);
            let sample = storage_init(factory);
            let initial = near_sdk::borsh::to_vec(&sample).unwrap().len() as u64;
            let max = maximal_state_bytes(&sample);
            assert!(max > initial);
            let minimum = u128::from(code_bytes + 100 + 5 + 40 + max) * price;
            for insufficient in [
                u128::from(code_bytes + 100 + 5 + 40 + initial) * price,
                minimum - 1,
            ] {
                storage_context(factory, insufficient, code_bytes);
                rejects(|| {
                    storage_init(factory);
                });
            }
            storage_context(factory, minimum, code_bytes);
            let m = storage_init(factory);
            // Explicit early write plus the SDK's later write count STATE once.
            let before = near_sdk::env::storage_usage();
            near_sdk::env::state_write(&m);
            assert_eq!(near_sdk::env::storage_usage(), before);
            assert_eq!(before, code_bytes + 100 + 5 + 40 + initial);
            ledger(&m, 0, 0, 0, 10 * ONE);
        }
    }
}

#[test]
fn u14_maximum_accounts_orders_and_refund_nonce_fit_serialized_bound() {
    let owner = "a".repeat(64);
    let agent = "b".repeat(64);
    let allowlist: Vec<_> = ['c', 'd', 'e', 'f']
        .iter()
        .map(|c| id(&c.to_string().repeat(64)))
        .collect();
    let initialize = || {
        Mandate::new_from_factory(
            id(&owner),
            id(&agent),
            allowlist.clone(),
            U128(10 * ONE),
            U64(END),
        )
    };
    storage_context(true, 10 * ONE, 140_000);
    let sample = initialize();
    let max = maximal_state_bytes(&sample);
    let minimum = u128::from(140_000 + 100 + 5 + 40 + max)
        * near_sdk::env::storage_byte_cost().as_yoctonear();
    storage_context(true, minimum - 1, 140_000);
    rejects(|| {
        initialize();
    });
    storage_context(true, minimum, 140_000);
    let mut m = initialize();
    let context = |predecessor: &str, results: Vec<PromiseResult>| {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id("job.factory.testnet"))
            .predecessor_account_id(id(predecessor))
            .account_balance(NearToken::from_near(1000))
            .block_timestamp(2)
            .prepaid_gas(Gas::from_tgas(100));
        testing_env!(
            b.build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            HashMap::new(),
            results
        );
    };
    for i in 0..16 {
        let key = format!("{i:064}");
        context(&agent, vec![]);
        drop(m.pay(key.clone(), allowlist[0].clone(), U128(1)));
        let pending = near_sdk::borsh::to_vec(&m).unwrap().len() as u64;
        assert!(pending <= max);
        if i == 15 {
            assert_eq!(pending, max);
        }
        context("job.factory.testnet", vec![PromiseResult::Failed]);
        assert!(!m.on_payment(key));
    }
    ledger(&m, 0, 0, 0, 10 * ONE);
    context(&owner, vec![]);
    m.stop();
    // A reachable retry counter near its lifetime u64 bound; Borsh is fixed
    // width, but its in-flight decimal refund key can grow to 20 bytes.
    let mut bytes = near_sdk::borsh::to_vec(&m).unwrap();
    let n = bytes.len();
    bytes[n - 8..].copy_from_slice(&(u64::MAX - 1).to_le_bytes());
    let mut m: Mandate = near_sdk::borsh::from_slice(&bytes).unwrap();
    drop(m.withdraw());
    assert_eq!(m.get_status().refund_nonce.0, u64::MAX);
    assert_eq!(
        m.get_status().in_flight,
        Some(format!("refund:{}", u64::MAX))
    );
    assert_eq!(
        near_sdk::borsh::to_vec(&m).unwrap().len() as u64,
        max - (64 - 20)
    );
    ledger(&m, 0, 0, 10 * ONE, 0);
}

#[test]
fn u09_initializer_limits() {
    for (owner, agent, allowlist, cap, deadline) in [
        (
            "owner.test",
            "owner.test",
            vec![id("vendor.test")],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "mandate.test",
            vec![id("vendor.test")],
            10 * ONE,
            END,
        ),
        ("owner.test", "agent.test", vec![], 10 * ONE, END),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test"); 5],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test"); 2],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("mandate.test")],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("owner.test")],
            10 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("agent.test")],
            10 * ONE,
            END,
        ),
        ("owner.test", "agent.test", vec![id("vendor.test")], 0, END),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test")],
            101 * ONE,
            END,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test")],
            10 * ONE,
            1,
        ),
        (
            "owner.test",
            "agent.test",
            vec![id("vendor.test")],
            10 * ONE,
            8 * 24 * 60 * 60 * 1_000_000_000,
        ),
    ] {
        ctx(owner, cap, 1, vec![]);
        rejects(|| {
            Mandate::new(id(owner), id(agent), allowlist, U128(cap), U64(deadline));
        });
    }
}
