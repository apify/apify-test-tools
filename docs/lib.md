# Vitest library API

```ts
import { describe, testActor, testStandbyActor, RunTestResult, ExpectStatic } from 'apify-test-tools';
```

Requires `vitest` `3.2.4` or later as a peer dependency.

## Environment variables

The library reads these when the test file is loaded:

| Variable                 | Description                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TESTER_APIFY_TOKEN`     | Token the tests start runs and read their data with. Without it (and without `RUN_ALL_PLATFORM_TESTS`), every `describe` block is skipped, so a plain `npm test` stays unaffected.                                                            |
| `ACTOR_BUILDS`           | JSON array of builds, as printed by the CLI's [`build`](cli.md#building-actors-build) and [`build-from-local`](cli.md#build-from-local-source-build-from-local). Only tests of Actors listed here run, and they run against the listed build. |
| `RUN_ALL_PLATFORM_TESTS` | Run every test, not only those of Actors in `ACTOR_BUILDS`. Actors missing from `ACTOR_BUILDS` run their default build. The scheduled platform tests set it.                                                                                  |

`ACTOR_BUILDS` entries look like this, and are matched to tests by `actorFullName` or `actorRawId`:

```json
[{ "buildId": "...", "actorRawId": "...", "buildNumber": "1.2.3", "actorFullName": "john.doe/my-actor" }]
```

## `describe(name, fn, options?)`

Same as vitest's `describe`, but skipped unless `TESTER_APIFY_TOKEN` or `RUN_ALL_PLATFORM_TESTS` is set. Its tests
run concurrently by default. Use it instead of vitest's `describe` for platform tests.

## `testActor(actorId, testName, fn, options?)`

Registers a test for an Actor. `actorId` is the Actor's full name (`owner/name`) or its raw platform ID. The test
only runs when the Actor is in `ACTOR_BUILDS` or `RUN_ALL_PLATFORM_TESTS` is set. Its name is
`<actorId>: <testName>`.

`fn` gets the vitest test context, with `expect` extended by the [custom matchers](#custom-matchers), and a `run`
function.

`expect` is soft: a failed assertion marks the test as failed but the test keeps going, so one run reports every
failed check at once. Use `expect.hard(...)` for an assertion that must stop the test, e.g. before indexing into a
list that may be empty.

```ts
import { describe, testActor } from 'apify-test-tools';

