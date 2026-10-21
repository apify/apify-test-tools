# Apify Test Tools

[Contributing link](CONTRIBUTING.md)

## Getting Started

### 1. Install the package

```bash
npm i -D apify-test-tools
```

- Requires `vitest` version `3.2.0` or later (uses [annotate](https://vitest.dev/guide/test-context.html#annotate))
- Make sure `target` and `module` in your `tsconfig.json`'s `compilerOptions` are set to `ES2022`
- Every Actor must already have at least one build under its default build tag (usually `latest`), built
  from a Git repository version whose URL points to this repository. Build it once manually on the
  platform before CI takes over. See [Repository check](#repository-check).

### 2. Create the config file

Every repo that uses `apify-test-tools` must have an `apify-test-tools.config.json` file at the root. It lists the actors in the repo, their folders, their full names on the platform, and which env var holds the token to use for each. A top-level `mode` field picks the file's layout; leave it out to use the default `"legacy"` layout.

See [Config file](#config-file) for the available modes and every field.

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
5. **`.dockerignore` filtering** — if a `.dockerignore` exists at the root of the actor's `dockerContextDir`, matching files are ignored. Patterns are resolved relative to `dockerContextDir`, matching Docker's own behavior. Test files are the exception: `get-affected-actors --test-files-glob <glob>` (relative to the repo root) skips this check for matching files, so a changed test triggers a build, and with it its tests, even when `.dockerignore` lists it. The PR workflow passes `test/platform/**`. Context matching still applies, so tests outside an actor's `dockerContextDir` (e.g. a root `test/` with standalone actors) need to be listed in its `overrideActorContext`; `get-affected-actors` logs a warning for changed test files outside every actor's context.
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

## Config file

`apify-test-tools.config.json` lives at the repo root and tells the tool which actors live in the repo, how to identify them, and which token to use.

### Actor fields

Every actor in the config is described by these fields, whatever the mode:

| Field                  | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder`               | yes      | Relative path from repo root to the actor's own project directory — the folder that directly contains `.actor/actor.json` (i.e. `<folder>/.actor/actor.json`), the actor's README/CHANGELOG, and its source. Use `"."` for a single-actor repo where `.actor/` is at the root.                                                                                                                                                                                                                          |
| `actorFullName`        | yes      | Full actor identifier in `owner/name` format (e.g. `"apify/web-scraper"`). This is the source of truth for the actor name — the `name` field in `actor.json` is not used.                                                                                                                                                                                                                                                                                                                               |
| `tokenEnvVar`          | yes      | Name of the environment variable holding the Apify API token for this actor. In [grouped mode](#grouped-mode) it's inherited from the group unless the actor sets its own. No fallback — if the env var is not set at build time, the build fails.                                                                                                                                                                                                                                                      |
| `overrideActorContext` | no       | Array of paths (relative to repo root) that define which files are relevant to this actor. When set, replaces the `dockerContextDir` from `actor.json` for change detection. Useful when an actor depends on shared packages outside its Docker build context. Entries must not be prefixes of one another (e.g. `["", "code"]` or `["actors", "actors/foo"]` are rejected). The actor's own `folder` is always part of its context — if none of the listed entries reach it, it's added automatically. |

### Modes

The file's layout is picked by the top-level `mode` field. Each mode is a different way of writing the same thing: every mode resolves to a list of actors with the fields above, and the same rules apply to all of them — no two actors may share a `folder`, and no two entries may point at the same `actorFullName`. If `mode` is left out, [`"legacy"`](#legacy-mode) is used, so existing config files keep working unchanged.

### Legacy mode

The default. A flat `actors` array where every entry carries all of its settings. Good for repos with a few actors, or where every actor has different settings.

```json
{
    "mode": "legacy",
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

`actors` must hold at least one entry. Every entry takes all the [actor fields](#actor-fields) directly, and `tokenEnvVar` is required on each one.

### Grouped mode

Actors are organized into `groups`, and each group sets `tokenEnvVar` and `overrideActorContext` once for all of its actors. Good for repos where many actors share the same token or context.

```json
{
    "mode": "grouped",
    "groups": {
        "myteam": {
            "tokenEnvVar": "APIFY_TOKEN_MYTEAM",
            "overrideActorContext": ["packages/shared"],
            "actors": [
                { "folder": "actors/web-scraper", "actorFullName": "myteam/web-scraper" },
                {
                    "folder": "actors/email-sender",
                    "actorFullName": "myteam/email-sender",
                    "overrideActorContext": ["actors/email-sender", "packages/mailer"]
                }
            ]
        },
        "partner": {
            "tokenEnvVar": "APIFY_TOKEN_PARTNER",
            "actors": [{ "folder": "actors/partner-crawler", "actorFullName": "partner/crawler" }]
        }
    }
}
```

`groups` is an object with at least one group. The group key (`myteam`, `partner` above) is only a label for readability; it has no effect on the result, and it does not need to match any folder or username. Each group needs a `tokenEnvVar` and at least one actor, and can optionally set `overrideActorContext`.

An actor inside a group can set its own `tokenEnvVar` or `overrideActorContext`, and that value replaces the group's for that actor only. Values are replaced, not merged: in the example above, `myteam/email-sender` gets `["actors/email-sender", "packages/mailer"]`, not `packages/shared` as well.

## Github worklows

The reusable workflows live in this repo, alongside the package they call. They are the
`public_`-prefixed files in `.github/workflows`; everything else there is this repo's own CI.
Reference them at the `@workflows-v0` major tag, never at `@master` — see
[Versioning and releases](#versioning-and-releases).

There should be 4 GH workflow files in `.github/workflows`, plus an optional fifth for Claude reviews.

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
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v0
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
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v0
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
        uses: apify/apify-test-tools/.github/workflows/public_pr-build-test.yaml@workflows-v0
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
        uses: apify/apify-test-tools/.github/workflows/public_push-build-latest.yaml@workflows-v0
        secrets: inherit
```

This workflow runs one step per command: `get-affected-actors --since ${{ github.event.before }}`, then
`build --version-number default` on every changed Actor, then `notify-release`. See [Releasing Actors](#releasing-actors) for how the
released range is determined and what to pass if you call the CLI from somewhere else.

### `claude-review.yaml`

Optional. Reviews a PR against the shared guidelines when you add the trigger label, and again on
every push while that label is on.

```yaml
name: Claude review

on:
    pull_request:
        types: [labeled, synchronize]

jobs:
    review:
        uses: apify/apify-test-tools/.github/workflows/public_review.yaml@workflows-v0
        secrets: inherit
```

The review instructions live in `.github/review-prompt.md` in this repo and are fetched at run time,
because a reusable workflow doesn't get its own repo checked out. `prompt-ref` selects which ref to
fetch them from and defaults to `workflows-v0`, so the instructions match the workflow you're calling — point
it at a branch only to test a prompt change.

### Secrets

Callers pass `secrets: inherit`. The workflows do not turn every inherited secret into job-wide
environment variables, so a secret is only visible to the step that needs it:

| Secret                                                                    | Reaches                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                                                               | dependency install steps only, as both `NPM_TOKEN` and `NODE_AUTH_TOKEN`. Use a read-only token: npm granular tokens can be read-only, classic automation tokens can publish.                                                |
| the Actor tokens named by `tokenEnvVar` in `apify-test-tools.config.json` | the build and `delete-old-builds` steps only                                                                                                                                                                                 |
| `TESTER_APIFY_TOKEN`                                                      | the vitest step, and the Claude investigation step: the Apify MCP server's bearer token for reading the failing run, its log and its storages, and Claude's token for re-running it to measure how often the failure happens |
| `SLACK_TOKEN_TESTS_BOT` / `SLACK_TOKEN_RELEASES_BOT`                      | the reporting and announcement steps only                                                                                                                                                                                    |

The Actor tokens are the one set that cannot be listed in the workflow, because each Actor names its
own token via `tokenEnvVar` in `apify-test-tools.config.json`. Those steps pass
`${{ toJSON(secrets) }}` as `ALL_SECRETS` and run the command through
`.github/scripts/run-with-apify-tokens.mjs`, which reads that same config file to decide which
secrets to pass on:

```yaml
- name: Build
  shell: bash
  env:
      ALL_SECRETS: ${{ toJSON(secrets) }}
  run: |
      jq '{ actors: .functionallyChangedActors }' affected.json \
        | node "${{ steps.setup.outputs.scripts-path }}/run-with-apify-tokens.mjs" \
          npx apify-test-tools build --version-number 0.99
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

The workflows and the npm package live in one repo but ship on their own schedules:

| What                                         | Consumers get it through                   | Ships when              |
| -------------------------------------------- | ------------------------------------------ | ----------------------- |
| the workflows and the CLI they call          | the `@workflows-v0` tag in `uses:`         | every master push       |
| the lib (`testActor`, `describe`, matchers…) | `apify-test-tools` in their `package.json` | a stable release on npm |

The CLI is bundled with its dependencies into `.github/cli/apify-test-tools.mjs` (`npm run bundle`,
run by the pre-commit hook and checked in CI), and the setup action runs it from there. Nothing is
installed for it, so a tag is a complete statement: these workflows and this CLI, with the exact
dependency versions from `package-lock.json` at that commit. The consumer's own `node_modules` is
left alone, so their tests keep the lib version they locked.

- **Workflow or CLI change** — merge it. `workflows-v0` moves once checks and tests pass, and it goes
  live. No release needed, even when a workflow starts using a new CLI feature: both are in the
  same commit.
- **Lib change** — merge it, then cut a release when you want it out. Consumers pick it up when
  they update `apify-test-tools`.

The CLI and the lib in one job can be different versions now, so the formats between them are a
contract: the `ACTOR_BUILDS` JSON that `build` writes and the lib reads, and the vitest JSON report
`report-tests` reads. Add fields freely; renaming or removing one needs a new major tag.

`workflows-v0` moving on every master push means `@workflows-v0` is as live as `@master` was —
there's no staging step. What the tag buys you is a `workflows-v1` for breaking workflow changes,
so repos migrate one at a time instead of all at once, and a way to roll back by pointing the tag at
an earlier commit (**Move major version tag** workflow). Bump `MAJOR_TAG` in
`.github/workflows/_move_major_tag.yaml` to cut the next major; the old tag then freezes where it is
and keeps working, CLI included, since the bundle is part of the frozen commit.

The tag tracks the **workflows'** contract, not the npm package version. They move independently on
purpose, so `@workflows-v0` is expected to stay `@workflows-v0` after the package reaches 1.0 —
bump it when a workflow breaks its callers, not when the package does. Because `uses:` cannot take an expression, every ref
into this repo repeats the tag literally; `check-major-tag-refs.mjs` fails the build if `MAJOR_TAG`
and those refs disagree, which is the mistake that would otherwise ship silently during a bump.

### Testing workflow changes

- Point [testing-repo-for-github-actions](https://github.com/apify-store/testing-repo-for-github-actions)
  at your branch (`uses: ...@your-branch`). It has real attached Actors and tests. The branch carries
  its own CLI bundle, so one branch tests the workflows and the CLI together.
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

### Dry runs (`--dry-run`)

Every command that changes something (`build`, `build-from-local`, `notify-release`, `delete-old-builds`, `report-tests`) takes `--dry-run`. A dry run:

- **Changes nothing.** No versions or builds are created, nothing is uploaded or deleted, and no Slack message is posted.
- **Does every read and check the real run does**, so it fails wherever the real run would: change detection, the Apify token and Actor lookup, the [repository check](#repository-check), collecting and zipping local sources, and the Slack token (verified with Slack's read-only `auth.test`).
- **Needs the same tokens as the real run.** Read-only tokens are enough, since nothing is written. A dry run can't tell whether a token is also allowed to write, because the Apify API has no dry-run mode of its own.
- **Prints a plan, not results.** Logs start with `[DRY RUN] Would …`. `build` and `build-from-local` write `{ "dryRun": true, "builds": [...] }` to stdout instead of the build array, so the plan can't be passed to tests as `ACTOR_BUILDS` by mistake.

### Running locally

Running the testing library locally is useful when you only want to update the testing code in /test because you can iterate on it without pushing new code to the remote.

If you don't need to change any source files and only iterate on /test code, you can skip steps 1-4. But if you want to test vs changed /src, you have to push that GitHub branch since it needs to build the Actors with that code.

The main local flow is:

1. Switch to a dummy branch that you will push and can later delete
2. `npm i apify-test-tools@latest -D`
3. Push your code (changes you want to test)
4. Build Actors on Apify (with your new code)
5. Run tests against those builds. You can change tests and run on the same builds.

Run every command from the root of the actor repository you want to work with.

#### 4. Build affected Actors

If you want to test vs existing src code, you can skip this and instead construct the output JSON manually from existing builds only for the Actors you need to test.

Requires `APIFY_TOKEN_<USERNAME>` for all Apify users that own your Actors (e.g. `apify`, `compass`, `lukaskrivka` users). The username is derived from the actor name — uppercased with non-word chars replaced by `_` (e.g. Actor `john.doe/my-actor` needs `APIFY_TOKEN_JOHN_DOE`).

```bash
npx apify-test-tools get-affected-actors --base origin/master \
  | jq '{ actors: .functionallyChangedActors }' \
  | APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools build --version-number 0.99 --dry-run
```

Run it with your dummy branch checked out: it builds the Actors that branch changed functionally, from the branch
as it is on the remote, into the test version `0.99`. With `--dry-run`, it prints the plan (the version and Git URL
each Actor would be built from). Remove `--dry-run` to actually trigger builds, and update `--base` to the branch
you compare against. `build` outputs a JSON array of build objects to stdout:

```json
[{ "buildId": "...", "actorRawId": "...", "buildNumber": "...", "actorFullName": "john.doe/my-actor" }]
```

#### Build from local source (no push needed)

If you don't want to push a dummy branch just to test a change and wait for all the tests to finish, `build-from-local` builds Actors directly from your local files (zipped into the Actor's `actor-<id>-source` key-value store and built as `TARBALL`, like `apify push`), skipping steps 1-4 above.

```bash
APIFY_TOKEN_JOHN_DOE=<token> \
  npx apify-test-tools build-from-local --actors john.doe/my-actor
```

Pass a hardcoded actor name via `--actors` to build only that Actor (comma-separate multiple names). Omit `--actors` to build all Actors in the repo, or add `--dry-run` to check the token, the Actor and the zipped sources without uploading or building. It outputs the same JSON build array as `build`, so you run tests against it the same way as in step 5 below:

```bash
# Build from local source and capture output
BUILDS=$(APIFY_TOKEN_JOHN_DOE=apify_api_xxx \
    npx apify-test-tools build-from-local --actors apify/my-actor)
```

Since you already scoped the build to just the Actor(s) you care about, point vitest at a specific test file (or a `-t` name filter) instead of the whole `test/platform` directory — you get feedback on that one test without waiting for the full suite to run.

#### 5. Run tests against the builds

Pass the build output as `ACTOR_BUILDS` and provide `TESTER_APIFY_TOKEN`. The token can point to your own account (if you have enough memory) or you can use the testing account (xRGg9iAfJSymqartk). Platform test suites are skipped unless `TESTER_APIFY_TOKEN` is set, so regular unit test runs stay unaffected.

If you want to run only certain tests, change the `test/platform` to be more specific.

```bash
ACTOR_BUILDS='<JSON output from build command>' \
TESTER_APIFY_TOKEN=<token> \
  npx vitest --run --maxConcurrency 20 --fileParallelism=true --maxWorkers 100 test/platform
```

#### Full example

Tests only run for Actors in `ACTOR_BUILDS`, so a custom workflow has to build (and pass) the Actors even when only tests changed. Pass `--test-files-glob` to `get-affected-actors` so test changes count even when `.dockerignore` lists them.

```bash
# Build and capture output
BUILDS=$(npx apify-test-tools get-affected-actors --base origin/master --test-files-glob 'test/platform/**' \
    | jq '{ actors: .functionallyChangedActors }' \
    | APIFY_TOKEN_JOHN_DOE=apify_api_xxx npx apify-test-tools build --version-number 0.99)

# Run tests with the builds
ACTOR_BUILDS="$BUILDS" \
TESTER_APIFY_TOKEN=apify_api_yyy \
  npx vitest --run --maxConcurrency 20 --fileParallelism=true --maxWorkers 100 test/platform
```

### Finding affected Actors (`get-affected-actors`)

`get-affected-actors` lists the Actors whose context changed in a commit range, using the rules in
[Change detection](#change-detection). It only reads git and the config file, so it needs no tokens.
The range always ends at the checked-out `HEAD`, so check out the branch you want to inspect first.

```bash
# A PR: the branch's own commits, after its last validated commit
npx apify-test-tools get-affected-actors --base origin/master --since <sha>

# A release: everything after the last released commit
npx apify-test-tools get-affected-actors --since <sha>
```

| Flag                | Default | Meaning                                                                                                                                    |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--base`            |         | Only commits on `HEAD` that are not on this branch count                                                                                   |
| `--since`           |         | Only commits after this one count (see below)                                                                                              |
| `--test-files-glob` |         | Test files (glob from the repo root) that count as changes even when `.dockerignore` lists them, see [Change detection](#change-detection) |
| `--actors`          | all     | Only report these Actors                                                                                                                   |
| `--ignore`          | none    | Never report these Actors                                                                                                                  |

Pass `--base`, `--since`, or both:

- **`--base` only** inspects the whole branch. If the branch merged `--base` in and has no functional changes
  of its own, no Actor is reported as functional, since `--base` is already validated (and none as cosmetic
  either, if the branch has no changes of its own at all).
- **`--base` and `--since`** inspects the branch after its last validated commit. If `--since` is not on the
  branch (force-push), or it is the head (a rerun), the whole branch is inspected instead.
- **`--since` only** inspects everything after it up to `HEAD`. It must be an ancestor of `HEAD` and fails
  otherwise, see [Releasing Actors](#releasing-actors). If `HEAD` is `--since`, nothing is
  reported.

The output is a JSON document:

```json
{
    "version": 1,
    "head": "<sha of HEAD>",
    "commits": [{ "sha": "…", "author": "…", "date": "…", "message": "…" }],
    "changedFiles": ["src/main.ts", "CHANGELOG.md"],
    "changelog": "Lines added to CHANGELOG.md, or null",
    "functionallyChangedActors": [{ "actorFullName": "john.doe/my-actor" }],
    "cosmeticallyChangedActors": [{ "actorFullName": "john.doe/other-actor" }]
}
```

Each changed Actor is in exactly one of the lists. `functionallyChangedActors` have at least one functional change, so
they need a new build and tests. `cosmeticallyChangedActors` only have cosmetic changes (see
[Change detection](#change-detection)), so they need a new build only when released: the PR workflow builds
`functionallyChangedActors`, the release workflow builds both.

### Building Actors (`build`)

`build` builds exactly the Actors it is given on stdin, from the checked-out branch as it is on the remote, and
prints the builds as the same JSON array `build-from-local` prints. A detached HEAD is an
error, since there is no branch to build from. It doesn't look at git history: which Actors to build is
up to you, usually picked from the output of [`get-affected-actors`](#finding-affected-actors-get-affected-actors).

```bash
# A PR: the Actors a branch changed functionally, built into the test version
npx apify-test-tools get-affected-actors --base origin/master \
  | jq '{ actors: .functionallyChangedActors }' \
  | npx apify-test-tools build --version-number 0.99

# A release: every Actor changed since the last release, into the version users run
npx apify-test-tools get-affected-actors --since <sha> \
  | jq '{ actors: (.functionallyChangedActors + .cosmeticallyChangedActors) }' \
  | npx apify-test-tools build --version-number default

# One Actor, whatever changed
echo '{ "actors": [{ "actorFullName": "john.doe/my-actor" }] }' | npx apify-test-tools build --version-number 0.99
```

The input is `{ "actors": [{ "actorFullName": "<owner/name>" }] }`; other fields are ignored. An empty `actors` list builds nothing and prints `[]`. Empty or invalid input is an error,
so a failed command earlier in the pipe can't turn into a successful run that built nothing. In GitHub
Actions, give such a step `shell: bash` so the pipe also fails on its own (the default shell has no `pipefail`).

| Flag               | Default             | Meaning                                                                                                                |
| ------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--version-number` | required            | Version to build, like `0.99`, or `default` for each Actor's default version (the one its default build tag points to) |
| `--repo-url`       | the `origin` remote | Repository to build from, see [Repository check](#repository-check)                                                    |

`build` never sets or changes build tags. A build gets the tag its version is configured with on the platform,
so building the default version moves its tag (usually `latest`) to the new build, and building a version
without a tag leaves every tag where it is. Builds always use the Docker cache.

### Releasing Actors

A release is three commands: find what changed since the last released commit, build those Actors into
their default version (the one users run), and announce it.

```bash
npx apify-test-tools get-affected-actors --since <sha> > affected.json

jq '{ actors: (.functionallyChangedActors + .cosmeticallyChangedActors) }' affected.json \
  | npx apify-test-tools build --version-number default --dry-run

npx apify-test-tools notify-release --release-slack-channel "#releases" --dry-run < affected.json
```

`notify-release` reads the output of `get-affected-actors` on stdin. It posts the changelog additions to
`--release-slack-channel` and the commits and changed files to `--report-slack-channel`, and posts nothing when
there are no new commits. It names the release after the `origin` remote (or `--repo-url`) and the author of the
newest commit, and needs `SLACK_TOKEN_RELEASES_BOT`.

#### The last released commit (`--since`)

The last commit that is **already released**. Everything after it, up to `HEAD`, is released. Git alone
can't tell which commits a push brought, and guessing wrong silently leaves Actors on old code, so it has
to be passed.

The changed files come from diffing `--since` and `HEAD` directly, so this works for every merge strategy as
long as `--since` is the branch tip from **before** the push:

| Merge strategy                 | What lands on the branch          | What to pass                                                           |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------------------- |
| Squash and merge               | 1 new commit                      | the push's "before" commit (`HEAD~1` also works)                       |
| Merge commit                   | the PR's commits + 1 merge commit | the push's "before" commit (`HEAD^1`, the first parent, also works)    |
| Rebase and merge / direct push | N new commits                     | the push's "before" commit (`HEAD~1` would miss the first N-1 commits) |

On GitHub, the push's "before" commit is `${{ github.event.before }}`, which the reusable workflow
passes for you. On other CIs use the equivalent, e.g. `$CI_COMMIT_BEFORE_SHA` on GitLab. The checkout
needs the full history (`fetch-depth: 0` in `actions/checkout`) so the commit is available locally.

`get-affected-actors --since` without `--base` fails instead of guessing when:

- the commit is all zeros (GitHub sends this for a push that created the branch)
- the commit isn't in the local history (shallow checkout) or isn't an ancestor of `HEAD`
  (the branch was force-pushed)

In those cases, rerun it with a `--since` you pick yourself: an ancestor of `HEAD` from before the changes
you want to release (for a shallow checkout, fetch the full history instead). `--actors` only narrows which
of the changed Actors are reported; it never forces a build, so on its own it doesn't get past these errors.
If `HEAD` is `--since`, nothing is reported, so nothing is built or announced.

A failed release isn't retried by the next push: that push's base commit is the failed one's head, so
its changes are skipped. Re-run the failed workflow run, or release the Actors manually.

#### Repository check

`build` points each Actor's version at the `origin` remote. Because a build overwrites the
version's Git URL, building from a fork or a mirror would repoint the Actor. So, before building, the
remote is compared with the Git URL of the Actor's default version (the one its default build tag
points to), and the command fails if they differ or if the default version isn't built from a Git
repository. The URL form doesn't matter (`https://github.com/org/repo` equals
`git@github.com:org/repo.git`).

To build from a different repository on purpose, e.g. when moving an Actor, pass `--repo-url`. That
skips the check.

#### Dev mode

For development on `apify-test-tools` itself, use `tsx` directly:

```bash
cd local-clone && tsx ../bin/main.ts get-actor-configs
```
