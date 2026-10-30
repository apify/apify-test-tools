# CLI API

The package includes the `apify-test-tools` binary. The [reusable workflows](workflows.md) call it to find changed
Actors, build them, and report results, and you can run it locally the same way:

```bash
npx apify-test-tools <command> [flags]
```

Run every command from the root of the Actor repository; it reads `apify-test-tools.config.json` from there.
Results are written to stdout as JSON, diagnostics to stderr, so commands can be piped into each other and into `jq`.

| Command                                                               | Does                                                    | Needs                |
| --------------------------------------------------------------------- | ------------------------------------------------------- | -------------------- |
| [`get-affected-actors`](#finding-affected-actors-get-affected-actors) | Lists the Actors changed in a commit range              | git only             |
| [`build`](#building-actors-build)                                     | Builds the Actors given on stdin from the pushed branch | Actor tokens         |
| [`build-from-local`](#build-from-local-source-build-from-local)       | Builds Actors from local files                          | Actor tokens         |
| [`test`](#running-tests-test)                                         | Runs the platform tests on the builds given on stdin    | `TESTER_APIFY_TOKEN` |
| [`notify`](#notifying-notify)                                         | Posts a test report or a release to Slack               | a Slack token        |
| [`delete-old-builds`](#deleting-old-builds-delete-old-builds)         | Deletes old builds of the Actors                        | Actor tokens         |
| [`get-actor-configs`](#listing-actors-get-actor-configs)              | Prints the resolved config                              | nothing              |

"Actor tokens" are the environment variables named by each Actor's `tokenEnvVar` in the config. A command only needs
the tokens of the Actors it touches.

## Global flags

| Flag          | Default | Meaning                                                                                                          |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `--log-level` | `info`  | Minimum level written to stderr: `debug`, `info`, `warn`, `error`, or `silent`. Results on stdout are unaffected |

## Selecting Actors (`--actors`, `--ignore`)

Commands that read the config take `--actors` and `--ignore`, each a list of `actorFullName`s (space-separated,
or the flag repeated). `--actors` keeps only the listed Actors, `--ignore` drops them. An unknown
name is an error rather than silently selecting nothing.

## Dry runs (`--dry-run`)

Every command that changes something (`build`, `build-from-local`, `notify`, `delete-old-builds`) takes
`--dry-run`. A dry run:

- **Changes nothing.** No versions or builds are created, nothing is uploaded or deleted, and no Slack message is
  posted.
- **Does every read and check the real run does**, so it fails wherever the real run would: change detection, the
  Apify token and Actor lookup, the [repository check](#repository-check), collecting and zipping local sources, and
  the Slack token (verified with Slack's read-only `auth.test`).
- **Needs the same tokens as the real run.** Read-only tokens are enough, since nothing is written. A dry run can't
  tell whether a token is also allowed to write, because the Apify API has no dry-run mode of its own.
- **Prints a plan, not results.** Logs start with `[DRY RUN] Would …`. `build` and `build-from-local` write
  `{ "dryRun": true, "builds": [...] }` to stdout instead of the build array, so the plan can't be passed to tests as
  `ACTOR_BUILDS` by mistake.

## Change detection

When a PR is opened or code is pushed, the tool determines which Actors need to be built and tested based on the
changed files. For each changed file, for each Actor:

1. **Sibling exclusion** — files inside another Actor's `folder` are excluded first. This prevents an Actor with
   broad context from being triggered by changes that belong to a sibling Actor.
2. **CHANGELOG classification** — a `CHANGELOG.md` file is always `cosmetic` (only triggers a release build, not
   tests), for every Actor, regardless of context or folder. (See
   [issue #106](https://github.com/apify/apify-test-tools/issues/106).)
3. **Context matching** — the file must fall within one of the Actor's context paths (`dockerContextDir` from
   `actor.json` by default, or `overrideActorContext` from config if set). Files outside every context path are
   skipped.
4. **Hardcoded ignore list, context-aware** — the file path is first "hoisted" relative to the context path it
   matched (e.g. a standalone Actor's own `.eslintrc` is checked as just `.eslintrc`, not the full
   repo-root-relative path), then checked against repo-level dev file patterns (`.vscode/`, `.gitignore`, `.husky/`,
   `.eslintrc`, `eslint.config.mjs`, `.prettierrc`, `.editorconfig`). There's no hardcoded special-casing for legacy
   `code/`/`shared/` layouts — repos that need those directories treated as top-level must list them explicitly in
   `overrideActorContext`.
5. **`.dockerignore` filtering** — if a `.dockerignore` exists at the root of the Actor's `dockerContextDir`,
   matching files are ignored. Patterns are resolved relative to `dockerContextDir`, matching Docker's own behavior.
   Test files are the exception: `get-affected-actors --test-files-glob <glob>` (relative to the repo root) skips
   this check for matching files, so a changed test triggers a build, and with it its tests, even when
   `.dockerignore` lists it. The PR workflow passes `test/platform/**`. Context matching still applies, so tests
   outside an Actor's `dockerContextDir` (e.g. a root `test/` with standalone Actors) need to be listed in its
   `overrideActorContext`; `get-affected-actors` logs a warning for changed test files outside every Actor's context.
6. **README classification** — a `README.md` file is `cosmetic` (only triggers a release build, not tests) if it
   lives inside the Actor's own `folder`; otherwise it's ignored entirely, since it isn't documentation for this
   Actor.
7. **Cosmetic JSON classification** — `.json` files inside the Actor's own `.actor/` directory with only cosmetic
   schema changes (whitespace, key ordering) only trigger a release build.
8. **Functional** — everything else triggers both build and tests.

## Finding affected Actors (`get-affected-actors`)

`get-affected-actors` lists the Actors whose context changed in a commit range, using the rules in
[Change detection](#change-detection). It only reads git and the config file, so it needs no tokens. The range always
ends at the checked-out `HEAD`, so check out the branch you want to inspect first.

```bash
# A PR: the branch's own changes, narrowed to the Actors that changed since its last validated commit
npx apify-test-tools get-affected-actors --base origin/master --since <sha>

# A release: everything after the last released commit
npx apify-test-tools get-affected-actors --since <sha>
```

| Flag                | Default | Meaning                                                                                                                                    |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--base`            |         | Only what `HEAD` changes compared to this branch counts, like `git diff <base>...HEAD`                                                     |
| `--since`           |         | Only changes after this commit count (see below)                                                                                           |
| `--test-files-glob` |         | Test files (glob from the repo root) that count as changes even when `.dockerignore` lists them, see [Change detection](#change-detection) |
| `--actors`          | all     | Only report these Actors                                                                                                                   |
| `--ignore`          | none    | Never report these Actors                                                                                                                  |

Pass `--base`, `--since`, or both:

- **`--base` only** inspects what the branch changes, the same files GitHub's "Files changed" tab shows: the diff
  from where the branch forked from `--base`, or the last commit of `--base` it merged in. What it merged in from
  `--base` is already validated there, so it doesn't count.
- **`--base` and `--since`** also inspects what changed after the branch's last validated commit, and reports only
  the Actors that changed in both. An Actor in only one of them is already validated, by this branch or on `--base`.
  When both changed an Actor, the changes can interact, so it is reported, but as functional only when both changes
  are functional. A validated functional change followed by README edits is cosmetic, and so is a functional
  change merged in from `--base` that meets only cosmetic changes of the branch. `--since` doesn't have to be on
  the branch, so a rebase only re-checks the Actors that `--base` changed too. If `--since` is not in the local
  history (a force-push), or it is `HEAD` (a rerun), it is ignored and the whole branch is checked.
- **`--since` only** inspects everything after it up to `HEAD`. It must be an ancestor of `HEAD` and fails
  otherwise, see [Releasing Actors](#releasing-actors). If `HEAD` is `--since`, nothing is reported.

`commits`, `changedFiles` and `changelog` describe the whole range, `--base...HEAD` or `--since..HEAD`: `--since`
together with `--base` only narrows the Actor lists.

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

Each changed Actor is in exactly one of the lists. `functionallyChangedActors` have at least one functional change,
so they need a new build and tests. `cosmeticallyChangedActors` only have cosmetic changes (see
[Change detection](#change-detection)), so they need a new build only when released: the PR workflow builds
`functionallyChangedActors`, the release workflow builds both.

## Building Actors (`build`)

`build` builds exactly the Actors it is given on stdin, from the checked-out branch as it is on the remote, and
prints the builds as the same JSON array `build-from-local` prints. A detached HEAD is an error, since there is no
branch to build from. It doesn't look at git history: which Actors to build is up to you, usually picked from the
output of [`get-affected-actors`](#finding-affected-actors-get-affected-actors).

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

The input is `{ "actors": [{ "actorFullName": "<owner/name>" }] }`; other fields are ignored. An empty `actors` list
builds nothing and prints `[]`. Empty or invalid input is an error, so a failed command earlier in the pipe can't turn
into a successful run that built nothing. In GitHub Actions, give such a step `shell: bash` so the pipe also fails on
its own (the default shell has no `pipefail`).

| Flag                         | Default             | Meaning                                                                                                                |
| ---------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--version-number`           | required            | Version to build, like `0.99`, or `default` for each Actor's default version (the one its default build tag points to) |
| `--repo-url`                 | the `origin` remote | Repository to build from, see [Repository check](#repository-check)                                                    |
| `--require-env-vars-in-sync` | `false`             | Fail unless the built version's env var names match the default version's, see [Env var check](#env-var-check)         |
| `--dry-run`                  | `false`             | See [Dry runs](#dry-runs---dry-run)                                                                                    |

The output is the build array the vitest library reads from `ACTOR_BUILDS`:

```json
[{ "buildId": "...", "actorRawId": "...", "buildNumber": "...", "actorFullName": "john.doe/my-actor" }]
```

`build` never sets or changes build tags. A build gets the tag its version is configured with on the platform, so
building the default version moves its tag (usually `latest`) to the new build, and building a version without a
tag leaves every tag where it is. Builds always use the Docker cache.

### Repository check

`build` points each Actor's version at the `origin` remote. Because a build overwrites the version's Git URL,
building from a fork or a mirror would repoint the Actor. So, before building, the remote is compared with the Git
URL of the Actor's default version (the one its default build tag points to), and the command fails if they differ
or if the default version isn't built from a Git repository. The URL form doesn't matter
(`https://github.com/org/repo` equals `git@github.com:org/repo.git`).

To build from a different repository on purpose, e.g. when moving an Actor, pass `--repo-url`. That skips the check.

### Env var check

Tests should run the Actor with the same env vars users run it with. Pass `--require-env-vars-in-sync` to `build` or
`build-from-local` to compare the env vars of the version they build (e.g. `0.99`, or `0.98` for `build-from-local`)
with those of the default version, and fail if a name is missing or extra. Only names are compared, since the API
doesn't return secret values. A version that doesn't exist yet counts as having no env vars, so if the default
version has any, create the test version on the platform with the same env vars first. A dry run checks the env vars
too.

The CLI leaves it off by default, so a one-off build, e.g. of a debug branch, isn't held up by it.
[`public_pr-build-test.yaml`](workflows.md#public_pr-build-testyaml) turns it on by default; set its
`require-env-vars-in-sync` input to `false` to turn it off.

## Build from local source (`build-from-local`)

Builds Actors directly from your local files, with no push needed: the sources are zipped into the Actor's
`actor-<id>-source` key-value store and built as `TARBALL`, like `apify push`. It prints the same build array as
`build`.

```bash
APIFY_TOKEN_JOHN_DOE=<token> npx apify-test-tools build-from-local --actors john.doe/my-actor
```

| Flag                         | Default | Meaning                                                                                                  |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `--actors`                   | all     | Only build these Actors. Point vitest at their tests only, for quicker feedback                          |
| `--ignore`                   | none    | Never build these Actors                                                                                 |
| `--require-env-vars-in-sync` | `false` | Fail unless the env var names of `0.98` match the default version's, see [Env var check](#env-var-check) |
| `--dry-run`                  | `false` | Check the token, the Actor and the zipped sources without uploading or building                          |

## Releasing Actors

A release is three commands: find what changed since the last released commit, build those Actors into their
default version (the one users run), and announce it.

```bash
npx apify-test-tools get-affected-actors --since <sha> > affected.json

jq '{ actors: (.functionallyChangedActors + .cosmeticallyChangedActors) }' affected.json \
  | npx apify-test-tools build --version-number default --dry-run

npx apify-test-tools notify --slack-channel "#notif-my-repo" --dry-run < affected.json
```

[`notify`](#notifying-notify) says what it posts for a release.

### The last released commit (`--since`)

The last commit that is **already released**. Everything after it, up to `HEAD`, is released. Git alone can't tell
which commits a push brought, and guessing wrong silently leaves Actors on old code, so it has to be passed.

The changed files come from diffing `--since` and `HEAD` directly, so this works for every merge strategy as long as
`--since` is the branch tip from **before** the push:

| Merge strategy                 | What lands on the branch          | What to pass                                                           |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------------------- |
| Squash and merge               | 1 new commit                      | the push's "before" commit (`HEAD~1` also works)                       |
| Merge commit                   | the PR's commits + 1 merge commit | the push's "before" commit (`HEAD^1`, the first parent, also works)    |
| Rebase and merge / direct push | N new commits                     | the push's "before" commit (`HEAD~1` would miss the first N-1 commits) |

On GitHub, the push's "before" commit is `${{ github.event.before }}`, which the reusable workflow passes for you.
On other CIs use the equivalent, e.g. `$CI_COMMIT_BEFORE_SHA` on GitLab. The checkout needs the full history
(`fetch-depth: 0` in `actions/checkout`) so the commit is available locally.

`get-affected-actors --since` without `--base` fails instead of guessing when:

- the commit is all zeros (GitHub sends this for a push that created the branch)
- the commit isn't in the local history (shallow checkout) or isn't an ancestor of `HEAD` (the branch was
  force-pushed)

In those cases, rerun it with a `--since` you pick yourself: an ancestor of `HEAD` from before the changes you want
to release (for a shallow checkout, fetch the full history instead). `--actors` only narrows which of the changed
Actors are reported; it never forces a build, so on its own it doesn't get past these errors. If `HEAD` is
`--since`, nothing is reported, so nothing is built or announced.

A failed release isn't retried by the next push: that push's base commit is the failed one's head, so its changes
are skipped. Re-run the failed workflow run, or release the Actors manually.

## Running tests (`test`)

`test` runs the repository's own vitest (the version in its `node_modules`, so the tests keep the lib version
the repository locked) on the builds it is given on stdin, and prints a report of the run for
[`notify`](#notifying-notify).

```bash
# A PR: test what was just built
... | npx apify-test-tools build --version-number 0.99 | npx apify-test-tools test > test-report.json

# Scheduled tests: every Actor's default build, nothing on stdin
npx apify-test-tools test --all test/platform/core > test-report.json

# Extra vitest flags go after --
npx apify-test-tools test --all -- -t 'finishes'
```

The input is the JSON array `build` and `build-from-local` print. A dry-run plan, empty or invalid input is an
error, as with `build`. `--all` reads no stdin and runs the tests of every Actor against its default build, which
is what `RUN_ALL_PLATFORM_TESTS=1` did. Both only come from these flags: `test` drops `ACTOR_BUILDS` and
`RUN_ALL_PLATFORM_TESTS` from its own environment.

It runs vitest with `--maxConcurrency=20 --fileParallelism --maxWorkers=100`, since platform tests mostly wait on
Actor runs rather than the CPU, and with its JSON reporter for the report. Passing one of those options after `--`
replaces ours, e.g. `-- --maxConcurrency 5` to debug a flaky test.

| Argument / flag        | Default         | Meaning                                                             |
| ---------------------- | --------------- | ------------------------------------------------------------------- |
| `[filters..]`          | `test/platform` | Test files to run, as vitest filters                                |
| `--all`                | `false`         | Test every Actor's default build instead of reading builds on stdin |
| `--vitest-output-file` |                 | Also keep vitest's own JSON report there, e.g. to upload it         |
| after `--`             |                 | Passed to vitest as they are                                        |

Vitest's own output goes to stderr, followed by a summary that lists every test with the link to its run. Stdout
gets only the report:

```json
{
    "version": 1,
    "success": false,
    "summary": { "total": 3, "passed": 1, "failed": 1, "skipped": 1 },
    "tests": [
        {
            "name": "john.doe/my-actor: finishes",
            "file": "test/platform/my-actor.test.ts",
            "status": "failed",
            "durationMs": 61234,
            "failureMessages": ["AssertionError: expected 'FAILED' to be 'SUCCEEDED'"],
            "run": { "actorId": "john.doe/my-actor", "runId": "…", "runLink": "https://console.apify.com/view/runs/…" }
        }
    ],
    "errors": ["test/platform/other.test.ts: Cannot find package 'foo'"]
}
```

`failureMessages` keeps the first line of each failure; diffs and stack traces are in the vitest output. `run` is
`null` for a test that started no run. `errors` lists what failed outside of any test: a test file that failed to
load, or vitest exiting without a report. `test` exits with 1 whenever `success` is false, and prints the report
anyway, so `notify` still hears about the failure.

## Notifying (`notify`)

`notify` tells one target about what it reads on stdin: a test run, as [`test`](#running-tests-test) reports it,
or a release, as [`get-affected-actors`](#finding-affected-actors-get-affected-actors) reports it. It tells the two
apart by their fields, so either can be piped in as it is. Slack is the only target for now. To post to more
places, call it once for each.

```bash
# A test run: posts only when the tests failed, the outcome and the first failure, linked to its run,
# with the other failures in the message's thread
npx apify-test-tools notify --slack-channel '#notif-my-repo' < test-report.json
npx apify-test-tools notify --slack-channel '#my-team' < test-report.json

# Or straight from test. With `set -o pipefail` (`shell: bash` in GitHub Actions), failed tests still fail the pipe
npx apify-test-tools test --all | npx apify-test-tools notify --slack-channel '#notif-my-repo'

# A release, see Releasing Actors
npx apify-test-tools get-affected-actors --since <sha> | npx apify-test-tools notify --slack-channel '#notif-my-repo'
```

| Flag              | Input   | Default                  | Meaning                                                           |
| ----------------- | ------- | ------------------------ | ----------------------------------------------------------------- |
| `--slack-channel` | both    |                          | Slack channel to post to                                          |
| `--on`            | tests   | `failure`                | `failure` posts only when the tests failed, `always` on every run |
| `--title`         | tests   | the GitHub workflow name | What the message calls the run                                    |
| `--job-url`       | tests   | the GitHub Actions run   | Where the message links to                                        |
| `--repo-url`      | release | the `origin` remote      | The repository the release is named after and its commits link to |

A flag the input has no use for, e.g. `--repo-url` with a test report, is an error rather than ignored. Both kinds
of notification post with `SLACK_BOT_TOKEN`.

Without a target, `notify` posts nothing and needs no token. With one, it checks the token on every run, also when
there is nothing to post, so a broken token shows up on a green run rather than on the day tests fail. A release
with no new commits is the exception: there is nothing to announce, so it needs no token either.

For a release, `notify` posts the changelog additions, then the commits, oldest first. Each commit is its title (cut
at 200 characters) linked to its page on GitHub, and its author. A merge commit or a squash merge is one commit; a
rebase merge lists every commit it brought. A repository hosted elsewhere gets the titles without links. The release
is named after the `origin` remote (or `--repo-url`) and the author of the newest commit. Nothing is posted when there
are no new commits:

```text
*my-repo* – New release (by Jane Doe):

- Fixed pagination on the search page

*Commits*:
1. <https://github.com/my-org/my-repo/commit/1a2b3c…|fix: pagination on the search page> – Jane Doe
```

## Deleting old builds (`delete-old-builds`)

Deletes builds older than 30 days of every selected Actor. It never deletes the default build, or a build tagged
`latest`, `version…`, `v-…` or `v0`–`v9…`. A build tagged `devel` is kept for only 7 days.

| Flag        | Default | Meaning                                                     |
| ----------- | ------- | ----------------------------------------------------------- |
| `--actors`  | all     | Only these Actors                                           |
| `--ignore`  | none    | Never these Actors                                          |
| `--dry-run` | `false` | List the builds that would be deleted without deleting them |

## Listing Actors (`get-actor-configs`)

Prints the [config](../README.md#config-file) as the tool resolves it: one entry per Actor, with the group's values
applied and `actor.json` read. Takes `--actors` and `--ignore`. Useful to check a config change.

## Running locally

Running the tests locally is useful when you only want to update the testing code in `test/`, because you can
iterate on it without pushing new code to the remote. If you only change tests, skip the builds entirely and run
them against the default builds, see [Running tests locally](lib.md#running-tests-locally).

To test changed Actor source, you need builds of it. The quickest way is
[`build-from-local`](#build-from-local-source-build-from-local), which needs no push:

```bash
APIFY_TOKEN_JOHN_DOE=apify_api_xxx \
    npx apify-test-tools build-from-local --actors john.doe/my-actor > builds.json
```

To build from git, like CI does:

1. Switch to a dummy branch that you will push and can later delete
2. `npm i apify-test-tools@latest -D`
3. Push your code (changes you want to test)
4. Build the Actors on Apify (with your new code)
5. Run tests against those builds. You can change tests and run on the same builds.

```bash
npx apify-test-tools get-affected-actors --base origin/master --test-files-glob 'test/platform/**' \
    | jq '{ actors: .functionallyChangedActors }' \
    | APIFY_TOKEN_JOHN_DOE=apify_api_xxx npx apify-test-tools build --version-number 0.99 > builds.json
```

Run it with your dummy branch checked out: it builds the Actors that branch changed functionally, from the branch as
it is on the remote, into the test version `0.99`. Add `--dry-run` to `build` to print the plan (the version and Git
URL each Actor would be built from) first, and update `--base` to the branch you compare against. Tests only run for
Actors in `ACTOR_BUILDS`, so pass `--test-files-glob` to count test changes even when `.dockerignore` lists them.

If you want to test against existing builds instead, skip the build and write the build array by hand, only for the
Actors you need to test.

Then run the tests against the builds with [`test`](#running-tests-test), as often as you like:

```bash
TESTER_APIFY_TOKEN=apify_api_yyy npx apify-test-tools test < builds.json
```

## Legacy git commands

`get-commits`, `get-latest-commit` and `get-changed-files` print the commits, the newest commit, or the changed files
on `--source-branch` since it diverged from `--target-branch` (optionally only after `--base-commit`). They predate
`get-affected-actors`, which reports the same data, and are kept for older workflows.
