# Migrating to v1

Version 1 of the library and `@workflows-v1` of the workflows go together: the v1 workflows refuse a library older
than 1.0.0, and the 1.0 library expects what the v1 workflows pass it. Migrate a repository in one PR:

1. [Update the packages](#update-the-packages): `apify-test-tools` 1.0, vitest 5 and Node.js
2. [Convert the config](#convert-the-config) to `"mode": "grouped"`
3. [Switch the workflows](#switch-the-workflows) to `@workflows-v1`, with `secrets: inherit` or the test tokens in `CONFIG_SECRETS`
4. [Update the tests](#update-the-tests): Actors by full name, the imports and `toFinishWith`

`@workflows-v0` keeps working with the libraries before 1.0, so a repository can stay on it until its PR is merged.
The [Troubleshooting](#troubleshooting) section maps the errors you may hit to the step that fixes them.

## Update the packages

```sh
npm install --save-dev apify-test-tools@^1.0.0 vitest@^5
```

- **vitest 5 or later** is a peer dependency. If your repository has its own vitest config or uses vitest APIs
  directly, go through [vitest's migration guide](https://vitest.dev/guide/migration).
- **Node.js 22.12 or later, 24, or 26 and later**, the versions vitest 5 runs on. The workflows run Node.js 24.
- **vitest no longer excludes `dist` by default.** The workflows' test step excludes `**/dist/**` itself. If you
  compile your tests and run `npx vitest` locally, add `dist/**` to `exclude` in your vitest config, or a compiled copy
  of each test runs next to it.

## Convert the config

`apify-test-tools.config.json` needs `"mode": "grouped"`, and its Actors go into groups. A config with a top-level
`actors` array and no `mode` fails with `Invalid input: expected "grouped" → at mode`.

Before:

```json
{
    "actors": [
        { "folder": "actors/web-scraper", "actorFullName": "myteam/web-scraper", "tokenEnvVar": "APIFY_TOKEN_MYTEAM" },
        {
            "folder": "actors/email-sender",
            "actorFullName": "myteam/email-sender",
            "tokenEnvVar": "APIFY_TOKEN_MYTEAM"
        },
        { "folder": "actors/partner", "actorFullName": "partner/scraper", "tokenEnvVar": "APIFY_TOKEN_PARTNER" }
    ]
}
```

After:

```json
{
    "mode": "grouped",
    "groups": {
        "myteam": {
            "tokenEnvVar": "APIFY_TOKEN_MYTEAM",
            "actors": [
                { "folder": "actors/web-scraper", "actorFullName": "myteam/web-scraper" },
                { "folder": "actors/email-sender", "actorFullName": "myteam/email-sender" }
            ]
        },
        "partner": {
            "tokenEnvVar": "APIFY_TOKEN_PARTNER",
            "actors": [{ "folder": "actors/partner", "actorFullName": "partner/scraper" }]
        }
    }
}
```

Group the Actors by the token that builds them. The group key is only a label. An Actor can still set its own
`tokenEnvVar` or `overrideActorContext`, which replaces the group's. `platformTestsGlob` stays at the top level.

The tests of each Actor run with its `testTokenEnvVar`, its `tokenEnvVar` unless the config names another, on the group
or on the Actor. See [Config file](../README.md#config-file).

## Switch the workflows

In every workflow that calls this repository's workflows, change `@workflows-v0` to `@workflows-v1`. The workflow
inputs are unchanged.

The PR and scheduled test workflows no longer take `TESTER_APIFY_TOKEN`: the tests run each Actor with its own test
token, its `testTokenEnvVar`, which is its `tokenEnvVar` unless the config names another. How the tokens get there
depends on how you pass the secrets.

### With `secrets: inherit`

Internal repositories, in the same GitHub organization or enterprise as this one, can pass all their secrets with
`secrets: inherit`. The workflows pick the tokens the config names from them, and each token only reaches the step
that needs it. Nothing to list, so the tag is the only change:

```yaml
jobs:
    buildDevelAndTest:
        uses: apify/apify-test-tools/.github/workflows/public_pr-build-test.yaml@workflows-v1
        secrets: inherit

    platformTestsDaily:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v1
        with:
            test-files-glob: 'test/platform/{daily,daily-without-pr}/**'
            report-slack-channel: '#notif-my-repo'
        secrets: inherit
```

Check that the repository, or its organization, has a secret under each name the config uses as a `tokenEnvVar` or
`testTokenEnvVar`. A test token that's missing is a warning in the test step, and the tests of its Actors fail with an
error naming it. A leftover `TESTER_APIFY_TOKEN` secret does no harm: the test workflows ignore it, unless the config
names it as a `testTokenEnvVar`.

`secrets: inherit` passes `TESTER_APIFY_TOKEN` to `public_platform-tests-claude-investigate-and-fix.yaml` as the
repository has it. Claude reads the failed run with it, and runs are private to the account that started them, so it
must be a token of the account the tests ran the Actors with. If the tests now run with another account's token than
`TESTER_APIFY_TOKEN`, either name `TESTER_APIFY_TOKEN` as the `testTokenEnvVar` in the config, or list the secrets of
the investigation job by name instead of inheriting them:

```yaml
handle-failure:
    needs: platformTestsDaily
    if: ${{ failure() }}
    uses: apify/apify-test-tools/.github/workflows/public_platform-tests-claude-investigate-and-fix.yaml@workflows-v1
    secrets:
        ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        # The token the tests ran the Actors with
        TESTER_APIFY_TOKEN: ${{ secrets.APIFY_TOKEN_MYTEAM }}
```

### With secrets listed by name

Remove `TESTER_APIFY_TOKEN` from the `secrets:` you pass to `public_pr-build-test.yaml` and
`public_platform-tests.yaml`. A reusable workflow refuses a secret it doesn't declare, so leaving it in fails the
workflow. Pass the test tokens in `CONFIG_SECRETS`, like the build tokens.

Before:

```yaml
jobs:
    platformTestsDaily:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v0
        with:
            test-files-glob: 'test/platform/{daily,daily-without-pr}/**'
            report-slack-channel: '#notif-my-repo'
        secrets:
            TESTER_APIFY_TOKEN: ${{ secrets.TESTER_APIFY_TOKEN }}
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
```

After:

```yaml
jobs:
    platformTestsDaily:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v1
        with:
            test-files-glob: 'test/platform/{daily,daily-without-pr}/**'
            report-slack-channel: '#notif-my-repo'
        secrets:
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
            # One entry per token the config names: each `tokenEnvVar` and `testTokenEnvVar`
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

`public_pr-build-test.yaml` already takes `CONFIG_SECRETS` for the builds. Drop `TESTER_APIFY_TOKEN` there, and make
sure `CONFIG_SECRETS` also holds any `testTokenEnvVar` that differs from the build tokens.

`public_platform-tests-claude-investigate-and-fix.yaml` still takes `TESTER_APIFY_TOKEN`: there it is the token Claude
reads and re-runs the failed run with. Keep passing it the token your tests ran the Actors with.

### Testing with `TESTER_APIFY_TOKEN` on purpose

If your tests ran with `TESTER_APIFY_TOKEN` on purpose, e.g. from an account other than the owner's, name it as the
test token in the config. With `secrets: inherit` that is all, otherwise also pass it in `CONFIG_SECRETS`:

```json
"partner": {
    "tokenEnvVar": "APIFY_TOKEN_PARTNER",
    "testTokenEnvVar": "TESTER_APIFY_TOKEN",
    "actors": [{ "folder": "actors/partner", "actorFullName": "partner/scraper" }]
}
```

## Update the tests

### Name every Actor by its full name

`testActor` and `testStandbyActor` take the Actor's full name, `owner/name`. A test that names its Actor by its raw ID
now fails its whole test file to load, instead of being skipped:

```ts
// Before
testActor('aYG0l9s7dbB7j3gbS', 'scrapes the start URL', async ({ expect, run }) => { ... });

// After
testActor('myteam/web-scraper', 'scrapes the start URL', async ({ expect, run }) => { ... });
```

### Import from the package root

The package exports only its root, `apify-test-tools`. Deep imports such as `apify-test-tools/dist/lib/lib.js` fail
with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Import everything from the root:

```ts
import { describe, testActor, testStandbyActor, RunTestResult } from 'apify-test-tools';
```

The `it` alias of `testActor` is gone: use `testActor`.

### `toFinishWith`

| Option                     | Before                                                        | Now                                                                                                      |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `duration`                 | `{ min: 600, max: 600_000 }` by default                       | not checked unless set                                                                                   |
| `requestsRetries`          | `{ max: 3 }` by default                                       | not checked unless set                                                                                   |
| `forbiddenLogs`            | the strings `ReferenceError`, `TypeError` anywhere in the log | strings or regular expressions, per log line. The defaults match a printed error, `TypeError: <message>` |
| `chargedEventCounts`       | an event you don't list must be 0                             | only the events you list are checked                                                                     |
| `strictChargedEventCounts` | –                                                             | `true` brings back: an event you don't list must be 0                                                    |
| `statisticsKeys`           | always `SDK_CRAWLER_STATISTICS_0`                             | one key or several, summed                                                                               |

What to change:

- **A test that relied on a duration or retries limit** sets it itself, e.g. `duration: { max: 10 * 60 * 1000 }`.
- **A test that relied on every unlisted event being 0** adds `strictChargedEventCounts: true`.
- **An event listed as never charged** passes now: `'premium': 0` asserts it wasn't charged. Before, an event listed
  but never charged failed.
- **An Actor without a Crawlee crawler** keeps `failedRequests: null`, and can drop `requestsRetries: null` and
  `duration: null`.
- **An adaptive crawler, a crawler with its own statistics id, or a run with several crawlers** sets
  `statisticsKeys`, e.g. `['SDK_CRAWLER_STATISTICS_0', 'SDK_CRAWLER_STATISTICS_1']`. The checks read their sum.
- **Your own `forbiddenLogs`** replace the defaults, as before. A string still matches anywhere in a line, but no
  longer across lines.

`runResult.getStatistics()` takes an optional key: `getStatistics('SDK_CRAWLER_STATISTICS_1')`.

## Running the CLI yourself

Skip this if you only use the workflows.

- `test` needs `apify-test-tools` 1.0.0 or newer installed in the repository, and fails on an older one.
- `test` takes its Actors by full name: each entry on stdin needs `actorFullName`. An entry with only `actorRawId`
  is rejected.
- `test` reads the config for each Actor's test token, so it needs `apify-test-tools.config.json`, and it doesn't use
  `TESTER_APIFY_TOKEN`. Set each Actor's test token env var instead.
- The CLI's help calls it `apify-test-tools`.

## Troubleshooting

| Error or warning                                                                                                         | Fix                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `The repository uses apify-test-tools 0.x, older than 1.0.0, the oldest version this CLI supports`                       | [Update the packages](#update-the-packages)                                                                                                  |
| `Invalid input: expected "grouped" → at mode`                                                                            | [Convert the config](#convert-the-config)                                                                                                    |
| `Test "…" names its Actor "…", which is not a full name`                                                                 | [Name every Actor by its full name](#name-every-actor-by-its-full-name)                                                                      |
| `APIFY_TOKEN_… is not set, so the tests of … will fail.` and `APIFY_TOKEN_… is not set. The tests of Actor "…" need it.` | Add that secret to the repository with `secrets: inherit`, or pass it in `CONFIG_SECRETS`, see [Switch the workflows](#switch-the-workflows) |
| `Actor … is not in apify-test-tools.config.json, so its tests will fail.`                                                | Add the Actor to the config                                                                                                                  |
| `Failed failedRequests check, expected 0, got no statistics record SDK_CRAWLER_STATISTICS_0.`                            | Set `statisticsKeys`, or `failedRequests: null` for an Actor without a crawler                                                               |
| A `chargedEventCounts` check that passes although an unlisted event was charged                                          | Add `strictChargedEventCounts: true`                                                                                                         |
| The workflow fails to start over `TESTER_APIFY_TOKEN`                                                                    | Remove it from the `secrets:` of the PR and scheduled test workflows, or pass `secrets: inherit`                                             |
| Claude's investigation can't find the failed run                                                                         | Pass it the token the tests ran with, see [With `secrets: inherit`](#with-secrets-inherit)                                                   |
| `ERR_PACKAGE_PATH_NOT_EXPORTED`                                                                                          | [Import from the package root](#import-from-the-package-root)                                                                                |
