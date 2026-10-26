# Apify Test Tools

Build, test and release Apify Actors from a GitHub repository. The package has three parts:

- **Reusable GitHub workflows** that build the Actors a PR changes, run their platform tests, and release them on merge
- **A vitest library** (`testActor`, `expect(run).toFinishWith(...)`, …) for writing platform tests
- **A CLI** (`apify-test-tools`) the workflows call, which you can also run locally

This README covers what you need to get a repo running. The full reference lives in `docs/`:

- [Workflow API](docs/workflows.md) — every reusable workflow, its inputs and secrets, versioning
- [Vitest library API](docs/lib.md) — `testActor`, `testStandbyActor`, `RunTestResult`, matchers, running tests locally
- [CLI API](docs/cli.md) — every command, change detection, releasing, building locally

[Contributing](CONTRIBUTING.md)

## Getting started

### 1. Install the package

```bash
npm i -D apify-test-tools
```

- Requires `vitest` version `3.2.4` or later (uses [annotate](https://vitest.dev/guide/test-context.html#annotate))
- Make sure `target` and `module` in your `tsconfig.json`'s `compilerOptions` are set to `ES2022`
- Every Actor must already have at least one build under its default build tag (usually `latest`), built
  from a Git repository version whose URL points to this repository. Build it once manually on the
  platform before CI takes over. See [Repository check](docs/cli.md#repository-check).

### 2. Create the config file

Every repo that uses `apify-test-tools` must have an `apify-test-tools.config.json` file at the root. See
[Config file](#config-file) below.

### 3. Set up Actor folders

Each Actor in the config must have a `.actor/actor.json` file. The `dockerContextDir` field in `actor.json` defines
the build context boundary — this is what the tool uses to decide which files can affect the Actor's build (see
[Change detection](docs/cli.md#change-detection)).

```
my-repo
├── apify-test-tools.config.json
├── actors
│   ├── web-scraper
│   │   ├── .actor
│   │   │   └── actor.json
│   │   └── src/
│   └── email-sender
│       ├── .actor
│       │   └── actor.json
│       └── src/
└── test
    ├── unit
    └── platform
        ├── core                    <- Core (hourly) tests
        │   └── core.test.ts
        ├── some.test.ts            <- Daily tests can be anywhere inside platform/
        └── some-other.test.ts
```

For a single-actor repo, set `"folder": "."` in the config and place `.actor/actor.json` at the repo root.

### 4. Create test directories

```bash
mkdir -p test/platform/core
```

- Core (hourly) tests go in `test/platform/core`
- Daily tests go anywhere in `test/platform`

### 5. Add the GitHub workflows

See [GitHub workflows](#github-workflows) below.

### 6. Write a test

See [Writing tests](#writing-tests) below.

## Config file

`apify-test-tools.config.json` lives at the repo root and tells the tool which Actors live in the repo, how to
identify them, and which token to use.

### Actor fields

Every Actor in the config is described by these fields, whatever the mode:

| Field                  | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder`               | yes      | Relative path from repo root to the actor's own project directory — the folder that directly contains `.actor/actor.json` (i.e. `<folder>/.actor/actor.json`), the actor's README/CHANGELOG, and its source. Use `"."` for a single-actor repo where `.actor/` is at the root.                                                                                                                                                                                                                          |
| `actorFullName`        | yes      | Full actor identifier in `owner/name` format (e.g. `"apify/web-scraper"`). This is the source of truth for the actor name — the `name` field in `actor.json` is not used.                                                                                                                                                                                                                                                                                                                               |
| `tokenEnvVar`          | yes      | Name of the environment variable holding the Apify API token for this actor. In [grouped mode](#grouped-mode) it's inherited from the group unless the actor sets its own. No fallback — if the env var is not set at build time, the build fails.                                                                                                                                                                                                                                                      |
| `overrideActorContext` | no       | Array of paths (relative to repo root) that define which files are relevant to this actor. When set, replaces the `dockerContextDir` from `actor.json` for change detection. Useful when an actor depends on shared packages outside its Docker build context. Entries must not be prefixes of one another (e.g. `["", "code"]` or `["actors", "actors/foo"]` are rejected). The actor's own `folder` is always part of its context — if none of the listed entries reach it, it's added automatically. |

### Modes

The file's layout is picked by the top-level `mode` field. Each mode is a different way of writing the same thing:
every mode resolves to a list of Actors with the fields above, and the same rules apply to all of them — no two
Actors may share a `folder`, and no two entries may point at the same `actorFullName`. If `mode` is left out,
[`"legacy"`](#legacy-mode) is used, so existing config files keep working unchanged.

### Legacy mode

The default. A flat `actors` array where every entry carries all of its settings. Good for repos with a few Actors,
or where every Actor has different settings.

```json
{
    "mode": "legacy",
    "actors": [
        {
            "folder": "actors/web-scraper",
            "actorFullName": "myteam/web-scraper",
            "tokenEnvVar": "APIFY_TOKEN_MYTEAM"
        },
        {
            "folder": "actors/email-sender",
            "actorFullName": "myteam/email-sender",
            "tokenEnvVar": "APIFY_TOKEN_MYTEAM",
            "overrideActorContext": ["actors/email-sender", "packages/shared"]
        }
    ]
}
```

`actors` must hold at least one entry. Every entry takes all the [Actor fields](#actor-fields) directly, and
`tokenEnvVar` is required on each one.

### Grouped mode

Actors are organized into `groups`, and each group sets `tokenEnvVar` and `overrideActorContext` once for all of its
Actors. Good for repos where many Actors share the same token or context.

```json
{
    "mode": "grouped",
    "groups": {
        "myteam": {
            "tokenEnvVar": "APIFY_TOKEN_MYTEAM",
            "overrideActorContext": ["packages/shared"],
            "actors": [
                { "folder": "actors/web-scraper", "actorFullName": "myteam/web-scraper" },
                {
                    "folder": "actors/email-sender",
                    "actorFullName": "myteam/email-sender",
                    "overrideActorContext": ["actors/email-sender", "packages/mailer"]
                }
            ]
        },
        "partner": {
            "tokenEnvVar": "APIFY_TOKEN_PARTNER",
            "actors": [{ "folder": "actors/partner-crawler", "actorFullName": "partner/crawler" }]
        }
    }
}
```

`groups` is an object with at least one group. The group key (`myteam`, `partner` above) is only a label for
readability; it has no effect on the result, and it does not need to match any folder or username. Each group needs
a `tokenEnvVar` and at least one Actor, and can optionally set `overrideActorContext`.

An Actor inside a group can set its own `tokenEnvVar` or `overrideActorContext`, and that value replaces the group's
for that Actor only. Values are replaced, not merged: in the example above, `myteam/email-sender` gets
`["actors/email-sender", "packages/mailer"]`, not `packages/shared` as well.

## GitHub workflows

Add these four files to `.github/workflows` in your repo. They call the reusable workflows in this repo, pinned at
the `@workflows-v0` major tag — never at `@master`. Every input, the optional Claude workflows, and how the tag
moves are in the [Workflow API](docs/workflows.md).

### `pr-build-devel-test.yaml`

Builds the Actors a PR changes into version `0.99` and runs their platform tests against those builds.

```yaml
name: PR Test

on:
    pull_request:
        branches: [master]

jobs:
    buildDevelAndTest:
        uses: apify/apify-test-tools/.github/workflows/public_pr-build-test.yaml@workflows-v0
        secrets: inherit
```

### `release-latest.yaml`

Builds the Actors a push to `master` changed into their default version, and announces the release on Slack.

```yaml
name: Release latest

on:
    push:
        branches: [master]

jobs:
    buildLatest:
        uses: apify/apify-test-tools/.github/workflows/public_push-build-latest.yaml@workflows-v0
        secrets: inherit
```

### `platform-tests-core.yaml`

Runs the tests in `test/platform/core` every hour against the released builds.

```yaml
name: Platform tests - Core

on:
    schedule:
        # Runs at the start of every hour
        - cron: '0 * * * *'
    workflow_dispatch:

jobs:
    platformTestsCore:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v0
        with:
            test-files-glob: core
        secrets: inherit
```

### `platform-tests-daily.yaml`

Runs every test in `test/platform` once a day against the released builds.

```yaml
name: Platform tests - Daily

on:
    schedule:
        # Runs at 00:00 UTC every day
        - cron: '0 0 * * *'
    workflow_dispatch:

jobs:
    platformTestsDaily:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v0
        secrets: inherit
```

### Secrets

Callers pass `secrets: inherit`, so set these as repository or organization secrets:

| Secret                                                                    | Needed for                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| the Actor tokens named by `tokenEnvVar` in `apify-test-tools.config.json` | building Actors and deleting their old builds                    |
| `TESTER_APIFY_TOKEN`                                                      | running the platform tests                                       |
| `SLACK_TOKEN_TESTS_BOT`                                                   | reporting scheduled test results to Slack                        |
| `SLACK_TOKEN_RELEASES_BOT`                                                | announcing releases on Slack                                     |
| `NPM_TOKEN`                                                               | optional, installing private npm packages. Use a read-only token |

Each secret only reaches the step that needs it. See [Secrets](docs/workflows.md#secrets) for how that works.

## Writing tests

Platform tests live in `test/platform` and use `describe` and `testActor` from `apify-test-tools` instead of the
ones from `vitest`. `testActor` registers a test that only runs when CI built that Actor (or in the scheduled runs),
and gives the callback an extended `expect` and a `run` function that starts the Actor.

```ts
import { describe, testActor } from 'apify-test-tools';

describe('web-scraper', () => {
    testActor('myteam/web-scraper', 'scrapes the start URL', async ({ expect, run }) => {
        const runResult = await run({ input: { startUrls: [{ url: 'https://apify.com' }] } });

        // Status SUCCEEDED, a sane duration, no failed requests, no errors in the log, and the item count
        await expect(runResult).toFinishWith({ datasetItemCount: { min: 1, max: 10 } });

        const { items } = await runResult.getDataset();
        expect(items[0].title, 'Page title').toBeNonEmptyString();
    });
});
```

Platform tests are skipped unless `TESTER_APIFY_TOKEN` is set, so your regular unit test run stays unaffected.

To run them locally against the Actors' current default builds:

```bash
RUN_ALL_PLATFORM_TESTS=1 TESTER_APIFY_TOKEN=<token> npx vitest --run test/platform
```

The [Vitest library API](docs/lib.md) covers everything `toFinishWith` checks, the other matchers, standby Actors,
reading run data, and running tests locally against builds of your own branch.
