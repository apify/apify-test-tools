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

`pr-build-test`, `platform-tests`, `push-build-latest`, `claude` and
`platform-tests-claude-investigate-and-fix` are the workflows consumer repos call. They live here
because they call this package's CLI, so a change to both is one PR. GitHub only reads workflow
files at the top level of `.github/workflows`, so they sit next to this repo's own CI; the
`_`-prefixed files are internal to this repo and are not meant to be called from outside.

Consumers pin `@v1`, not `@master`. See
[Versioning and releases](./README.md#versioning-and-releases) in the README for how the tag and the
npm release relate — the short version:

- changing only a workflow needs no npm release
- changing only the package needs no workflow change
- a workflow that calls a **new** CLI feature must raise the floor in
  `.github/workflows-min-package-version` in the same PR. The `v1` tag is then held until that
  version is on npm, so merging can't ship a workflow that calls a CLI that doesn't exist yet.

`npm run lint` and `actionlint` (via the `Code checks` workflow) both gate master, so run them before
pushing workflow changes.
