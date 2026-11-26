# Vitest library API

```ts
import { describe, testActor, testStandbyActor, RunTestResult, ExpectStatic } from 'apify-test-tools';
```

Requires `vitest` 5 or later as a peer dependency.

## Environment variables

The library reads these when the test file is loaded:

| Variable       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTOR_BUILDS` | JSON array of Actors to test, e.g. the builds the CLI's [`build`](cli.md#building-actors-build) and [`build-from-local`](cli.md#build-from-local-source-build-from-local) print. Only tests of Actors listed here run, against the listed build, or the default build for an Actor listed without one. Each entry names the env var holding the token its tests run with, see below. Without any Actors, every `describe` block is skipped, so a plain `npm test` stays unaffected. |

`ACTOR_BUILDS` entries look like this, and are matched to tests by `actorFullName`. Without `buildNumber`, the Actor's
tests run on its default build:

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

The tests of an Actor start runs and read their data with the token in the environment variable `testTokenEnvVar`
names. [`test`](cli.md#running-tests-test) fills it in from the Actor's `testTokenEnvVar` in
`apify-test-tools.config.json`, which is its `tokenEnvVar` unless the config names another. An Actor listed without
one, or whose variable isn't set, fails its own tests, and the other Actors' tests still run.

## `describe(name, fn, options?)`

Same as vitest's `describe`, but skipped unless `ACTOR_BUILDS` lists any Actors. Its tests
run concurrently by default. Use it instead of vitest's `describe` for platform tests.

## `testActor(actorFullName, testName, fn, options?)`

Registers a test for an Actor. `actorFullName` is the Actor's full name, `owner/name`. Anything else, like a raw
Actor ID, throws, so the test file fails to load instead of the test being skipped. The test only runs when the Actor
is in `ACTOR_BUILDS`. Its name is `<actorFullName>: <testName>`.

`fn` gets the vitest test context, with `expect` extended by the [custom matchers](#custom-matchers), a `run`
function, and `apifyClient`: an `ApifyClient` with the token the Actor's tests run with, e.g. to read storages the run
left elsewhere. Use it rather than a client of your own, whose token may not see the runs.

`expect` is soft: a failed assertion marks the test as failed but the test keeps going, so one run reports every
failed check at once. Use `expect.hard(...)` for an assertion that must stop the test, e.g. before indexing into a
list that may be empty.

```ts
import { describe, testActor } from 'apify-test-tools';

