# Preserved installed base-nova primitives

`button.tsx` and `card.tsx` preserve the installed prebrand project source. The original local evidence location is intentionally omitted from public documentation; the exact source hashes below identify the preserved copies.

This is the actual project baseline (shadcn base-nova), not the later customized components one level above or a newly downloaded registry version. Keep these copies uncustomized. Review/results import them explicitly so unrelated approved brand surfaces and integration are not globally reverted.

SHA-256:
- button.tsx: `313353436d0fcc8e44ab470adb614b9fd013d28626f624328ea0d66d41a6c81b`
- card.tsx: `8ad3a18d36bda0598dc0e9aa96ea22854944d5443ee4946f1d173815e115375f`

`native-shadcn` scopes the original font/radius token values from the same prebrand `index.css`; existing Haldir palette values are inherited. Existing 44px mobile touch and wrapping accommodations remain app-level accessibility rules. No new dependency or registry install.
