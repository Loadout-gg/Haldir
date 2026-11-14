# Run and verify Haldir

[Back to Haldir](../README.md)

Choose the proof you want. These paths have different prerequisites and establish different things.

| Path | Requires wallet or real funds? | What it demonstrates |
| --- | --- | --- |
| Scripted browser demo | No | User journey and explicit state transitions |
| Focused Node tests | No | Validation, authorization boundaries and synthetic recovery behavior |
| Frontend unit tests/build | No | UI tests and compilation, not public financial execution |
| Native local Sandbox | No public wallet or real funds | Contract execution on an ephemeral local NEAR chain |
| Hosted public-chain journey | Separate configuration and explicit authorization | Not established by the local paths above |

## Prerequisites and source completeness

Use **Node 26.13.1**. The frontend declares **npm 12.2.2**. Check your versions before installing. Root and frontend lockfiles are separate.

The full source snapshot must contain `prototype/`, `src/`, `tests/`, `qualification/mandate-contract/`, `qualification/mandate-factory/` and `qualification/native-wallet/`. If your checkout contains only the initial probe, it is an incomplete application snapshot; changing credentials will not fix that.

```sh
node --version
npm --version
npm ci --ignore-scripts
npm --prefix prototype ci --ignore-scripts
```

Run in your own checkout. Do not reuse another person's actively edited workspace. The commands are reproduction instructions; a fresh dependency installation and clean-clone build have not been certified by this documentation update.

## 1. Run the interface

```sh
npm --prefix prototype run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173/demo`. Use [the walkthrough](DEMO.md), including the visible presenter controls. Stop your server with Ctrl-C. If the port is occupied, select another port rather than terminating an unrelated process.

```sh
npm --prefix prototype run build
npm --prefix prototype run test
```

The build runs TypeScript and Vite. The default frontend test command runs Vitest. Browser tests are a separate runner; a passing unit suite does not establish browser or physical-device behavior.

The frontend development server does not activate the hosted financial, model or signing services. Do not add real keys to make the scripted demo work.

## 2. Reproduce the focused boundary checks

From the repository root:

```sh
node --test --test-timeout=120000 \
  qualification/native-wallet/*.test.mjs \
  tests/server/near-owner-operations.test.mjs \
  tests/server/owner-preparation-retry.test.mjs \
  tests/server/two-source-contract.test.mjs \
  tests/server/fixture.test.mjs \
  tests/agent/two-source-run-job.test.mjs
```

**Execution recorded on 14 November 2026:** 386 tests passed, zero failures, cancellations or skips. Node was `v26.13.1`; the existing dependency installation was reused. The shell npm version was `11.20.0`, not the frontend's declared `12.2.2`; npm installation/build was not part of this run.

The test run covers:

- unsigned owner-request shape and restricted execution-key validation;
- causal owner-operation evidence and unknown-outcome handling;
- explicit same-identity preparation retry without reopening uncertain operations;
- distinct two-source bindings and proof ownership;
- fictional Northwind evidence, report limitations and next checks;
- lost-response recovery, owner stop/expiry between sources, report fallback and cached recovery.

External RPC, wallet, model and payment outcomes in these tests are synthetic. A receipt-shaped fixture is not a public-chain receipt. This focused result must not be combined with overlapping historical totals to produce a larger unique-test count.

## 3. Execute the contracts in local NEAR Sandbox

This path additionally needs Rust/Cargo **1.99.1**, the `wasm32-unknown-unknown` target and **cargo-near 0.23.0**. macOS needs Xcode Command Line Tools. The recorded local setup used Sandbox **2.14.0**. Initial builds may download dependencies and the Sandbox binary.

**Current reproduction blocker:** the three Node Sandbox harnesses below hard-code `process.versions.node === '26.13.0'`, while this project declares Node 26.13.1. They currently fail their version guard under the declared runtime, before starting Sandbox. Do not downgrade the project runtime to hide this mismatch. Those guards must be aligned and the harnesses rerun before this path can be marked reproducible. The build and Rust commands below are separate from that Node-harness blocker.

Build the mandate first because the factory embeds its generated WASM:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$PWD/target"

cargo near build non-reproducible-wasm --locked \
  --manifest-path qualification/mandate-contract/Cargo.toml \
  --no-abi --out-dir target/mandate-wasm

cargo near build non-reproducible-wasm --locked \
  --manifest-path qualification/mandate-factory/Cargo.toml \
  --no-abi --out-dir target/mandate-factory-wasm

cargo test --locked --manifest-path qualification/mandate-contract/Cargo.toml
cargo test --locked --manifest-path qualification/mandate-factory/Cargo.toml

node --test --test-timeout=180000 qualification/mandate.sandbox.test.mjs
node --test --test-timeout=180000 qualification/mandate-factory.sandbox.test.mjs
node --test --test-timeout=180000 qualification/haldir-native-journey.test.mjs
```

Expected WASM output names are `target/mandate-wasm/u01_mandate_proof.wasm` and `target/mandate-factory-wasm/u01_mandate_factory.wasm`. The original technical prefix is retained in these build artifacts.

Sandbox creates ephemeral local accounts and local funds. It is not public testnet. Any model or supplier fixture used by a journey test remains synthetic even when its contract transactions execute on the local chain.

These commands were inspected against the existing setup but **were not rerun in this documentation update**. They are not proof of a reproducible production image or public deployment.

## 4. Advanced runtime tests

`deployment/haldir-public/operational-entrypoint.test.mjs` and `operational-faults.test.mjs` exercise the composed runtime with synthetic external adapters. Installed-Chrome tests such as `prototype/tests/operational-readout-chrome.test.mjs` and `operational-runtime-chrome.test.mjs` exercise narrower browser/runtime surfaces.

Some advanced harnesses still depend on installed Chrome, local WASM outputs, private temporary evidence directories or development-specific paths. They are **not the portable quickstart**. Do not copy an operator's absolute paths or enable live signing to satisfy a missing harness prerequisite.

A scoped reader test at narrow viewport widths is not full-application mobile acceptance. A virtual HTTPS relay is not proof of the deployed TLS/cookie boundary. Local SQLite success is not intended-host Firestore acceptance.

## What remains before claiming a live financial journey

A separate run must establish the exact deployed revision, clean installation, intended persistence service, real wallet flow, restricted agent key, approved network/accounts, provider configuration, causal transfer receipts, source delivery, report, owner stop and settled-principal withdrawal. Same-job reopening must not create extra charges or inference.

Use the network and accounts explicitly authorized for that run. The earlier Agent API experiments under `qualification/agent-api/` are not interchangeable with the current native mandate path; do not assume that an endpoint called “demo” uses testnet.

## Troubleshooting without widening permissions

- **No root `npm test`:** use the explicit Node command above.
- **`test:sandbox` passes but no mandate journey appears:** that root script targets the early return-42 probe, not the mandate contract.
- **No AI response in the scripted demo:** expected; presenter events drive the simulation.
- **Pending/unknown payment:** inspect the same operation. Do not submit a replacement payment to clear the UI.
- **Missing source directory:** obtain the complete source snapshot; do not substitute a different branch or release without identifying what it contains.
- **Missing real provider/wallet configuration:** keep the live path closed. Local tests are not permission to use real credentials or funds.
