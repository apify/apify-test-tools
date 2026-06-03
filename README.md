# Apify Test Tools

[Contributing link](CONTRIBUTING.md)

## Getting Started

1. Install the package `npm i -D apify-test-tools`
    - because it uses [annotate](https://vitest.dev/guide/test-context.html#annotate), `vitest` version to be at least `3.2.0`
    - make sure that `target` and `module` in your `tsconfig.json`'s `compilerOptions` are set to `ES2022`
2. create test directories: `mkdir -p test/platform/core`
    - core (hourly) tests should go to `test/platform/core`
    - daily tests should go to `test/platform`
3. setup github worklows TODO

File structure:

```
google-maps
├── actors
└── src
└── test
    ├── unit
    └── platform
        ├── core                  <- Core tests need to be inside core directory
        │   └── core.test.ts
        ├── some.test.ts          <- Other tests can be defined anywhere inside platform directory
        └── some-other.test.ts
```

## Github worklows

There should be 4 GH workflow files in `.github/workflows`.

### `platform-tests-core.yaml`

```yaml
name: Platform tests - Core

on:
    schedule:
        # Runs at the start of every hour
        - cron: '0 * * * *'
    workflow_dispatch:

jobs:
    platformTestsCore:
        uses: apify-store/github-actions-source/.github/workflows/platform-tests.yaml@new_master
        with:
            subtest: core
        secrets: inherit
```

### `platform-tests-daily.yaml`

```yaml
name: Platform tests - Daily

on:
    schedule:
        # Runs at 00:00 UTC every day
        - cron: '0 0 * * *'
    workflow_dispatch:

jobs:
    platformTestsDaily:
        uses: apify-store/github-actions-source/.github/workflows/platform-tests.yaml@new_master
        secrets: inherit
```

### `pr-build-devel-test.yaml`

```yaml
name: PR Test

on:
    pull_request:
        branches: [master]

jobs:
    buildDevelAndTest:
        uses: apify-store/github-actions-source/.github/workflows/pr-build-test.yaml@new_master
        secrets: inherit
```

### `release-latest.yaml`

```yaml
name: Release latest

on:
    push:
        branches: [master]

jobs:
    buildLatest:
        uses: apify-store/github-actions-source/.github/workflows/push-build-latest.yaml@new_master
        secrets: inherit
```

## Writing tests

### Test structure

`testActor` runs the actor and provides extended `expect` and `run` inside the callback.

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

---

### Validating basic run attributes

`toFinishWith` validates common run properties in a single call:

```ts
await expect(runResult).toFinishWith({
    datasetItemCount: 100,
});
```

You can also specify a range:

```ts
await expect(runResult).toFinishWith({
    datasetItemCount: { min: 80, max: 120 },
});
```

Here is full example of what you can validate with `toFinishWith`

```ts
await expect(runResult).toFinishWith({
    // These are default
    status: 'SUCCEEDED',
    duration: {
        min: 600, // 0.6 sec
        max: 600_000, // 10 min
    },
    failedRequests: 0,
    requestsRetries: { max: 3 },
    forbiddenLogs: ['ReferenceError', 'TypeError'],

    // only datasetItemCount is required
    datasetItemCount: { min: 80, max: 120 },

    // optional
    chargedEventCounts: {
        'actor-start': 1,
        'place-scraped': 9,
    },
});
```

---

### Custom validations

```ts
expect(place.title, `London Eye's title`).toEqual('lastminute.com London Eye');
```

---

### Custom validation functions

You can create your own functions wrapping a common validation logic in e.g. `test/platform/utils.ts` and import it in test files.

```ts
import { ExpectStatic } from 'apify-test-tools'

export const validateItem = (expect: ExpectStatic, item: any) {
    expect(item.title, 'Item title').toBeString();
}
```

---

### Test options

You can pass options as the fourth argument to `testActor`:

```ts
testActor(
    actorId,
    'slow actor test',
    async ({ expect, run }) => {
        const runResult = await run({ input });
        await expect(runResult).toFinishWith({ datasetItemCount: 100 });
    },
    {
        timeout: 2 * 60 * 60 * 1000, // 2 hours (default is 1 hour)
        retry: 3, // retry up to 3 times (default is 1)
    },
);
```

---

### Using prefilled input

If the actor has a prefilled input on the platform, you can merge it with your test input:

```ts
testActor(actorId, 'with prefilled input', async ({ expect, run }) => {
    const runResult = await run({
        prefilledInput: true,
        input: { maxItems: 10 }, // merged on top of the prefilled input
    });
    await expect(runResult).toFinishWith({ datasetItemCount: 10 });
});
```

---

### Testing an existing run

You can skip starting a new run and validate an existing one by passing `runId`:

```ts
testActor(actorId, 'validate existing run', async ({ expect, run }) => {
    const runResult = await run({ runId: 'some-run-id' });
    await expect(runResult).toFinishWith({ datasetItemCount: 100 });
});
```

---

### Accessing run data

`RunTestResult` provides methods to access the run's data:

```ts
testActor(actorId, 'check dataset items', async ({ expect, run }) => {
    const runResult = await run({ input });

    // Access dataset items
    const { items } = await runResult.getDataset();
    expect(items[0].title).toBeNonEmptyString();

    // Access run log
    const log = await runResult.getLog();
    expect(log).toContain('Crawl finished');

    // Access crawler statistics
    const stats = await runResult.getStatistics();
    expect(stats?.requestsFinished).toBeGreaterThan(0);

    // Access key-value store
    const kvs = runResult.getKeyValueStoreClient();
    const record = await kvs.getRecord('OUTPUT');

    // Access run info (refreshed from API)
    const runInfo = await runResult.getRunInfo();
});
```

---

### Testing standby actors

Use `testStandbyActor` for actors that support standby mode:

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

---

### Custom matchers

`testActor` extends `expect` with the following custom matchers:

- `toBeArray()` / `toBeEmptyArray()` / `toBeNonEmptyArray()`
- `toBeString()` / `toBeNonEmptyString()` / `toStartWith(prefix)`
- `toBeNumber()` / `toBeWholeNumber()` / `toBeWithinRange(min, max)`
- `toBeBoolean()` / `toBeTrue()` / `toBeFalse()`
- `toBeObject()` / `toBeNonEmptyObject()`
- `toFinishWith(options)` - validates run status, duration, dataset, logs, etc.

## CLI (`apify-test-tools` bin)

The package includes a CLI binary used by CI workflows to build actors, detect changes, and report test results. You can also run it locally for debugging.

### Running locally

The main local flow is: **build** affected actors, then **run tests** against those builds.

`cd` into the actor repository you want to work with (or use `--workspace`).

#### 1. Build affected actors

Requires `APIFY_TOKEN_<USERNAME>` for each actor owner. The username is derived from the actor name — uppercased with non-word chars replaced by `_` (e.g. actor `john.doe/my-actor` needs `APIFY_TOKEN_JOHN_DOE`).

```bash
APIFY_TOKEN_JOHN_DOE=<token> \
GITHUB_WORKSPACE=. \
  npx apify-test-tools build \
    --target-branch origin/master \
    --source-branch HEAD \
    --dry-run
```

Remove `--dry-run` to actually trigger builds. The command outputs a JSON array of build objects to stdout:

```json
[{ "buildId": "...", "actorId": "...", "buildNumber": "...", "actorName": "john.doe/my-actor" }]
```

#### 2. Run tests against the builds

Pass the build output as `ACTOR_BUILDS` and provide `TESTER_APIFY_TOKEN` (the token used to call actors and read results):

```bash
ACTOR_BUILDS='<JSON output from build command>' \
TESTER_APIFY_TOKEN=<token> \
RUN_PLATFORM_TESTS=1 \
  npx vitest --run --maxConcurrency 20 --fileParallelism=true --maxWorkers 100 test/platform
```

#### Full example

```bash
# Build and capture output
BUILDS=$(APIFY_TOKEN_JOHN_DOE=apify_api_xxx \
  GITHUB_WORKSPACE=. \
  npx apify-test-tools build \
    --target-branch origin/master \
    --source-branch HEAD)

# Run tests with the builds
ACTOR_BUILDS="$BUILDS" \
TESTER_APIFY_TOKEN=apify_api_yyy \
RUN_PLATFORM_TESTS=1 \
  npx vitest --run --maxConcurrency 20 --fileParallelism=true --maxWorkers 100 test/platform
```

#### Dev mode

For development on `apify-test-tools` itself, use `tsx` directly:

```bash
GITHUB_WORKSPACE=local-clone tsx bin/main.ts get-actor-configs
```
