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

## Differences in writing tests

---

### Test structure

To run the tests concurrently, we had to start the run outside of `it` and then call `await` inside. This is now no longer needed and everything can be inside `it` aka `testActor`.

Before:

```ts
({ it, xit, run, expect, expectAsync, input, describe }: TestSpecInputs) => {
		describe('test', () => {
				{
		        const runPromise = run({ actorId, input })
						it('actor test 1', async () => {
						    const runResult = await runPromise;

						    // your checks
						});
				}

				{
		        const runPromise = run({ actorId, input })
						it('actor test 2', async () => {
						    const runResult = await runPromise;

						    // your checks
						});
				}
		});
})
```

After:

```ts
import { describe, testActor } from 'apify-test-tools';

describe('test', () => {
		testActor(actorId, 'actor test 1', async ({ expect, run }) => {
				const runResult = await run({ input })

				// your checks
		)};

		testActor(actorId, 'actor test 2', async ({ expect, run }) => {
				const runResult = await run({ input })

				// your checks
		)};
})
```

`testActor` extends `expect` with couple of custom matchers (e.g. `toFinishWith`) and provides `run` function call the correct actor, based on it’s first parameter

---

### Validating basic run attributes

Before:

```ts
await expectAsync(runResult).toHaveStatus('SUCCEEDED');

await expectAsync(runResult).withLog((log) => {
    expect(log).not.toContain('ReferenceError');
    expect(log).not.toContain('TypeError');
});

await expectAsync(runResult).withStatistics((stats) => {
    expect(stats.requestsRetries).withContext(runResult.format('Request retries')).toBeLessThan(3);
    expect(stats.crawlerRuntimeMillis).withContext(runResult.format('Run time')).toBeWithinRange(600, 600_000);
});

await expectAsync(runResult).withDataset(({ dataset }) => {
    expect(dataset.items?.length).withContext(runResult.format('Dataset cleanItemCount')).toBe(100);
});
```

After:

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

Before:

```ts
expect(place.title).withContext(runResult.format(`London Eye's title`)).toEqual('lastminute.com London Eye');
```

After:

```ts
expect(place.title, `London Eye's title`).toEqual('lastminute.com London Eye');
```

---

### Custom validation functions

You can now create your own functions wrapping a common validation logic in e.g. `test/platform/utils.ts` and import it in test files.

```ts
import { ExpectStatic } from 'apify-test-tools'

export const validateItem = (expect: ExpectStatic, item: any) {
		expect(item.title, 'Item title').toBeString();
}
```
