# U01

A spending mandate for one AI job. NEAR hackathon project.

## Current scope

Local toolchain qualification only. `qualification/contract` is a disposable
probe returning `42`, not the spending mandate. Its test deploys the compiled
WASM to an ephemeral local NEAR Sandbox, sends a transaction, checks its return
value and tears down the node. It uses the sandbox's public test genesis key,
never a user's wallet. No public testnet or mainnet operations are required.

## Qualified versions

- Node 26.13.0 and npm 12.2.2; Node is pinned in `mise.toml`.
- Rust/Cargo 1.99.1 with `wasm32-unknown-unknown`, rustfmt and clippy.
- cargo-near 0.23.0, installed separately from its official macOS ARM64 release
  with its published SHA-256 checked.
- near-sdk 5.30.1; complete Rust resolution in `qualification/contract/Cargo.lock`.
- near-api-js 7.4.0 and near-sandbox 0.3.5; resolution in `package-lock.json`.
- Sandbox binary 2.14.0, explicitly selected in the test.

The sandbox downloader's pinned tar dependency is overridden to 7.5.22 to
resolve advisories reported against its older pin. `npm audit` reported zero
vulnerabilities at qualification; this is a dated advisory check, not a security
certification. Recheck when changing the lockfile.

## Reproduce on the qualified Mac

Prerequisites: Xcode Command Line Tools, the Rust toolchain and cargo-near above,
Node 26.13.0, npm 12.2.2. Ensure `$HOME/.cargo/bin` is on PATH. If using mise,
review this repository's `mise.toml` before trusting it. No global npm packages
are needed.

From the repository root:

```sh
npm ci --ignore-scripts
npm run build:probe
npm run test:sandbox
cargo fmt --manifest-path qualification/contract/Cargo.toml -- --check
npm audit --audit-level=low
```

Initial installation downloads dependencies and the Sandbox binary. The test
then contacts only its loopback RPC. Expected: one test passes and the contract
returns `42`. The build is explicitly a local `non-reproducible-wasm` build;
this does not qualify a reproducible release image.

## Observed qualification

On 9 November 2026 (macOS ARM64):

1. Rust 1.99.1 + near-sdk 5.30.1 compiled successfully with cargo-near 0.23.0.
2. The initial near-workspaces JS 5.0.0 runner failed with WASM deserialization
   in its older Sandbox. It was replaced, not downgraded around.
3. Direct Sandbox 2.14.0 executed the same probe and the test failed on the
   deliberate `0 !== 42` assertion: behavioral RED, separate from runner failure.
4. Changing only the probe return value to `42`, rebuilding and rerunning passed.

Not qualified: allowed recipients, budget reservation, concurrency, credentials,
payment settlement, delivery, callback recovery, revocation or expiry. Those are
the next product-engineering work, not capabilities demonstrated by this probe.

No deployment, CI, cloud resources or paid inference are configured.
