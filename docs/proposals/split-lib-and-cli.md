# Proposal: split the library and the CLI into separate npm packages

Status: **draft, for discussion**. Nothing in this PR changes code or workflows.

## TL;DR

Publish `lib/` and `bin/` as two packages from this repo:

- **`apify-test-tools`** keeps its name and becomes the library only (`testActor`, `describe`, the matchers).
  Consumer repos keep it in `devDependencies` and their lockfile decides its version.
- **A new CLI package** (working name `@apify/test-tools-cli`) holds `build`, `release`, `report-tests`, and
  the other commands. The reusable workflows install it themselves at the pinned version, in a separate folder.

The main win: a CI change no longer forces a library upgrade on every consumer repo, and a library change
no longer has to ship to everyone the moment the workflows move.

## Why

### The two halves are already independent

- Nothing in `lib/` imports from `bin/`, and nothing in `bin/` imports from `lib/`.
- They have different users. Test files in consumer repos import the library. Only the reusable workflows
  (and people running commands locally) call the CLI.
- They have different dependencies. The library needs `apify-client` and a `vitest` peer. Everything else
  (`@slack/web-api`, `adm-zip`, `yargs`, `zod`, `ignore`, `@apify/consts`) is CLI-only, but every consumer
  repo installs it today.

### CI currently overrides the library version

`.github/actions/checkout-restore-dependencies/action.yaml` runs, after `npm ci`:

```bash
npm install "apify-test-tools@$pinned_version" --no-save
```

Pinning the CLI is the right call: the workflows need to know which commands and flags they can use. But
because the CLI and library are one package, the same step also swaps the **library** that a repo's tests
import, whatever the repo's lockfile says. As a result:

- Each workflow release silently upgrades the test library in every consumer repo's CI. A behaviour change
  in a matcher or in `testActor` lands everywhere at once, with no way for a repo to stay behind.
- Local runs use the lockfile version and CI uses the pinned one, so the two can disagree.
- `check-package-version-bump.mjs` treats `lib/` changes as CLI changes, so a library-only change still
  takes part in the workflow pin dance.

### Other projects

Projects usually ship one package when the CLI is a thin wrapper over the library API (`eslint`, `vitest`,
`prettier`, `typescript`). They split when the two have different users, dependencies or release timing:
`prisma` / `@prisma/client`, `firebase-tools` / `firebase`, `@angular/cli` / `@angular/core`, and Apify's
own `apify-cli` / `apify`. This repo is in the second group.

## The contract between the two packages

Once the packages are versioned independently, any combination of CLI version × library version can run
together in CI. What they share becomes a public interface and must stay backward compatible:

