# Contributing

The package consists of three parts:

- cli located in `bin/`
- test library located in `lib`
- the reusable GitHub workflows consumer repos call, in `.github/workflows/` and `.github/actions/`

## CLI

- `bin/build.ts` actor building
- `bin/git.ts` git wrappers for getting relevant git commits and changed files
- `bin/main.ts` entrypoing
- `bin/slack.ts` sending notifications to slack
- `bin/test-report.ts` processing vitest's test reports

CLI command results use `writeJson` from `bin/output.ts` to write newline-terminated JSON to stdout.
Use the CLI `logger` from `bin/logger.ts` for diagnostics; every level writes to stderr.
ESLint rejects `console.log` throughout the codebase and all direct `console` calls in `bin/`.
The importable library in `lib/` keeps its own diagnostics; CLI log levels apply only to `bin/`.

The CLI's global `--log-level` option accepts `debug`, `info` (default), `warn`, `error`, or `silent`.
It filters diagnostics without affecting command results. Use `logger.debug` for detailed troubleshooting,
`logger.info` for progress, `logger.warn` for recoverable problems, and `logger.error` for failures.

## Test library

- `lib/extend-expect.ts` - custom matchers
- `run-test-result.ts` - `RunTestResult` class that's the output of `run` function
    - wrapper around run endpoints: `logLog`, `getStatistics`, `getDataset`, etc

### Development setup

1. Clone and build `apify-test-tools` repo:

```sh
git clone git@github.com:apify/apify-test-tools.git
cd apify-test-tools
npm i
npm run build
```

For testing purposes, we use `testing-repo-for-github-actions` repo so that we don't mess with the production repos:

```sh
git clone git@github.com:apify-store/testing-repo-for-github-actions.git
```

#### Working on the CLI

To work on the library, run the cli from the root of your testing repo:

```sh
cd /path/to/testing-repo-for-github-actions
npx tsx /path/to/apify-test-tools/bin/main.ts --help
npx tsx /path/to/apify-test-tools/bin/main.ts get-commits --target-branch master --source-branch feat/testing-feature-branch
```

Or clone a test repo into `local-clone/` inside this repo and run `npm run start:dev -- <command>`.

#### Working on the library

You need to istall the local version of `apify-test-tools` in your cloned `testing-repo-for-github-actions`:

```sh
npm i -D ../path/to/apify-test-tools
```

You need to run `npm run build` inside `apify-test-tools` repo everytime you want to test your changes in `testing-repo-for-github-actions`.

## Reusable workflows

The `public_`-prefixed workflows are the ones consumer repos call: `public_pr-build-test`,
`public_platform-tests`, `public_push-build-latest`, `public_claude`, `public_review` and
`public_platform-tests-claude-investigate-and-fix`. They live here because they call this package's
CLI, so a change to both is one PR. GitHub only reads workflow files at the top level of
`.github/workflows`, so they sit next to this repo's own CI, and the prefix is what separates the
two: `public_` is the API other repos depend on, `_` is internal plumbing, and `on_`/`manual_` are
this repo's own triggers.

A `public_` filename is part of the contract — it is baked into every consumer's `uses:` line, so
renaming one is a breaking change that needs a major tag bump, not a tidy-up.

The tag is not semver, so `git-cliff` would abort on it. It is skipped only because
`apify/actions`' cliff.toml sets `tag_pattern = "v[0-9]+\."` — a release failing with
`Semver error: unexpected character` means that pattern changed, not that anything here is wrong.
The action's "Nothing to release" guard resolves to this tag and no longer fires, so an empty stable
release fails at `npm publish` instead of erroring cleanly.

