# Apify Test Tools

[Contributing link](CONTRIBUTING.md)

## Getting Started

### 1. Install the package

```bash
npm i -D apify-test-tools
```

- Requires `vitest` version `3.2.0` or later (uses [annotate](https://vitest.dev/guide/test-context.html#annotate))
- Make sure `target` and `module` in your `tsconfig.json`'s `compilerOptions` are set to `ES2022`

### 2. Create the config file

Every repo that uses `apify-test-tools` must have an `apify-test-tools.config.json` file at the root. This file tells the tool which actors live in the repo, how to identify them, and which token to use.

```json
{
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

Each entry has:

| Field                  | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder`               | yes      | Relative path from repo root to the actor's own project directory — the folder that directly contains `.actor/actor.json` (i.e. `<folder>/.actor/actor.json`), the actor's README/CHANGELOG, and its source. Use `"."` for a single-actor repo where `.actor/` is at the root.                                                                                                                                                                                                                          |
| `actorFullName`        | yes      | Full actor identifier in `owner/name` format (e.g. `"apify/web-scraper"`). This is the source of truth for the actor name — the `name` field in `actor.json` is not used.                                                                                                                                                                                                                                                                                                                               |
| `tokenEnvVar`          | yes      | Name of the environment variable holding the Apify API token for this actor. No fallback — if the env var is not set at build time, the build fails.                                                                                                                                                                                                                                                                                                                                                    |
| `overrideActorContext` | no       | Array of paths (relative to repo root) that define which files are relevant to this actor. When set, replaces the `dockerContextDir` from `actor.json` for change detection. Useful when an actor depends on shared packages outside its Docker build context. Entries must not be prefixes of one another (e.g. `["", "code"]` or `["actors", "actors/foo"]` are rejected). The actor's own `folder` is always part of its context — if none of the listed entries reach it, it's added automatically. |

### 3. Set up actor folders

Each actor in the config must have a `.actor/actor.json` file. The `dockerContextDir` field in `actor.json` defines the build context boundary — this is what the tool uses to determine which files can affect the actor's build.

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

### Change detection

When a PR is opened or code is pushed, the tool determines which actors need to be built and tested based on the changed files. For each changed file, for each actor:

1. **Sibling exclusion** — files inside another actor's `folder` are excluded first. This prevents an actor with broad context from being triggered by changes that belong to a sibling actor.
2. **CHANGELOG classification** — a `CHANGELOG.md` file is always `cosmetic` (only triggers a release build, not tests), for every actor, regardless of context or folder. (See [issue #106](https://github.com/apify/apify-test-tools/issues/106).)
3. **Context matching** — the file must fall within one of the actor's context paths (`dockerContextDir` from `actor.json` by default, or `overrideActorContext` from config if set). Files outside every context path are skipped.
4. **Hardcoded ignore list, context-aware** — the file path is first "hoisted" relative to the context path it matched (e.g. a standalone actor's own `.eslintrc` is checked as just `.eslintrc`, not the full repo-root-relative path), then checked against repo-level dev file patterns (`.vscode/`, `.gitignore`, `.husky/`, `.eslintrc`, `eslint.config.mjs`, `.prettierrc`, `.editorconfig`). There's no hardcoded special-casing for legacy `code/`/`shared/` layouts — repos that need those directories treated as top-level must list them explicitly in `overrideActorContext`.
5. **`.dockerignore` filtering** — if a `.dockerignore` exists at the root of the actor's `dockerContextDir`, matching files are ignored. Patterns are resolved relative to `dockerContextDir`, matching Docker's own behavior.
6. **README classification** — a `README.md` file is `cosmetic` (only triggers a release build, not tests) if it lives inside the actor's own `folder`; otherwise it's ignored entirely, since it isn't documentation for this actor.
7. **Cosmetic JSON classification** — `.json` files inside the actor's own `.actor/` directory with only cosmetic schema changes (whitespace, key ordering) only trigger a release build.
8. **Functional** — everything else triggers both build and tests.

### 4. Create test directories

```bash
mkdir -p test/platform/core
```

- Core (hourly) tests go in `test/platform/core`
- Daily tests go anywhere in `test/platform`

### 5. Set up GitHub workflows

See the [GitHub workflows](#github-worklows) section below.

## Github worklows

The reusable workflows live in this repo, alongside the package they call. Reference them at the
`@v1` major tag, never at `@master` — see [Versioning and releases](#versioning-and-releases).

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
        uses: apify/apify-test-tools/.github/workflows/platform-tests.yaml@v1
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
        uses: apify/apify-test-tools/.github/workflows/platform-tests.yaml@v1
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
        uses: apify/apify-test-tools/.github/workflows/pr-build-test.yaml@v1
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
        uses: apify/apify-test-tools/.github/workflows/push-build-latest.yaml@v1
        secrets: inherit
```

### Secrets

Callers pass `secrets: inherit`. The workflows do not turn every inherited secret into job-wide
environment variables, so a secret is only visible to the step that needs it:

| Secret                                                                    | Reaches                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                                                               | dependency install steps only, as both `NPM_TOKEN` and `NODE_AUTH_TOKEN`. Use a read-only token: npm granular tokens can be read-only, classic automation tokens can publish. |
| the Actor tokens named by `tokenEnvVar` in `apify-test-tools.config.json` | the `build`, `release`, and `delete-old-builds` steps only                                                                                                                    |
| `TESTER_APIFY_TOKEN`                                                      | the vitest step only                                                                                                                                                          |
| `SLACK_TOKEN_TESTS_BOT` / `SLACK_TOKEN_RELEASES_BOT`                      | the reporting and release steps only                                                                                                                                          |

The Actor tokens are the one set that cannot be listed in the workflow, because each Actor names its
own token via `tokenEnvVar` in `apify-test-tools.config.json`. Those steps pass
`${{ toJSON(secrets) }}` as `ALL_SECRETS` and run the command through
`.github/scripts/run-with-apify-tokens.mjs`, which reads that same config file to decide which
secrets to pass on:

```yaml
- name: Build
  env:
      ALL_SECRETS: ${{ toJSON(secrets) }}
  run: |
      node "${{ steps.setup.outputs.scripts-path }}/run-with-apify-tokens.mjs" \
        npx apify-test-tools build --target-branch ...
```

The wrapper passes only the tokens the config declares and drops `ALL_SECRETS`, so neither `npx` nor
anything under `node_modules` sees the blob. Nothing is written to `$GITHUB_ENV`, so the tokens stay
inside that one command rather than leaking into later steps. Reading the same file
`apify-test-tools` reads means the two can't drift, and a secret that merely looks like an Actor
token is not passed just because of its name.

A token the config declares but the repo hasn't set is a warning, not a failure: a repo can carry an
Actor whose token isn't configured and still build fine as long as that Actor never changes, and
`apify-test-tools` raises a precise error naming the Actor at the point it actually needs the token.

`scripts-path` comes from the setup action (give the step `id: setup`) and points at this repo's
`.github/scripts/` directory inside the runner's action checkout, so workflows can run these helpers
without checking this repo out again. The caller's workspace holds the caller's repo, not this one.

Two tidier-looking alternatives don't work, so don't reach for them:

- **Exporting to `$GITHUB_ENV`** would let the steps call `npx` directly with no wrapper, but
  `$GITHUB_ENV` applies to every later step in the job. In `pr-build-test` the vitest step runs after
  the build, so it would inherit Actor tokens it has no use for.
- **Returning the tokens as a step output** would be scoped correctly, but the runner refuses to set
  an output whose value contains a registered secret. It logs `Skip output <name> since it may
contain secret` and leaves the output empty, so anything reading it downstream gets nothing.

The `unitTest` job runs static checks and needs `NPM_TOKEN` only. No job runs `npm ci` with Apify or
Slack credentials in scope, so a postinstall script in the dependency tree cannot read them.

## Versioning and releases

The workflows and the npm package live in one repo but ship on their own schedules. Two pointers
decide what a consumer repo actually runs:

| Pointer                                 | What it selects                                | Moves when                                               |
| --------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| the `@v1` tag in `uses:`                | which workflows run                            | a master push, once the version floor below is published |
| `.github/workflows-min-package-version` | oldest `apify-test-tools` the workflows accept | you edit it                                              |

The setup action installs `apify-test-tools@>=<floor>`, which resolves to the newest published stable
— the same thing `@latest` gave before, except a floor that was never released fails with a plain
version error instead of a confusing CLI error deep in a build.

Nothing is coupled that doesn't need to be:

- **Workflow-only change** — merge it. `v1` moves, it goes live, no release needed.
- **Package-only change** — merge it, then cut a release when you want it out. The workflows are
  unchanged, so consumers see nothing until the release lands.
- **A workflow that calls a new CLI feature** — the one case that can break consumers, and the only
  one with any ceremony. Put the package change, the workflow change, and the floor bump in one PR.
  On merge the tag is **held**: the CI job reports that the floor isn't on npm and leaves `v1` where
  it is, so consumers keep running the previous workflows. Cut a stable release, and the tag moves
  on its own. Run **Move major version tag** if you don't want to wait for the next master push.

`v1` moving on every master push means `@v1` is as live as `@master` was — there's no staging step,
just a gate on the package version. What the tag buys you is a `v2` for breaking workflow changes,
so repos migrate one at a time instead of all at once, and a way to roll back by pointing the tag at
an earlier commit. Bump `MAJOR_TAG` in `.github/workflows/_move_major_tag.yaml` to cut `v2`; `v1`
then freezes where it is and keeps working.

### Testing workflow changes

- Point [testing-repo-for-github-actions](https://github.com/apify-store/testing-repo-for-github-actions)
  at your branch (`uses: ...@your-branch`). It has real attached Actors and tests. Because the
  package lives here too, a master push publishes a `beta`, and the lockfile-beta path in the setup
  action installs that exact version — so one branch tests both halves of a change together.
- To change the composite action itself, repoint the `uses:` refs inside the reusable workflows at
  your branch as well, and change them back before merging.
- Make sure the shell code actually works on your laptop first.
- After merging, watch the workflow on a real project before moving on.

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

The package includes a CLI binary used by CI workflows to build Actors, detect changes, and report test results. You can also run it locally.

### Running locally

Running the testing library locally is useful when you only want to update the testing code in /test because you can iterate on it without pushing new code to the remote.

If you don't need to change any source files and only iterate on /test code, you can skip steps 1-4. But if you want to test vs changed /src, you have to push that GitHub branch since it needs to build the Actors with that code.

The main local flow is:

1. Switch to a dummy branch that you will push and can later delete
2. `npm i apify-test-tools@latest -D`
3. Push your code (changes you want to test)
4. Build Actors on Apify (with your new code)
5. Run tests against those builds. You can change tests and run on the same builds.

`cd` into the actor repository you want to work with (or use `--workspace`).

#### 4. Build affected Actors

If you want to test vs existing src code, you can skip this and instead construct the output JSON manually from existing builds only for the Actors you need to test.

Requires `APIFY_TOKEN_<USERNAME>` for all Apify users that own your Actors (e.g. `apify`, `compass`, `lukaskrivka` users). The username is derived from the actor name — uppercased with non-word chars replaced by `_` (e.g. Actor `john.doe/my-actor` needs `APIFY_TOKEN_JOHN_DOE`).

```bash
APIFY_TOKEN_JOHN_DOE=<token> \
GITHUB_WORKSPACE=. \
  npx apify-test-tools build \
    --target-branch origin/master \
    --source-branch origin/my-dummy-branch \
    --dry-run
```

Remove `--dry-run` to actually trigger builds and update the branch names/ The command outputs a JSON array of build objects to stdout:

```json
[{ "buildId": "...", "actorRawId": "...", "buildNumber": "...", "actorFullName": "john.doe/my-actor" }]
```

#### Build from local source (no push needed)

If you don't want to push a dummy branch just to test a change and wait for all the tests to finish, `build-from-local` builds Actors directly from your local files (zipped and uploaded as `SOURCE_FILES`), skipping steps 1-4 above.

```bash
APIFY_TOKEN_JOHN_DOE=<token> \
GITHUB_WORKSPACE=. \
  npx apify-test-tools build-from-local --actors john.doe/my-actor
```

Pass a hardcoded actor name via `--actors` to build only that Actor (comma-separate multiple names). Omit `--actors` to build all Actors in the repo, or add `--dry-run` to preview without building. It outputs the same JSON build array as `build`, so you run tests against it the same way as in step 5 below:

```bash
# Build from local source and capture output
BUILDS=$(APIFY_TOKEN_JOHN_DOE=apify_api_xxx \
  GITHUB_WORKSPACE=. \
  npx apify-test-tools build-from-local --actors apify/my-actor)
```

Since you already scoped the build to just the Actor(s) you care about, point vitest at a specific test file (or a `-t` name filter) instead of the whole `test/platform` directory — you get feedback on that one test without waiting for the full suite to run.

#### 5. Run tests against the builds

Pass the build output as `ACTOR_BUILDS` and provide `TESTER_APIFY_TOKEN`. The token can point to your own account (if you have enough memory) or you can use the testing account (xRGg9iAfJSymqartk).

If you want to run only certain tests, change the `test/platform` to be more specific.

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
    --source-branch origin/my-dummy-branch)

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
