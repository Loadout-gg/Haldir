# Agent API local qualification results

Scope: local synthetic policy/SDK tests only. No partner credentials, owner signing or mainnet money movement.

## Local execution

- SDK: `@near-intents-agent-api/sdk@0.8.0`, exact package and lockfile pin.
- Runtime observed: Node 26.13.0 / npm 12.2.2.
- L2 RED: empty object fails expected policy deep equality; exit 1.
- L3a GREEN: policy shape, one passing test; exit 0.
- L3b RED: invalid budget does not throw before validation; exit 1.
- L3c GREEN: shape and input validation, two passing tests; exit 0.
- L4/L6: two policy tests plus two SDK transport characterizations, four passing; exit 0.
- Fresh `npm ci --ignore-scripts --no-fund`: succeeded; same four tests passed afterward.
- Existing Sandbox regression: one test passed using the previously built local probe. No rebuild claimed.
- `npm audit --audit-level=low`: zero reported vulnerabilities at this check, not a security certification.
- Existing README, toolchain pins and qualification source hashes preserved.

Run the offline Agent API checks from the repository root:

```sh
node --test --test-timeout=10000 qualification/agent-api/policy.test.mjs qualification/agent-api/sdk.test.mjs
```

Transport injection always returns a synthetic response or throws; it never falls through to real fetch. Synthetic tokens are not real credentials. These tests do not establish hosted policy enforcement, owner wallet compatibility, financial concurrency or return of funds.

## Feasibility matrix

All rows start NOT_RUN. Public discovery evidence is recorded separately when available; a public catalog read alone cannot pass a financial test.

| ID | Test | Status |
|---|---|---|
| F01 | Public preflight | NOT_RUN |
| F02 | Access | NOT_RUN |
| F03 | Owner flow | NOT_RUN |
| F04 | Work grants | NOT_RUN |
| F05 | Funding | NOT_RUN |
| F06 | Allowed purchase | NOT_RUN |
| F07 | Excluded recipient | NOT_RUN |
| F08 | Shared concurrency | NOT_RUN |
| F09 | Cumulative cap | NOT_RUN |
| F10 | Extra funding resistance | NOT_RUN |
| F11 | Lost HTTP response | NOT_RUN |
| F12 | Conflicting replay | NOT_RUN |
| F13 | Expiry | NOT_RUN |
| F14 | Stop race | NOT_RUN |
| F15 | Normal close | NOT_RUN |
| F16 | Emergency freeze | NOT_RUN |
| F17 | Error model | NOT_RUN |
| F18 | Evidence | NOT_RUN |
| F19 | Order reuse | NOT_RUN |
| F20 | Judge rehearsal | NOT_RUN |

## Required evidence for a future live row

Record source revision, origin/network, approved input manifest, operation/request IDs, observed error code/layer, before/after balances, policy and counted-usage evidence, terminal receipt, receiver evidence, redactions and unresolved limitations. No grant tokens, partner keys, owner private keys or reusable signatures in tracked artifacts.

## Remaining gates

Concrete owner wallet and signing support; partner access; exact asset, recipients, funding/fee caps; reviewed live harness; explicit mainnet authorization. No automatic transition from local GREEN to funded execution.
