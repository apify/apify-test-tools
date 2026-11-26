# Migrating to v1

Version 1 of the library and `@workflows-v1` of the workflows go together: the v1 workflows refuse a library older
than 1.0.0, and the 1.0 library expects what the v1 workflows pass it. Migrate a repository in one PR:

1. [Update the packages](#update-the-packages): `apify-test-tools` 1.0, vitest 5 and Node.js
2. [Convert the config](#convert-the-config) to `"mode": "grouped"`, with `tokenEnvVar` renamed to `buildTokenEnvVar`
   and a `testTokenEnvVar` on every group
3. [Choose the test token](#choose-the-test-token) of every group, `testTokenEnvVar`: the Actor's owner, or
   `TESTER_APIFY_TOKEN` as before
4. [Switch the workflows](#switch-the-workflows) to `@workflows-v1`, with every Apify token in `CONFIG_SECRETS`
5. [Update the tests](#update-the-tests): Actors by full name, the imports, server interface tests and `toFinishWith`

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

`tokenEnvVar` is renamed to `buildTokenEnvVar`, on the groups and on the Actors, so it reads apart from
`testTokenEnvVar`. A config that still has `tokenEnvVar` anywhere fails with
`tokenEnvVar is renamed to buildTokenEnvVar`.

Every group also needs a `testTokenEnvVar`, the token its Actors' platform tests run with. It has no default, and a
group without one fails with `testTokenEnvVar is required`. The example below tests with the same token that builds;
[Choose the test token](#choose-the-test-token) covers the other choice. A config that is already grouped only needs
the rename and the test tokens.

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
            "buildTokenEnvVar": "APIFY_TOKEN_MYTEAM",
            "testTokenEnvVar": "APIFY_TOKEN_MYTEAM",
            "actors": [
                { "folder": "actors/web-scraper", "actorFullName": "myteam/web-scraper" },
                { "folder": "actors/email-sender", "actorFullName": "myteam/email-sender" }
            ]
        },
        "partner": {
            "buildTokenEnvVar": "APIFY_TOKEN_PARTNER",
            "testTokenEnvVar": "APIFY_TOKEN_PARTNER",
            "actors": [{ "folder": "actors/partner", "actorFullName": "partner/scraper" }]
        }
    }
}
```

Group the Actors by the token that builds them. The group key is only a label. An Actor can still set its own
`buildTokenEnvVar`, `testTokenEnvVar` or `overrideActorContext`, which replaces the group's. `platformTestsGlob` stays
at the top level.

See [Config file](../README.md#config-file) for every field.

## Choose the test token

Before v1, every platform test ran its Actor with `TESTER_APIFY_TOKEN`. In v1, the tests of each Actor run with the
`testTokenEnvVar` of its group, or its own. The test token decides:

- which account the test runs start in, and whose usage they count against;
- whose runs they show up among;
- which token the Claude investigation workflow needs to read a failed run, see
  [The Claude investigation workflow](#the-claude-investigation-workflow);
- whether server interface tests can run an Actor's PR build.

**Only the owner, or an account with write access to the Actor, can call an Actor's
[server interface](lib.md#testserverinterfaceactoractorfullname-testname-fn-options) on a build other than its default
one, which is what the tests do on a PR.**

### Token permissions

- **`buildTokenEnvVar`** needs a token with full permissions, for now. A token that needs less is planned.
- **`testTokenEnvVar`** depends on the tests:
    - **Server interface tests need a full-permission token**, of the Actor's owner or of an account with write access
      to the Actor. A scoped token can't get write access to an Actor on its own, so a scoped token makes these tests
      fail on a PR.
    - **Other tests only need to run the repo's Actors**, so a scoped token with run access to them is enough.

### The owner's token or `TESTER_APIFY_TOKEN`

Testing with the owner's token, the same env var as `buildTokenEnvVar` as in [Convert the config](#convert-the-config),
works for every test, server interface tests included, and the runs start in the owner's account.

To keep the tests running with `TESTER_APIFY_TOKEN`, as before, set it as the `testTokenEnvVar` of every group. That
works for server interface tests only if it is a full-permission token of an account with write access to the Actor.
It can't be set for the whole config at once:

```json
{
    "mode": "grouped",
    "groups": {
        "myteam": {
            "buildTokenEnvVar": "APIFY_TOKEN_MYTEAM",
            "testTokenEnvVar": "TESTER_APIFY_TOKEN",
            "actors": [
                { "folder": "actors/web-scraper", "actorFullName": "myteam/web-scraper" },
                { "folder": "actors/email-sender", "actorFullName": "myteam/email-sender" }
            ]
        },
        "partner": {
            "buildTokenEnvVar": "APIFY_TOKEN_PARTNER",
            "testTokenEnvVar": "TESTER_APIFY_TOKEN",
            "actors": [{ "folder": "actors/partner", "actorFullName": "partner/scraper" }]
        }
    }
}
```

An Actor can set its own `testTokenEnvVar` too, to run only its tests with another token, e.g. the owner's token for an
Actor with server interface tests in a group tested with `TESTER_APIFY_TOKEN`. Pass `TESTER_APIFY_TOKEN` inside
`CONFIG_SECRETS` then, see [Switch the workflows](#switch-the-workflows).

## Switch the workflows

In every workflow that calls this repository's workflows, change `@workflows-v0` to `@workflows-v1`. The workflow
inputs are unchanged.

The workflows read the Apify tokens only from the `CONFIG_SECRETS` secret, one JSON object with an entry per name the
config uses as a `buildTokenEnvVar` or `testTokenEnvVar`. Before v1, internal repositories could pass all their
secrets with `secrets: inherit` instead. In v1 that no longer passes the tokens, and GitHub doesn't let a job inherit
its secrets and list `CONFIG_SECRETS` too, so every job lists its secrets by name.

The PR and scheduled test workflows no longer take `TESTER_APIFY_TOKEN`: the tests run each Actor with its own test
token, its `testTokenEnvVar`.

Remove `TESTER_APIFY_TOKEN` from the `secrets:` you pass to `public_pr-build-test.yaml` and
`public_platform-tests.yaml`. A reusable workflow refuses a secret it doesn't declare, so leaving it in fails the
workflow. Pass the test tokens in `CONFIG_SECRETS`, like the build tokens. A job with `secrets: inherit` gets the same
`secrets:` block as the one after.

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
            # One entry per token the config names: each `buildTokenEnvVar` and `testTokenEnvVar`
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

`public_pr-build-test.yaml` already takes `CONFIG_SECRETS` for the builds. Drop `TESTER_APIFY_TOKEN` there, and make
sure `CONFIG_SECRETS` also holds any `testTokenEnvVar` that differs from the build tokens. If the tests keep running
with `TESTER_APIFY_TOKEN`, that means adding `"TESTER_APIFY_TOKEN": "${{ secrets.TESTER_APIFY_TOKEN }}"`.

A token the config names that `CONFIG_SECRETS` leaves out is a warning in the build or test step, and the tests of its
Actors fail with an error naming it.

### The Claude investigation workflow

`public_platform-tests-claude-investigate-and-fix.yaml` still takes `TESTER_APIFY_TOKEN`: there it is the token Claude
reads and re-runs the failed run with. Runs are private to the account that started them, so pass it the token your
tests ran the Actors with, by name:

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

## Update the tests

### Name every Actor by its full name

`testActor` and `testServerInterfaceActor` take the Actor's full name, `owner/name`. A test that names its Actor by its raw ID
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
import { describe, testActor, testServerInterfaceActor, RunTestResult } from 'apify-test-tools';
```

The `it` alias of `testActor` is gone: use `testActor`.

### Server interface tests

The platform renamed standby mode to server interface, and so did the library. `callStandby` is `sendRequestToServer`,
and it takes the request's `path`, `query`, `body`, `method` and `headers`, instead of an `input` that was always the
JSON body of a `POST`:

```ts
// Before
testStandbyActor('myteam/search', 'answers a query', async ({ expect, callStandby }) => {
    const { data, status } = await callStandby({ input: { query: 'test' }, headers: { 'Content-Type': 'application/json' } });
    ...
});

// After
testServerInterfaceActor('myteam/search', 'answers a query', async ({ expect, sendRequestToServer }) => {
    const { data, text, status } = await sendRequestToServer({ body: { query: 'test' } });
    expect(status, text).toBe(200);
    ...
});
```

`testServerInterfaceActor` sends its requests straight to the Actor's server interface URL and selects the PR build
with the `X-Actor-Build` header, instead of creating a temporary task on that build. As a result:

- the report and the test annotations no longer link the server interface runs;
- an object `body` goes as JSON, with `Content-Type: application/json` unless `headers` set another type, so a test
  can drop that header. A string, `Buffer`, `FormData` or other raw body is sent as it is;
- without a `body` the request is a `GET`, so pass `method: 'POST'` for a `POST` without a body;
- it also returns `text`, the raw response text, and `data` is `undefined` when the response isn't JSON. Pass `text` as
  the message of the status assertion to see what came back when it fails.

### `toFinishWith`

| Option                     | Before                                                        | Now                                                                                                      |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `duration`                 | `{ min: 600, max: 600_000 }` by default                       | not checked unless set                                                                                   |
| `requestsRetries`          | `{ max: 3 }` by default                                       | not checked unless set                                                                                   |
| `forbiddenLogs`            | the strings `ReferenceError`, `TypeError` anywhere in the log | strings or regular expressions, per log line. The defaults match a printed error, `TypeError: <message>` |
| `chargedEventCounts`       | an event you don't list must be 0                             | only the events you list are checked                                                                     |
| `strictChargedEventCounts` | –                                                             | `true` brings back: an event you don't list must be 0                                                    |
| `statisticsKeys`           | always `SDK_CRAWLER_STATISTICS_0`                             | every `SDK_CRAWLER_STATISTICS_*` and `CRAWLEE_CRAWLER_STATISTICS_*` record, summed, or the keys you list |

What to change:

- **A test that relied on a duration or retries limit** sets it itself, e.g. `duration: { max: 10 * 60 * 1000 }`.
- **A test that relied on every unlisted event being 0** adds `strictChargedEventCounts: true`.
- **An event listed as never charged** passes now: `'premium': 0` asserts it wasn't charged. Before, an event listed
  but never charged failed.
- **An Actor without crawler statistics, e.g. without a Crawlee crawler, must set `failedRequests: null`**, as before:
  `failedRequests` is checked by default and fails without statistics. It can drop `requestsRetries: null` and
  `duration: null`.
- **An adaptive crawler, a crawler with its own statistics id, or a run with several crawlers** needs no setting:
  the checks read every statistics record of the run and sum them. To read only some, set `statisticsKeys`, e.g.
  `'SDK_CRAWLER_STATISTICS_0'`.
- **Your own `forbiddenLogs`** replace the defaults, as before. A string still matches anywhere in a line, but no
  longer across lines.

`runResult.getStatistics()` reads the statistics the way `toFinishWith` does: summed over every crawler's record, or
only the records you pass, e.g. `getStatistics('SDK_CRAWLER_STATISTICS_1')`. It returns the counters that add up,
`requestsFinished`, `requestsFailed`, `requestsRetries`, `requestRetryHistogram`, `maxRetriesPerRequest` and the total
durations, not the whole record. Read a record's other fields, like its timestamps, from the key-value store with
`runResult.getKeyValueStoreClient()`.

## Running the CLI yourself

Skip this if you only use the workflows.

- `test` needs `apify-test-tools` 1.0.0 or newer installed in the repository, and fails on an older one.
- `test` takes its Actors by full name: each entry on stdin needs `actorFullName`. An entry with only `actorRawId`
  is rejected.
- `test` reads the config for each Actor's test token, so it needs `apify-test-tools.config.json`, and it doesn't use
  `TESTER_APIFY_TOKEN`. Set each Actor's test token env var instead.
- The CLI's help calls it `apify-test-tools`.

## Troubleshooting

| Error or warning                                                                                                               | Fix                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `The repository uses apify-test-tools 0.x, older than 1.0.0, the oldest version this CLI supports`                             | [Update the packages](#update-the-packages)                                                                             |
| `Invalid input: expected "grouped" → at mode`                                                                                  | [Convert the config](#convert-the-config)                                                                               |
| `tokenEnvVar is renamed to buildTokenEnvVar`                                                                                   | [Convert the config](#convert-the-config)                                                                               |
| `testTokenEnvVar is required`                                                                                                  | [Choose the test token](#choose-the-test-token) and add it to every group                                               |
| `Test "…" names its Actor "…", which is not a full name`                                                                       | [Name every Actor by its full name](#name-every-actor-by-its-full-name)                                                 |
| `APIFY_TOKEN_… is not set, so the tests of … will fail.` and `APIFY_TOKEN_… is not set. The tests of Actor "…" need it.`       | Pass it in `CONFIG_SECRETS`, see [Switch the workflows](#switch-the-workflows)                                          |
| `Actor … is not in apify-test-tools.config.json, so its tests will fail.`                                                      | Add the Actor to the config                                                                                             |
| `Failed failedRequests check, expected 0, got no statistics record SDK_CRAWLER_STATISTICS_* or CRAWLEE_CRAWLER_STATISTICS_*.`  | `failedRequests: null` for an Actor without a Crawlee crawler                                                           |
| A `chargedEventCounts` check that passes although an unlisted event was charged                                                | Add `strictChargedEventCounts: true`                                                                                    |
| The workflow fails to start over `TESTER_APIFY_TOKEN`                                                                          | Remove it from the `secrets:` of the PR and scheduled test workflows                                                    |
| ``Warning: … declares … as `buildTokenEnvVar`, but the CONFIG_SECRETS secret has no such entry``, e.g. with `secrets: inherit` | List the secrets by name, with every Apify token in `CONFIG_SECRETS`, see [Switch the workflows](#switch-the-workflows) |
| Claude's investigation can't find the failed run                                                                               | Pass it the token the tests ran with, see [The Claude investigation workflow](#the-claude-investigation-workflow)       |
| `ERR_PACKAGE_PATH_NOT_EXPORTED`                                                                                                | [Import from the package root](#import-from-the-package-root)                                                           |
| `Module '"apify-test-tools"' has no exported member 'testStandbyActor'` or `testStandbyActor is not a function`                | [Rename it to `testServerInterfaceActor`](#server-interface-tests)                                                      |
| `Property 'callStandby' does not exist`, or `callStandby is not a function`                                                    | [Use `sendRequestToServer`](#server-interface-tests)                                                                    |