| Contract                            | Written by                      | Read by                | Notes                                                                                                                                               |
| ----------------------------------- | ------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTOR_BUILDS` env var (JSON array) | CLI `build`, `build-from-local` | library (`lib/lib.ts`) | `{ buildId, actorRawId, buildNumber, actorFullName }[]`. Today the type is defined twice (`lib/types.ts` `ActorBuild`, `bin/types.ts` `BuildData`). |
| `TESTER_APIFY_TOKEN`                | workflows                       | library                |                                                                                                                                                     |
| `RUN_ALL_PLATFORM_TESTS`            | workflows                       | library                |                                                                                                                                                     |
| `run_link` test annotations         | library                         | Vitest JSON report     | CLI `report-tests` reads the Vitest report, not the library directly.                                                                               |
| Vitest JSON reporter format         | Vitest (consumer's version)     | CLI `report-tests`     | Already outside our control; unchanged by the split.                                                                                                |
| `apify-test-tools.config.json`      | consumer repo                   | CLI only               | The library never reads it.                                                                                                                         |

Rules going forward:

- Only add fields to `ACTOR_BUILDS`; never rename or remove one. The library already ignores unknown fields.
- Move the `ActorBuild` type into one place that both packages import from (a tiny internal workspace
  package, or the library exports it and the CLI depends on it as a type-only dev dependency). One shared
  definition means a breaking change to it shows up as a type error.
- Add a contract test: the CLI's `build` output, fed through `ACTOR_BUILDS`, is accepted by the library.

## Proposed layout

One repo, npm workspaces, independent versions:

```
packages/
  lib/        -> publishes "apify-test-tools"       (today's lib/ + index.ts)
  cli/        -> publishes "@apify/test-tools-cli"  (today's bin/)
.github/
  workflows-package-version   -> now pins the CLI package only
```

- Each package gets its own `package.json`, `CHANGELOG.md` and `tsconfig.json`, all extending a root config.
- `git-cliff` runs per package, filtered by path (`packages/lib/**`, `packages/cli/**`), so each changelog
  only lists its own changes.
- The release workflows (`_update_release_metadata.yaml`, `manual_publish_to_npm.yaml`,
  `manual_release_stable.yaml`) take a `package` input. A stable CLI release writes
  `workflows-package-version`. A library release does not touch it.
- `check-package-version-bump.mjs` narrows `PACKAGE_CODE` to `packages/cli/`. Library changes no longer
  interact with the workflow pin at all.

## CI install

The setup action stops overriding anything in the consumer's `node_modules` and installs the CLI on its
own:

```bash
cli_version=$(cat "${{ github.action_path }}/../../workflows-package-version")
npm install --prefix "$RUNNER_TEMP/test-tools-cli" "@apify/test-tools-cli@$cli_version" --no-audit --no-fund
echo "$RUNNER_TEMP/test-tools-cli/node_modules/.bin" >> "$GITHUB_PATH"
```

Workflows then call `apify-test-tools build ...` (or keep `npx` pointing at the explicit path). Some
side benefits:

- The CLI's dependency tree never mixes with the consumer's, so version conflicts between the two go away.
- The library version in CI is exactly what the lockfile says, as it is locally.
- The CLI can be cached on its own key (`cli_version`), separately from the consumer's `node_modules` cache.

The CLI must work from the consumer repo root without being installed there. It already uses
`process.cwd()` and git for everything, so this should be a matter of checking, not changing.

## Migration

1. **Restructure the repo** into `packages/lib` and `packages/cli`. Publish the CLI as
   `@apify/test-tools-cli`. `apify-test-tools` still ships the `bin` entry, implemented as a thin
   re-export of the CLI package, so nothing breaks.
2. **Switch the workflows** to install the CLI separately (the setup action change above). From this point
   CI stops overriding the library. Consumer repos that are behind on the library start running their
   lockfile version in CI. Some of them may have been relying on the forced upgrade without knowing, so
   announce this step and suggest an `npm i -D apify-test-tools@latest` first.
3. **Deprecate the `bin` in `apify-test-tools`.** The shim prints a warning pointing to the new package for
   one minor release, then the next minor removes it along with the CLI-only dependencies.
4. **Split the README** into "Writing tests" (library) and "CI and the CLI" (workflows, config file,
   commands), one per package.

Local use after the split: `npx @apify/test-tools-cli build-from-local ...`, or add it as a devDependency
in repos where people run it often.

## Branch testing

Today, a `-beta` of `apify-test-tools` in a consumer's lockfile makes the setup action skip the pin, which
is how [testing-repo-for-github-actions](https://github.com/apify-store/testing-repo-for-github-actions)
tests unreleased changes. After the split:

- **Library betas** keep working through the lockfile. Nothing in CI overrides the library any more.
- **CLI betas** need their own switch, since the CLI is not in the consumer's lockfile. Proposal: an
  optional `test-tools-cli-version` input on the reusable workflows, which the setup action uses instead of
  the pin when set. Only the testing repo sets it.

## Alternatives considered

- **Keep one package and stop overriding the library in CI** (install the pinned version in a separate
  prefix and run its `bin` from there, leave the lockfile copy alone for tests). This gets most of the CI
  benefit without a second package. The downsides: consumers still install every CLI dependency, both
  halves still share one version number and changelog, and a library-only release still bumps the version
  the workflows pin. Reasonable as a first step if the full split is too much right now; it is also
  roughly migration step 2 on its own.
- **Two repos.** More separation than we need: the contract above is easier to keep stable when both sides
  are in one PR and one test run.

## Open questions

1. **CLI package name.** `@apify/test-tools-cli`, `apify-test-tools-cli`, or something else? A scoped name
   needs publish rights to the `@apify` scope from this repo's npm token.
2. **Version numbers.** Should both packages continue from `0.10.x`, or should the CLI start at `1.0.0` to
   mark the new package?
3. **Shared types.** Should we use a private internal workspace package, or have the CLI import types from
   the library?
4. **Rollout of step 2.** Should we announce first and give repos a week to update their lockfiles, or
   switch and handle breakages as they come?
