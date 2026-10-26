# Workflow API

Ready-made GitHub Actions workflows built on the [CLI](cli.md) and the [vitest library](lib.md). They are the
`public_`-prefixed files in this repo's `.github/workflows`. Call them from a job with `uses:` and pass
`secrets: inherit`:

```yaml
jobs:
    myJob:
        uses: apify/apify-test-tools/.github/workflows/<workflow>.yaml@workflows-v0
        with:
            # inputs, if any
        secrets: inherit
```

Always reference them at the `@workflows-v0` major tag, never at `@master` — see [Versioning](#versioning).

They only run on GitHub Actions. On another CI platform, build the same steps with the [CLI](cli.md); each workflow
The build, release and test workflows below list the CLI commands they run.

| Workflow                                                                                                         | Typical trigger                     | What it does                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| [`public_pr-build-test.yaml`](#public_pr-build-testyaml)                                                         | `pull_request`                      | Builds the Actors a PR changes into `0.99` and tests them, plus static checks    |
| [`public_push-build-latest.yaml`](#public_push-build-latestyaml)                                                 | `push` to `master`                  | Builds the changed Actors into their default version and announces the release   |
| [`public_platform-tests.yaml`](#public_platform-testsyaml)                                                       | `schedule`                          | Runs platform tests against the released builds and reports results to Slack     |
| [`public_review.yaml`](#public_reviewyaml)                                                                       | `pull_request` (labeled)            | Claude reviews the PR against the shared guidelines                              |
| [`public_claude.yaml`](#public_claudeyaml)                                                                       | issue and PR comments, issue labels | Claude acts on `@claude` mentions                                                |
| [`public_platform-tests-claude-investigate-and-fix.yaml`](#public_platform-tests-claude-investigate-and-fixyaml) | after a failed platform test job    | Claude investigates a failing platform test, opens an issue, and tries to fix it |

All of them run on `ubuntu-latest` with Node.js 24. The ones that need the repo's dependencies install them with
`npm ci`, or with pnpm when the repo has a `pnpm-lock.yaml` and no `package-lock.json`.

## `public_pr-build-test.yaml`

Validates a pull request. It runs two jobs in parallel.

**`platformTest`** builds and tests the Actors the PR changes:

1. Finds the affected Actors with [`get-affected-actors`](cli.md#finding-affected-actors-get-affected-actors),
   comparing the PR branch with its base branch. Changed files under `test/platform/**` count even when
   `.dockerignore` lists them.
2. Builds the functionally changed Actors into the test version `0.99` with [`build`](cli.md#building-actors-build).
   Cosmetic-only changes (README, CHANGELOG, schema formatting) need no tests, so they're not built.
3. Runs `npx vitest ./test/platform/<test-files-glob>` with those builds in `ACTOR_BUILDS`, so only the tests of
   the built Actors run.
4. On success, caches the tested commit as the "last validated commit". The next push to the PR then only builds
   and tests the Actors that changed since it (see `--since` in
   [`get-affected-actors`](cli.md#finding-affected-actors-get-affected-actors)).

**`unitTest`** runs static checks against the repo, using the repo's own scripts where they exist:

| Check          | Runs                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| TypeScript     | `npm run build-check` if the script exists, else `npx tsc --noEmit`                         |
| Lint           | `npm run lint`                                                                              |
| Test           | `npm test`                                                                                  |
| Formatter      | `npm run format:check` if it exists, else `npx prettier --check .` if prettier is installed |
| Unused exports | `npm run check-unused` if it exists                                                         |

In a repo whose Actors aren't written in JavaScript or TypeScript, define the `build-check`, `lint` and `test`
scripts, e.g. to run your language's own checks: without them, the TypeScript, Lint and Test checks fail.

| Input                 | Type    | Default | Description                                                                  |
| --------------------- | ------- | ------- | ---------------------------------------------------------------------------- |
| `skip-platform-tests` | boolean | `false` | Skip the `platformTest` job and run the static checks only                   |
| `test-files-glob`     | string  | `''`    | Which tests to run, relative to `test/platform`. Empty runs everything in it |

Secrets: the Actor tokens, `TESTER_APIFY_TOKEN`, and optionally `NPM_TOKEN`.

A new push to the same PR cancels the run in progress.

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

## `public_push-build-latest.yaml`

Releases the Actors a push changed. Skipped when the head commit message contains `[skip ci]` or
`[skip platform-test]`. It runs one step per CLI command:

1. `get-affected-actors --since ${{ github.event.before }}` finds everything the push changed. See
   [Releasing Actors](cli.md#releasing-actors) for how the released range is determined.
2. `build --version-number default` builds both the functionally and the cosmetically changed Actors into their
   default version, the one users run.
3. `notify-release` posts the changelog additions to `#delivery-public-actors`, and the commits and changed files to
   the report channel. It posts nothing when the push brought no new commits.
4. `delete-old-builds` deletes old builds of every Actor in the config (see
   [`delete-old-builds`](cli.md#deleting-old-builds-delete-old-builds)).

| Input                  | Type   | Default | Description                                                   |
| ---------------------- | ------ | ------- | ------------------------------------------------------------- |
| `report-slack-channel` | string | `''`    | Slack channel for the report. Empty uses `#notif-<repo-name>` |

Secrets: the Actor tokens, `SLACK_TOKEN_RELEASES_BOT`, and optionally `NPM_TOKEN`.

A failed release isn't retried by the next push: that push's "before" commit is the failed one's head, so its changes
are skipped. Re-run the failed workflow run, or release the Actors manually.

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

## `public_platform-tests.yaml`

Runs the platform tests against the Actors' current default builds, with `RUN_ALL_PLATFORM_TESTS=1` so every test
runs, not only those of built Actors. It then reports the results to Slack with
[`report-tests`](cli.md#reporting-test-results-report-tests) and uploads the vitest JSON report as the
`vitest-results` artifact. Runs only on `master` or `main`.

| Input                  | Type   | Default | Description                                                                  |
| ---------------------- | ------ | ------- | ---------------------------------------------------------------------------- |
| `test-files-glob`      | string | `''`    | Which tests to run, relative to `test/platform`. Empty runs everything in it |
| `subtest`              | string | `''`    | Deprecated, use `test-files-glob`                                            |
| `report-slack-channel` | string | `''`    | Slack channel for the results. Empty uses `#notif-<repo-name>`               |

Secrets: `TESTER_APIFY_TOKEN`, `SLACK_TOKEN_TESTS_BOT`, and optionally `NPM_TOKEN`.

How often to run which tests is up to you. For example, every test once a day:

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

and a few critical tests, kept in e.g. `test/platform/hourly`, every hour:

```yaml
name: Platform tests - Hourly

on:
    schedule:
        # Runs at the start of every hour
        - cron: '0 * * * *'
    workflow_dispatch:

jobs:
    platformTestsHourly:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v0
        with:
            test-files-glob: hourly
        secrets: inherit
```

## `public_review.yaml`

Optional. Reviews a PR against the shared guidelines when you add the trigger label, and again on every push while
that label is on. The trigger label is removed once the review finishes, so re-applying it asks for another review.

| Input            | Type   | Default             | Description                                                                                   |
| ---------------- | ------ | ------------------- | --------------------------------------------------------------------------------------------- |
| `label`          | string | `Ask claude review` | Label that triggers a review                                                                  |
| `reviewed-label` | string | `claude reviewed`   | Label added after a successful review and never removed. Set to `''` to disable               |
| `prompt-ref`     | string | `workflows-v0`      | Ref of this repo to fetch the review instructions from. Override only to test a prompt change |
| `model`          | string | `sonnet`            | Claude Code model (`best`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`)   |

Secrets: `ANTHROPIC_API_KEY`.

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

The review instructions live in `.github/review-prompt.md` in this repo and are fetched at run time, because a
reusable workflow doesn't get its own repo checked out. `prompt-ref` defaults to `workflows-v0`, so the
instructions match the workflow you're calling — point it at a branch only to test a prompt change.

## `public_claude.yaml`

Optional. Runs Claude Code when someone mentions `@claude` in an issue, an issue or PR comment, or a PR review, or
labels an issue `claude` (unless it is also labeled `claude:done`). On a PR it pushes to the PR's branch; on an issue
it opens a PR. It also picks up a "changes requested" review on PRs Claude opened.

| Input                 | Type   | Default  | Description                                                                                                  |
| --------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| `model`               | string | `sonnet` | Claude Code model (`best`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`)                  |
| `extra_allowed_tools` | string | `''`     | Comma-separated tool patterns appended to `--allowedTools`, e.g. `Bash(npm run e2e),Bash(npm run typecheck)` |

Secrets: `ANTHROPIC_API_KEY`.

```yaml
name: Claude

on:
    issue_comment:
        types: [created]
    pull_request_review_comment:
        types: [created]
    pull_request_review:
        types: [submitted]
    issues:
        types: [opened, labeled]

jobs:
    claude:
        uses: apify/apify-test-tools/.github/workflows/public_claude.yaml@workflows-v0
        secrets: inherit
```

## `public_platform-tests-claude-investigate-and-fix.yaml`

Optional. Call it after a failed platform test job. It runs in two phases:

1. **investigate** — Claude reviews the test logs, recent workflow runs and existing issues, and investigates the
   failing run on the Apify platform (its log, dataset and key-value store). It opens a GitHub issue with its
   findings and labels it `claude`, or does nothing if a matching issue already exists.
2. **fix** — runs only when the first phase opened an issue. Claude implements a fix, opens a PR, and labels the
   issue `claude:done`.

Scheduled runs use a `GITHUB_TOKEN` that cannot trigger other workflows, so the fix phase is a direct job
dependency rather than a label-triggered run of `public_claude.yaml`.

| Input                | Type   | Default    | Description                                                                                              |
| -------------------- | ------ | ---------- | -------------------------------------------------------------------------------------------------------- |
| `model`              | string | `sonnet`   | Claude model for both phases                                                                             |
| `effort`             | string | `''`       | Claude effort level (`low`, `medium`, `high`, `xhigh`, `max`). Empty uses the Claude Code default        |
| `max_flakiness_runs` | number | `200`      | The most times Claude may re-run the failing Actor run to measure how often the failure happens          |
| `investigate_prompt` | string | (built in) | Prompt for the investigation phase. Override to change how issues are investigated, titled and described |

Secrets: `ANTHROPIC_API_KEY`, `TESTER_APIFY_TOKEN`, and optionally `NPM_TOKEN`.

```yaml
jobs:
    platformTestsHourly:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v0
        with:
            test-files-glob: hourly
        secrets: inherit

    handle-failure:
        needs: platformTestsHourly
        if: ${{ failure() }}
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests-claude-investigate-and-fix.yaml@workflows-v0
        secrets: inherit
```

## Secrets

Callers pass `secrets: inherit`. The workflows do not turn every inherited secret into job-wide environment
variables, so a secret is only visible to the step that needs it:

| Secret                                                                    | Reaches                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                                                               | dependency install steps only, as both `NPM_TOKEN` and `NODE_AUTH_TOKEN`. Use a read-only token: npm granular tokens can be read-only, classic automation tokens can publish.                                                |
| the Actor tokens named by `tokenEnvVar` in `apify-test-tools.config.json` | the build and `delete-old-builds` steps only                                                                                                                                                                                 |
| `TESTER_APIFY_TOKEN`                                                      | the vitest step, and the Claude investigation step: the Apify MCP server's bearer token for reading the failing run, its log and its storages, and Claude's token for re-running it to measure how often the failure happens |
| `SLACK_TOKEN_TESTS_BOT` / `SLACK_TOKEN_RELEASES_BOT`                      | the reporting and announcement steps only                                                                                                                                                                                    |
| `ANTHROPIC_API_KEY`                                                       | the Claude steps of the Claude workflows only                                                                                                                                                                                |

The Actor tokens reach the build only for the Actors your config declares: a secret that merely looks like an Actor
token is not passed on. A token the config declares but the repo hasn't set is a warning, not a failure: a repo can
carry an Actor whose token isn't configured and still build fine as long as that Actor never changes. The build fails
with an error naming the Actor once it actually needs the token.

The `unitTest` job runs static checks and needs `NPM_TOKEN` only. No job runs `npm ci` or `pnpm install` with Apify
or Slack credentials in scope, so a postinstall script in the dependency tree cannot read them.

## Versioning

The workflows and the vitest library ship separately:

| What                                             | You get it through                        | Updates when                     |
| ------------------------------------------------ | ----------------------------------------- | -------------------------------- |
| the workflows and the CLI they run               | the `@workflows-v0` tag in `uses:`        | every change merged to this repo |
| the library (`testActor`, `describe`, matchers…) | `apify-test-tools` in your `package.json` | you update the package           |

The workflows bring their own copy of the CLI, so they don't use or change the `apify-test-tools` version in your
`node_modules`, and your tests keep the library version you locked.

`@workflows-v0` always points at the latest workflows, so fixes and new features reach you without any change on your
side. Changes that would break callers go to a new tag (`@workflows-v1`), and `@workflows-v0` keeps working, so you
can migrate when it suits you.
