use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near};

const ONE: u128 = 1_000_000_000_000_000_000_000_000;
const MAX_WINDOW: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
const MAX_ORDERS: usize = 16;
const MAX_ORDER_ID_BYTES: usize = 64;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrderState {
    Pending,
    Paid,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Order {
    pub order_id: String,
    pub recipient: AccountId,
    pub amount: U128,
    pub state: OrderState,
}

#[near(serializers = [borsh])]
struct Flight {
    key: String,
    amount: u128,
    refund: bool,
}

#[near(serializers = [json])]
pub struct Status {
    pub owner: AccountId,
    pub agent: AccountId,
    pub allowlist: Vec<AccountId>,
    pub cap: U128,
    pub deadline_ns: U64,
    pub spent: U128,
    pub refunded: U128,
    pub reserved: U128,
    pub free: U128,
    pub stopped: bool,
    pub expired: bool,
    pub in_flight: Option<String>,
    pub refund_nonce: U64,
    pub orders: Vec<Order>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Mandate {
    owner: AccountId,
    agent: AccountId,
    allowlist: Vec<AccountId>,
    cap: u128,
    deadline_ns: u64,
    spent: u128,
    refunded: u128,
    stopped: bool,
    orders: Vec<Order>,
    flight: Option<Flight>,
    refund_nonce: u64,
}

#[near]
impl Mandate {
    #[init]
    #[payable]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        allowlist: Vec<AccountId>,
        cap: U128,
        deadline_ns: U64,
    ) -> Self {
        assert_eq!(env::predecessor_account_id(), owner, "OWNER_ONLY");
        Self::initial_state(owner, agent, allowlist, cap, deadline_ns)
    }

    #[init]
    #[payable]
    pub fn new_from_factory(
        owner: AccountId,
        agent: AccountId,
        allowlist: Vec<AccountId>,
        cap: U128,
        deadline_ns: U64,
    ) -> Self {
        let current = env::current_account_id();
        let (_, parent) = current.as_str().split_once('.').expect("FACTORY_CHILD");
        assert_eq!(
            env::predecessor_account_id().as_str(),
            parent,
            "FACTORY_ONLY"
        );
        Self::initial_state(owner, agent, allowlist, cap, deadline_ns)
    }

    pub fn get_status(&self) -> Status {
        Status {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            allowlist: self.allowlist.clone(),
            cap: U128(self.cap),
            deadline_ns: U64(self.deadline_ns),
            spent: U128(self.spent),
            refunded: U128(self.refunded),
            reserved: U128(self.reserved()),
            free: U128(self.free()),
            stopped: self.stopped,
            expired: env::block_timestamp() >= self.deadline_ns,
            in_flight: self
                .flight
                .as_ref()
                .map(|f| format!("{}:{}", if f.refund { "refund" } else { "payment" }, f.key)),
            refund_nonce: U64(self.refund_nonce),
            orders: self.orders.clone(),
        }
    }

    pub fn pay(&mut self, order_id: String, recipient: AccountId, amount: U128) -> Promise {
        self.zero();
        assert_eq!(env::predecessor_account_id(), self.agent, "AGENT_ONLY");
        assert!(
            !order_id.is_empty()
                && order_id.len() <= MAX_ORDER_ID_BYTES
                && order_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "ORDER_ID"
        );
        assert!(
            !self.orders.iter().any(|o| o.order_id == order_id),
            "DUPLICATE"
        );
        assert!(!self.stopped, "STOPPED");
        assert!(env::block_timestamp() < self.deadline_ns, "EXPIRED");
        assert!(self.allowlist.contains(&recipient), "RECIPIENT");
        assert!(self.flight.is_none(), "IN_FLIGHT");
        assert!(self.orders.len() < MAX_ORDERS, "ORDER_LIMIT");
        assert!(amount.0 > 0 && amount.0 <= self.free(), "BUDGET");
        self.gas();
        self.orders.push(Order {
            order_id: order_id.clone(),
            recipient: recipient.clone(),
            amount,
            state: OrderState::Pending,
        });
        self.flight = Some(Flight {
            key: order_id.clone(),
            amount: amount.0,
            refund: false,
        });
        self.transfer(
            recipient,
            amount.0,
            "on_payment",
            near_sdk::serde_json::json!({"order_id": order_id}),
        )
    }

    pub fn stop(&mut self) {
        self.zero();
        assert_eq!(env::predecessor_account_id(), self.owner, "OWNER_ONLY");
        self.stopped = true;
    }

    pub fn withdraw(&mut self) -> Promise {
        self.zero();
        assert_eq!(env::predecessor_account_id(), self.owner, "OWNER_ONLY");
        assert!(
            self.stopped || env::block_timestamp() >= self.deadline_ns,
            "NOT_CLOSED"
        );
        assert!(self.flight.is_none(), "IN_FLIGHT");
        let amount = self.free();
        assert!(amount > 0, "EMPTY");
        self.gas();
        let nonce = self.refund_nonce.checked_add(1).expect("NONCE_LIMIT");
        self.refund_nonce = nonce;
        self.flight = Some(Flight {
            key: nonce.to_string(),
            amount,
            refund: true,
        });
        self.transfer(
            self.owner.clone(),
            amount,
            "on_refund",
            near_sdk::serde_json::json!({"nonce": U64(nonce)}),
        )
    }

    #[private]
    pub fn on_payment(&mut self, order_id: String) -> bool {
        let ok = self.callback();
        let Some(f) = self.flight.as_ref() else {
            return false;
        };
        if f.refund || f.key != order_id {
            return false;
        }
        let index = self
            .orders
            .iter()
            .position(|o| o.order_id == order_id && o.state == OrderState::Pending)
            .expect("PENDING_BINDING");
        assert_eq!(self.orders[index].amount.0, f.amount, "AMOUNT_BINDING");
        let amount = f.amount;
        if ok {
            self.spent = self.spent.checked_add(amount).expect("OVERFLOW");
        }
        self.orders[index].state = if ok {
            OrderState::Paid
        } else {
            OrderState::Failed
        };
        self.flight = None;
        ok
    }

    #[private]
    pub fn on_refund(&mut self, nonce: U64) -> bool {
        let ok = self.callback();
        let Some(f) = self.flight.as_ref() else {
            return false;
        };
        if !f.refund || f.key != nonce.0.to_string() {
            return false;
        }
        let amount = f.amount;
        if ok {
            self.refunded = self.refunded.checked_add(amount).expect("OVERFLOW");
        }
        self.flight = None;
        ok
    }
}

impl Mandate {
    fn initial_state(
        owner: AccountId,
        agent: AccountId,
        allowlist: Vec<AccountId>,
        cap: U128,
        deadline_ns: U64,
    ) -> Self {
        assert!(
            owner != agent
                && owner != env::current_account_id()
                && agent != env::current_account_id(),
            "ROLES"
        );
        assert!(cap.0 > 0 && cap.0 <= 100 * ONE, "CAP");
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            cap.0,
            "PRINCIPAL_DEPOSIT"
        );
        let now = env::block_timestamp();
        assert!(
            deadline_ns.0 > now && deadline_ns.0 - now <= MAX_WINDOW,
            "DEADLINE"
        );
        assert!(
            !allowlist.is_empty() && allowlist.len() <= 4,
            "ALLOWLIST_SIZE"
        );
        for (i, recipient) in allowlist.iter().enumerate() {
            assert!(
                recipient != &owner
                    && recipient != &agent
                    && recipient != &env::current_account_id(),
                "RECIPIENT_ROLE"
            );
            assert!(!allowlist[..i].contains(recipient), "ALLOWLIST_DUPLICATE");
        }
        let state = Self {
            owner,
            agent,
            allowlist,
            cap: cap.0,
            deadline_ns: deadline_ns.0,
            spent: 0,
            refunded: 0,
            stopped: false,
            orders: vec![],
            flight: None,
            refund_nonce: 0,
        };
        // Immutable allowlist bounds every future recipient (AccountId <=64 bytes).
        // Serialize the real types: 16 retained orders, including failed orders,
        // plus ONE flight. Payment keys are <=64 bytes; u64 refund keys <=20.
        // Vec length and Option tag already exist in the empty initial STATE;
        // all other fields are fixed-width or immutable. No collection writes.
        let largest_order = Order {
            order_id: "x".repeat(MAX_ORDER_ID_BYTES),
            recipient: state
                .allowlist
                .iter()
                .max_by_key(|a| a.as_str().len())
                .expect("ALLOWLIST_SIZE")
                .clone(),
            amount: U128(0),
            state: OrderState::Pending,
        };
        let largest_flight = Flight {
            key: "x".repeat(MAX_ORDER_ID_BYTES),
            amount: 0,
            refund: false,
        };
        let growth = (MAX_ORDERS
            * near_sdk::borsh::to_vec(&largest_order)
                .expect("ORDER_BYTES")
                .len()
            + near_sdk::borsh::to_vec(&largest_flight)
                .expect("FLIGHT_BYTES")
                .len()) as u64;
        // The init wrapper writes STATE only after this function returns. Materialize
        // it now so runtime usage includes code, account, key and record overhead.
        // The wrapper's identical overwrite adds no bytes; a panic rolls this back.
        env::state_write(&state);
        let max_storage = env::storage_usage()
            .checked_add(growth)
            .expect("STORAGE_BYTES");
        let storage_cost = u128::from(max_storage)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("STORAGE_COST");
        assert!(
            env::account_balance()
                .as_yoctonear()
                .checked_sub(cap.0)
                .is_some_and(|float| float >= storage_cost),
            "STORAGE_FUNDING"
        );
        state
    }

    fn reserved(&self) -> u128 {
        self.flight.as_ref().map_or(0, |f| f.amount)
    }
    fn free(&self) -> u128 {
        self.cap
            .checked_sub(self.spent)
            .and_then(|v| v.checked_sub(self.refunded))
            .and_then(|v| v.checked_sub(self.reserved()))
            .expect("ACCOUNTING")
    }

    fn zero(&self) {
        assert_eq!(env::attached_deposit().as_yoctonear(), 0, "NO_DEPOSIT");
    }
    fn gas(&self) {
        assert!(env::prepaid_gas() >= Gas::from_tgas(80), "GAS");
    }
    fn transfer(
        &self,
        recipient: AccountId,
        amount: u128,
        callback: &str,
        args: near_sdk::serde_json::Value,
    ) -> Promise {
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Promise::new(env::current_account_id()).function_call(
                callback.to_string(),
                near_sdk::serde_json::to_vec(&args).expect("CALLBACK_ARGS"),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(20),
            ))
    }

    fn callback(&self) -> bool {
        self.zero();
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "CALLBACK_PRIVATE"
        );
        assert_eq!(env::promise_results_count(), 1, "CALLBACK_RESULT");
        match env::promise_result_checked(0, 0) {
            Ok(_) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => panic!("TRANSFER_RESULT"),
        }
    }
}
