# Apify Test Tools

Build, test and release Apify Actors from a Git repository or local source code. The package has three parts:

1. **A vitest library** for writing platform tests that run your Actors on Apify and check the results:

    ```ts
    testActor('myteam/web-scraper', 'scrapes the start URL', async ({ expect, run }) => {
        const runResult = await run({ input: { startUrls: [{ url: 'https://apify.com' }] } });
        await expect(runResult).toFinishWith({ datasetItemCount: { min: 1, max: 10 } });
    });
    ```

2. **A CLI** that finds the Actors a change affects, builds them, and reports the results. It runs anywhere, so you
   can build your own pipeline on it in any CI:

    ```bash
    npx apify-test-tools get-affected-actors --base origin/master \
      | jq '{ actors: (.functionallyChangedActors + .testChangedActors) }' \
      | npx apify-test-tools build --version-number 0.99
    ```

3. **Ready-made GitHub Actions workflows** built on the CLI and the library, so a GitHub repo needs only a few lines
   per workflow:

    ```yaml
    jobs:
        buildDevelAndTest:
            uses: apify/apify-test-tools/.github/workflows/public_pr-build-test.yaml@workflows-v1
            secrets:
                # One entry per secret apify-test-tools.config.json names: each `buildTokenEnvVar` and `testTokenEnvVar`
                CONFIG_SECRETS: |
                    { "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}" }
    ```

Most repos only need the library and the workflows: the workflows call the CLI for you. Use the CLI directly only to
build your own pipeline, e.g. on a CI platform other than GitHub, or to build and test locally.

## Only what changed is retested

Builds and platform tests cost time and money, so the tool skips everything a change can't affect:

- **Only affected Actors.** A changed file counts for Actors whose context contains it, subject to ignore rules,
  or whose `actor.json` links it. A shared file linked from `actor.json` affects every Actor that uses it.
- **Cosmetic changes skip tests.** Linked README/changelog edits and cosmetic schema changes don't trigger tests on a PR;
  they're only rebuilt when released.
- **Only new changes on a PR.** Each push to a PR retests only the Actors that changed since its last green run, not
  the whole PR again.
- **Only their tests.** Only the tests of the Actors that were built run.

