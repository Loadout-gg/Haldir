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

This release includes `prototype/`, `src/`, `tests/`, `qualification/mandate-contract/`, `qualification/mandate-factory/` and `qualification/native-wallet/`, with all 278 selected members present. The offline cloud command helper `deployment/haldir-cloud/packet.py` and its test `deployment/haldir-cloud/test_packet.py` are now included. Rendering commands requires your own explicitly configured authorized account; imports and pure assembly do not. See [account configuration](../deployment/haldir-cloud/ACCOUNT-CONFIGURATION.md), [source provenance](SOURCE-PROVENANCE.md) and [portability notes](SOURCE-PORTABILITY.md). The helper only renders command arrays; its inclusion does not authorize cloud execution. Its 18 Python tests and 102 subtests passed in a closed offline runner with zero product-test external-operation attempts; this is not a clean-install, full-suite or deployment result.

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
  tests/server/fixture.test.mjs \
  tests/agent/two-source-run-job.test.mjs
```

**Historical execution, not a rerun of this public snapshot:** a prior local run recorded 386 passing tests under Node `v26.13.1` using existing dependencies. That run also included `tests/server/two-source-contract.test.mjs`, which is not part of this selected publication, so its total is not attributed to the command above. The shell npm version was `11.20.0`, not the frontend's declared `12.2.2`; dependency installation/build was not part of that run. This publication performs byte-integrity and source scans, not a fresh application qualification.

The test run covers:

- unsigned owner-request shape and restricted execution-key validation;
- causal owner-operation evidence and unknown-outcome handling;
- explicit same-identity preparation retry without reopening uncertain operations;
- distinct two-source bindings and proof ownership;
- fictional Northwind evidence, report limitations and next checks;
- lost-response recovery, owner stop/expiry between sources, report fallback and cached recovery.

External RPC, wallet, model and payment outcomes in these tests are synthetic. A receipt-shaped fixture is not a public-chain receipt. This focused result must not be combined with overlapping historical totals to produce a larger unique-test count.

### Public-only backend and closed-runtime reproduction

This source-only path needs **only the root lockfile installation**; it does not need the frontend installation, a UI build, WASM, Chrome, private operator records or credentials. Use the exact public baseline `0430aeaf082777f08b83795a46c984b9cfca8d8f` plus the reproduction correction containing this section; do not silently substitute a newer branch. The correction supplies the previously missing `deployment/haldir-testnet/manifest.synthetic-fixture.json` without changing the consuming tests or product guards.

```sh
# In your isolated checkout, with Node 26.13.1 selected:
node --version
npm --version
npm ci --ignore-scripts --no-audit --no-fund
mkdir -p test-results/portable-home test-results/portable-tmp
env -i PATH="$PATH" HOME="$PWD/test-results/portable-home" \
  TMPDIR="$PWD/test-results/portable-tmp" \
  node --test --test-reporter=tap --test-timeout=120000 \
  qualification/native-wallet/*.test.mjs \
  tests/server/near-owner-operations.test.mjs \
  tests/server/owner-preparation-retry.test.mjs \
  tests/server/fixture.test.mjs \
  tests/agent/two-source-run-job.test.mjs \
  tests/server/near-manifest.test.mjs \
  tests/server/near-mandate-status.test.mjs \
  tests/server/closed-runtime.test.mjs \
  tests/server/app.test.mjs \
  deployment/haldir-public/server.test.mjs \
  deployment/haldir-public/trusted-composition.test.mjs
```

The added manifest is **synthetic test input only**, constructed from the public test contracts and existing public artifact hash pins. Its generic accounts, public keys, protocol responses and historical fixture clock are not deployment records, funded accounts, authorization or live chain evidence. It contains no WASM and does not replace a build prerequisite. Existing admission, ownership, expiry, scope, budget and malformed-evidence assertions remain unchanged.

`closed-runtime.test.mjs` exercises the real public/preview executables' refusal before network/listening, and the public executable's missing generated-UI-receipt gate. It also starts the actual public server factory and default closed composition on ephemeral loopback using an in-memory local repository and explicitly synthetic static HTML. Health responds; unauthenticated creation is rejected; model/signing/financial capabilities remain disabled. This is **closed local startup**, not successful hosted `main.mjs` startup, a compiled interface, wallet authentication or a financial journey. The test does not generate a UI receipt to bypass the hosted gate.

The root `npm ci --ignore-scripts` path was exercised with a fresh private npm cache under Node `26.13.1` / npm `11.20.0`: 248 packages installed, followed by actual SDK/module imports and these local checks. Lifecycle scripts were disabled: esbuild and native add-on install hooks were not executed. This is a **scripts-disabled lockfile installation**, not a full lifecycle clean install, frontend installation/build, WASM build, Sandbox or live end-to-end qualification. The frontend's separate npm `12.2.2` requirement remains unchanged. Network/child-process denial controls and a macOS loopback-only sandbox were used for the recorded qualification; the `env -i` command itself is environment isolation, not an OS network sandbox.

Do not broaden this selection to `node --test` or recursive test globs and assume the same prerequisites. In particular:

- `tests/server/near-receipts.test.mjs` and `tests/vendor/payment-proof.test.mjs` retain assertions against `target/mandate-factory/storage-fix/final-sandbox.log`, a historical capture not distributed here. Do not invent that capture or present synthetic data as its replacement. Their historical checks are not part of the public-only command above.
- `tests/vendor/payment-proof.test.mjs` also requires the explicitly installed Sandbox `2.14.0` binary and generated mandate WASM for its real local-chain case. A dependency import alone does not provide either.
- `deployment/haldir-testnet/manifest.test.mjs` and the advanced operational suites require genuine generated mandate/factory WASM. The manifest suite registers its tests but fails while loading those inputs, before exercising contract-manifest validation; other suites may fail during collection. These are separate build-dependent gates, not portable source-only tests.
- Historical owner-signing/operator entrypoints under `qualification/owner-ui/` and `qualification/agent-api/` are not this startup path. Their private approval/signature prerequisites are not supplied by a clone. Generic private-path names in synthetic tests do not mean those records are included or required by this selection.

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

Personal absolute-path defaults were removed by the scoped [portability changes](SOURCE-PORTABILITY.md). Advanced harnesses still require installed Chrome, local WASM outputs or separately supplied historical task-panel `before/` metrics. They are **not the portable quickstart**. Do not copy an operator's absolute paths or enable live signing to satisfy a missing harness prerequisite.

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
