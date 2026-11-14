[![Haldir — Give AI a job. Keep control of its spending.](docs/assets/haldir-cover.jpg)](https://haldir.ldt.sh/)

# Haldir

Haldir is a research-agent prototype that separates permission to do a job from permission to spend money. A person reviews the job, spending cap, expiry and allowed recipients. The agent works within that mandate; a request in an email cannot grant it new spending authority.

Built for **NEAR HACKATHON 2026**.

[Website](https://haldir.ldt.sh/) · [Workspace preview](https://haldir.ldt.sh/app) · [Scripted demo](https://haldir.ldt.sh/demo) · [Architecture](docs/ARCHITECTURE.md) · [Run and verify](docs/VALIDATION.md)

## The problem

An agent checking a supplier may need to buy company records or background research. Giving it a wallet is too much authority; asking the user to approve every step defeats the point of delegation. A budget alone is not enough either: an unauthorized payment can still be cheap.

Haldir makes the boundary explicit: **enough money does not mean permission to pay.**

## See the boundary in action

[![Actual Haldir scripted-demo capture: a 2 TEST request to an excluded recipient is blocked while 22 TEST remains available. The visible notice identifies the workflow as simulated.](docs/assets/scripted-demo.png)](docs/assets/scripted-demo.png)

*Captured from the public scripted demo. Fictional data and simulated events, not live payments. Click the image to inspect the full-size interface, or [try the same walkthrough](docs/DEMO.md).*

## One job, a visible result, bounded spending

The target product journey follows a fictional supplier, **Northwind Print**. The current browser simulation demonstrates its spending states and a partial evidence preview, not the complete backend report:

1. Ask for a short evidence-backed brief before signing a contract.
2. Review one mandate with a spending cap, expiry and two approved recipients.
3. Obtain the first source and inspect its evidence and purchase receipt while another source is pending.
4. Encounter an email requesting a small extra payment to an unapproved recipient. The amount fits the budget; the recipient does not.
5. Reject that payment without widening the mandate, then continue the permitted work.
6. Review the brief, including sources, limitations and a concrete next check. This richer report is exercised in the backend fixture tests; the browser demo currently shows only a partial brief.
7. Stop new spending and recover only settled, unused principal after confirmation.

The scripted demo uses **30 TEST**, with illustrative purchases of **8** and **15**, an excluded request for **2**, and **7** left to recover. TEST is a fictional demonstration unit, not an instruction to fund a wallet or a claim that these transfers happened on a public network.

## Why NEAR is part of the mechanism

[![Architecture illustration: an agent request passes through the NEAR mandate's recipient, cap, expiry and stop checks before a payment can proceed. Email content cannot grant permissions.](docs/assets/spending-boundary.png)](docs/ARCHITECTURE.md)

*Mechanism illustration, not a transaction receipt. Read the [trust boundaries and implementation limits](docs/ARCHITECTURE.md).*

The native implementation puts the spending boundary in a **NEAR smart contract**, separate from the model and the chat interface:

- **One job-specific mandate:** owner, agent, allowed recipients, principal cap and expiry are bound at creation.
- **Restricted payment entry:** `pay` checks the caller, recipient, remaining principal, expiry, stop state and operation identity before requesting a native transfer.
- **Asynchronous outcomes:** pending payments reserve principal; callbacks determine paid or failed outcomes. A lost response is not permission to pay again.
- **Owner-controlled closure:** `stop` prevents new spending. `withdraw` returns free principal only after closure and when no operation is in flight.
- **Restricted agent capability:** the wallet qualification code checks a finite-allowance, `pay`-only function-call key for the exact mandate, rejecting full-access or extra-method keys.

The contract permits **one in-flight payment or withdrawal at a time**. It does not claim parallel settlement or cross-chain payments. Native NEAR execution, local Sandbox tests, the browser simulation and a public testnet deployment are different evidence levels.

See [the architecture and trust boundaries](docs/ARCHITECTURE.md) for the source map and what the contract does **not** guarantee.

## Try it without a wallet

Open [the scripted demo](https://haldir.ldt.sh/demo). It is a presenter-driven walkthrough, not a live financial service. No wallet, funds or model API key is needed for this mode.

Follow the [demo guide](docs/DEMO.md) for exact actions and expected observations. The presenter controls deliberately expose simulated funding, purchase and return events; they are not agent autonomy or on-chain evidence.

## Implementation and evidence status

This is a hackathon prototype, not an audited financial product. The latest reviewed publication is an interface preview and scripted demonstration; its financial execution, model execution and trusted signing are disabled. This documentation update does not certify a newer deployment.

| Layer | What is available | What that establishes |
| --- | --- | --- |
| User experience | Conversational job preparation, mandate review, working panel and a scripted lifecycle | A way to inspect the interaction and state transitions, not real purchases |
| Native NEAR contracts | Mandate and factory source; Rust and local Sandbox test suites | Inspectable enforcement logic and a local-chain qualification path |
| Agent and backend | Two-source orchestration, payment/delivery evidence binding, report generation, owner operations and recovery adapters | Implemented components with local synthetic tests; not a completed public financial journey |
| Focused verification | **386/386 tests passed on 14 November 2026**, using the exact command in the validation guide | Restricted wallet requests, owner-operation checks, two-source bindings, fixtures and runner behavior under synthetic transports |
| Public end-to-end execution | **Not established by this documentation** | Requires a separately verified wallet, network, provider, persistence and hosted-runtime run |

The focused test result reused installed dependencies. It is not a fresh-install result, security audit, live model invocation or public-chain acceptance. Broader historical test totals are intentionally not added together.

**Current limitations:** fictional email and supplier sources; no verified mailbox connector; no universal phishing detection; no guarantee of supplier accuracy; no privacy/TEE or mainnet assurance. A report preserves evidence and uncertainty rather than declaring the supplier safe to sign with.

## Run locally

Use **Node 26.13.1**. The frontend also declares **npm 12.2.2**. Root and frontend dependencies are installed separately.

```sh
git clone https://github.com/Loadout-gg/Haldir.git
cd Haldir
npm ci --ignore-scripts
npm --prefix prototype ci --ignore-scripts
npm --prefix prototype run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173/demo` for the scripted walkthrough. These commands do not activate a financial backend. Use an unused local port if 5173 is occupied.

**Source-release boundary:** the application source snapshot must include `prototype/`, `src/`, `tests/` and the native qualification directories. A checkout containing only the early toolchain probes is not the full Haldir application. Clean-clone reproduction and publication of the complete source snapshot remain release checks; the commands above are not a claim that those checks have passed.

[Validation guide](docs/VALIDATION.md): focused tests, UI build and native Sandbox setup. There is no root `npm test`; the root `test:sandbox` script tests the early return-42 probe, not the spending mandate.

## For reviewers

The most useful questions are concrete:

- Can a prompt or email change the authorized recipients? Inspect the immutable job bindings and the contract recipient check.
- Can an uncertain payment trigger a duplicate charge? Follow stable operation identities, receipt reconciliation and the lost-response tests.
- Does the useful result survive a blocked payment? Inspect the scripted walkthrough and two-source report tests separately.
- Can the owner distinguish available funds from funds actually recovered? Inspect stop/withdraw validation and the receipt-linked outcomes.

Start with [the demo](docs/DEMO.md), then [the trust boundaries](docs/ARCHITECTURE.md), then [the verification commands and their limits](docs/VALIDATION.md). This is stronger evidence than a total test count or an unexplained “powered by NEAR” claim.

## Repository map

| Path | Purpose |
| --- | --- |
| `prototype/` | React interface, scripted demonstration and UI tests |
| `qualification/mandate-contract/` | Native NEAR spending mandate |
| `qualification/mandate-factory/` | Job-specific mandate creation |
| `qualification/native-wallet/` | Unsigned owner requests and restricted-key validation |
| `src/server/` | Job admission, owner operations, orders and chain-evidence validation |
| `src/agent/` | Bounded research orchestration and model-provider interface |
| `src/vendor/` | Fictional source delivery and payment-proof handling |
| `tests/` | Backend and agent regression tests |
| `deployment/haldir-public/` | Hosted-runtime composition and qualification tools |
| `qualification/agent-api/`, `qualification/owner-ui/` | Earlier Agent API and owner-signing experiments, not the current native mandate route |

## Build provenance and licensing

Haldir was developed with AI coding assistance. Earlier code and package names may use **U01**, the project's original technical name. The stack includes NEAR SDK/API/Sandbox, Meteor, React, Vite, Tailwind, Base UI and Lucide; exact dependency versions are recorded in their lockfiles. The bundled Manrope font retains its SIL Open Font License (`prototype/public/fonts/manrope/OFL.txt`).

**The project license has not yet been selected.** Public visibility alone does not grant an open-source license. A project LICENSE and the final hackathon baseline/contribution disclosure must be resolved before submission; third-party licenses do not license Haldir itself. Do not publish credentials, personal submission data or real customer email in this repository.
