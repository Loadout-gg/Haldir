# Operator account for offline command rendering

Set `HALDIR_GCLOUD_ACCOUNT` explicitly in your local shell to the intended authorized operator's email before rendering `foundation`, `inspect-build`, `build`, or `deploy` commands. Keep personal configuration out of committed files.

The renderer accepts a conservative ASCII mailbox address (at most 254 characters, local part at most 64, dotted DNS domain); it rejects missing/empty values, whitespace, control characters, quoted addresses, and flag/shell syntax. Values are not trimmed or normalized. There is no ambient gcloud-account fallback. The selected address is used for both `--account` and the foundation's operator-user storage bindings.

Importing the helper and the pure `assemble` action do not read or require this setting. The helper only renders command arrays; it does not authenticate, execute gcloud, or authorize cloud changes. Existing project, source-integrity, runtime, and budget guards still apply.
