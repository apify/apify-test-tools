# Public API review for 1.0

A review of `apify-test-tools` (branch `feat/extend-support`) and `github-actions-source` (`master`),
looking for surface that is too Apify-internal, too hardcoded, or not worth keeping. Reference
consumer: `apify-store/google-maps`.

Each finding is tagged with one of:

- **[SPLIT]** too specific to Apify internals, move it out of the core tool
- **[CUT]** not enough value, remove it to shrink the API
- **[CONFIG]** too hardcoded, needs to expose configuration
- **[ADD]** missing feature or generalization

Findings are ordered by how much they block a public 1.0.

---

## Summary

Six things stand between this and a 1.0 that outsiders can use:

1. `secrets: inherit` plus secrets-to-env dumps every repo secret into the environment of every step. **[SPLIT]**
2. Workflows are consumed at `@master` with no tags, so "1.0" means nothing to a consumer. **[CONFIG]**
3. CI force-installs `apify-test-tools@latest` over the lockfile on every run. **[CONFIG]**
4. Slack, including the literal channel `#delivery-public-actors`, is compiled into the release path. **[SPLIT]**
5. `toFinishWith` assumes every Actor is a Crawlee crawler and fails Actors that aren't. **[CONFIG]**
6. The Claude workflows are a separate product living in the deploy repo. **[SPLIT]**

Beyond those, the biggest simplification available is dropping the `expect` / `expect.hard`
inversion, and the biggest missing feature is aborting Actor runs when a test times out.

---

## 1. Blockers

### 1.1 Every secret is exported to every step **[SPLIT]**

`platform-tests.yaml:40`, `pr-build-test.yaml:37`, `push-build-latest.yaml:34`

All three workflows require `secrets: inherit` from the caller and then run
`oNaiPs/secrets-to-env-action` with `secrets: ${{ toJSON(secrets) }}`. Every secret in the repo
becomes an environment variable for the whole job, including the `npx` and `npm ci` steps that
execute the consumer's full dependency tree. Any postinstall script in any transitive dependency
can read every organization secret.

Inside a trusted fleet this is a reasonable trade, because `tokenEnvVar` is dynamic per Actor and
the workflow can't know the secret names ahead of time. Published to the community it is a
supply-chain hazard, and it's the first thing a reviewer will flag.

The fix is to make the token set explicit. Options, cheapest first:

- Add an `apify-token-secrets` input listing the secret names the repo actually uses, and map only
  those. The config file already names them in `tokenEnvVar`, so the workflow can validate the two
  agree.
- Or scope the secrets-to-env step to the build step only, not the whole job, so `npm ci` never
  sees them.

### 1.2 Workflows have no versions **[CONFIG]**

`github-actions-source/README.md` says it plainly: "These workflows are used based on branch code,
there is no deployment. So once you merge the code, it will be running in production." Every
consumer, including `google-maps`, pins `@master`.

A 1.0 promise can't coexist with that. Tag releases and publish a moving `v1` tag, then update the
docs to `@v1`. This is the single cheapest change with the largest effect on what "1.0" means.

Related doc drift: `apify-test-tools/README.md` still shows `@new_master` in all four workflow
examples (lines 117, 136, 151, 166), while `google-maps` uses `@master`.

### 1.3 CI overrides the lockfile with `@latest` **[CONFIG]**

`checkout-restore-dependencies/action.yaml:60-73`

Every CI run replaces whatever `apify-test-tools` version the repo pinned with `@latest`, unless the
locked version happens to contain `-beta`. The comment explains the motive: "Repos can still have
older version locally but on cloud we enforce uniformity."

For a fleet you control, fine. For a public consumer, their CI is not reproducible, a bad release
breaks every repo at once, and under semver a 1.0 promise dies the moment `@latest` crosses into 2.0.
The `github-actions-source` README already lists this as a contested TODO.

Default to the lockfile. Keep the behavior behind an opt-in `enforce-latest-test-tools: true` input
for the internal fleet.

