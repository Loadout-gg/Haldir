# Owner signing qualification

## Outcome

Six offline characterization tests pass against the installed `near-api-js@7.4.0`; the combined Agent API local suite passes ten tests. These tests use new ephemeral ed25519 keys in memory and synthetic .testnet/.invalid identities. They make no RPC call, create no account, persist no private key and submit no signature.

This qualifies SDK signing/serialization primitives, not a live owner adapter, wallet UI, full-access-key registration or Agent API acceptance.

## Correction to the Meteor concern

The Agent API OpenAPI NEP-366 payload contains only `receiverId` and one or two `FunctionCall` actions. It does not supply `nonce`, `maxBlockHeight`, `senderId` or `publicKey`. The official near-owner signing example obtains the current key nonce and block height through a finality-final access-key read and adds the delegate envelope at signing time.

Therefore Meteor's omission of those fields from its high-level delegate request is NOT evidence that it changes the API payload. A wallet must still preserve receiver, ordered actions, exact arguments, gas and deposit, use the pinned owner key, return the required base64 Borsh signature and avoid broadcasting itself. Its actual UI flow remains untested.

## Operator signing route for the financial experiment

A dedicated NEAR owner key can use `KeyPairSigner.signDelegateAction` and `signNep413Message` without putting the key into the agent backend. The operator process can read current full-access-key metadata, produce the signature locally and pass only signed data back to the approved submission harness.

This route has direct precedent in the publisher's example. No example source was copied: the tests exercise the MIT-licensed installed SDK and use independent Node crypto verification. The examples repository's absent license remains a constraint on copying its helper implementations.

Before live use: owner approval and exact public identity; protected credential injection; key match/full-access check; intent expiry; authenticated user/correlation binding; full preview and exact payload verification; allowed RPC/origin; no automatic broadcast; serialized nonce use; no logs of secrets or reusable signatures. No operator key loader or live submission runner is implemented here.

## What the tests check

- NEP-366 keeps the source payload unchanged and the supplied bigint nonce exact.
- Node crypto verifies the ed25519 signature over the delegate hash.
- Altered nonce or receiver invalidates that signature.
- A mismatched signing public key is rejected.
- NEP-413 verifies against separately constructed Borsh message bytes and domain prefix.
- Altered message, nonce or recipient fails verification; a nonce of the wrong length is rejected.

The NEP-366 digest uses the SDK's delegate encoder, so this does not independently certify every Borsh field against NEAR runtime. Live acceptance remains F03 NOT_RUN.

## Public preflight

Production `/v1/network` reported mainnet, contract outlayer.near and NEAR/passkey owner support. `/v1/tokens` reported Base USDC with six decimals:

`nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`

No funding minimum or fee is exposed by that catalog entry. This is a candidate asset, not an approved capital allocation. F01 is partial until exact asset selection and runtime compatibility are accepted. F02 and all authenticated/financial tests remain NOT_RUN.

## Sources

- https://api.agentsonintents.com/openapi.json (Intent schema, freshly read)
- https://docs.agentsonintents.com/integration/agent-api/owner-signing
- https://docs.agentsonintents.com/integration/agent-api/signing-standards
- https://raw.githubusercontent.com/NEAR-Intents-Agent-API/examples/8e397fccde9e5542b6e92e0fccec662553af1ce6/support/sign-near-intent.ts
- https://raw.githubusercontent.com/NEAR-Intents-Agent-API/examples/8e397fccde9e5542b6e92e0fccec662553af1ce6/support/near-owner.ts
- Installed `near-api-js/lib/index.js`: Signer.signDelegateAction, Signer.signNep413Message and NEP-413 serialization.

## Run offline

```sh
node --test --test-timeout=10000 qualification/agent-api/*.test.mjs
```

Expected: ten local tests pass. No partner key or user wallet is needed.
