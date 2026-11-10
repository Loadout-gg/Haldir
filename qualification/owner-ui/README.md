# Local owner-signing qualification UI

An operator utility, not the U01 product frontend. It displays one already-generated, owner-approved `agent_create` intent and can ask Meteor for an account-only connection and an explicit NEP-366 signature. The server verifies the signature and saves it locally. **There is no Agent API submission, generation or funding route.**

## Run

From the project root on the pinned Node version:

```sh
npm ci --ignore-scripts
node qualification/owner-ui/build.mjs
node --test --test-timeout=15000 qualification/owner-ui/*.test.mjs qualification/agent-api/*.test.mjs
node qualification/owner-ui/run.mjs
```

Open `http://127.0.0.1:4173/` (not `localhost`). The live review entrypoint requires two private, operator-prepared files, deliberately excluded from Git:

- `.hermes/proposals/owner-qualification.json`: exact approved request including owner and policy.
- `.hermes/proposals/owner-intent-generated.json`: corresponding unsigned API response.

It refuses a policy or signer mismatch. A fresh checkout can run all tests and build without these files, but cannot run the live review entrypoint. Do not fabricate or copy someone else's owner records to bypass that prerequisite. No API key is needed by this server.

## Boundaries

- Bind only to loopback. Host and Origin checks reject rebinding/cross-origin requests; signature saving also requires a random session CSRF token.
- The frontend permits only the frozen, empty actions/assets/destinations, zero-budget qualification profile and its two expected function calls.
- Wallet connections use in-memory SDK storage, no function-call-key request, no key import/export or migration, no `sign_transactions`.
- The browser and server both reject expired intents. Signing does not refresh them.
- The server binds owner, exact receiver/actions/arguments/gas/deposit, canonical Borsh bytes and ed25519 signature. It does not prove current chain nonce/block-height validity; live submission is a separate gate.
- A signature is stored exclusively once in `.hermes/proposals/owner-signature.json` with mode 0600, never sent upstream. Treat it as sensitive until expiration. Local OS processes are outside the browser-origin isolation boundary.
- Attached storage deposit is shown exactly; zero spending budget does not imply zero attached deposit. Agent API documents sponsorship of owner-request gas and storage, but runtime sponsorship remains unqualified here.

## Browser build and remaining risks

Meteor 3.24.1 needs Buffer/process/global compatibility and the util browser package. The build injects those explicitly and **drops all console calls**, because upstream includes unconditional wallet-response logging. Do not serve an alternate unreviewed build or source map with restored logging.

Initial installed dependency graph reported high advisories in nanoid and decode-uri-component. Exact scoped patch overrides remove those reported highs. Current audit still reports ten low propagated findings rooted in elliptic/secp256k1. This page is marked qualification-only; no real wallet was used during QA. No claim of absence of reachability or production security approval is made. npm metadata does not declare a Meteor SDK license; do not redistribute its generated bundle until licensing is resolved. `target/owner-ui/client.js` remains ignored.

## Verification receipt

- Original bootstrap/HTTP controls failed before implementation, then passed.
- A forged Host test initially used fetch, which normalized the Host; switched only the test transport to node:http and preserved the rejection assertion.
- Combined frontend, HTTP server and incumbent Agent API tests: 27 passing.
- Browser bundling initially failed on util/buffer, then browser startup failed on process/global. Explicit browser compatibility fixed these; current bundle loads in Chrome and the real Meteor SDK initializes without connecting an account.
- Chrome rendered the real expired intent, preserved the exact storage amount, and disabled signing. At a 390 CSS-pixel viewport the page scroll width was 390. No external resources were loaded during initial rendering.
- Impeccable detector completed with exit 0 and empty stdout after the final client edit.
- No wallet connection, real signature, intent regeneration, authenticated API submission or blockchain transaction was performed.