### 1.4 Slack is compiled into the core **[SPLIT]**

`bin/slack.ts`, `bin/main.ts:194-203`, `bin/test-report.ts:104-106`, `push-build-latest.yaml:46`

The core CLI depends on `@slack/web-api`, reads two hardcoded token env vars
(`SLACK_TOKEN_RELEASES_BOT`, `SLACK_TOKEN_TESTS_BOT`), and `push-build-latest.yaml` passes
`--release-slack-channel "#delivery-public-actors"` unconditionally for every consumer. The default
report channel is `#notif-<repo-name>` (`platform-tests.yaml:69`, `push-build-latest.yaml:46`),
which is an Apify naming convention.

The message bodies are Apify process too. `notifyToSlack` splits into a short "additions to the
changelog" post for a public channel and a long commit-list post for a dev channel, which encodes
how the Apify team runs releases, not how Actor testing works.

Recommendation: have `report-tests` and `release` emit a structured JSON report to stdout or a file
and stop there. Move Slack delivery into an optional package or a small composite action that
consumes that JSON. That drops `@slack/web-api` from core dependencies and removes two undocumented
env vars from the public contract. At minimum, delete the `#delivery-public-actors` and
`#notif-<repo>` defaults so nothing is posted unless a channel is passed.

### 1.5 `toFinishWith` assumes Crawlee **[CONFIG]**

`lib/consts.ts:3-13`, `lib/extend-expect.ts:161-162`, `lib/run-test-result.ts:20-28`

The defaults include `failedRequests: 0` and `requestsRetries: { max: 3 }`. Both read from
`getStatistics()`, which fetches the KVS record `SDK_CRAWLER_STATISTICS_0`. An Actor that isn't a
Crawlee crawler has no such record, so `stats` is `undefined`, and `checkInterval(undefined,
'failedRequests', ...)` compares `undefined !== 0` and fails.

So the headline matcher fails by default on any non-Crawlee Actor, with the message "Failed failed
requests check, expected 0, got undefined". That's a hard stop for community adoption and it looks
like a bug rather than a design choice.

Fix: when `getStatistics()` returns nothing, skip the Crawlee-derived checks and log once that they
were skipped. Keep the strict behavior when stats are present.

Two more hardcodes in the same defaults:

- `duration: { min: 600, max: 600_000 }` puts a 10-minute ceiling on every Actor run. Plenty of
  Actors legitimately run longer, and the 0.6s floor is an implicit assertion nobody asked for.
- `forbiddenLogs: ['ReferenceError', 'TypeError']` is a plain substring match over the whole log, so
  a line reading "handled TypeError gracefully" fails the run. Accept `RegExp` as well as `string`.

These belong in a repo-wide defaults block in `apify-test-tools.config.json` rather than being
repeated per assertion. One config key, not fifteen new function parameters:

```json
{
    "defaults": {
        "toFinishWith": {
            "duration": { "max": 1800000 },
            "forbiddenLogs": ["ReferenceError", "TypeError", "/ECONNRESET/"]
        }
    }
}
```

### 1.6 The Claude workflows are a different product **[SPLIT]**

`claude.yaml`, `platform-tests-claude-investigate-and-fix.yaml`

These have nothing to do with building and testing Actors. They also carry the sharpest defaults in
the repo: `--dangerously-skip-permissions` in both jobs of the investigate-and-fix workflow, a
hardcoded `BASE_TOOLS="Bash(gh pr*),Bash(gh api*),Bash(gh issue*),Bash(npm ci)"`, a 15-line default
prompt encoding Apify issue conventions, the `claude` / `claude:done` label protocol, and a job that
opens a PR automatically on every scheduled test failure.

Move both to their own repo. They can stay in the Apify org and keep evolving on trunk without
being bound by the testing tool's 1.0 promise. If they ship publicly at all,
`--dangerously-skip-permissions` should not be the default.

---

## 2. Library

### 2.1 Drop the `expect` / `expect.hard` inversion **[CUT]**

`lib/extend-expect.ts:250-268`