Consumers pin `@workflows-v0`, not `@master`. See [Versioning and releases](#versioning-and-releases) below.

- `npm test` covers the bundle without network (`test/bundle/`). `npm run test:e2e` runs it against
  dummy Actors in an isolated sandbox account (`test/e2e/`) and skips itself unless
  `E2E_TEST_APIFY_TOKEN_DBYPODOIHUZABNQTR` is set. CI passes that secret only to the `E2E tests` job.
  The git `build` and release pipeline tests clone
  [testing-repo-for-github-actions](https://github.com/apify-store/testing-repo-for-github-actions) and
  use its `e2e/base` and `e2e/feature` branches as fixtures, so never rebase or delete those.

`npm run lint` and `actionlint` (via the `Code checks` workflow) both gate master, so run them before
pushing workflow changes.

`public_review` is the odd one out: it fetches `.github/review-prompt.md` over HTTP at run time, because a
reusable workflow runs with the caller's repo checked out and never gets its own. Its `prompt-ref`
input defaults to `workflows-v0` so the instructions come from the same release as the workflow — leaving it
at `master` would run released workflows against unreleased instructions.

## Versioning and releases

The workflows and the npm package live in one repo but ship on their own schedules:

| What                                         | Consumers get it through                   | Ships when              |
| -------------------------------------------- | ------------------------------------------ | ----------------------- |
| the workflows and the CLI they call          | the `@workflows-v0` tag in `uses:`         | every master push       |
| the lib (`testActor`, `describe`, matchers…) | `apify-test-tools` in their `package.json` | a stable release on npm |

The CLI is bundled with its dependencies into `.github/cli/apify-test-tools.mjs` (`npm run bundle`, run by the
pre-commit hook and checked in CI), and the setup action runs it from there. Nothing is installed for it, so a tag is
a complete statement: these workflows and this CLI, with the exact dependency versions from `package-lock.json` at
that commit. The consumer's own `node_modules` is left alone, so their tests keep the lib version they locked.

- **Workflow or CLI change** — merge it. `workflows-v0` moves once checks and tests pass, and it goes live. No
  release needed, even when a workflow starts using a new CLI feature: both are in the same commit.
- **Lib change** — merge it, then cut a release when you want it out. Consumers pick it up when they update
  `apify-test-tools`.

The CLI and the lib in one job can be different versions now, so the formats between them are a contract: the
`ACTOR_BUILDS` JSON that `build` writes and the lib reads, and the vitest JSON report `report-tests` reads. Add
fields freely; renaming or removing one needs a new major tag.

`workflows-v0` moving on every master push means `@workflows-v0` is as live as `@master` was — there's no staging
step. What the tag buys you is a `workflows-v1` for breaking workflow changes, so repos migrate one at a time instead
of all at once, and a way to roll back by pointing the tag at an earlier commit (**Move major version tag**
workflow). Bump `MAJOR_TAG` in `.github/workflows/_move_major_tag.yaml` to cut the next major; the old tag then
freezes where it is and keeps working, CLI included, since the bundle is part of the frozen commit.

The tag tracks the **workflows'** contract, not the npm package version. They move independently on purpose, so
`@workflows-v0` is expected to stay `@workflows-v0` after the package reaches 1.0 — bump it when a workflow breaks
its callers, not when the package does. Because `uses:` cannot take an expression, every ref into this repo repeats
the tag literally; `check-major-tag-refs.mjs` fails the build if `MAJOR_TAG` and those refs disagree, which is the
mistake that would otherwise ship silently during a bump.

## Testing workflow changes

- Point [testing-repo-for-github-actions](https://github.com/apify-store/testing-repo-for-github-actions) at your
  branch (`uses: ...@your-branch`). It has real attached Actors and tests. The branch carries its own CLI bundle, so
  one branch tests the workflows and the CLI together.
- To change the composite action itself, repoint the `uses:` refs inside the reusable workflows at your branch as
  well, and change them back before merging.
- Make sure the shell code actually works on your laptop first.
- After merging, watch the workflow on a real project before moving on.

## How the workflows scope secrets

The public side of this is the [Secrets](./docs/workflows.md#secrets) table.

The Actor tokens are the one set that cannot be listed in the workflow, because each Actor names its own token via
`tokenEnvVar` in `apify-test-tools.config.json`, and a reusable workflow only accepts secrets it declares by name.
Callers pack them into the `CONFIG_SECRETS` secret. Those steps pass `${{ toJSON(secrets) }}` as `WORKFLOW_SECRETS`
and run the command through `.github/scripts/run-with-apify-tokens.mjs`, which reads that same config file to decide
which secrets to pass on. It looks each one up in `CONFIG_SECRETS` first, then among the secrets `secrets: inherit`
brought:

```yaml
- name: Build
  shell: bash
  env:
      WORKFLOW_SECRETS: ${{ toJSON(secrets) }}
  run: |
      jq '{ actors: .functionallyChangedActors }' affected.json \
        | node "${{ steps.setup.outputs.scripts-path }}/run-with-apify-tokens.mjs" \
          apify-test-tools build --version-number 0.99
```

The wrapper passes only the tokens the config declares and drops `WORKFLOW_SECRETS`, so neither the CLI nor anything
under `node_modules` sees the blob. Nothing is written to `$GITHUB_ENV`, so the tokens stay inside that one command
rather than leaking into later steps. Reading the same file `apify-test-tools` reads means the two can't drift, and a
secret that merely looks like an Actor token is not passed just because of its name.

A token the config declares but the repo hasn't set is a warning, not a failure: a repo can carry an Actor whose
token isn't configured and still build fine as long as that Actor never changes, and `apify-test-tools` raises a
precise error naming the Actor at the point it actually needs the token.

The runner masks a secret by its exact value, so it only knows `CONFIG_SECRETS` as a whole blob. The setup action
runs `.github/scripts/mask-config-secrets.sh` first, which registers each value inside it with `::add-mask::`, so a
token taken out of the blob is masked too.

`scripts-path` comes from the setup action (give the step `id: setup`) and points at this repo's `.github/scripts/`
directory inside the runner's action checkout, so workflows can run these helpers without checking this repo out
again. The caller's workspace holds the caller's repo, not this one.

Two tidier-looking alternatives don't work, so don't reach for them:

- **Exporting to `$GITHUB_ENV`** would let the steps call the CLI directly with no wrapper, but `$GITHUB_ENV`
  applies to every later step in the job. In `pr-build-test` the vitest step runs after the build, so it would
  inherit Actor tokens it has no use for.
- **Returning the tokens as a step output** would be scoped correctly, but the runner refuses to set an output whose
  value contains a registered secret. It logs `Skip output <name> since it may contain secret` and leaves the output
  empty, so anything reading it downstream gets nothing.

The `unitTest` job runs static checks and needs `NPM_TOKEN` only. No job runs `npm ci` or `pnpm install` with Apify
or Slack credentials in scope, so a postinstall script in the dependency tree cannot read them.
