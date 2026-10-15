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

Consumers pin `@workflows-v0`, not `@master`. See
[Versioning and releases](./README.md#versioning-and-releases) in the README for how the tag and the
npm release relate — the short version:

- the workflows and the CLI ship together on every master push, through the tag; no npm release needed
- the lib ships through a stable npm release
- the CLI runs from `.github/cli/apify-test-tools.mjs`, a bundle the pre-commit hook rebuilds with
  `npm run bundle`. If you commit with `--no-verify`, run it yourself: the `CLI bundle` check fails
  on a stale bundle, and a stale bundle would hold the tag.
- `npm test` covers the bundle without network (`test/bundle/`). `npm run test:e2e` runs it against
  dummy Actors in an isolated sandbox account (`test/e2e/`) and skips itself unless
  `E2E_TEST_APIFY_TOKEN_DBYPODOIHUZABNQTR` is set. CI passes that secret only to the `E2E tests` job.
  The git `build` and `release` tests clone
  [testing-repo-for-github-actions](https://github.com/apify-store/testing-repo-for-github-actions) and
  use its `e2e/base` and `e2e/feature` branches as fixtures, so never rebase or delete those.

`npm run lint` and `actionlint` (via the `Code checks` workflow) both gate master, so run them before
pushing workflow changes.

`public_review` is the odd one out: it fetches `.github/review-prompt.md` over HTTP at run time, because a
reusable workflow runs with the caller's repo checked out and never gets its own. Its `prompt-ref`
input defaults to `workflows-v0` so the instructions come from the same release as the workflow — leaving it
at `master` would run released workflows against unreleased instructions.
