# Source portability and provenance addendum

These notes describe the narrowly derived source included in this incremental publication, not application readiness.

## Source boundary

The selected baseline contains 278 members. This first tranche publishes 276, withholding exactly `deployment/haldir-cloud/packet.py` and `deployment/haldir-cloud/test_packet.py` pending portable account configuration. These optional pending cloud-helper files are not available here. Only 13 test/spec files differ from the original selected candidate. The [changed-source inventory](source-portability-files.json) records before/after byte hashes, lengths and modes without machine locations or private custody metadata.

The change removes personal absolute machine-path defaults. Eleven browser specs now resolve their default evidence outputs beneath repository-root `test-results/`, using module URLs and `fileURLToPath` so spaces, non-ASCII names and URL-significant characters survive relocation. Every existing `HALDIR_EVIDENCE_DIR` override and its suffix behavior is retained. The Chrome runtime harness places temporary fixture data under its already-created evidence directory. The offline adapter test creates a repository-local ignored scratch parent before requesting unique temporary directories.

The task-panel comparison still requires its genuine `before/` metrics as a separately supplied reproduction prerequisite. They are not in this source selection. No private archive fallback, historical metric regeneration or fabricated replacement was added. Relative rejection fixtures and intentional synthetic credential snippets remain unchanged.

## Preserved policy

The included runtime/cloud bindings, nonsecret infrastructure target identifiers, finite admission and model limits, expiry checks, closed production binding and historical operator ceiling remain unchanged. A historical ceiling is not a live balance, remaining allocation, renewed authorization or permission to execute. Only approved source-bound nonsecret technical project and service-account identifiers are retained; operator account addresses are excluded. No credentials, live operator readbacks, private receipts or enclosing audit metadata belong in the public payload.

The incumbent scanner implementation, its 11 detectors and five exact reviewed spans remain byte-identical. Those five spans are bound to four complete file hashes. All protected files are unchanged; no test file was omitted from scanning. The qualified portable selection yielded zero unclassified findings and 15 narrowly classified synthetic matches; the final payload is rescanned with that same policy. Additional detector and hash/path-drift controls passed. This is heuristic scanning, not proof that secrets cannot exist.

## Executed local checks

Under installed Node `26.13.1`:

- 46 extracted, real path-expression/helper checks passed, including relocated paths and existing override behavior. These are not full browser-spec execution.
- The complete affected offline adapter test file plus the existing owner-attempt path test file passed: 27 tests, zero failed/skipped. Transport was synthetic; no live inference was called.
- All 13 changed files passed native Node syntax checks, including the TypeScript specs. No frontend compiler was invoked.
- The exact source patch was replayed with zero fuzz into a separate non-Git tree; all 290 reconstructed candidate files matched (before the two-file incremental omission). The path checks and the actual offline adapter module were also exercised from that replay.

The behavioral run used a positive environment allowlist, JavaScript transport/child-process fences and an inherited macOS sandbox denying networking and writes outside the private work area. The three incumbent CLI subprocesses were restricted to offline/preflight and unbounded-live refusal cases, with explicit preload fencing. Product-test forbidden network/child counters were zero; separate synthetic denial controls proved the fence acted before transport/execution.

No installation, frontend build, Chrome run, application boot, cloud/database/RPC call, secret access, wallet action or live model execution was performed. Generated WASM, installed SDKs, Chrome and the existing runtime-version inconsistencies remain separate reproduction prerequisites. Syntax and focused offline tests are not a full suite or clean-install acceptance.

## License and release boundary

This release preserves the existing [MIT License](../LICENSE) and README grant scope. Third-party terms and brand/media rights are not broadened. See [source provenance](SOURCE-PROVENANCE.md) for the exact incremental boundary. The optional cloud helper and its test remain pending a later integration; no deployment command using them is available in this tranche.