`extendExpect` swaps vitest semantics: the `expect` handed to tests is actually `expect.soft`, and
the real `expect` is available as `expect.hard`. Silently inverting a well-known third-party API is
the most surprising thing in the package for a new user, and the implementation copies enumerable
properties onto a new function, so anything vitest adds later is dropped.

The usage data argues it isn't earning the surprise. Across all of `google-maps`:

- 64 uses of `expect.hard`
- 64 of them are `expect.hard(runResult).toFinishWith(...)`
- 0 are anything else

`expect.hard` exists to serve exactly one matcher. Soft-by-default is genuinely right for E2E,
because you want every failure from a 40-minute run rather than the first. But the same outcome is
reachable without the inversion:

- Make `toFinishWith` a hard assertion. If the run itself failed, per-item assertions are noise.
- Keep everything else soft, and provide it as a plain second context property rather than a
  monkeypatched `.hard`.

Type bug regardless of the above: `hard` is declared inside `ActorMatchers` (`lib/types.ts:128`),
which is merged into vitest's `Assertion` and `Matchers`. That makes `expect(x).hard(...)`
type-check in any vitest project that imports this package. `hard` belongs on `ExpectStatic`.

### 2.2 Generic matchers: freeze them, don't grow them **[CUT]**

`lib/extend-expect.ts:9-110`

Fourteen of the fifteen matchers are generic assertion-library territory: `toBeArray`, `toBeBoolean`,
`toBeEmptyArray`, `toBeNonEmptyArray`, `toBeNonEmptyString`, `toBeNumber`, `toBeNonEmptyObject`,
`toBeObject`, `toBeString`, `toBeTrue`, `toBeFalse`, `toBeWholeNumber`, `toBeWithinRange`,
`toStartWith`. Most exist in `jest-extended` under the same names, and `toBeWithinRange` is
literally vitest's own documentation example for `expect.extend`.

They're also load-bearing: 208 call sites in `google-maps` alone, more than 3x the `toFinishWith`
count. So deleting them is not on the table. The realistic 1.0 position:

- Declare them stable and stop adding to them. Without a line in the docs saying so, this list grows
  to include `toBeUuid`, `toBeIso8601`, and everything else a user wants, and none of it is
  Apify-specific.
