# Contributing

The package consists of three parts:

- cli located in `bin/`
- test library located in `lib`
- the reusable GitHub workflows consumer repos call, in `.github/workflows/` and `.github/actions/`

## CLI

- `bin/build.ts` actor building
- `bin/git.ts` git wrappers for getting relevant git commits and changed files
- `bin/github.ts` github push event parsing
- `bin/main.ts` entrypoing
- `bin/slack.ts` sending notifications to slack
- `bin/test-report.ts` processing vitest's test reports

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

To work on the library, you just need to define `GITHUB_WORKSPACE` to tell the cli where you repo is located:

```sh
export GITHUB_WORKSPACE=../path/to/testing-repo-for-github-actions # path to the repo
npx tsx bin/main.ts --help
npx tsx bin/main.ts get-commits --target-branch master --source-branch feat/testing-feature-branch
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

Consumers pin `@v0`, not `@master`. See
[Versioning and releases](./README.md#versioning-and-releases) in the README for how the tag and the
npm release relate — the short version:

- changing only a workflow needs no npm release
- changing only the package needs no workflow change
- a workflow that calls a **new** CLI feature must set `.github/workflows-package-version` to the
  version that will contain it, in the same PR. The `v0` tag is then held until that version is on
  npm, so merging can't ship a workflow that calls a CLI that doesn't exist yet.

`.github/workflows-package-version` holds one exact version, and the stable release writes it. The
workflows install exactly it, which is what makes a frozen major tag stay frozen — it keeps the
library it was tested with instead of following `latest` forever.

The `Package version bump needed` check enforces the point above: a PR touching both a `public_`
workflow (or the composite action) and `bin/`, `lib/` or `index.ts` has to move the pin. When the
two changes are unrelated and the workflow doesn't need the new code, label the PR
`no-version-bump-needed`.

It only looks at a single PR, so it won't catch a workflow that starts using a CLI feature merged in
an earlier, still-unreleased PR. That needs someone to land a CLI change and sit on it unreleased;
catching it would mean flagging every workflow edit made while any package change is unreleased.

`npm run lint` and `actionlint` (via the `Code checks` workflow) both gate master, so run them before
pushing workflow changes.

`public_review` is the odd one out: it fetches `.github/review-prompt.md` over HTTP at run time, because a
reusable workflow runs with the caller's repo checked out and never gets its own. Its `prompt-ref`
input defaults to `v0` so the instructions come from the same release as the workflow — leaving it
at `master` would run released workflows against unreleased instructions.
