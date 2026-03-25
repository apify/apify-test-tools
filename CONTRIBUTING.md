# Contributing

The package consists of two parts:

- cli located in `bin/`
- test library located in `lib`

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
git clone git@github.com:apify-projects/apify-test-tools.git
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
