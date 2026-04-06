# Apify Test Tools

[Contributing link](CONTRIBUTING.md)

## Getting Started

1. Install the package `npm i -D apify-test-tools`
    - requires [`vitest`](https://vitest.dev/) `>= 3.2.0` (uses [`annotate`](https://vitest.dev/guide/test-context.html#annotate))
    - set `target` and `module` to `ES2022` in your `tsconfig.json` `compilerOptions`
2. Create a test directory: `mkdir -p test/platform`
3. Set up GitHub workflows (see below)

File structure:

```
google-maps
├── actors
├── src
└── test
    ├── unit
    └── platform
        ├── core                  <- Tests that should also run hourly
        │   └── core.test.ts
        ├── some.test.ts
        └── some-other.test.ts
```

## GitHub Workflows

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
            backward_compatible_hourly_dir: core
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

## Writing Tests

### Basic usage

```ts
import { describe, testActor } from 'apify-test-tools';

describe('google-maps', () => {
    testActor(actorId, 'smoke test', async ({ run, expect }) => {
        const result = await run({ input: { query: 'London Eye' } });

        await expect(result).toFinishWith({
            datasetItemCount: { min: 1, max: 10 },
        });
    });
});
```

`testActor` provides a `run` function that calls the actor built in the current CI run, and extends `expect` with custom matchers (e.g. `toFinishWith`).

### Validating run results

```ts
await expect(result).toFinishWith({
    // all fields below are optional and have sensible defaults
    status: 'SUCCEEDED',
    duration: { min: 600, max: 600_000 }, // ms
    failedRequests: 0,
    requestsRetries: { max: 3 },
    forbiddenLogs: ['ReferenceError', 'TypeError'],

    // required — exact number or range
    datasetItemCount: { min: 80, max: 120 },

    // optional — PPE event counts; any omitted event is expected to be 0
    chargedEventCounts: {
        'actor-start': 1,
        'place-scraped': { min: 9 },
    },
});
```

### Shared validation helpers

Create reusable helpers in e.g. `test/platform/utils.ts` and import them in test files:

```ts
import { ExpectStatic } from 'apify-test-tools';

export const validatePlace = (expect: ExpectStatic, place: unknown) => {
    expect(place.title, 'place title').toBeNonEmptyString();
    expect(place.url, 'place url').toBeNonEmptyString();
};
```

## Trigger & Alert Configuration

Tests default to running on `daily` and `pullRequest` triggers, with Slack alerts enabled. Use the `triggers` option on `describe` or `testActor` to override.

### Opting out of a trigger

```ts
// This suite only runs on daily and hourly, never on pull requests
describe({
    name: 'google-maps',
    triggers: { runWhen: { pullRequest: false } },
}, () => { ... });
```

### Running only on specific triggers

```ts
// This test only runs hourly (opt out of daily and pullRequest)
testActor(actorId, {
    name: 'extended smoke',
    triggers: { runWhen: { daily: false, pullRequest: false } },
}, async ({ run, expect }) => { ... });
```

### Inheriting and overriding through the describe hierarchy

`triggers` are merged field-by-field from outer to inner — children only need to override what they want to change:

```ts
describe(
    {
        name: 'google-maps',
        triggers: { runWhen: { pullRequest: false } }, // disable PR runs for the whole suite
    },
    () => {
        testActor(actorId, 'smoke', async ({ run, expect }) => {
            // inherits pullRequest: false from the describe above
        });

        testActor(
            actorId,
            {
                name: 'extended',
                triggers: { runWhen: { daily: false } }, // additionally disable daily
            },
            async ({ run, expect }) => {
                // effective: pullRequest: false, daily: false → runs hourly only
            },
        );
    },
);
```

### Disabling Slack alerts

```ts
describe({
    name: 'experimental',
    triggers: { alerts: { slack: false } },  // failures won't ping Slack
}, () => { ... });
```

### Hourly tests (core directory)

Tests inside the `core/` directory automatically run hourly when the workflow passes `BACKWARD_COMPATIBLE_HOURLY_DIR=core`. No changes needed in test files.

For new tests that should run hourly, opt in explicitly instead:

```ts
testActor(actorId, {
    name: 'smoke',
    triggers: { runWhen: { hourly: true } },
}, async ({ run, expect }) => { ... });
```

### Reading the current trigger at runtime

```ts
import { getCurrentTrigger, TRIGGER_ENV_VAR } from 'apify-test-tools';

// Returns 'hourly' | 'daily' | 'pullRequest' | undefined
const trigger = getCurrentTrigger();
```
