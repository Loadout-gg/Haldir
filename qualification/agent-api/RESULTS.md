# Agent API local qualification results

Scope: local policy/SDK/signing qualification plus explicitly labeled authenticated access and unsigned owner-request observations. No real owner signature submitted or mainnet money movement. The initial local execution section is historical.

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
node --test --test-timeout=10000 qualification/agent-api/*.test.mjs
```

Transport injection always returns a synthetic response or throws; it never falls through to real fetch. Synthetic tokens are not real credentials. These tests do not establish hosted policy enforcement, owner wallet compatibility, financial concurrency or return of funds.

## Owner signing follow-up

Six new SDK characterization tests pass using ephemeral keys and synthetic identities. Combined local suite: ten passing tests. No live owner or service was exercised. See [OWNER-SIGNING.md](OWNER-SIGNING.md) for corrected Meteor compatibility analysis, source references and limits.

## Feasibility matrix

All rows start NOT_RUN. Public discovery evidence is recorded separately when available; a public catalog read alone cannot pass a financial test.

| ID | Test | Status |
|---|---|---|
| F01 | Public preflight | PARTIAL: public network/catalog/schema read; asset approval and live compatibility pending |
| F02 | Access | PARTIAL: authenticated whoami HTTP 200 reverified after credential correction; historical quotas read; key expiry/administrative qualification still open |
| F03 | Owner flow | PARTIAL: Meteor account connection observed; unsigned frozen creation request generated and later read as FAILED; live signature/submission NOT_RUN |
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

Owner-signing adapter corrections pass 41 combined local tests, including the installed Meteor SDK's actual deserialization path, ambiguous-save latches and startup file-existence guards. Independent review passed the exact owner-ui diff SHA-256 `3abfa227d6ba7e2ce00772f3b462a62a76b00e412f2eca81ddd6afd041ee306b`; Chrome SDK initialization reverified. These are not live signature/service acceptance.

Before the first real signature, resolve the canonical Agent API Owner Terms URL/version and retain explicit owner acceptance of it, OutLayer terms and the required mainnet-loss notice. The demo OpenAPI/llms require this, but the Owner Terms URL was not found in the inspected official public sources. OutLayer terms were located at https://app.outlayer.ai/terms; no substituted terms or inferred acceptance.

Then qualify real owner signature/submission, NEP-413 grants, exact asset/recipients/funding/fee caps and recovery. No automatic transition from local GREEN to funded execution. Current dependency audit has ten low propagated findings after the scoped high-advisory fixes; the historical zero-advisory baseline above predates Meteor installation.