describe('test', () => {
    testActor(actorId, 'actor test 1', async ({ expect, run }) => {
        const runResult = await run({ input });

        // your checks
    });

    testActor(actorId, 'actor test 2', async ({ expect, run }) => {
        const runResult = await run({ input });

        // your checks
    });
});
```

### Test options

The fourth argument takes vitest's test options:

| Option       | Default |
| ------------ | ------- |
| `timeout`    | 1 hour  |
| `retry`      | `1`     |
| `concurrent` | `true`  |

```ts
testActor(
    actorId,
    'slow actor test',
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

Starts the Actor, waits for the run to finish, and returns a [`RunTestResult`](#runtestresult). It runs the build
from `ACTOR_BUILDS`, or the Actor's default build when it isn't listed there. Before returning, it waits 20 seconds
for the run's dataset and statistics to sync, since the platform is only eventually consistent. The run's Console
link is added to the test as a vitest annotation.

| Option           | Description                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`          | Actor input                                                                                                                                                                                                                                               |
| `prefilledInput` | When `true`, `input` is merged on top of the Actor's prefilled input                                                                                                                                                                                      |
| `options`        | [Actor call options](https://docs.apify.com/api/client/js/reference/interface/ActorCallOptions) like `memory`. `timeout` is in seconds and defaults to the Actor's default run timeout, at most 59 minutes, so the run finishes before the test times out |
| `runId`          | Don't start a run; return this existing run instead. Every other option is ignored                                                                                                                                                                        |

#### Using prefilled input

```ts
testActor(actorId, 'with prefilled input', async ({ expect, run }) => {
    const runResult = await run({
        prefilledInput: true,
        input: { maxItems: 10 }, // merged on top of the prefilled input
    });
    await expect(runResult).toFinishWith({ datasetItemCount: 10 });
});
```

#### Testing an existing run

Useful for iterating on the checks of a test without waiting for a new run:

```ts
testActor(actorId, 'validate existing run', async ({ expect, run }) => {
    const runResult = await run({ runId: 'some-run-id' });
    await expect(runResult).toFinishWith({ datasetItemCount: 100 });
});
```

## `testStandbyActor(actorId, testName, fn, options?)`

Same as `testActor`, for Actors in standby mode. It creates a temporary task with the build from `ACTOR_BUILDS` (or
the Actor's standby build) and deletes it after the test. Instead of `run`, `fn` gets `callStandby`, which sends a
`POST` request with `input` as the JSON body to the task's standby URL, plus `path`, and returns
`{ data, status, headers }`, where `data` is the parsed JSON response.

```ts
import { describe, testStandbyActor } from 'apify-test-tools';

describe('standby tests', () => {
    testStandbyActor(actorId, 'standby request', async ({ expect, callStandby }) => {
        const { data, status } = await callStandby({
            input: { query: 'test' },
            path: '/search',
            headers: { 'Content-Type': 'application/json' },
        });

        expect(status).toBe(200);
        expect(data.results).toBeNonEmptyArray();
    });
});
```

It fails if the Actor doesn't support standby mode.

## `RunTestResult`

What `run` returns. Every getter fetches its data on the first call and returns the same result afterwards, so you
can call them freely.

| Member                     | Returns                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `id`                       | The run ID                                                                                               |
| `status`                   | The run status when it finished                                                                          |
| `getDataset<T>()`          | `{ items: T[] }`, every item of the default dataset                                                      |
| `getLog()`                 | The run log as a string                                                                                  |
| `getStatistics()`          | The crawler statistics from the `SDK_CRAWLER_STATISTICS_0` record, or `undefined` for non-crawler Actors |
| `getInput<T>()`            | The `INPUT` record of the default key-value store                                                        |
| `getKeyValueStoreClient()` | An `apify-client` client for the default key-value store                                                 |
| `getRunInfo()`             | The run object, fetched again so it reflects changes after the run finished                              |

```ts
testActor(actorId, 'check dataset items', async ({ expect, run }) => {
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

Validates the common run properties in a single call and reports every failed check at once. Only
`datasetItemCount` is required; the rest have defaults. Numeric checks take an exact number or a range: `{ min }`,
`{ max }` or `{ min, max }`. Set a check with a default to `null` to skip it.

| Option                 | Default                           | Checks                                                                                           |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `datasetItemCount`     | required                          | Number of items in the default dataset                                                           |
| `status`               | `'SUCCEEDED'`                     | Run status                                                                                       |
| `duration`             | `{ min: 600, max: 600_000 }`      | Run duration in milliseconds (0.6 s to 10 min)                                                   |
| `failedRequests`       | `0`                               | Failed requests in the crawler statistics                                                        |
| `requestsRetries`      | `{ max: 3 }`                      | Request retries in the crawler statistics                                                        |
| `maxRetriesPerRequest` | `null`                            | The most retries any single request needed                                                       |
| `forbiddenLogs`        | `['ReferenceError', 'TypeError']` | Strings that must not appear in the log                                                          |
| `chargedEventCounts`   | not checked                       | Pay-per-event counts, per event name. An event you omit is expected to have been charged 0 times |

`failedRequests` and `requestsRetries` come from the crawler statistics, so they fail for an Actor that doesn't
write them. Set both to `null` for Actors that don't use a Crawlee crawler.

```ts
await expect(runResult).toFinishWith({
    datasetItemCount: { min: 80, max: 120 },
    duration: { max: 30 * 60 * 1000 },
    chargedEventCounts: {
        'actor-start': 1,
        'place-scraped': { min: 80, max: 120 },
    },
});
```

## Custom matchers

`expect` in `testActor` and `testStandbyActor` is extended with:

- `toBeArray()` / `toBeEmptyArray()` / `toBeNonEmptyArray()`
- `toBeString()` / `toBeNonEmptyString()` / `toStartWith(prefix)`
- `toBeNumber()` / `toBeWholeNumber()` / `toBeWithinRange(min, max)`
- `toBeBoolean()` / `toBeTrue()` / `toBeFalse()`
- `toBeObject()` / `toBeNonEmptyObject()`
- [`toFinishWith(options)`](#tofinishwithoptions)

Pass a message as the second argument of `expect` to say what failed:

```ts
expect(place.title, `London Eye's title`).toEqual('lastminute.com London Eye');
```

### Custom validation functions

Wrap shared checks in your own functions, e.g. in `test/platform/utils.ts`, and pass them `expect`. Use the
`ExpectStatic` type so the custom matchers type-check:

```ts
import { ExpectStatic } from 'apify-test-tools';

export const validateItem = (expect: ExpectStatic, item: any) => {
    expect(item.title, 'Item title').toBeString();
};
```

## Running tests locally

Run every command from the root of the Actor repository.

**Against the current default builds.** Enough when you only change the tests:

```bash
RUN_ALL_PLATFORM_TESTS=1 TESTER_APIFY_TOKEN=<token> npx vitest --run test/platform
```

**Against builds of your changes.** Build the Actors with the CLI, either from local files with
[`build-from-local`](cli.md#build-from-local-source-build-from-local) or from a pushed branch with
[`build`](cli.md#building-actors-build), and pass the output to [`test`](cli.md#running-tests-test):

```bash
APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools build-from-local --actors john.doe/my-actor > builds.json

TESTER_APIFY_TOKEN=<token> npx apify-test-tools test < builds.json
```

`test` passes the builds to vitest as `ACTOR_BUILDS`, so plain vitest works too:
`ACTOR_BUILDS="$(cat builds.json)" TESTER_APIFY_TOKEN=<token> npx vitest run test/platform`.

You can change the tests and re-run them against the same builds.

`TESTER_APIFY_TOKEN` can be the token of any account with enough memory for the runs. To run only some tests, pass a specific file instead of `test/platform`, or filter by
name with `-- -t <name>`. See [Running locally](cli.md#running-locally) for the full flow.
