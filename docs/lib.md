# Vitest library API

```ts
import { describe, testActor, testServerInterfaceActor, RunTestResult, ExpectStatic } from 'apify-test-tools';
```

Requires `vitest` 5 or later as a peer dependency.

## Environment variables

The library reads `ACTOR_BUILDS` when a test file loads: a JSON array of the Actors to test. A test runs only when its
Actor is listed there. [`test`](cli.md#running-tests-test) sets it from its input. Without any Actors, every
`describe` block is skipped, so a plain `npm test` is unaffected. A value that isn't a JSON array fails the test file.

```json
[
    {
        "actorFullName": "john.doe/my-actor",
        "buildId": "...",
        "buildNumber": "1.2.3",
        "testTokenEnvVar": "APIFY_TOKEN_JOHN_DOE"
    }
]
```

| Field             | Description                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `actorFullName`   | The Actor's full name, `owner/name`. Tests are matched to entries by it                           |
| `buildNumber`     | The build to test. Without it, the Actor's tests run on its default build                         |
| `buildId`         | The build whose input schema [`prefilledInput`](#runoptions) reads. Without it, the default build |
| `testTokenEnvVar` | Name of the environment variable holding the token the Actor's tests run with                     |

`test` fills in `testTokenEnvVar` from the Actor's `testTokenEnvVar` in `apify-test-tools.config.json`. If an entry has
no `testTokenEnvVar`, or the variable isn't set, that Actor's tests fail. The other Actors' tests still run.

## `describe(name, fn, options?)`

Vitest's `describe`, skipped unless `ACTOR_BUILDS` lists at least one Actor. Its tests run concurrently by default. Use
it instead of Vitest's `describe` for platform tests.

## `testActor(actorFullName, testName, fn, options?)`

Registers a test named `<actorFullName>: <testName>`. It runs only when `ACTOR_BUILDS` lists the Actor.
`actorFullName` must be the Actor's full name, `owner/name`. Anything else, such as an Actor ID, throws, so the test
file fails to load instead of the test being skipped without a word.

`fn` gets the Vitest test context with:

- `expect`, extended with the [custom matchers](#custom-matchers).
- `run`, which runs the Actor, see [`run(options)`](#runoptions).
- `apifyClient`, an `ApifyClient` with the Actor's test token, e.g. to read storages the run left elsewhere. Use it
  rather than a client of your own, whose token may not see the runs.

`expect` is soft: a failed assertion marks the test as failed, but the test continues, so one run reports every failed
check. Use `expect.hard(...)` for an assertion that must stop the test, e.g. before indexing into a list that may be
empty.

```ts
import { describe, testActor } from 'apify-test-tools';

describe('my-actor', () => {
    testActor('john.doe/my-actor', 'first test', async ({ expect, run }) => {
        const runResult = await run({ input });

        // your checks
    });

    testActor('john.doe/my-actor', 'second test', async ({ expect, run }) => {
        const runResult = await run({ input });

        // your checks
    });
});
```

### Test options

The fourth argument takes Vitest's test options. These defaults differ from Vitest's:

| Option       | Default |
| ------------ | ------- |
| `timeout`    | 1 hour  |
| `retry`      | `1`     |
| `concurrent` | `true`  |

```ts
testActor(
    'john.doe/my-actor',
    'slow test',
    async ({ expect, run }) => {
        const runResult = await run({ input });
        await expect(runResult).toFinishWith({ datasetItemCount: 100 });
    },
    {
        timeout: 2 * 60 * 60 * 1000, // 2 hours
        retry: 3,
    },
);
```

### `run(options)`

Starts the Actor, waits for the run to finish, and returns a [`RunTestResult`](#runtestresult). It runs the
`buildNumber` that `ACTOR_BUILDS` lists for the Actor, or its default build without one. It then waits 20 seconds for
the run's dataset and statistics to sync, since the platform is eventually consistent. The run's Console link is added
to the test as a Vitest annotation.

| Option           | Description                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`          | Actor input                                                                                                                                                                                                                                                     |
| `prefilledInput` | When `true`, `input` is merged on top of the prefilled values from the input schema of the build under test                                                                                                                                                     |
| `options`        | [Actor call options](https://docs.apify.com/api/client/js/reference/interface/ActorCallOptions), such as `memory`. `timeout` is in seconds and defaults to the Actor's default run timeout, capped at 59 minutes, so the run finishes before the test times out |
| `runId`          | Don't start a run. Return this existing run instead, without the 20-second wait. Every other option is ignored                                                                                                                                                  |

#### Using prefilled input

```ts
testActor('john.doe/my-actor', 'with prefilled input', async ({ expect, run }) => {
    const runResult = await run({
        prefilledInput: true,
        input: { maxItems: 10 }, // merged on top of the prefilled input
    });
    await expect(runResult).toFinishWith({ datasetItemCount: 10 });
});
```

#### Testing an existing run

Useful for iterating on a test's checks without waiting for a new run:

```ts
testActor('john.doe/my-actor', 'validate existing run', async ({ expect, run }) => {
    const runResult = await run({ runId: 'some-run-id' });
    await expect(runResult).toFinishWith({ datasetItemCount: 100 });
});
```

## `testServerInterfaceActor(actorFullName, testName, fn, options?)`

Like `testActor`, for an Actor's server interface (formerly standby mode). Instead of `run`, `fn` gets
`fetchServer(path, init?)`. It gets `expect` and `apifyClient` as in `testActor`. The test fails if the Actor has no
server interface.

`fetchServer` is [`fetch`](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch) for the Actor's server
interface:

- `path` is appended to the server interface's URL and can include a query string, e.g. `/search?q=shoes`. It defaults
  to `/`.
- `init` takes the same options as `fetch`: `method`, `headers`, `body`, `signal`, and the rest.
- It returns the `Response`, and doesn't throw on an error status.

It adds two headers, unless `init` sets them:

- `Authorization` with the Actor's test token.
- `X-Actor-Build` with the `buildNumber` that `ACTOR_BUILDS` lists for the Actor, e.g. the build of a PR. Without one,
  as in scheduled tests on the default build, it sends no `X-Actor-Build`, and the platform serves the Actor's
  configured server interface build. A test that sets its own `X-Actor-Build` runs against that build instead.

**Server interface tests need a full-permission test token.** Only the Actor's owner, or an account with write access
to it, can select a build with `X-Actor-Build`, and a scoped token can't get write access to an Actor on its own. Point
the Actor's `testTokenEnvVar` at a full-permission token of such an account, e.g. the same token as its
`buildTokenEnvVar`, or its tests fail on a PR. See [Token permissions](../README.md#token-permissions).

```ts
import { describe, testServerInterfaceActor } from 'apify-test-tools';

describe('server interface tests', () => {
    testServerInterfaceActor('john.doe/my-actor', 'search request', async ({ expect, fetchServer }) => {
        const response = await fetchServer('/search?limit=10', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'test' }),
        });

        // With the response text as the message, a wrong status shows what came back
        expect(response.status, await response.clone().text()).toBe(200);
        const data = await response.json();
        expect(data.results).toBeNonEmptyArray();
    });

    testServerInterfaceActor('john.doe/my-actor', 'health check', async ({ expect, fetchServer }) => {
        const response = await fetchServer('/health');
        expect(response.ok).toBe(true);
    });
});
```

## `RunTestResult`

What `run` returns. Each method fetches its data on the first call and reuses it afterwards, so you can call them
freely.

| Member                     | Returns                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | The run ID                                                                                                                   |
| `status`                   | The run status when it finished                                                                                              |
| `getDataset<T>()`          | `{ items: T[] }`, every item of the default dataset                                                                          |
| `getLog()`                 | The run log as a string                                                                                                      |
| `getStatistics(keys?)`     | The crawler statistics, summed over every crawler, or `undefined` without any. See [Crawler statistics](#crawler-statistics) |
| `getInput<T>()`            | The `INPUT` record of the default key-value store                                                                            |
| `getKeyValueStoreClient()` | An `apify-client` client for the default key-value store                                                                     |
| `getRunInfo()`             | The run object, fetched again, so it reflects changes made after the run finished                                            |

```ts
testActor('john.doe/my-actor', 'check dataset items', async ({ expect, run }) => {
    const runResult = await run({ input });

    const { items } = await runResult.getDataset();
    expect(items[0].title).toBeNonEmptyString();

    const log = await runResult.getLog();
    expect(log).toContain('Crawl finished');

    const stats = await runResult.getStatistics();
    expect(stats?.requestsFinished).toBeGreaterThan(0);

    const kvs = runResult.getKeyValueStoreClient();
    const record = await kvs.getRecord('OUTPUT');

    const runInfo = await runResult.getRunInfo();
});
```

## `toFinishWith(options)`

Checks the common run properties in one call and reports every failed check at once. Only `datasetItemCount` is
required. `datasetItemCount`, `duration`, `failedRequests`, `requestsRetries`, and each `chargedEventCounts` value take
an exact number or a range: `{ min }`, `{ max }`, or `{ min, max }`.

| Option                     | Default                                   | Checks                                                                                                                                                                 |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `datasetItemCount`         | required                                  | Number of items in the default dataset                                                                                                                                 |
| `status`                   | `'SUCCEEDED'`                             | Run status                                                                                                                                                             |
| `failedRequests`           | `0`                                       | Failed requests in the crawler statistics. **Set it to `null` for an Actor without crawler statistics**, or the check fails                                            |
| `forbiddenLogs`            | `[/\bReferenceError: /, /\bTypeError: /]` | Strings no log line may contain, or regular expressions no log line may match. A failure quotes up to three offending lines. `[]` turns the check off                  |
| `duration`                 | not checked                               | Run duration in milliseconds                                                                                                                                           |
| `requestsRetries`          | not checked                               | Request retries over all requests, from the crawler statistics                                                                                                         |
| `maxRetriesPerRequest`     | not checked                               | A number: the most retries any single request may have needed, from the crawler statistics                                                                             |
| `chargedEventCounts`       | not checked                               | Pay-per-event counts by event name. Only the listed events are checked, and an event that was never charged counts as `0`                                              |
| `strictChargedEventCounts` | `false`                                   | With `chargedEventCounts`, also fail on any charged event it doesn't list                                                                                              |
| `statisticsKeys`           | every crawler's                           | The key-value store record, or records, with the crawler statistics. By default, every record starting with `SDK_CRAWLER_STATISTICS_` or `CRAWLEE_CRAWLER_STATISTICS_` |

`duration`, `failedRequests`, `requestsRetries`, and `maxRetriesPerRequest` take `null` to skip the check.

The default `forbiddenLogs` match a `ReferenceError` or `TypeError` as JavaScript prints one (`TypeError: <message>`),
not the word in prose or in a longer name. Your own `forbiddenLogs` replace the defaults.

### Crawler statistics

`failedRequests`, `requestsRetries`, and `maxRetriesPerRequest` read the crawler statistics. A Crawlee crawler persists
them in the record `SDK_CRAWLER_STATISTICS_<id>` or `CRAWLEE_CRAWLER_STATISTICS_<id>`, where `<id>` is `0` for a run's
first crawler, or the ID its statistics were given. By default, the checks sum every such record of the run, found by
listing the first 1,000 keys under each prefix. A run with several crawlers, e.g. an adaptive crawler, needs no
setting. Set `statisticsKeys` to read only some records, e.g. one crawler's out of several. If a record it names
doesn't exist, those checks fail.

`runResult.getStatistics(keys?)` reads the same records: every crawler's by default, or only the `keys` given (a string
or an array). It returns the counters summed across them: `requestsFinished`, `requestsFailed`, `requestsRetries`,
`requestRetryHistogram`, `maxRetriesPerRequest`, `requestTotalFinishedDurationMillis`, and
`requestTotalFailedDurationMillis`, plus `keys`, the records it summed. It returns `undefined` when the run has no
statistics record, and throws a `MissingStatisticsError` when a key you gave doesn't exist. To read a record's other
fields, like its timestamps, use `getKeyValueStoreClient()`.

**An Actor without crawler statistics, such as one without a Crawlee crawler, must set `failedRequests: null`.**
`failedRequests` is checked by default, and a run without any statistics record fails it with
`got no statistics record SDK_CRAWLER_STATISTICS_* or CRAWLEE_CRAWLER_STATISTICS_*`. With `null`, and no other check
that needs them, the statistics aren't read at all:

```ts
await expect(runResult).toFinishWith({ datasetItemCount: 1, failedRequests: null });
```

```ts
await expect(runResult).toFinishWith({
    datasetItemCount: { min: 80, max: 120 },
    duration: { max: 30 * 60 * 1000 },
    // Only the first crawler's statistics, instead of every crawler's
    statisticsKeys: 'SDK_CRAWLER_STATISTICS_0',
    chargedEventCounts: {
        'actor-start': 1,
        'place-scraped': { min: 80, max: 120 },
    },
    strictChargedEventCounts: true,
});
```

## Custom matchers

`expect` in `testActor` and `testServerInterfaceActor` is extended with:

- `toBeArray()`, `toBeEmptyArray()`, `toBeNonEmptyArray()`
- `toBeString()`, `toBeNonEmptyString()`, `toStartWith(prefix)`
- `toBeNumber()`, `toBeWholeNumber()`, `toBeWithinRange(min, max)` (inclusive)
- `toBeBoolean()`, `toBeTrue()`, `toBeFalse()`
- `toBeObject()`, `toBeNonEmptyObject()`
- [`toFinishWith(options)`](#tofinishwithoptions)

Pass a message as the second argument of `expect` to say what failed:

```ts
expect(place.title, `London Eye's title`).toEqual('lastminute.com London Eye');
```

### Custom validation functions

Put shared checks in your own functions, e.g. in `test/platform/utils.ts`, and pass them `expect`. Type it as
`ExpectStatic` so the custom matchers type-check:

```ts
import { ExpectStatic } from 'apify-test-tools';

export const validateItem = (expect: ExpectStatic, item: any) => {
    expect(item.title, 'Item title').toBeString();
};
```

## Running tests locally

Run every command from the root of the Actor repository.

**Against the current default builds.** Enough when you only change the tests. List the Actors with
[`get-actor-configs`](cli.md#listing-actors-get-actor-configs), all of them or a few with `--actors`, and pass them to
[`test`](cli.md#running-tests-test), which tests each on its default build:

```bash
npx apify-test-tools get-actor-configs --actors john.doe/my-actor | APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools test
```

This also runs tests that reuse an existing run with [`runId`](#testing-an-existing-run), as long as their Actor is
listed.

**Against builds of your changes.** Build the Actors from local files with
[`build-from-local`](cli.md#build-from-local-source-build-from-local), or from a pushed branch with
[`build`](cli.md#building-actors-build), and pass the output to `test`. You can change the tests and re-run them
against the same builds.

```bash
APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools build-from-local --actors john.doe/my-actor > builds.json

APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools test < builds.json
```

To run only some test files, pass `--test-files-glob` to `test`. `test` rejects any other flag, so to filter tests by
name with Vitest's `-t`, run Vitest directly. Set `ACTOR_BUILDS` yourself then, with each Actor's `testTokenEnvVar`,
which `test` would otherwise add:

```bash
ACTOR_BUILDS='[{"actorFullName":"john.doe/my-actor","testTokenEnvVar":"APIFY_TOKEN_JOHN_DOE"}]' \
    APIFY_TOKEN_JOHN_DOE=<token> npx vitest run test/platform -t 'first test'
```

See [Running locally](cli.md#running-locally) for the full flow.
