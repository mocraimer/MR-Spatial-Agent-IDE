# Coordinator build and type seam

This page covers how the earlier host gets the coordinator's spatial API, at build time and in tests. It does not cover activating a coordinator or running the host; see [private host setup](HOST-SETUP.md) for that. The spatial view does not use any of this.

The earlier host compiles against `agent-system/spatial-api`, the spatial API of the public [agent-system](https://github.com/mocraimer/agent-system) coordinator. It was added to agent-system `main` by [pull request 14](https://github.com/mocraimer/agent-system/pull/14), so a current `main` has it. This is a build-time dependency, not a published package or another execution service. The coordinator owns the API in its `src/spatial-api.ts` and emits declarations with its normal build. Product source holds no coordinator paths or aliases.

## Quick start

`npm ci` is enough to typecheck and build. The declarations are committed in `vendor/coordinator-api/` and linked as the development dependency `agent-system`.

To run the tests that drive the real coordinator, or the earlier host, build a coordinator that has the spatial API and point `SPATIAL_COORDINATOR_DIST` at its compiled `dist/` directory:

```sh
git clone https://github.com/mocraimer/agent-system ../agent-system
(cd ../agent-system && npm ci && npm run build)
export SPATIAL_COORDINATOR_DIST="$PWD/../agent-system/dist"
npm run coordinator-api:verify -- --build-directory "$SPATIAL_COORDINATOR_DIST"
npm test
```

Without the variable, those tests are skipped and each says which variable to set. Use only a build made for this product; never rebuild or modify a shared live coordinator as part of product setup.

`coordinator-api:verify` is the check that the committed declarations belong to the build you selected. If it fails, the build differs from the one the declarations came from: refresh them as below, or select the matching build.

## Select a different coordinator build

```sh
node scripts/coordinator-api-prepare.mjs --build-directory /path/to/agent-system/dist
npm run coordinator-api:verify -- --build-directory /path/to/agent-system/dist
npm run typecheck
```

Preparation rewrites `vendor/coordinator-api/`; commit that folder with the change that needs it. The build directory can be anywhere; there is no default sibling checkout or worktree. Do not prepare while a coordinator build is being written; retry once it finishes. Build from a clean, committed coordinator checkout: the identity records the source revision and whether the tree was dirty, and a revision alone does not identify a dirty build.

## What is committed

The product does **not** install the coordinator's implementation. Preparation walks only the declarations reachable from `spatial-api.d.ts` and writes a small package of the same module name with the `.d.ts` files, a `package.json` and `coordinator-api-identity.json`. It has no runtime JS export, install scripts, authority implementation, credentials, user data, state, evidence, volumes or workspaces, and it never imports coordinator modules. Links and relative declaration imports outside the compiled directory are rejected.

The metadata, readable as `agent-system/coordinator-api-identity`, holds:

- `schemaVersion`: `1`.
- `build`: the stamped coordinator `digest`, `revision` and `dirty` fields.
- `declarationsDigest`: hash of the packaged declaration paths and contents.

Preparation recomputes the coordinator's compiled-content digest with its stamp-build algorithm, checks the stamp, and checks again before it writes the folder. The metadata omits timestamps and machine paths, so the same build makes the same folder in any checkout. Verification compares the selected compiled build with the installed metadata and checks the declarations' integrity. It loads no command or store code, contacts no provider, and opens no coordinator state.

The installed private host package contains compiled host JavaScript and runtime dependencies only. The preparation and verification scripts, `vendor/` and the declaration package stay in the source checkout; start the installed host with `npm start` from its version directory.

## Runtime is a separate owner-controlled choice

`host/src/runtime-coordinator.ts` re-exports **types only**; these imports disappear from compiled JS. At run time the host loads the explicitly configured coordinator build's `commands.js` factory through the private owner configuration and activation checks (`coordinator.buildDirectory` in [HOST-SETUP.md](HOST-SETUP.md)). It must not import the declaration package as an execution fallback or use its path as a runtime selection. Matching type identity is not activation approval, grants, provider authentication or permission to replace shared writers.

## Verification

From a source checkout with development dependencies installed:

```sh
npm run build
node --test build/host/tests/coordinator-api.test.js
```

The tests prepare declarations from a fixture build holding private-data sentinels, inspect the folder's contents, run `npm ci` and type imports in unrelated temporary layouts, rebuild the folder after moving the build, and reject changed builds, changed installed declarations, stale stamps, escaping imports and links. They do not establish live-agent readiness or authorize coordinator activation.