- Fix the correctness bugs first, since each is a silent false pass:
  - `toBeObject(null)` passes, because `typeof null === 'object'` (issue #88).
  - `toBeNonEmptyObject(null)` throws inside `Object.entries(null)` rather than failing.
  - `toBeNumber(NaN)` passes.
- Fix the messages. `toBeBoolean` and `toBeString` print the type, not the value: `Expected "string"
  to be a boolean`. None of them invert under `.not`.
- Document that `toBeWithinRange` is inclusive on both ends.

### 2.3 Env var contract is implicit and Apify-flavored **[CONFIG]**

`lib/lib.ts:12-35`

Four env vars form the runtime contract and none appear in a type or a config file:
`ACTOR_BUILDS`, `TESTER_APIFY_TOKEN`, `RUN_PLATFORM_TESTS`, `RUN_ALL_PLATFORM_TESTS`.

Problems:

- The `ApifyClient` is constructed at module load (`lib/lib.ts:35`). There is no way to configure the
  token programmatically, no way to use different tester accounts for Actors owned by different
  users, and the library can't be unit-tested.
- `RUN_PLATFORM_TESTS` and `RUN_ALL_PLATFORM_TESTS` are one tri-state wearing two booleans. `describe`
  runs if either is set; `testActor` runs if `RUN_ALL_PLATFORM_TESTS` is set or the Actor appears in
  `ACTOR_BUILDS`. Collapse to a single `APIFY_TEST_MODE=changed|all`, or derive it: `ACTOR_BUILDS`
  present means changed-only.
- `TESTER_APIFY_TOKEN` doesn't match the `APIFY_TOKEN_<USER>` convention used everywhere else.
  Namespace the lot as `APIFY_TEST_TOOLS_*` and document them in one table.

### 2.4 `describe` is a wrapper that mostly doesn't pay for itself **[CUT]**

`lib/lib.ts:44-46`

It calls `vitestDescribe.runIf(RUN_PLATFORM_TESTS || RUN_ALL_PLATFORM_TESTS)`. Since `testActor`
already gates itself, the only thing this buys is not evaluating the suite body.

It also has two rough edges. The argument order is `(name, fn, options)` where vitest uses
`(name, options, fn)`, and `options` replaces `DEFAULT_TEST_OPTIONS` wholesale instead of merging,
so passing any option silently drops `concurrent: true` and the one-hour timeout. `testActor` gets
this right by spreading.

Better replacement: ship a vitest config preset from the package. It can set the include pattern,
concurrency, timeouts, and reporter in one place, which also removes the
`--maxConcurrency 20 --fileParallelism=true --maxWorkers 100` incantation currently duplicated
across two workflows and the README (see 4.4).

### 2.5 Abort runs when the test ends **[ADD]**

`lib/lib.ts:48-52`, issue #16

`testActor` sets a vitest timeout to "prevent orphaned runs", but nothing aborts the platform run
when the test times out or fails. The vitest worker gives up and the Actor keeps running and keeps
billing. For an Actor that would have run four hours, that's real money on every timeout, and it
happens on exactly the runs most likely to be pathological.

`run()` should register cleanup that aborts the run when the test doesn't finish normally, with an
opt-out for tests that deliberately inspect long-running runs.

### 2.6 Count the dataset instead of downloading it **[CONFIG]**

`lib/run-test-result.ts:39-47`, `lib/extend-expect.ts:143`

`toFinishWith` computes `datasetItemCount` as `(await received.getDataset()).items.length`, which
downloads every item over `listItems()` with no pagination arguments. Two consequences worth
checking: it's slow and memory-hungry for large datasets, and the count depends on whatever page
size the client defaults to rather than on the true item count.

Use `dataset.get().itemCount` for the count. That's one cheap API call and it's correct regardless of
pagination. Separately, expose pagination on `getDataset({ limit, offset })` for tests that do want
the items.

### 2.7 `getStatistics` hardcodes the stats key **[CONFIG]**

`lib/run-test-result.ts:25`, issue #111

`SDK_CRAWLER_STATISTICS_0` is hardcoded. Actors with multiple crawlers write `_1`, `_2`, and so on.
Take an optional index or key, default to 0.

### 2.8 `datasetItemCount` shouldn't be required **[CONFIG]**

`lib/types.ts:55`

It's the one required field on `ToFinishWithOptions`. A standby Actor, an API Actor, or one that
writes to a key-value store has nothing meaningful to put there and is forced to write
`datasetItemCount: 0`. Make it optional and skip the check when absent.

### 2.9 `testStandbyActor` should be marked experimental **[SPLIT]**

`lib/lib.ts:79-124`, `lib/lib.ts:202-254`

The doc comment says it outright: "Using task is just current shortcoming of standby feature but
ideally we would use Actor directly." It creates a real task on the platform with a `Math.random()`
name, deletes it in a `finally` block that won't run if CI kills the process, and carries two open
bugs (#58 "callStandby is broken", #52 "disableStandbyFieldsOverride is not allowed by the schema").

The request shape is also too narrow. A standby Actor is an HTTP server, but `callStandby` always
sends `POST` with a JSON body and offers only `path` and `headers`. No GET, no query parameters, no
non-JSON bodies.

Either fix the request shape to be `fetch`-like (`method`, `path`, `query`, `headers`, `body`) or
exclude this from the 1.0 stability promise until the platform supports overriding the build on a
standby Actor directly. Marking it experimental is the honest call for now.

### 2.10 Small cuts **[CUT]**

- `it = testActor` (`lib/lib.ts:142`) and `testTestActor` (`lib/lib.ts:126-140`) are exported from
  `lib.ts` but not from `index.ts`. Dead weight; `testTestActor` is a test fixture that shouldn't
  ship at all.
- `RunOptions.runId` (`lib/types.ts:21`) makes every other option silently inert. Useful while
  developing a test, dangerous once committed, because the test goes permanently green against a
  stale run. Drive it from an env var instead, or refuse it when `process.env.CI` is set.
- `prefilledInput` (`lib/types.ts:13`) costs two extra API calls and, on failure, logs to
  `console.error` and returns `{}`. A test that believes it's using prefills may be running with
  none. Either fail loudly or drop it, since importing the input schema achieves the same thing.

### 2.11 Validate against the Actor's own schemas **[ADD]**

This is the most obvious Apify-specific matcher that's missing. Actors ship `input_schema.json` and
`dataset_schema.json`. Nothing in the library uses them, and `google-maps` has hand-rolled
`dataset-schema:generate|check|validate` scripts to fill the gap.

Two additions worth having:

- `expect(runResult).toMatchDatasetSchema()`, validating dataset items against the Actor's declared
  dataset schema.
- Validate the test input against the input schema before starting the run. Failing in 200ms beats
  failing after ten minutes.

---

## 3. CLI

### 3.1 `deleteOldBuilds` deletes on every merge with no controls **[CONFIG]**

`bin/build.ts:172-257`, `push-build-latest.yaml:49`

It runs unconditionally after every push to master, and it's destructive. Everything about it is
hardcoded:

- `PROTECTED_TAGS_PREFIX = ['latest', 'v-', 'version', 'v0' ... 'v9']`, a heuristic guess at which
  tags are production. The comment concedes it: "This hardcoded solution is not ideal."
- `DEFAULT_DAYS_BACK_PROD_VERSIONS = 30` and `DEFAULT_DAYS_BACK_DEVEL = 7` are named as defaults but
  can't be overridden.
- The literal `devel` tag is special-cased, with a comment saying it's legacy.
- `builds().list()` isn't paginated, so only the first page is ever considered.
- The global `--dry-run` flag exists but this command ignores it.

A public 1.0 that silently deletes users' builds on every merge is a bad default. Take it out of the
release workflow, expose `--keep-days`, `--protect-tags`, and a working `--dry-run`, and let
consumers schedule it separately. It's housekeeping, not testing.

### 3.2 The ignore list has no escape hatch **[CONFIG]**

`bin/diff-changes.ts:13-21`

```
['.vscode/', '.gitignore', '.husky/', '.eslintrc', 'eslint.config.mjs', '.prettierrc', '.editorconfig']
```

Every repo has different dev tooling: `.idea/`, `biome.json`, `.changeset/`, `docs/`, `LICENSE`,
`.nvmrc`. Notably `.github/` is not on the list, so editing a workflow file rebuilds and retests
every Actor in the repo.

Add `ignoredPaths` to the config file, defaulting to the current list. One key, high value. A
matching `cosmeticPaths` key is worth considering too, since the cosmetic-versus-functional split is
the other half of the same decision and is currently just as hardcoded (`readme.md`, `changelog.md`,
`.actor/*.json`).

### 3.3 Changelog handling is hardcoded to one file per repo **[CONFIG]**

`bin/diff-changes.ts:55-60`, `bin/github.ts:43-68`, issue #106

Any file named `changelog.md`, anywhere, is classified cosmetic for every Actor in the repo. The
code already flags this as wrong: "TODO: hardcodes that there's a single repo-wide changelog
belonging to every actor." `bin/github.ts` separately hardcodes `CHANGELOG.md` at the repo root for
release notes.

`actor.json` already declares `readme` and `changelog` paths. Parsing them gives correct per-Actor
classification for free, and it generalizes to repos that organize docs differently. Since it changes
change-detection behavior, it belongs in 1.0 rather than after.

### 3.4 Reserved version numbers are invisible **[CONFIG]**

`bin/build.ts:313` uses `versionNumber = '0.99'` for PR builds, `bin/build.ts:105` uses
`ZIP_VERSION = '0.98'` for local builds. Neither is documented or configurable, and both collide with
any Actor that genuinely versions up to 0.98 or 0.99.

Make the test version configurable, and either way state loudly in the README that these two
versions are reserved.

### 3.5 Any stderr output is treated as fatal **[CONFIG]**

`bin/utils.ts:71-87`

`spawnCommandInGhWorkspace` throws whenever a command writes anything to stderr, with a single
special case for `You are in 'detached HEAD' state`. Git writes to stderr routinely: `warning: LF
will be replaced by CRLF`, `hint:` advice blocks, progress output, and the same detached-HEAD notice
in other locales. This will break on external users with different git configurations.

Check the exit status instead.

Related, and worth treating as a security note: the same function runs with `shell: true` and
`git.ts` interpolates branch names straight into command strings (`git log ... ${targetBranch}..
${sourceBranch}`). Branch names are attacker-controlled on a PR from a fork. This is also the root of
issue #105, "git log command breaks on weirder branch names". Pass arguments as an array instead of
building a shell string.

### 3.6 `--help` is empty **[CONFIG]**

`bin/main.ts`

Every command is registered with `''` as its description, so `--help` lists nine commands and
explains none of them. `scriptName('public-actors-utils')` (line 82) is a leftover internal name that
doesn't match the published binary. Both are trivial to fix and both are the first thing a new user
sees.

### 3.7 Trim the introspection commands **[CUT]**

Of the nine commands, `get-commits`, `get-changed-files`, and `get-actor-configs` aren't used by any
workflow and read as debug helpers. `get-affected-actors` is worth keeping public, because consumers
building their own CI need it. Fold the other three behind a `debug` subcommand or drop them.

### 3.8 Config file discovery is rigid **[CONFIG]**

`bin/utils.ts:97`, `bin/utils.ts:116-125`

`apify-test-tools.config.json` must sit in `process.cwd()`. There's no `--config` flag, no upward
search, and no published JSON Schema, so editors give no autocomplete on a file every consumer has
to hand-write. Publishing `schema.json` and honoring `$schema` is cheap and pays for itself.

Also, `setCwd` (`bin/utils.ts:231-238`) keys off `GITHUB_WORKSPACE`, which the README documents even
for local use (`GITHUB_WORKSPACE=.`). For a general tool, `--workspace` should be primary and
`GITHUB_WORKSPACE` the fallback.

### 3.9 Document the two skip optimizations **[CONFIG]**

`bin/main.ts:43-79`, `pr-build-test.yaml:48-57`

Two heuristics can decide not to test a PR:

- `hasMergeFromTarget` skips everything when a branch merged from master and has no functional
  changes of its own.
- The `base_commit` cache limits the diff range to commits after the last validated one.

Both degrade safely (a miss means a full retest) and both are good ideas. But "we decided not to test
your PR" is a scary default for someone who just adopted the tool, and neither is mentioned in the
README. Document them, and consider a config toggle for the merge optimization.

### 3.10 Doc bug on token naming **[CONFIG]**

`README.md:402` claims the token env var is derived from the Actor name: "The username is derived
from the actor name, uppercased with non-word chars replaced by `_`". The code does no derivation;
`ApifyBuilder.fromActorConfig` (`bin/build.ts:158-166`) reads the explicit `tokenEnvVar` from the
config and fails if it's unset. The explicit design is the right one. Fix the doc.

---

## 4. Workflows

### 4.1 Node 24 is hardcoded **[CONFIG]**

`checkout-restore-dependencies/action.yaml:26-29`. The consumer's Actor code is built and tested
here, so the version has to be theirs to choose. Add a `node-version` input, default 24.

### 4.2 npm is assumed **[CONFIG]**

`npm ci` is hardcoded and the cache key is `package-lock.json` only, so pnpm, yarn, and bun repos are
out. Staying npm-only is a defensible opinion for 1.0, but say so in the docs rather than letting it
be discovered.

Separately, caching `node_modules` directly rather than `~/.npm` is a known-fragile pattern with
native modules and across runner images.

### 4.3 Test directory layout is hardcoded **[CONFIG]**

`platform-tests.yaml:55`, `pr-build-test.yaml:77`

`./test/platform/` is baked into the vitest invocation, and `test-files-glob` is interpreted relative
to it. Add a `test-dir` input defaulting to `test/platform`.

The deprecated `subtest` input (`platform-tests.yaml:6-10`) should go in 1.0, since `test-files-glob`
supersedes it and `google-maps` has already migrated.

### 4.4 Vitest tuning is hardcoded in three places **[CONFIG]**

`--maxConcurrency 20 --fileParallelism=true --maxWorkers 100` appears in `platform-tests.yaml`,
`pr-build-test.yaml`, and twice in the README. One hundred workers is aggressive, and the right
number is really "how many concurrent Actor runs can this account afford", which is per-repo.

Ship it as a vitest preset from the library (see 2.4) so the repo owns the tuning and the workflow
just runs `npx vitest --run`. That kills the duplication and the magic numbers together.

### 4.5 The unit test job is generic CI wearing Actor-tool clothes **[SPLIT]**

`pr-build-test.yaml:92-159`

Five checks driven by `jq` script sniffing: TypeScript (with a `build-check` override), lint, test,
format (with a prettier fallback), and unused exports (with a knip then ts-unused-exports fallback
chain). `npm run lint` is required and fails if absent, while the other four are conditional, which
is inconsistent on its own.

None of this is Actor-specific. Most repos adopting this tool already have their own lint and test CI
and will now run it twice. It also runs on every PR regardless of what changed, which the file itself
flags as a TODO.

Replace the sniffing with a `checks` input listing npm scripts to run, defaulting to the current set.
Or split it into its own reusable workflow so consumers can opt out entirely.

### 4.6 Branch names are hardcoded in the schedule guard **[CONFIG]**

`platform-tests.yaml:32`: `if: github.ref == 'refs/heads/master' || github.ref == 'refs/heads/main'`.
Minor, since `schedule` only fires on the default branch anyway, but it blocks running platform tests
from a release branch. Drop it or make it an input.

---

## 5. What to keep hardcoded

The goal isn't a hundred knobs. These are opinions worth defending as-is:

- **One config file per repo, with `folder` plus `actorFullName` plus `tokenEnvVar` per Actor.** The
  explicit `tokenEnvVar` with no fallback is the right call and should not gain a derivation rule.
- **`dockerContextDir` from `actor.json` as the default change-detection boundary**, with
  `overrideActorContext` as the escape hatch. Deriving from the file that already declares the build
  context is exactly right.
- **`.dockerignore` and `.gitignore` honored via git itself** rather than reimplemented matching
  (`bin/utils.ts:24-59`). Keep delegating.
- **Exhaustive `chargedEventCounts`.** Requiring every PPE event to be listed catches accidental new
  charges, which is the whole point. Issue #44 asks for partial matching; the exhaustive default is
  the better assertion and should stay the default.
- **Soft assertions inside a test body.** The behavior is right for E2E even though the delivery
  mechanism (2.1) is not.
- **npm only, vitest only.** Two fewer axes of support surface. Say so out loud.

---

## 6. Proposed 1.0 surface

Everything not on this list is internal or experimental and free to change.

**Library**

- `testActor`, `testStandbyActor` (experimental), `RunTestResult`, `ExpectStatic`
- `toFinishWith` plus the frozen generic matcher set
- A vitest config preset
- `describe` only if 2.4 isn't adopted

**Config**

- `apify-test-tools.config.json` with a published JSON Schema, plus the new `defaults.toFinishWith`
  and `ignoredPaths` keys

**Environment**

- One namespaced token var, one mode var, `ACTOR_BUILDS`

**CLI**

- `build`, `build-from-local`, `release`, `get-affected-actors`, `report-tests`
- `delete-old-builds` as opt-in with real flags

**Workflows, tagged `@v1`**

- `pr-build-test`, `push-build-latest`, `platform-tests`
- Claude workflows moved out
