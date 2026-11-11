# NEP-413 adapter qualification

`prepareNep413(generated, expectedOwnerPublicKey, { clock })` prepares a Meteor `near::sign_message` request and provides an asynchronous `signedData(output)` validator. This module is not wired into the owner UI and never issues a grant, calls a wallet or submits an API request.

## Verified offline

- Canonical base64 nonce decoding, exactly 32 bytes.
- Original message, recipient, optional callbackUrl and returned API payload preserved.
- Mainnet account pinned from the trusted generated signer; public key checked against the independently supplied expected key.
- Signature verification against the original NEP-413 encoding before returning base64 wire data.
- Expiry and mutation guards before preparation and after wallet response.
- Installed Meteor 3.24.1 action creation, mocked direct-extension transport and actual deserialization exercised. Its separate PublicKey class and Buffer signature are accepted without treating them as strings.
- Tampered nonce/message/recipient/callback, wrong key/account, malformed responses and expiry refused.

Implementation followed behavioral RED/GREEN tests. Parent independently ran the combined suite: 84 passed, comprising 43 new adapter cases plus 41 prior qualification cases.

```sh
node --test --test-timeout=15000 qualification/agent-api/*.test.mjs qualification/owner-ui/*.test.mjs
```

## Not established

Real wallet signing, FullAccess-key freshness, hosted grant issuance/revocation, grant-token custody, replay persistence, operator UI consent and API acceptance remain unqualified. The caller must independently approve the generated account/key/preview before using the request. Mainnet is intentional, not a testnet guarantee. Owner Terms/risk acceptance remains a separate real-signature gate.
