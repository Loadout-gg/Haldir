# Haldir interface

A React interface for preparing a research job, reviewing spending permissions and inspecting activity, evidence and receipts.

- [Product overview](../README.md)
- [Demo walkthrough](../docs/DEMO.md)
- [Architecture](../docs/ARCHITECTURE.md)
- [Setup, tests and evidence limits](../docs/VALIDATION.md)

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Product landing |
| `/app` | Workspace preview |
| `/demo` | Explicitly scripted, fictional demonstration |
| `/?mode=public-testnet` | Legacy workspace alias; the name does not establish live testnet execution |
| `/?mode=simulation` | Legacy simulator alias |

The finite production host and Vite's development fallback have different routing behavior. A page opening through Vite does not prove that the deployed host serves the same route.

## Local development

Use Node **26.13.1** and the declared frontend npm **12.2.2**. Install root dependencies as well as frontend dependencies because wallet SDK imports use the root installation.

From the repository root:

```sh
npm ci --ignore-scripts
npm --prefix prototype ci --ignore-scripts
npm --prefix prototype run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173/demo` for the scripted path. This does not start or enable a financial backend.

```sh
npm --prefix prototype run build
npm --prefix prototype run test
npm --prefix prototype run lint
```

`test:browser` is a separate Playwright runner. Standalone Node browser tests under `tests/` are not automatically included in the Vitest or Playwright commands; inspect their prerequisites before running them.

## Source guide

- `src/App.tsx`: application entry and workspace integration.
- `src/demo/`: deterministic simulation state, presenter controls, panels and formatting.
- `src/integration/`: workspace/backend boundary and draft/recovery integration.
- `tests/`: UI, state and integration tests; evidence fixtures are explicitly synthetic.

The simulator's transition state, presenter controls and operational backend are separate. “Authorize” in the simulator does not create a real permission; a presenter confirmation is not a chain receipt.

## State expectations

Draft preparation is not authorization. Login is not payment approval. Pending payment, confirmed payment and delivered content are different states. An excluded purchase must not erase earlier results. Stop prevents new spending; funds are recovered only after confirmation.

The scripted demo uses fictional data and an in-memory session with a fixed fixture clock. Reloading it is not a persistent-job recovery test. Narrow viewport tests are not physical-device acceptance.

## Release boundary

The public preview and the current local source may differ. Publication requires the exact source/assets to be assembled and tested with the actual host; a development build is not deployment evidence. Hosting and provider configuration do not belong in the public frontend quickstart, and real credentials must never be placed in browser code.
