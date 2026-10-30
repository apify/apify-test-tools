# Workflow API

Ready-made GitHub Actions workflows built on the [CLI](cli.md) and the [vitest library](lib.md). They are the
`public_`-prefixed files in this repo's `.github/workflows`. Call them from a job with `uses:` and pass the secrets
the workflow lists, see [Secrets](#secrets):

```yaml
jobs:
    myJob:
        uses: apify/apify-test-tools/.github/workflows/<workflow>.yaml@workflows-v0
        with:
            # inputs, if any
        secrets:
            # the secrets the workflow lists
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
3. Runs [`test`](cli.md#running-tests-test) on `./test/platform/<test-files-glob>` with those builds, so only the
   tests of the built Actors run.
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

| Input                      | Type    | Default | Description                                                                                                              |
| -------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `skip-platform-tests`      | boolean | `false` | Skip the `platformTest` job and run the static checks only                                                               |
| `test-files-glob`          | string  | `''`    | Which tests to run, relative to `test/platform`. Empty runs everything in it                                             |
| `require-env-vars-in-sync` | boolean | `true`  | Fail the build unless the env var names of `0.99` match the default version's, see [Env var check](cli.md#env-var-check) |

Secrets: `TESTER_APIFY_TOKEN`, the Actor tokens in `CONFIG_SECRETS`, and optionally `NPM_TOKEN`. With
`skip-platform-tests`, only `NPM_TOKEN`.

A new push to the same PR cancels the run in progress.

```yaml
name: PR Test

on:
    pull_request:
        branches: [master]

jobs:
    buildDevelAndTest:
        uses: apify/apify-test-tools/.github/workflows/public_pr-build-test.yaml@workflows-v0
        secrets:
            TESTER_APIFY_TOKEN: ${{ secrets.TESTER_APIFY_TOKEN }}
            # One entry per secret apify-test-tools.config.json names, today each `tokenEnvVar`
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

## `public_push-build-latest.yaml`

Releases the Actors a push changed. Skipped when the head commit message contains `[skip ci]` or
`[skip platform-test]`. It runs one step per CLI command:

1. `get-affected-actors --since ${{ github.event.before }}` finds everything the push changed. See
   [Releasing Actors](cli.md#releasing-actors) for how the released range is determined.
2. `build --version-number default` builds both the functionally and the cosmetically changed Actors into their
   default version, the one users run.
3. [`notify`](cli.md#notifying-notify) posts the release (its changelog additions and its commits, linked to
   GitHub) to the report channel. It posts nothing when the push brought no new commits.
4. `delete-old-builds` deletes old builds of every Actor in the config (see
   [`delete-old-builds`](cli.md#deleting-old-builds-delete-old-builds)).

| Input                  | Type   | Default | Description                                                   |
| ---------------------- | ------ | ------- | ------------------------------------------------------------- |
| `report-slack-channel` | string | `''`    | Slack channel for the report. Empty uses `#notif-<repo-name>` |

Secrets: `SLACK_BOT_TOKEN`, the Actor tokens in `CONFIG_SECRETS`, and optionally `NPM_TOKEN`.

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
        secrets:
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
            # One entry per secret apify-test-tools.config.json names, today each `tokenEnvVar`
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

## `public_platform-tests.yaml`

Runs the platform tests against the Actors' current default builds with [`test --all`](cli.md#running-tests-test), so
every test runs, not only those of built Actors. A separate step then posts failures to Slack with
[`notify`](cli.md#notifying-notify), so the Slack token never reaches the tests. Both the report of `test` and
vitest's own JSON report are uploaded as the `vitest-results` artifact. Runs only on `master` or `main`.

| Input                  | Type   | Default | Description                                                                  |
| ---------------------- | ------ | ------- | ---------------------------------------------------------------------------- |
| `test-files-glob`      | string | `''`    | Which tests to run, relative to `test/platform`. Empty runs everything in it |
| `subtest`              | string | `''`    | Deprecated, use `test-files-glob`                                            |
| `report-slack-channel` | string | `''`    | Slack channel for the results. Empty uses `#notif-<repo-name>`               |

Secrets: `TESTER_APIFY_TOKEN` (required), `SLACK_BOT_TOKEN`, and optionally `NPM_TOKEN`.

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
        secrets:
            TESTER_APIFY_TOKEN: ${{ secrets.TESTER_APIFY_TOKEN }}
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
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
        secrets:
            TESTER_APIFY_TOKEN: ${{ secrets.TESTER_APIFY_TOKEN }}
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
```

## `public_review.yaml`

Optional. Reviews a PR against the shared guidelines when you add the trigger label, and again on every push while
that label is on. The trigger label is removed once the review finishes, so re-applying it asks for another review.

| Input            | Type   | Default             | Description                                                                                   |
| ---------------- | ------ | ------------------- | --------------------------------------------------------------------------------------------- |
| `label`          | string | `Ask claude review` | Label that triggers a review                                                                  |
| `reviewed-label` | string | `claude reviewed`   | Label added after a successful review and never removed. Set to `''` to disable               |
| `prompt-ref`     | string | `''`                | Ref of this repo to fetch the review instructions from. Override only to test a prompt change |
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
        secrets:
            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The review instructions live in `.github/review-prompt.md` in this repo and are fetched at run time, because a
reusable workflow doesn't get its own repo checked out. When `prompt-ref` is empty they come from the same commit as
the workflow you're calling — point it at a branch only to test a prompt change.

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
        secrets:
            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
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
        secrets:
            TESTER_APIFY_TOKEN: ${{ secrets.TESTER_APIFY_TOKEN }}
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}

    handle-failure:
        needs: platformTestsHourly
        if: ${{ failure() }}
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests-claude-investigate-and-fix.yaml@workflows-v0
        secrets:
            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
            TESTER_APIFY_TOKEN: ${{ secrets.TESTER_APIFY_TOKEN }}
```

## Secrets

The workflows take two kinds of secrets:

- **Secrets a workflow always reads**, like `TESTER_APIFY_TOKEN` for the tests or `NPM_TOKEN` for installing private
  packages. Each workflow declares these, and you pass them by name.
- **Secrets your `apify-test-tools.config.json` names**, today each Actor's `tokenEnvVar`. Their names differ per
  repo, and a reusable workflow only accepts secrets it declares by name, so they go packed in one JSON object,
  `CONFIG_SECRETS`, with one entry per name the config uses. A name the config declares but the object leaves out
  is reported as a warning in the build step.

The examples above show both. If you'd rather not keep `CONFIG_SECRETS` in sync with the config, you can pass all of
the repo's secrets in it:

```yaml
secrets:
    TESTER_APIFY_TOKEN: ${{ secrets.TESTER_APIFY_TOKEN }}
    CONFIG_SECRETS: ${{ toJSON(secrets) }}
```

Only the names the config declares are used. The cost is that every secret the repo can read, deploy keys and publish
tokens included, goes to code at a tag this repo moves, and you are trusting it to use only those.

Repos in the `apify` org can keep using `secrets: inherit`, which GitHub only allows when the caller is in the same
organization or enterprise as this repo. The config's secrets are then looked up among the inherited ones whenever
`CONFIG_SECRETS` doesn't have them.

`required` on a reusable workflow's secret only checks that the caller lists it, not that it has a value: the repo
may not have the secret, and PRs from forks never get secrets. The test workflows check that `TESTER_APIFY_TOKEN` is
not empty before doing anything else, and fail with a message saying so.

Values that arrive inside `CONFIG_SECRETS` are registered as masks one by one before anything uses them. The runner
masks a secret by its exact value, so it would otherwise only recognise the whole JSON blob, not a single token taken
out of it.

The workflows do not turn the secrets they receive into job-wide environment variables, so a secret is only visible
to the step that needs it:

| Secret                                                                    | Reaches                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                                                               | dependency install steps only, as both `NPM_TOKEN` and `NODE_AUTH_TOKEN`. Use a read-only token: npm granular tokens can be read-only, classic automation tokens can publish.                                              |
| the Actor tokens named by `tokenEnvVar` in `apify-test-tools.config.json` | the build and `delete-old-builds` steps only                                                                                                                                                                               |
| `TESTER_APIFY_TOKEN`                                                      | the test step, and the Claude investigation step: the Apify MCP server's bearer token for reading the failing run, its log and its storages, and Claude's token for re-running it to measure how often the failure happens |
| `SLACK_BOT_TOKEN`                                                         | the `notify` steps only                                                                                                                                                                                                    |
| `ANTHROPIC_API_KEY`                                                       | the Claude steps of the Claude workflows only                                                                                                                                                                              |

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

Whatever ref you call a workflow at, it runs the setup action and the CLI from that same commit. Pinning a commit SHA
or pointing at a branch of this repo therefore gets you that commit's workflows as a whole.

`@workflows-v0` always points at the latest workflows, so fixes and new features reach you without any change on your
side. Changes that would break callers go to a new tag (`@workflows-v1`), and `@workflows-v0` keeps working, so you
can migrate when it suits you.
