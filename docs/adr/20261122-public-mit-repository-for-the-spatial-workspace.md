# ADR: The workspace is one public MIT repository; private values stay in untracked local configuration

## Status
Accepted

## Area
Publication

## Context
The owner works in this repository alone and asked to publish it, "making sure we are not exposing things we should not". Asked whether publishing changes who the project is for, the owner answered that it is "Still for you alone". The first history held values that must not be public: personal device and network identifiers, absolute paths on the owner's machines, and names of private projects. A stranger's `npm ci` also failed, because the coordinator's spatial API existed only on a local branch of a private history.

## Decision
The repository is public on GitHub as `MR-Spatial-Agent-IDE` under the MIT license and is the one place the work lives. The public history starts from one cleaned commit, followed by the commits made after it; the earlier history is kept only as a bundle outside the repository. Values that must stay private live in untracked local configuration: environment variables for tool and coordinator locations, and a private-terms list outside the repository that `git config leakcheck.privateList` names. A leak check (`scripts/leak-check.mjs`) guards every push through the tracked `.githooks/pre-push`, and a CI workflow runs its generic part on GitHub, where GitHub's secret scanning with push protection is also on. The coordinator's spatial API is offered to the public agent-system as a pull request, and the repository carries only its type declarations (`vendor/coordinator-api/`).

The North Star position "Who it's for" is unchanged: the project is built for the owner alone, and the source is public as is, with no promise of support, issues handled or changes accepted.

## Alternatives Considered
- **A private repository with cleaned exports**: two places for one body of work, and every export is a chance to leak or drift — the owner chose one repository.
- **Publishing the spatial view alone**: it reuses the earlier host's pairing and certificate code, and a partial repository would still need the same cleaning — the owner chose the whole product.
- **Changing the audience, with support and a community**: the owner ruled that the project stays for one person; publishing costs the owner no new duty.

## Consequences

### Positive
- One repository and ordinary pushes; a stranger can clone, install, build and run the view from public sources.
- A push that carries a private value is refused before it leaves the machine.

### Negative
- The check finds only what its list and its generic shapes name; a private value of a kind nobody listed passes, and a public push cannot be recalled.
- The tracked hook protects only a clone that turned it on (`git config core.hooksPath .githooks`); GitHub's push protection and CI stand behind it.
- The owner's local checks need local configuration (`SPATIAL_COORDINATOR_DIST`, and `SPATIAL_PI_BIN` and `SPATIAL_CLAUDE_BIN` when the tools are not on `PATH`).

## Source
- Session: /do run (2026-11-22)
- Related: 20261121-thin-webxr-view-over-herdr
