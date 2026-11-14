# Source provenance and reproduction status

[Back to Haldir](../README.md)

## Published source

This incremental release publishes **all 278 selected members**, including the actual React application and demo state model, backend/agent/vendor modules, native NEAR mandate and factory contracts, wallet/request helpers, tests, lockfiles and runtime-composition code. The selection count includes the root README and ignore rules. It is not a marketing-only export or replacement implementation.

The two previously withheld selected files are now included with portable account configuration:

- `deployment/haldir-cloud/packet.py` — offline cloud command renderer requiring explicit validated `HALDIR_GCLOUD_ACCOUNT` configuration.
- `deployment/haldir-cloud/test_packet.py` — its corresponding offline tests, including account validation and account-independent import/assembly.

No command in the quickstart requires these files. See [account configuration](../deployment/haldir-cloud/ACCOUNT-CONFIGURATION.md) for use with your own authorized account. The helper only renders command arrays; inclusion is not deployment authorization or proof of a usable hosted deployment.

The published tree contains **294 files**, including the 278 selected members, retained public documentation/assets and the account-configuration note. The [public file inventory](source-files.json) records final relative paths, modes, byte lengths and SHA-256 hashes for the published tree, excluding only the inventory itself to avoid a self-referential hash. Existing public history, documentation and visual assets are retained. Generated output, dependency installations, credentials, logs, operator records and personal application details are not source-release contents.

## Code, website and execution are separate

- `prototype/src/landing/` is the **legacy React landing** required by this application's routing graph. It is not the newer separately hosted standalone forest landing. This publication neither supplies that standalone landing nor deploys or replaces the hosted website.
- **Scripted simulation · No live funds or AI calls.** TEST amounts, fictional company documents and synthetic receipts are not public-network transactions or inference evidence.
- Runtime, signing and provider adapters are inspectable implementations, not authorization to enable them. No public end-to-end financial/model journey is claimed.

## Verification and limits

Published selected source retains the qualified portable selection and public-facing README packaging, with the two account-helper files integrated as qualified public-safe replacements. Source differences from the original selected candidate are the 13 test/spec path changes and the two account-helper changes described in the [portability notes](SOURCE-PORTABILITY.md) and [changed-source inventory](source-portability-files.json). There are no selected-member omissions; the account-helper inventory records public after-bytes only.

The inherited 11-pattern scanner and five exact reviewed spans bound to four whole-file hashes are unchanged. All final payload files and staged Git blobs are scanned, including test fixtures and documentation. Zero unclassified findings is a heuristic result, not proof of privacy, secret absence or a security audit.

The portable selection reuses 73 distinct focused offline checks (46 path/helper checks and 27 existing adapter/owner-path tests), plus syntax checks for the 13 changed files. These checks are not a fresh clean-install build, full-suite result, browser acceptance or public-chain/model acceptance. Historical unrelated totals are not combined.

The account-helper integration separately passed 18 Python tests and 102 subtests in a closed offline runner, with zero product-test network, external-command or outside-area write attempts. This verifies the bounded helper behavior, not cloud execution or deployment readiness.

## Reproduction prerequisites

Use the [validation guide](VALIDATION.md) for declared scripts and commands. Root and frontend dependencies must be installed separately. The project declares Node `26.13.1`; the frontend declares npm `12.2.2`. There is no root `npm test`.

The mandate must be built before the factory because the latter embeds generated mandate WASM. Three native Sandbox Node harnesses still require `26.13.0`, conflicting with the declared `26.13.1`; they require a separate correction and rerun. Installed SDKs, Chrome, generated outputs and genuine historical task-panel `before/` metrics remain separate prerequisites. No private metrics are supplied or fabricated.

No dependencies were installed, frontend compiled, browser launched, application booted, cloud deployed, wallet signed, chain transaction submitted or live model/provider called for this publication. A verified public clone establishes source integrity, not runtime readiness. Historical finite guards are retained as code, not renewed execution authority.

## Licensing and assets

Haldir-owned source is covered by the [MIT License](../LICENSE). Third-party code and fonts retain their own terms and notices, including Manrope's [SIL Open Font License](../prototype/public/fonts/manrope/OFL.txt). Brand marks, screenshots and other media are not automatically covered by MIT; see [asset provenance](assets/README.md). Haldir was developed with AI coding assistance; U01 remains a historical technical name.

This is source publication, not submission, announcement, production activation or a claim of submission readiness.
