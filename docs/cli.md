# CLI API

The package includes the `apify-test-tools` binary. The [reusable workflows](workflows.md) call it to find changed
Actors, build them, test them, and report the results. You can run it locally the same way:

```bash
npx apify-test-tools <command> [flags]
```

Run every command from the root of the Actor repository, where it reads `apify-test-tools.config.json`. Results go to
stdout as JSON and diagnostics to stderr, so commands can be piped into each other and into `jq`.

| Command                                                               | Does                                                    | Needs             |
| --------------------------------------------------------------------- | ------------------------------------------------------- | ----------------- |
| [`get-affected-actors`](#finding-affected-actors-get-affected-actors) | Lists the Actors changed in a commit range              | git only          |
| [`build`](#building-actors-build)                                     | Builds the Actors given on stdin from the pushed branch | build tokens      |
| [`build-from-local`](#build-from-local-source-build-from-local)       | Builds Actors from local files                          | build tokens      |
| [`test`](#running-tests-test)                                         | Runs the platform tests of the Actors given on stdin    | test tokens       |
| [`notify`](#notifying-notify)                                         | Posts a test report or a release to Slack               | `SLACK_BOT_TOKEN` |
| [`delete-old-builds`](#deleting-old-builds-delete-old-builds)         | Deletes old builds of the Actors                        | build tokens      |
| [`get-actor-configs`](#listing-actors-get-actor-configs)              | Prints the resolved config                              | nothing           |

Build tokens are the environment variables named by each Actor's `buildTokenEnvVar` in the config, test tokens those
named by its `testTokenEnvVar`. Both can name the same variable. A command only needs the tokens of the Actors it
touches.

## Global flags

| Flag          | Default | Meaning                                                                                                          |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `--log-level` | `info`  | Minimum level written to stderr: `debug`, `info`, `warn`, `error`, or `silent`. Results on stdout are unaffected |

The CLI is strict: an unknown flag or an extra argument is an error.

## Selecting Actors (`--actors`, `--ignore`)

`get-affected-actors`, `build-from-local`, `delete-old-builds`, and `get-actor-configs` take `--actors` and `--ignore`.
Each takes a list of Actor full names (`owner/name`), space-separated or with the flag repeated. `--actors` keeps only
the listed Actors, then `--ignore` drops the listed ones. A name that isn't in the config is an error, so a typo never
selects the wrong set. `build` and `test` take their Actors on stdin instead.

## Dry runs (`--dry-run`)

`build`, `build-from-local`, `notify`, and `delete-old-builds` take `--dry-run`. A dry run:

- **Changes nothing.** It creates no versions or builds, uploads and deletes nothing, and posts no Slack message.
- **Does every read and check the real run does**, so it fails wherever the real run would: change detection, the
  Apify token and Actor lookup, the [repository check](#repository-check), the [env var check](#env-var-check),
  collecting and zipping local sources, and the Slack token (verified with Slack's read-only `auth.test`).
- **Needs the same tokens as the real run.** Read-only tokens are enough. A dry run can't tell whether a token may
  also write, because the Apify API has no dry-run mode.
- **Prints a plan, not results.** Log lines start with `[DRY RUN] Would …`. `build` and `build-from-local` write
  `{ "dryRun": true, "builds": [...] }` to stdout instead of the build array, and `test` rejects it, so a plan can't
  be tested by mistake.

## Change detection

`get-affected-actors` decides which Actors to build and test from the changed files.

Paths in `.actor/actor.json` resolve relative to its `.actor/` directory. When `dockerfile`, `readme`, `changelog`, or
the input schema is omitted, the first existing default file is used: in `.actor/` first, then in the Actor's folder,
with file names matched case-insensitively.

Each changed file is checked against each Actor, in this order:

1. **Linked files.** The Actor's resolved `dockerfile` is functional. Its resolved `readme` and `changelog` are
   cosmetic: they only need a release build. `actor.json` and the schema files it links are compared as JSON:
   formatting, key order, and edits to `title`, `description`, `example`, `enumTitles`, `sectionCaption`, and
   `sectionDescription` are cosmetic, anything else is functional. The linked schemas are `input`/`inputSchema`,
   `output`/`outputSchema`, `webServerSchema`, `storages.dataset`, every `storages.datasets.<alias>`, and
   `storages.keyValueStore`; inline schemas are compared as part of `actor.json`. Linked files count even outside the
   Actor's context, inside a sibling Actor's folder, or when ignore rules exclude them. A shared file affects every
   Actor that links it.
2. **Sibling exclusion.** Other files inside another Actor's `folder` don't count, so an Actor with a broad context
   isn't triggered by a sibling's changes.
3. **Context matching.** Other files must be within one of the Actor's context paths: `overrideActorContext` from the
   config if set, otherwise `dockerContextDir` from `actor.json`. The Actor's own folder is always part of its
   context. An `overrideActorContext` entry can also be a single file, such as a root `package-lock.json`. Files
   outside every context path don't count.
4. **Ignored dev files.** The path is taken relative to the context path it matched, so a standalone Actor's own
   `.eslintrc` is checked as `.eslintrc`. Paths starting with `.vscode/`, `.gitignore`, `.husky/`, `.eslintrc`,
   `eslint.config.mjs`, `.prettierrc`, or `.editorconfig` don't count. Folders like `code/` or `shared/` get no special
   treatment: to treat them as top-level, list them in `overrideActorContext`.
5. **Platform tests.** A file matching `platformTestsGlob` from the config (a glob from the repo root, default
   `test/platform/**`, helpers included) is a test change, even when `.dockerignore` lists it. A test change puts the
   Actor in `testChangedActors`, so its tests run, but it is neither functional nor cosmetic, so a release doesn't
   build it. Step 3 still applies: tests outside an Actor's `dockerContextDir` (for example, a root `test/` with
   standalone Actors) must be listed in its `overrideActorContext`. `get-affected-actors` warns about changed test
   files outside every Actor's context.
6. **`.dockerignore`.** Files matched by the `.dockerignore` at the root of the Actor's `dockerContextDir` don't
   count. Patterns are relative to `dockerContextDir`, as in Docker. Files in the Actor's own `.actor/` directory are
   never ignored this way.
7. **Functional.** Everything else is functional: it needs a build and tests.

## Finding affected Actors (`get-affected-actors`)

`get-affected-actors` lists the Actors whose context changed in a commit range, using the rules in
[Change detection](#change-detection). It reads only git and the config file, so it needs no tokens. The range always
ends at the checked-out `HEAD`, so check out the branch you want to inspect first.

```bash
# A PR: the branch's own changes, narrowed to the Actors that changed since its last validated commit
npx apify-test-tools get-affected-actors --base origin/master --since <sha>

# A release: everything after the last released commit
npx apify-test-tools get-affected-actors --since <sha>
```

| Flag              | Default | Meaning                                                                                                                                    |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--base`          |         | Only what `HEAD` changes compared to this branch counts, like `git diff <base>...HEAD`                                                     |
| `--since`         |         | Only changes after this commit count (see below). An empty value counts as not passed                                                      |
| `--stored-builds` |         | JSON file with the builds earlier runs of the PR made, as `build` prints them. A missing file has none, an invalid one none with a warning |
| `--actors`        | all     | Only report these Actors                                                                                                                   |
| `--ignore`        | none    | Never report these Actors                                                                                                                  |

Pass `--base`, `--since`, or both:

- **`--base` only** inspects what the branch changes, the same files as GitHub's "Files changed" tab: the diff from
  where the branch forked from `--base`, or from the last commit of `--base` it merged in. What it merged in from
  `--base` is already validated there, so it doesn't count.
- **`--base` and `--since`** also inspects what changed after the branch's last validated commit, and reports only the
  Actors that changed in both. An Actor in only one of them is already validated, by this branch or on `--base`. An
  Actor changed in both is reported, since the changes can interact, but as functional only when both changes are
  functional. So a validated functional change followed by README edits is cosmetic, and so is a functional change
  merged in from `--base` that meets only cosmetic changes of the branch. `--since` doesn't have to be on the branch,
  so after a rebase only the Actors that `--base` also changed are checked again. If `--since` isn't in the local
  history (a force-push) or is `HEAD` (a rerun), it is ignored and the whole branch is checked.
- **`--since` only** inspects everything after it up to `HEAD`. It must be an ancestor of `HEAD`, see
  [Releasing Actors](#releasing-actors). If `HEAD` is `--since`, nothing is reported.

`commits`, `changedFiles`, and `changelog` describe the whole range (`--base...HEAD` or `--since..HEAD`). `--since`
together with `--base` only narrows the Actor lists.

`changelog` holds the lines added to the selected Actors' resolved changelog files in that range, each shared file
counted once. It is `null` when none of those files changed, and an empty string when they changed without added lines.
A `CHANGELOG.md` counts only when an Actor resolves its changelog to it.

The output is a JSON document:

```json
{
    "version": 1,
    "head": "<sha of HEAD>",
    "commits": [{ "sha": "…", "author": "…", "date": "…", "message": "…" }],
    "changedFiles": ["src/main.ts", "CHANGELOG.md"],
    "changelog": "Added lines from resolved changelogs, or null",
    "functionallyChangedActors": [{ "actorFullName": "john.doe/my-actor" }],
    "cosmeticallyChangedActors": [{ "actorFullName": "john.doe/other-actor" }],
    "testChangedActors": [
        { "actorFullName": "john.doe/third-actor", "build": "default" },
        {
            "actorFullName": "john.doe/fourth-actor",
            "build": { "buildId": "…", "actorRawId": "…", "buildNumber": "0.99.12" }
        },
        { "actorFullName": "john.doe/fifth-actor" }
    ]
}
```

- `functionallyChangedActors` have at least one functional change, so they need a new build and tests.
- `cosmeticallyChangedActors` have cosmetic changes and no functional one, so they need a new build only when
  released.
- `testChangedActors` have a changed platform test in their context and no functional change, so their tests need to
  run. A test change alone needs no release.

An Actor is in at most one of the first two lists. It can be in `cosmeticallyChangedActors` and `testChangedActors`,
but never in `functionallyChangedActors` and `testChangedActors`, since a functional change needs a new build and all
the tests anyway. With `--base` and `--since`, an Actor is in `testChangedActors` when its tests changed on the branch
and again since `--since`, the same rule as for functional changes.

The PR workflow passes `functionallyChangedActors` and `testChangedActors` to [`build`](#building-actors-build). The
release workflow builds `functionallyChangedActors` and `cosmeticallyChangedActors`.

An Actor in `testChangedActors` comes with the existing `build` that can run its tests, so `build` doesn't build it
again:

- `"default"`: the branch didn't change the Actor's code compared to `--base` (whatever `--since` is), so its default
  build has the same code.
- A stored build from `--stored-builds`: the branch changed the code, and an earlier run of the PR built it. That
  build has the current code, because a later functional change would have built the Actor again. Entries without a
  `buildId` (the default builds `build` passes through) are skipped.
- No `build`: the branch changed the code and no build of it is stored, so `build` builds the Actor.

## Building Actors (`build`)

`build` builds exactly the Actors given on stdin, from the checked-out branch as it is on the remote, and prints the
builds. It doesn't look at git history: you pick the Actors, usually from the output of
[`get-affected-actors`](#finding-affected-actors-get-affected-actors). An Actor listed twice is built once, so the
lists of `get-affected-actors` can be joined without removing duplicates. A detached `HEAD` is an error, since there is
no branch to build from.

An Actor listed with a `build`, as `testChangedActors` gives it, is not built:

- `"build": "default"` passes through as `{ "actorFullName": … }`, which [`test`](#running-tests-test) runs on the
  default build.
- A build object passes through while the build still exists, succeeded, and belongs to the Actor. Otherwise the Actor
  is built, and the log says why. `delete-old-builds` deletes builds after 30 days, so an old stored build gets
  replaced this way.
- An Actor listed several times with different builds (for example, once without one) is built from scratch. Entries
  that name the same build count as one.

The output lists every build to test, new and reused, so it goes straight to `test`.

```bash
# A PR: the Actors whose code or platform tests the branch changed, built into the test version, or reused
npx apify-test-tools get-affected-actors --base origin/master --stored-builds pr-builds.json \
  | jq '{ actors: (.functionallyChangedActors + .testChangedActors) }' \
  | npx apify-test-tools build --version-number 0.99

# A release: every Actor changed since the last release, into the version users run
npx apify-test-tools get-affected-actors --since <sha> \
  | jq '{ actors: (.functionallyChangedActors + .cosmeticallyChangedActors) }' \
  | npx apify-test-tools build --version-number default

# One Actor, whatever changed
echo '{ "actors": [{ "actorFullName": "john.doe/my-actor" }] }' | npx apify-test-tools build --version-number 0.99
```

The input is `{ "actors": [{ "actorFullName": "<owner/name>" }] }`, each Actor with an optional `build` (see above).
Other fields are ignored, and every Actor must be in the config. An empty `actors` list builds nothing and prints `[]`
(or an empty plan in a dry run). Empty or invalid input is an error, so a failed command earlier in the pipe can't turn
into a successful run that built nothing. In GitHub Actions, give such a step `shell: bash` so the pipe also fails on
its own (the default shell has no `pipefail`).

| Flag                         | Default             | Meaning                                                                                                                                     |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--version-number`           | required            | Version to build, as `<major>.<minor>` like `0.99`, or `default` for each Actor's default version (the one its default build tag points to) |
| `--repo-url`                 | the `origin` remote | Repository to build from, see [Repository check](#repository-check)                                                                         |
| `--require-env-vars-in-sync` | `false`             | Fail unless the built version's env var names match the default version's, see [Env var check](#env-var-check)                              |
| `--dry-run`                  | `false`             | See [Dry runs](#dry-runs---dry-run)                                                                                                         |

The output is the build array the library reads from `ACTOR_BUILDS`. A reused default build is the Actor's name alone:

```json
[
    { "buildId": "...", "actorRawId": "...", "buildNumber": "...", "actorFullName": "john.doe/my-actor" },
    { "actorFullName": "john.doe/other-actor" }
]
```

`build` never sets or changes build tags. A build gets the tag its version has on the platform, so building the default
version moves its tag (usually `latest`) to the new build, and building a version without a tag leaves every tag where
it is. When the default version doesn't have the default build tag, `build --version-number default` warns that users
keep running the previous build. Builds always use the Docker cache.

Every Actor needs a build under its default build tag, built from a Git repository version that points to this
repository. Build it once manually on the platform before the first run.

### Repository check

A build overwrites the version's Git URL with the `origin` remote, so building from a fork or a mirror would repoint
the Actor. Before building, `build` compares the remote with the Git URL of the Actor's default version (the one its
default build tag points to). It fails if they differ or if the default version isn't built from a Git repository. The
URL form doesn't matter: `https://github.com/org/repo` equals `git@github.com:org/repo.git`.

To build from a different repository on purpose, for example when moving an Actor, pass `--repo-url`. That skips the
check.

### Env var check

Tests should run the Actor with the same env vars users run it with. With `--require-env-vars-in-sync`, `build` and
`build-from-local` compare the env vars of the version they build (for example, `0.99`, or `0.98` for
`build-from-local`) with those of the default version, and fail if a name is missing or extra. Only names are
compared, since the API doesn't return secret values. A version that doesn't exist yet has no env vars, so if the
default version has some, first create the test version on the platform with the same env vars.

The CLI leaves the check off by default, so a one-off build (for example, of a debug branch) isn't held up by it.
[`public_pr-build-test.yaml`](workflows.md#public_pr-build-testyaml) turns it on by default; set its
`require-env-vars-in-sync` input to `false` to turn it off.

## Build from local source (`build-from-local`)

Builds Actors from your local files, with no push needed, into version `0.98`. Like `apify push`, it zips the sources
into the Actor's `actor-<id>-source` key-value store and builds them as `TARBALL`, without the Docker cache. The zip
holds the files git doesn't ignore, minus those the `.dockerignore` excludes. The Actor's `.actor/` folder is always
included, and secret files (`.env*`, `*.pem`, `*.key`, `*.pfx`, and `*.p12`) never are. It prints the same build array
as `build`.

```bash
APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools build-from-local --actors john.doe/my-actor
```

| Flag                         | Default | Meaning                                                                                                  |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `--actors`                   | all     | Only build these Actors                                                                                  |
| `--ignore`                   | none    | Never build these Actors                                                                                 |
| `--require-env-vars-in-sync` | `false` | Fail unless the env var names of `0.98` match the default version's, see [Env var check](#env-var-check) |
| `--dry-run`                  | `false` | Check the token, the Actor, and the zipped sources without uploading or building                         |

## Releasing Actors

A release is three commands: find what changed since the last released commit, build those Actors into their default
version (the one users run), and announce it.

```bash
npx apify-test-tools get-affected-actors --since <sha> > affected.json

jq '{ actors: (.functionallyChangedActors + .cosmeticallyChangedActors) }' affected.json \
  | npx apify-test-tools build --version-number default --dry-run

npx apify-test-tools notify --slack-channel "#notif-my-repo" --dry-run < affected.json
```

[`notify`](#notifying-notify) describes what it posts for a release.

### The last released commit (`--since`)

`--since` is the last commit that is **already released**. Everything after it, up to `HEAD`, is released. Git alone
can't tell which commits a push brought, and a wrong guess silently leaves Actors on old code, so you have to pass it.

The changed files come from diffing `--since` and `HEAD` directly, so every merge strategy works as long as `--since`
is the branch tip from **before** the push:

| Merge strategy                 | What lands on the branch          | What to pass                                                           |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------------------- |
| Squash and merge               | 1 new commit                      | the push's "before" commit (`HEAD~1` also works)                       |
| Merge commit                   | the PR's commits + 1 merge commit | the push's "before" commit (`HEAD^1`, the first parent, also works)    |
| Rebase and merge / direct push | N new commits                     | the push's "before" commit (`HEAD~1` would miss the first N-1 commits) |

On GitHub, the push's "before" commit is `${{ github.event.before }}`, which the reusable workflow passes for you. On
other CIs, use the equivalent, such as `$CI_COMMIT_BEFORE_SHA` on GitLab. The checkout needs the full history
(`fetch-depth: 0` in `actions/checkout`) so the commit is available locally.

`get-affected-actors --since` without `--base` fails instead of guessing when:

- the commit is all zeros (GitHub sends this for a push that created the branch)
- the commit isn't in the local history (a shallow checkout or an invalid commit)
- the commit isn't an ancestor of `HEAD` (the branch was force-pushed)

Then rerun it with a `--since` you pick yourself: an ancestor of `HEAD` from before the changes you want to release.
For a shallow checkout, fetch the full history instead. `--actors` only narrows which changed Actors are reported. It
never forces a build, so it doesn't get past these errors. If `HEAD` is `--since`, nothing is reported, built, or
announced.

The next push doesn't retry a failed release: its "before" commit is the failed push's head, so the failed changes are
skipped. Re-run the failed workflow run, or release the Actors manually.

## Running tests (`test`)

`test` runs the repository's own Vitest (the one in its `node_modules`, so the tests keep the versions the repository
locked) on the Actors given on stdin. Only the tests of those Actors run. It prints a report of the run for
[`notify`](#notifying-notify).

```bash
# A PR: test what was just built
... | npx apify-test-tools build --version-number 0.99 | npx apify-test-tools test > test-report.json

# Scheduled tests: every Actor in the config, on its default build
npx apify-test-tools get-actor-configs \
    | npx apify-test-tools test --test-files-glob 'test/platform/{hourly,hourly-without-pr}/**' > test-report.json

# Only some of them
npx apify-test-tools get-actor-configs --actors john.doe/my-actor | npx apify-test-tools test > test-report.json
```

The input is a JSON array of Actors, each named by its full name: `[{ "actorFullName": "<owner/name>" }]`, the name the
tests use for it. An Actor's tests run on the build given with it (`buildId` and `buildNumber`, as `build` and
`build-from-local` print them), or on its default build without one. Other fields are ignored, so the output of
[`get-actor-configs`](#listing-actors-get-actor-configs) works as it is. A dry-run plan, empty input, or invalid input
is an error, as with `build`.

Each Actor's tests run with its test token, the environment variable named by its `testTokenEnvVar`. `test` reads the
config for it, so the config file must exist. An Actor that isn't in the config, or whose token isn't set, gets a
warning, and only its own tests fail.

`test` passes the Actors to Vitest as `ACTOR_BUILDS`, each with its `testTokenEnvVar`, replacing any `ACTOR_BUILDS` in
its own environment. It needs `vitest` installed in the repository, and fails if the repository has apify-test-tools
older than 1.0.0, which could otherwise skip every test. It also excludes `**/dist/**`, which Vitest doesn't
exclude by default, so a compiled copy of the tests doesn't run next to them. The repository's own `exclude` still
applies.

If `test` is given Actors but no test runs, the report fails, since a run that tested nothing must not pass. At least 1
test must run for the whole set of given Actors, not 1 for each Actor. When none runs, the tests usually name the
Actors differently, or `--test-files-glob` selects none of their tests. A given Actor none of whose tests ran only gets
a warning, since an Actor may have no tests in the selected files.

`test` runs Vitest with `--maxConcurrency=20 --fileParallelism --maxWorkers=100`, since platform tests mostly wait on
Actor runs rather than the CPU. It uses the `default` reporter plus the `json` one the report is read from. These
replace any `reporters` in the repository's Vitest config; add more with `--reporter`, such as `github-actions` to
annotate failing tests in a GitHub Actions run. It takes no other Vitest options. For those (for example, `-t` to run
one test by name), run Vitest directly with the builds in `ACTOR_BUILDS`, see
[Running tests locally](lib.md#running-tests-locally).

| Flag                   | Default            | Meaning                                                                                                                            |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--test-files-glob`    | `test/platform/**` | Glob from the repo root of the test files to run, see below                                                                        |
| `--vitest-output-file` |                    | Also keep Vitest's own JSON report there, for example to upload it                                                                 |
| `--reporter`           |                    | [Vitest reporter](https://vitest.dev/guide/reporters) to add to `default` and `json`, such as `github-actions`. Repeat it for more |

`test` takes no test paths as arguments, only `--test-files-glob`, which is read the same way as `platformTestsGlob` in
the config file. Vitest filters are parts of a file path, not globs, so `test` finds the files the glob matches and
passes Vitest as few paths as it can: each folder whose files all match, with a trailing `/`, and the other matched
files one by one. For example, `test/platform/{daily,hourly}/**` becomes two folders however many tests they hold.
Vitest still applies its own `include` and `exclude`, so helper files in the glob run nothing. A glob that matches no
file is an error, because Vitest without filters would run every test in the repository. Quote the glob, so the shell
doesn't expand it.

Vitest's own output goes to stderr, followed by a summary that lists the passed and failed tests with links to their
runs. Stdout gets only the report:

```json
{
    "kind": "test-report",
    "version": 2,
    "success": false,
    "summary": { "total": 3, "passed": 1, "failed": 1, "skipped": 1 },
    "tests": [
        {
            "name": "john.doe/my-actor: finishes",
            "file": "test/platform/my-actor.test.ts",
            "status": "failed",
            "durationMs": 61234,
            "failureMessages": ["AssertionError: expected 'FAILED' to be 'SUCCEEDED'"],
            "run": {
                "actorFullName": "john.doe/my-actor",
                "runId": "…",
                "runLink": "https://console.apify.com/view/runs/…"
            }
        }
    ],
    "errors": ["test/platform/other.test.ts: Cannot find package 'foo'"]
}
```

`failureMessages` keeps the first line of each failure; diffs and stack traces are in the Vitest output. `run` is
`null` for a test that started no run. `errors` lists failures outside any test, such as a test file that failed to
load, or Vitest exiting without a report. `test` exits with 1 whenever `success` is false, and prints the report anyway,
so `notify` still hears about the failure.

## Notifying (`notify`)

`notify` reads a test run (the output of [`test`](#running-tests-test)) or a release (the output of
[`get-affected-actors`](#finding-affected-actors-get-affected-actors)) on stdin and posts about it. It tells the two
apart by the report's `kind` and the release's `commits`, so either can be piped in as it is. Slack is the only target
for now, and each call posts to one channel; to post to more channels, call it once for each.

```bash
# A test run: posts only when the tests failed. The message has the failure counts and the first failure, linked to
# its run, with the other failures in the message's thread
npx apify-test-tools notify --slack-channel '#notif-my-repo' < test-report.json
npx apify-test-tools notify --slack-channel '#my-team' < test-report.json

# Or straight from test. With `set -o pipefail` (`shell: bash` in GitHub Actions), failed tests still fail the pipe
npx apify-test-tools get-actor-configs | npx apify-test-tools test | npx apify-test-tools notify --slack-channel '#notif-my-repo'

# A release, see Releasing Actors
npx apify-test-tools get-affected-actors --since <sha> | npx apify-test-tools notify --slack-channel '#notif-my-repo'
```

| Flag              | Input   | Default             | Meaning                                                           |
| ----------------- | ------- | ------------------- | ----------------------------------------------------------------- |
| `--slack-channel` | both    |                     | Slack channel to post to (one per call)                           |
| `--on`            | tests   | `failure`           | `failure` posts only when the tests failed, `always` on every run |
| `--title`         | tests   | `-`                 | What the message calls the run, such as the CI workflow name      |
| `--job-url`       | tests   |                     | Link to the CI job, included in the message                       |
| `--repo-url`      | release | the `origin` remote | The repository the release is named after and its commits link to |
| `--dry-run`       | both    | `false`             | See [Dry runs](#dry-runs---dry-run)                               |

A flag the input has no use for (for example, `--repo-url` with a test report) is an error. Both kinds of notification
post with the Slack token in `SLACK_BOT_TOKEN`.

Without `--slack-channel`, `notify` posts nothing and needs no token. With it, the token must be set on every run, even
when there is nothing to post, so a missing token shows up on a green run rather than on the day tests fail. A dry run
also verifies the token with Slack. A release with no new commits is the exception: there is nothing to announce, so it
needs no token.

For a release, `notify` posts the changelog additions, then the commits, oldest first. Each commit is its title (cut at
200 characters) linked to its page on GitHub, followed by its author. A merge commit or a squash merge is one commit; a
rebase merge lists every commit it brought. A repository hosted elsewhere gets the titles without links. The release is
named after the `origin` remote (or `--repo-url`) and the author of the newest commit. Without a changelog addition,
`notify` logs a warning and posts the commits only.

```text
*my-repo* – New release (by Jane Doe):

- Fixed pagination on the search page

*Commits*:
1. <https://github.com/my-org/my-repo/commit/1a2b3c…|fix: pagination on the search page> – Jane Doe
```

## Deleting old builds (`delete-old-builds`)

Deletes every build older than 30 days of each selected Actor, except the default build and builds whose tag starts
with `latest`, `version`, `v-`, or `v0`–`v9`. It needs each Actor's build token.

| Flag        | Default | Meaning                                                     |
| ----------- | ------- | ----------------------------------------------------------- |
| `--actors`  | all     | Only these Actors                                           |
| `--ignore`  | none    | Never these Actors                                          |
| `--dry-run` | `false` | List the builds that would be deleted without deleting them |

## Listing Actors (`get-actor-configs`)

Prints the [config](../README.md#config-file) as the tool resolves it: one entry per Actor, with the group's values
applied and `actor.json` read. It takes `--actors` and `--ignore`. Use it to check a config change, or to pipe every
Actor into [`test`](#running-tests-test).

## Running locally

To update only the tests in `test/`, you don't need new builds: run the tests against the default builds, see
[Running tests locally](lib.md#running-tests-locally).

To test changed Actor source, you need builds of it. The quickest way is
[`build-from-local`](#build-from-local-source-build-from-local), which needs no push:

```bash
APIFY_TOKEN_JOHN_DOE=apify_api_xxx \
    npx apify-test-tools build-from-local --actors john.doe/my-actor > builds.json
```

To build from git, like CI does:

1. Switch to a dummy branch that you will push and can delete later.
2. Run `npm i apify-test-tools@latest -D`.
3. Push the code you want to test.
4. Build the Actors on Apify.
5. Run the tests against those builds. You can change the tests and rerun them on the same builds.

```bash
npx apify-test-tools get-affected-actors --base origin/master \
    | jq '{ actors: (.functionallyChangedActors + .testChangedActors) }' \
    | APIFY_TOKEN_JOHN_DOE=apify_api_xxx npx apify-test-tools build --version-number 0.99 > builds.json
```

Run it with your dummy branch checked out, and set `--base` to the branch you compare against. It builds the Actors the
branch changed functionally into the test version `0.99`, from the branch as it is on the remote. Add `--dry-run` to
`build` to print the plan (the version and Git URL of each build) first. Tests only run for the Actors in
`ACTOR_BUILDS`, so the `jq` filter also passes the Actors whose platform tests changed: those whose code the branch
didn't change run on their default build, the others are built.

To test existing builds instead, skip the build and write the build array by hand, only for the Actors you need.

Then run the tests on the builds with [`test`](#running-tests-test), as often as you like:

```bash
APIFY_TOKEN_JOHN_DOE=apify_api_xxx npx apify-test-tools test < builds.json
```