describe('test', () => {
    testActor('john.doe/my-actor', 'actor test 1', async ({ expect, run }) => {
        const runResult = await run({ input });

        // your checks
    });

    testActor('john.doe/my-actor', 'actor test 2', async ({ expect, run }) => {
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
    'john.doe/my-actor',
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
testActor('john.doe/my-actor', 'with prefilled input', async ({ expect, run }) => {
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
testActor('john.doe/my-actor', 'validate existing run', async ({ expect, run }) => {
    const runResult = await run({ runId: 'some-run-id' });
    await expect(runResult).toFinishWith({ datasetItemCount: 100 });
});
```

## `testStandbyActor(actorFullName, testName, fn, options?)`

Same as `testActor`, for Actors in standby mode. Instead of `run`, `fn` gets `callStandby`, which sends a
`POST` request with `input` as the JSON body directly to the Actor's standby URL, plus `path`. It sends
`Content-Type: application/json` unless `headers` set another type. When `ACTOR_BUILDS` lists a build for the Actor,
as on a PR, the request selects it with the `X-Actor-Build` header. Otherwise, as in the scheduled platform tests, it
sends no header and the platform serves the Actor's configured standby build. It returns
`{ data, body, status, headers }`, where `body` is the raw response text and `data` is `body` parsed as JSON, or
`undefined` when the response isn't JSON, e.g. an HTML error page. Pass `body` as the message of the status assertion
to see what came back when it fails. `fn` gets `apifyClient` too.

Only the Actor's owner, or an account with write access to it, can select a build with `X-Actor-Build`. The tests run
with the owner's token by default; if you point `testTokenEnvVar` at another account, give it write access to the
Actor, or its standby tests can only run on the default build.

```ts
import { describe, testStandbyActor } from 'apify-test-tools';

describe('standby tests', () => {
    testStandbyActor('john.doe/my-actor', 'standby request', async ({ expect, callStandby }) => {
        const { data, body, status } = await callStandby({
            input: { query: 'test' },
            path: '/search',
        });

        expect(status, body).toBe(200);
        expect(data.results).toBeNonEmptyArray();
    });
});
```

It fails if the Actor doesn't support standby mode.

## `RunTestResult`

What `run` returns. Every getter fetches its data on the first call and returns the same result afterwards, so you
can call them freely.

| Member                     | Returns                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `id`                       | The run ID                                                                                                      |
| `status`                   | The run status when it finished                                                                                 |
| `getDataset<T>()`          | `{ items: T[] }`, every item of the default dataset                                                             |
| `getLog()`                 | The run log as a string                                                                                         |
| `getStatistics(key?)`      | The crawler statistics from the record `key`, by default `SDK_CRAWLER_STATISTICS_0`, or `undefined` without one |
| `getInput<T>()`            | The `INPUT` record of the default key-value store                                                               |
| `getKeyValueStoreClient()` | An `apify-client` client for the default key-value store                                                        |
| `getRunInfo()`             | The run object, fetched again so it reflects changes after the run finished                                     |

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

Validates the common run properties in a single call and reports every failed check at once. Only
`datasetItemCount` is required. Numeric checks take an exact number or a range: `{ min }`, `{ max }` or
`{ min, max }`. Set a check with a default to `null` to skip it.

| Option                     | Default                                   | Checks                                                                                                                        |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `datasetItemCount`         | required                                  | Number of items in the default dataset                                                                                        |
| `status`                   | `'SUCCEEDED'`                             | Run status                                                                                                                    |
| `failedRequests`           | `0`                                       | Failed requests in the crawler statistics                                                                                     |
| `forbiddenLogs`            | `[/\bReferenceError: /, /\bTypeError: /]` | Strings that no log line may contain, or regular expressions that no log line may match. A failure quotes the offending lines |
| `duration`                 | not checked                               | Run duration in milliseconds                                                                                                  |
| `requestsRetries`          | not checked                               | Request retries in the crawler statistics, over all requests                                                                  |
| `maxRetriesPerRequest`     | not checked                               | The most retries any single request needed                                                                                    |
| `chargedEventCounts`       | not checked                               | Pay-per-event counts, per event name. Only the events listed are checked, and an event that was never charged counts as 0     |
| `strictChargedEventCounts` | `false`                                   | Also fail on any charged event that `chargedEventCounts` doesn't list                                                         |
| `statisticsKeys`           | `'SDK_CRAWLER_STATISTICS_0'`              | The key-value store record, or records, with the crawler statistics                                                           |

The default `forbiddenLogs` match a `ReferenceError` or `TypeError` the way JavaScript prints one, `TypeError: <message>`,
not the word in prose or in a longer name. Your own `forbiddenLogs` replace them.

`failedRequests`, `requestsRetries` and `maxRetriesPerRequest` read the crawler statistics, which a Crawlee crawler
persists in the record `SDK_CRAWLER_STATISTICS_<id>`: `0` for the first crawler of a run, or the id its statistics were
given. Give `statisticsKeys` the record of another crawler, or the records of every crawler of a run with several, e.g.
an adaptive crawler: the checks then read their sum. A record that doesn't exist fails those checks, so set
`failedRequests: null` for an Actor that doesn't use a Crawlee crawler.

```ts
await expect(runResult).toFinishWith({
    datasetItemCount: { min: 80, max: 120 },
    duration: { max: 30 * 60 * 1000 },
    statisticsKeys: ['SDK_CRAWLER_STATISTICS_0', 'SDK_CRAWLER_STATISTICS_1'],
    chargedEventCounts: {
        'actor-start': 1,
        'place-scraped': { min: 80, max: 120 },
    },
    strictChargedEventCounts: true,
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

**Against the current default builds.** Enough when you only change the tests. List the Actors with
[`get-actor-configs`](cli.md#listing-actors-get-actor-configs), all of them or a few with `--actors`, and pass them to
[`test`](cli.md#running-tests-test), which tests each on its default build:

```bash
npx apify-test-tools get-actor-configs --actors john.doe/my-actor | APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools test
```

This also runs a test that reuses an existing run with [`runId`](#testing-an-existing-run), as long as its Actor is
listed.

**Against builds of your changes.** Build the Actors with the CLI, either from local files with
[`build-from-local`](cli.md#build-from-local-source-build-from-local) or from a pushed branch with
[`build`](cli.md#building-actors-build), and pass the output to [`test`](cli.md#running-tests-test):

```bash
APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools build-from-local --actors john.doe/my-actor > builds.json

APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools test < builds.json
```

`test` passes the builds to vitest as `ACTOR_BUILDS`, with each Actor's `testTokenEnvVar`. To run plain vitest, add
`testTokenEnvVar` to each build yourself:
`ACTOR_BUILDS='[{"actorFullName":"john.doe/my-actor","testTokenEnvVar":"APIFY_TOKEN_JOHN_DOE"}]' APIFY_TOKEN_JOHN_DOE=<token> npx vitest run test/platform`.

You can change the tests and re-run them against the same builds.

The same token builds and tests an Actor unless the config names a `testTokenEnvVar`. To run only some tests, pass a specific file instead of `test/platform`, or filter by
name with vitest's `-t <name>` when running vitest directly. See [Running locally](cli.md#running-locally) for the full flow.