See [Change detection](docs/cli.md#change-detection) for the exact rules.

This README covers what you need to get a repo running. The full reference lives in `docs/`:

- [Vitest library API](docs/lib.md) — `testActor`, `testServerInterfaceActor`, `RunTestResult`, matchers, running tests locally
- [CLI API](docs/cli.md) — every command, change detection, releasing, building locally
- [Workflow API](docs/workflows.md) — every GitHub workflow, its inputs and secrets, versioning
- [Migrating to v1](docs/migrating-to-v1.md) — updating a repository from `@workflows-v0` and a library before 1.0

[Contributing](CONTRIBUTING.md)

## Getting started

Your Actors can be written in any programming language, e.g. Python: anything the platform builds from a Dockerfile
works. Only the tests and this tooling run on Node.js, so all a repo needs is a `package.json` at the root with
`apify-test-tools` and `vitest` in its `devDependencies`, and tests written in TypeScript or JavaScript. If you use the
[PR workflow](docs/workflows.md#public_pr-build-testyaml), also define the `build-check`, `lint` and `test` scripts
its static checks run, e.g. with your language's own linter and unit tests.

### 1. Install the package

```bash
npm i -D apify-test-tools
```

- Requires Node.js 22.12+, 24 or 26+ and `vitest` 5 or later (uses [annotate](https://vitest.dev/guide/test-context.html#annotate))
- Make sure `target` and `module` in your `tsconfig.json`'s `compilerOptions` are set to `ES2022`
- Every Actor must already have at least one build under its default build tag (usually `latest`), built
  from a Git repository version whose URL points to this repository. Build it once manually on the
  platform before CI takes over. See [Repository check](docs/cli.md#repository-check).

### 2. Create the config file

Every repo must have an `apify-test-tools.config.json` file at the root that lists its Actors. See
[Config file](#config-file) below.

### 3. Set up Actor folders

Each Actor in the config must have a `.actor/actor.json` file. The `dockerContextDir` field in `actor.json` defines
the build context boundary. Resolved documentation, schema, and Dockerfile links in `actor.json` also count as
dependencies even outside that context (see
[Change detection](docs/cli.md#change-detection)).

This example has two Actors that share the code at the repo root, and one standalone Actor with its own code:

```
my-repo
├── apify-test-tools.config.json
├── Dockerfile                      <- shared by web-scraper and email-sender
├── package.json
├── src/                            <- shared by web-scraper and email-sender
├── actors
│   ├── web-scraper
│   │   └── .actor
│   │       └── actor.json          <- points to the repo root
│   └── email-sender
│       └── .actor
│           └── actor.json          <- points to the repo root
├── standalone-actors
│   └── orchestrator
│       ├── .actor
│       │   └── actor.json          <- default context: its own folder
│       ├── Dockerfile
│       ├── package.json
│       └── src/
└── test
    └── platform
        ├── web-scraper.test.ts
        ├── email-sender.test.ts
        └── orchestrator
            └── orchestrator.test.ts
```

The Actors that share code point their `dockerfile` and `dockerContextDir` at the repo root. Both paths are relative
to the `.actor` folder:

```json
{
    "actorSpecification": 1,
    "name": "web-scraper",
    "version": "0.1",
    "dockerfile": "../../../Dockerfile",
    "dockerContextDir": "../../.."
}
```

A change to the shared `src/` then builds and tests both of them, while a change in `standalone-actors/orchestrator`
counts only for the orchestrator, even though it lies inside the others' context. The orchestrator leaves
`dockerContextDir` out, so its context is its own folder.

For a single-Actor repo, set `"folder": "."` in the config and place `.actor/actor.json` at the repo root.

### 4. Write tests

Put platform tests in `test/platform`. How you organize them inside is up to you. See
[Writing tests](#writing-tests) below.

### 5. Set up CI

On GitHub, add the [GitHub workflows](#github-workflows) below. On another CI platform, call the
[CLI](docs/cli.md) from your own pipeline; the workflows are a good template for the steps.

## Config file

`apify-test-tools.config.json` lives at the repo root and tells the tool which Actors live in the repo, where they are,
and which tokens build and test them. Actors are organized into groups, and each group sets the tokens once for all of
its Actors:

```json
{
    "mode": "grouped",
    "groups": {
        "myteam": {
            "buildTokenEnvVar": "APIFY_TOKEN_MYTEAM",
            "testTokenEnvVar": "APIFY_TOKEN_MYTEAM",
            "actors": [
                { "folder": "actors/web-scraper", "actorFullName": "myteam/web-scraper" },
                { "folder": "actors/email-sender", "actorFullName": "myteam/email-sender" },
                {
                    "folder": "standalone-actors/orchestrator",
                    "actorFullName": "myteam/orchestrator",
                    "overrideActorContext": ["standalone-actors/orchestrator", "test/platform/orchestrator"]
                }
            ]
        }
    }
}
```

The group key (`myteam` above) is only a label for readability; it doesn't need to match any folder or username. Each
group needs a `buildTokenEnvVar`, a `testTokenEnvVar` and at least one Actor. Add another group for Actors that need a
different token, e.g. Actors owned by another account.

`buildTokenEnvVar` names the token that builds the Actors, `testTokenEnvVar` the one their platform tests run them
with, so the test runs start in that token's account. The two can name the same env var, as `myteam` does above, or
the tests can run with a token that may do less. [Token permissions](#token-permissions) says what each one needs.

Here the tests of the partner's Actors run with a scoped tester token. The search Actor sets its own
`testTokenEnvVar`, the partner's full token, because its tests call its server interface on the PR build:

```json
"partner": {
    "buildTokenEnvVar": "APIFY_TOKEN_PARTNER",
    "testTokenEnvVar": "APIFY_TOKEN_TESTER",
    "actors": [
        { "folder": "actors/partner-scraper", "actorFullName": "partner/scraper" },
        {
            "folder": "actors/partner-search",
            "actorFullName": "partner/search",
            "testTokenEnvVar": "APIFY_TOKEN_PARTNER"
        }
    ]
}
```

The orchestrator sets `overrideActorContext` because its tests live outside its own folder: without it, a change to
only `test/platform/orchestrator` wouldn't test it. The other two already have the whole repo, tests included, as
their context.

| Field                  | Where          | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`                 | top level      | yes      | Always `"grouped"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `folder`               | Actor          | yes      | Relative path from repo root to the Actor's own project directory — the folder that directly contains `.actor/actor.json` (i.e. `<folder>/.actor/actor.json`) and its source. Documentation and schemas may be linked from elsewhere through `actor.json`. Use `"."` for a single-Actor repo where `.actor/` is at the root.                                                                                                                                                                           |
| `actorFullName`        | Actor          | yes      | Full Actor identifier in `owner/name` format (e.g. `"apify/web-scraper"`). This is the source of truth for the Actor name — the `name` field in `actor.json` is not used.                                                                                                                                                                                                                                                                                                                              |
| `buildTokenEnvVar`     | group or Actor | yes      | Name of the environment variable holding the Apify API token that builds the group's Actors. It needs full permissions, see [Token permissions](#token-permissions). No fallback — if the env var is not set at build time, the build fails.                                                                                                                                                                                                                                                           |
| `testTokenEnvVar`      | group or Actor | yes      | Name of the environment variable holding the Apify API token the platform tests run the group's Actors with. It can name the same env var as `buildTokenEnvVar`, or a token that may do less, see [Token permissions](#token-permissions). If the env var is not set, the tests of the Actors that use it fail.                                                                                                                                                                                        |
| `platformTestsGlob`    | top level      | no       | Glob from the repo root of the platform tests and their helpers. Default `test/platform/**`. A changed file that matches it is a test change, also when `.dockerignore` lists it: the PR workflow builds and tests the Actor whose context holds it, and a release skips it. See [Change detection](docs/cli.md#change-detection).                                                                                                                                                                     |
| `overrideActorContext` | group or Actor | no       | Array of paths (relative to repo root) that define which files are relevant to the Actor. When set, replaces the `dockerContextDir` from `actor.json` for change detection. Useful when an Actor depends on shared packages outside its Docker build context. Entries must not be prefixes of one another (e.g. `["", "code"]` or `["actors", "actors/foo"]` are rejected). The Actor's own `folder` is always part of its context — if none of the listed entries reach it, it's added automatically. |

A value set on an Actor replaces the group's for that Actor only. Values are replaced, not merged: if the `myteam`
group also set `overrideActorContext`, the orchestrator would still get only the two paths it lists.

No two Actors may share a `folder`, and no two entries may point at the same `actorFullName`.

### Token permissions

- **`buildTokenEnvVar`** needs a token with full permissions, for now. It builds the Actors, creates their versions and
  deletes their old builds. A token that needs less is planned.
- **`testTokenEnvVar`** only needs to run the repo's Actors, so a scoped token with run access to them is enough,
  unless the tests call a server interface.
  **Only the owner, or an account with write access to the Actor, can call an Actor's
  [server interface](docs/lib.md#testserverinterfaceactoractorfullname-testname-fn-options) on a build other than its
  default one, which is what the tests do on a PR.** A scoped token can't get write access to an Actor on its own, so
  the `testTokenEnvVar` of an Actor with server interface tests needs a full-permission token of such an account,
  e.g. the same token as its `buildTokenEnvVar`.

## GitHub workflows

The workflows take every change straight to production, with tests in between:

- **Every push to a PR** builds the Actors the PR changes into a test version (`0.99`) that users never run, and runs
  their platform tests against those builds. Only the Actors whose files changed are built and tested, and a later
  push only re-tests what changed since the last green run.
- **Every merge to `master`** builds the changed Actors into their default version (`latest`), which is what users
  run, and announces the release on Slack. There is no separate release step.
- **Scheduled runs** (optional) run the tests against the released builds to catch what breaks without a code change,
  like a website changing its layout.

These are GitHub Actions workflows. On another CI platform, build the same flow with the [CLI](docs/cli.md).

Add these files to `.github/workflows` in your repo. They call the reusable workflows in this repo, pinned at the
`@workflows-v1` major tag — never at `@master`. Every input, the optional Claude workflows, stale issue closer, and how the tag moves are
in the [Workflow API](docs/workflows.md).

### `pr-build-devel-test.yaml`

```yaml
name: PR Test

on:
    pull_request:
        branches: [master]

jobs:
    buildDevelAndTest:
        uses: apify/apify-test-tools/.github/workflows/public_pr-build-test.yaml@workflows-v1
        secrets:
            # One entry per secret apify-test-tools.config.json names: each `buildTokenEnvVar` and `testTokenEnvVar`
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

### `release-latest.yaml`

```yaml
name: Release latest

on:
    push:
        branches: [master]

jobs:
    buildLatest:
        uses: apify/apify-test-tools/.github/workflows/public_push-build-latest.yaml@workflows-v1
        secrets:
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
            # One entry per secret apify-test-tools.config.json names, here each `buildTokenEnvVar`
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

### Scheduled tests (optional)

How often to run which tests is up to you. `test-files-glob` is a glob from the repo root, see
[Splitting the tests](docs/workflows.md#splitting-the-tests). For example, you can run the daily tests once a day:

```yaml
name: Platform tests - Daily

on:
    schedule:
        # Runs at 00:00 UTC every day
        - cron: '0 0 * * *'
    workflow_dispatch:

jobs:
    platformTestsDaily:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v1
        with:
            test-files-glob: 'test/platform/{daily,daily-without-pr}/**'
        secrets:
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
            # One entry per token the tests run with: each `testTokenEnvVar`
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

and a few critical tests every hour:

```yaml
name: Platform tests - Hourly

on:
    schedule:
        # Runs at the start of every hour
        - cron: '0 * * * *'
    workflow_dispatch:

jobs:
    platformTestsHourly:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v1
        with:
            test-files-glob: 'test/platform/{hourly,hourly-without-pr}/**'
        secrets:
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

### Secrets

Set these as repository or organization secrets and pass them in each job's `secrets:` block, as in the examples
above. The Actor tokens go packed in one JSON object, `CONFIG_SECRETS`, because their names differ per repo:

| Secret                                                                         | Needed for                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| the Actor tokens named by `buildTokenEnvVar` in `apify-test-tools.config.json` | building Actors and deleting their old builds                     |
| the test tokens named by `testTokenEnvVar`, which can be the Actor tokens      | running the platform tests                                        |
| `SLACK_BOT_TOKEN`                                                              | announcing releases and reporting scheduled test results to Slack |
| `NPM_TOKEN`                                                                    | optional, installing private npm packages. Use a read-only token  |

The workflows read the Apify tokens only from `CONFIG_SECRETS`, so `secrets: inherit` doesn't pass them. Each secret
only reaches the step that needs it. See [Secrets](docs/workflows.md#secrets), also for passing `CONFIG_SECRETS`
without listing the tokens.

## Writing tests

Platform tests use `describe` and `testActor` from `apify-test-tools` instead of the ones from `vitest`. `testActor`
registers a test that only runs when that Actor was built for it (or when you ask for all tests), and gives the
callback an extended `expect` and a `run` function that starts the Actor.

```ts
import { describe, testActor } from 'apify-test-tools';

describe('web-scraper', () => {
    testActor('myteam/web-scraper', 'scrapes the start URL', async ({ expect, run }) => {
        const runResult = await run({ input: { startUrls: [{ url: 'https://apify.com' }] } });

        // Status SUCCEEDED, no failed requests, no thrown TypeError or ReferenceError in the log, and the item count
        await expect(runResult).toFinishWith({ datasetItemCount: { min: 1, max: 10 } });

        const { items } = await runResult.getDataset();
        expect(items[0].title, 'Page title').toBeNonEmptyString();
    });
});
```

Platform tests only run on the Actors [`test`](docs/cli.md#running-tests-test) passes to them, each with its
`testTokenEnvVar` token, so your regular unit test run stays unaffected.

To run them locally against the Actors' current default builds:

```bash
npx apify-test-tools get-actor-configs | APIFY_TOKEN_MYTEAM=<token> npx apify-test-tools test
```

The [Vitest library API](docs/lib.md) covers everything `toFinishWith` checks, the other matchers, server interfaces,
reading run data, and running tests locally against builds of your own changes.
