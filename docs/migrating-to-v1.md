# Migrating to v1

Version 1.0 of the library and `@workflows-v1` of the workflows go together: the v1 workflows refuse a library older
than 1.0.0, and the 1.0 library expects what the v1 workflows pass it. Migrate a repository in one PR:

1. [Update the packages](#update-the-packages): `apify-test-tools` 1.0, `vitest` 5, and Node.js.
2. [Convert the config](#convert-the-config): add `"mode": "grouped"`, rename `tokenEnvVar` to `buildTokenEnvVar`, and
   add a `testTokenEnvVar` to every group.
3. [Choose the test token](#choose-the-test-token) of every group: the Actor owner's token, or `TESTER_APIFY_TOKEN` as
   before.
4. [Switch the workflows](#switch-the-workflows) to `@workflows-v1` and pass every Apify token in `CONFIG_SECRETS`.
5. [Update the tests](#update-the-tests): full Actor names, imports, server interface tests, and `toFinishWith`.

`@workflows-v0` keeps working with libraries before 1.0, so a repository can stay on it until its PR is merged.
[Troubleshooting](#troubleshooting) maps each error you may hit to the step that fixes it.

## Update the packages

```sh
npm install --save-dev apify-test-tools@^1.0.0 vitest@^5
```

- **Vitest 5 or later** is a peer dependency. If your repository has its own Vitest config or uses Vitest APIs
  directly, follow [Vitest's migration guide](https://vitest.dev/guide/migration).
- **Node.js `^22.12.0`, `^24.0.0`, or `>=26.0.0`** is required, as for Vitest 5. The workflows use Node.js 24.
- **Vitest no longer excludes `dist` by default.** `apify-test-tools test` excludes `**/dist/**` itself, so the
  workflows need nothing. If you compile your tests and run `npx vitest` locally, add `dist/**` to `exclude` in your
  Vitest config, or a compiled copy of each test runs too.

## Convert the config

In `apify-test-tools.config.json`:

1. **Add `"mode": "grouped"` and move the Actors into `groups`.** A config with a top-level `actors` array and no
   `mode` fails with `Invalid input: expected "grouped" → at mode`.
2. **Rename `tokenEnvVar` to `buildTokenEnvVar`**, on groups and on Actors. A config that still has `tokenEnvVar`
   anywhere fails with `tokenEnvVar is renamed to buildTokenEnvVar`.
3. **Add a `testTokenEnvVar` to every group**: the env var with the token the group's platform tests run with. It has
   no default, so a group without one fails with `testTokenEnvVar is required`.

A config that is already grouped only needs steps 2 and 3. The example below tests with the build token.
[Choose the test token](#choose-the-test-token) covers the alternative.

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

Group the Actors by the token that builds them. The group key is only a label. An Actor can set its own
`buildTokenEnvVar`, `testTokenEnvVar`, or `overrideActorContext` to replace the group's. `platformTestsGlob` stays at
the top level. See [Config file](../README.md#config-file) for every field.

## Choose the test token

Before v1, every platform test ran its Actor with `TESTER_APIFY_TOKEN`. In v1, an Actor's tests run with its group's
`testTokenEnvVar`, or its own. The test token decides:

- Which account the test runs start in, and whose usage they count against.
- Which token the Claude investigation workflow needs to read a failed run. See
  [The Claude investigation workflow](#the-claude-investigation-workflow).
- Whether server interface tests can run an Actor's PR build.

### Token permissions

- **`buildTokenEnvVar`** needs a full-permission token, for now. A token that needs less is planned.
- **`testTokenEnvVar`** depends on the tests:
    - **Server interface tests need a full-permission token of the Actor's owner, or of an account with write access
      to the Actor.** Only those can call an Actor's
      [server interface](lib.md#testserverinterfaceactoractorfullname-testname-fn-options) on a build other than its
      default one, which is what the tests do on a PR. A scoped token can't get write access to an Actor on its own, so
      it makes these tests fail on a PR.
    - **Other tests only need to run the repository's Actors**, so a scoped token with run access to them is enough.

### The owner's token or `TESTER_APIFY_TOKEN`

**The owner's token** works for every test, server interface tests included, and the runs start in the owner's
account. Use the same env var as `buildTokenEnvVar`, as in [Convert the config](#convert-the-config).

**`TESTER_APIFY_TOKEN`** keeps the tests running as before. Set it as the `testTokenEnvVar` of every group, since there
is no config-wide setting. Server interface tests then pass only if it's a full-permission token of an account with
write access to the Actor.

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

To test a single Actor with another token, set `testTokenEnvVar` on that Actor. For example, use the owner's token for
an Actor with server interface tests in a group tested with `TESTER_APIFY_TOKEN`.

Whichever tokens you choose, pass each of them in `CONFIG_SECRETS`, `TESTER_APIFY_TOKEN` included. See
[Switch the workflows](#switch-the-workflows).

## Switch the workflows

1. **Change `@workflows-v0` to `@workflows-v1`** in every workflow that calls this repository's workflows. The inputs
   are unchanged.
2. **Remove `TESTER_APIFY_TOKEN` from the `secrets:`** you pass to `public_pr-build-test.yaml` and
   `public_platform-tests.yaml`. They no longer declare it, and GitHub rejects a secret that a reusable workflow doesn't
   declare.
3. **Pass every Apify token in `CONFIG_SECRETS`**: one JSON object with an entry for each name the config uses as a
   `buildTokenEnvVar` or `testTokenEnvVar`. The workflows read Apify tokens only from there.
4. **Replace `secrets: inherit` with secrets listed by name.** It no longer passes the tokens, and GitHub doesn't let a
   job inherit its secrets and list `CONFIG_SECRETS` too.

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

`public_pr-build-test.yaml` already takes `CONFIG_SECRETS` for the builds. Add every `testTokenEnvVar` that isn't a
build token, for example `"TESTER_APIFY_TOKEN": "${{ secrets.TESTER_APIFY_TOKEN }}"` if the tests keep running with it.

A token the config names but `CONFIG_SECRETS` leaves out is a warning in the build or test step, and the tests of its
Actors fail with an error naming it. To pass all of the repository's secrets in `CONFIG_SECRETS` instead of listing
them, see [Secrets](workflows.md#secrets).

### The Claude investigation workflow

`public_platform-tests-claude-investigate-and-fix.yaml` still takes `TESTER_APIFY_TOKEN`: Claude reads and re-runs the
failed run with it. Runs are private to the account that started them, so pass the token your tests ran the Actors
with:

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

`testActor` and `testServerInterfaceActor` take the Actor's full name, `owner/name`. A test that names its Actor by
its raw ID now makes its whole test file fail to load, instead of being skipped:

```ts
// Before
testActor('aYG0l9s7dbB7j3gbS', 'scrapes the start URL', async ({ expect, run }) => { ... });

// After
testActor('myteam/web-scraper', 'scrapes the start URL', async ({ expect, run }) => { ... });
```

### Import from the package root

The package exports only its root. Deep imports such as `apify-test-tools/dist/lib/lib.js` fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. Import everything from `apify-test-tools`:

```ts
import { describe, testActor, testServerInterfaceActor, RunTestResult } from 'apify-test-tools';
```

The `it` alias of `testActor` is gone. Use `testActor`.

### Server interface tests

The platform renamed standby mode to server interface, and so did the library: `testStandbyActor` is now
`testServerInterfaceActor`, and `callStandby` is now `fetchServer`.

`fetchServer(path, init?)` is `fetch` for the Actor's server interface: it resolves `path` against the server interface
URL, takes `fetch`'s own options as `init`, and returns the `Response`. It no longer turns an `input` into the JSON body
of a `POST`, so set the method, body, and content type yourself:

```ts
// Before
testStandbyActor('myteam/search', 'answers a query', async ({ expect, callStandby }) => {
    const { data, status } = await callStandby({ input: { query: 'test' }, headers: { 'Content-Type': 'application/json' } });
    ...
});

// After
testServerInterfaceActor('myteam/search', 'answers a query', async ({ expect, fetchServer }) => {
    const response = await fetchServer('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const data = await response.json();
    ...
});
```

Read the response with `response.json()` or `response.text()`, as with `fetch`. Passing its text as the message of the
status assertion shows what came back when the assertion fails.

`fetchServer` sends requests straight to the Actor's server interface URL, authenticated with the Actor's test token.
It selects the build under test, such as the PR build, with the `X-Actor-Build` header, instead of creating a temporary
task on that build. `init` can set either header itself. The test doesn't start a run, so the report and the test
annotations no longer link server interface runs.

### `toFinishWith`

| Option                     | Before                                                           | Now                                                                                                              |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `duration`                 | `{ min: 600, max: 600_000 }` by default                          | not checked unless set                                                                                           |
| `requestsRetries`          | `{ max: 3 }` by default                                          | not checked unless set                                                                                           |
| `forbiddenLogs`            | the strings `ReferenceError` and `TypeError` anywhere in the log | strings or regular expressions, matched per log line. The defaults match a printed error, `TypeError: <message>` |
| `chargedEventCounts`       | an event you don't list must be 0                                | only the events you list are checked                                                                             |
| `strictChargedEventCounts` | didn't exist                                                     | `true` restores the old check: an event you don't list must be 0                                                 |
| `statisticsKeys`           | always `SDK_CRAWLER_STATISTICS_0`                                | every `SDK_CRAWLER_STATISTICS_*` and `CRAWLEE_CRAWLER_STATISTICS_*` record, summed, or the keys you list         |

What to change:

- **A test that relied on the duration or retries limit** sets it itself, for example
  `duration: { max: 10 * 60 * 1000 }`.
- **A test that relied on every unlisted event being 0** adds `strictChargedEventCounts: true`.
- **An event listed but never charged** now counts as 0, so `'premium': 0` asserts it wasn't charged. Before, it failed.
- **An Actor without crawler statistics**, for example one without a Crawlee crawler, still sets
  `failedRequests: null`. `failedRequests` is checked by default and fails without statistics. The Actor can drop
  `requestsRetries: null` and `duration: null`.
- **An adaptive crawler, a crawler with its own statistics ID, or a run with several crawlers** needs no setting: the
  checks sum every statistics record of the run. To read only some, set `statisticsKeys`, for example
  `'SDK_CRAWLER_STATISTICS_0'`.
- **Your own `forbiddenLogs`** replace the defaults, as before. A string still matches anywhere in a line, but no longer
  across lines.

`runResult.getStatistics(keys?)` reads the statistics the way `toFinishWith` does: summed over every crawler's record,
or only the records you pass, for example `getStatistics('SDK_CRAWLER_STATISTICS_1')`. It returns the summed counters
(`requestsFinished`, `requestsFailed`, `requestsRetries`, `requestRetryHistogram`, `maxRetriesPerRequest`, and the
total durations) and the `keys` it read, not the whole record. Without any record, it returns `undefined`. Read a
record's other fields, like its timestamps, from the key-value store with `runResult.getKeyValueStoreClient()`.

## Running the CLI yourself

Skip this if you only use the workflows.

- `test` needs `apify-test-tools` 1.0.0 or later installed in the repository, and fails with an older one.
- `test` takes Actors by full name: each entry on stdin needs `actorFullName`. An entry with only `actorRawId` is
  rejected.
- `test` reads each Actor's test token env var from `apify-test-tools.config.json`, so it needs the config. It doesn't
  use `TESTER_APIFY_TOKEN`, so set each test token env var instead.
- The report `test` prints is `"version": 2`, and each test's `run` names its Actor by `actorFullName`.
- The CLI rejects unknown flags instead of ignoring them.
- The CLI's help calls it `apify-test-tools`.

## Troubleshooting

| Error or warning                                                                                                              | Fix                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `The repository uses apify-test-tools …, older than 1.0.0, the oldest version this CLI supports`                              | [Update the packages](#update-the-packages)                                                                             |
| `Invalid input: expected "grouped" → at mode`                                                                                 | [Convert the config](#convert-the-config)                                                                               |
| `tokenEnvVar is renamed to buildTokenEnvVar`                                                                                  | [Convert the config](#convert-the-config)                                                                               |
| `testTokenEnvVar is required`                                                                                                 | [Choose the test token](#choose-the-test-token) and add it to every group                                               |
| `Test "…" names its Actor "…", which is not a full name`                                                                      | [Name every Actor by its full name](#name-every-actor-by-its-full-name)                                                 |
| `… is not set, so the tests of … will fail.` or `… is not set. The tests of Actor "…" need it.`                               | Pass the token in `CONFIG_SECRETS`. See [Switch the workflows](#switch-the-workflows)                                   |
| `Actor … is not in apify-test-tools.config.json, so its tests will fail.`                                                     | Add the Actor to the config                                                                                             |
| `Failed failedRequests check, expected 0, got no statistics record SDK_CRAWLER_STATISTICS_* or CRAWLEE_CRAWLER_STATISTICS_*.` | Set `failedRequests: null` for an Actor without a Crawlee crawler                                                       |
| A `chargedEventCounts` check passes although an unlisted event was charged                                                    | Add `strictChargedEventCounts: true`                                                                                    |
| `Invalid secret, TESTER_APIFY_TOKEN is not defined in the referenced workflow`                                                | Remove it from the `secrets:` of the PR and scheduled test workflows                                                    |
| ``Warning: … declares … as `…`, but the CONFIG_SECRETS secret has no such entry``, for example with `secrets: inherit`        | List the secrets by name, with every Apify token in `CONFIG_SECRETS`. See [Switch the workflows](#switch-the-workflows) |
| Claude's investigation can't find the failed run                                                                              | Pass it the token the tests ran with. See [The Claude investigation workflow](#the-claude-investigation-workflow)       |
| `ERR_PACKAGE_PATH_NOT_EXPORTED`                                                                                               | [Import from the package root](#import-from-the-package-root)                                                           |
| `Module '"apify-test-tools"' has no exported member 'testStandbyActor'` or `testStandbyActor is not a function`               | [Rename it to `testServerInterfaceActor`](#server-interface-tests)                                                      |
| `Property 'callStandby' does not exist` or `callStandby is not a function`                                                    | [Use `fetchServer`](#server-interface-tests)                                                                            |
