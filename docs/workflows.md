# Workflow API

Ready-made GitHub Actions workflows built on the [CLI](cli.md) and the [Vitest library](lib.md). They are the
`public_`-prefixed files in this repo's `.github/workflows`. Call them from a job with `uses:` and pass the secrets the
workflow lists (see [Secrets](#secrets)):

```yaml
jobs:
    myJob:
        uses: apify/apify-test-tools/.github/workflows/<workflow>.yaml@workflows-v1
        with:
            # inputs, if any
        secrets:
            # the secrets the workflow lists
```

Always reference them at the `@workflows-v1` major tag, never at `@master`. See [Versioning](#versioning).

They only run on GitHub Actions. On another CI platform, build the same steps with the [CLI](cli.md): the build,
release, and test workflows below list the CLI commands they run.

| Workflow                                                                                                         | Typical trigger                           | What it does                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| [`public_pr-build-test.yaml`](#public_pr-build-testyaml)                                                         | `pull_request`                            | Builds the Actors a PR changes into `0.99` and tests them, plus static checks    |
| [`public_push-build-latest.yaml`](#public_push-build-latestyaml)                                                 | `push` to `master`                        | Builds the changed Actors into their default version and announces the release   |
| [`public_platform-tests.yaml`](#public_platform-testsyaml)                                                       | `schedule`                                | Runs platform tests against the released builds and reports failures to Slack    |
| [`public_review.yaml`](#public_reviewyaml)                                                                       | `pull_request` (`labeled`, `synchronize`) | Claude reviews the PR against the shared guidelines                              |
| [`public_claude.yaml`](#public_claudeyaml)                                                                       | issue and PR comments, issue labels       | Claude acts on `@claude` mentions                                                |
| [`public_stale-issues.yaml`](#public_stale-issuesyaml)                                                           | `schedule`                                | Warns owners of inactive issues, then closes them a month later                  |
| [`public_platform-tests-claude-investigate-and-fix.yaml`](#public_platform-tests-claude-investigate-and-fixyaml) | after a failed platform test job          | Claude investigates a failing platform test, opens an issue, and tries to fix it |

All of them run on `ubuntu-latest`. The jobs that need the repo's dependencies set up Node.js 24 and install them with
`npm ci`, or with `pnpm install` when the repo has a `pnpm-lock.yaml` and no `package-lock.json`.

## `public_pr-build-test.yaml`

Validates a pull request with two parallel jobs. A new push to the same PR cancels the run in progress.

**`platformTest`** builds and tests the Actors the PR changes:

1. Finds the affected Actors with [`get-affected-actors`](cli.md#finding-affected-actors-get-affected-actors), comparing
   the PR branch with its base branch. Changed files that match `platformTestsGlob` in the config file (default
   `test/platform/**`) are test changes, even when `.dockerignore` lists them.
2. Builds the Actors with functional changes into the test version `0.99` with [`build`](cli.md#building-actors-build).
   An Actor with only test changes is tested on its default build if the branch didn't change its code, or on the build
   an earlier run of the PR made, while that build exists. Otherwise it is built too. Cosmetic-only changes (README,
   CHANGELOG, schema formatting) need no tests, so they're not built.
3. Runs [`test`](cli.md#running-tests-test) on the files that match `test-files-glob`, against the new and reused
   builds, so only the tests of those Actors run, each Actor with its test token. Failing tests are annotated on the PR.
4. If the tests pass, caches the tested commit as the "last validated commit", with the builds the PR tested. The next
   push to the PR then only builds and tests the Actors that changed since that commit (see `--since` in
   [`get-affected-actors`](cli.md#finding-affected-actors-get-affected-actors)). If GitHub evicts the cache, the next
   push checks and builds the whole branch again.

**`unitTest`** runs static checks, using the repo's own scripts where they exist:

| Check          | Runs                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript     | `npm run build-check` if the script exists, else `npx tsc --noEmit`                                                                |
| Lint           | `npm run lint`                                                                                                                     |
| Test           | `npm test`                                                                                                                         |
| Formatter      | `npm run format:check` if it exists, else `npx prettier --check .` if Prettier is installed                                        |
| Unused exports | `npm run check-unused` if it exists, else `knip` or `ts-unused-exports` if installed (in that order). Skipped when none is present |

If your Actors aren't written in JavaScript or TypeScript, define the `build-check`, `lint`, and `test` scripts (for
example, to run your language's own checks). Without them, the TypeScript, Lint, and Test checks fail.

| Input                      | Type    | Default            | Description                                                                                                                 |
| -------------------------- | ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `skip-platform-tests`      | boolean | `false`            | Skip the `platformTest` job and run the static checks only                                                                  |
| `test-files-glob`          | string  | `test/platform/**` | Glob of the test files to run, from the repo root. Empty means the default. See [Splitting the tests](#splitting-the-tests) |
| `require-env-vars-in-sync` | boolean | `true`             | Fail the build unless the env var names of `0.99` match the default version's. See [Env var check](cli.md#env-var-check)    |

Secrets: `CONFIG_SECRETS` with each Actor's `buildTokenEnvVar` and `testTokenEnvVar`, and optionally `NPM_TOKEN`. With
`skip-platform-tests`, only `NPM_TOKEN`.

```yaml
name: PR Test

on:
    pull_request:
        branches: [master]

jobs:
    buildAndTest:
        uses: apify/apify-test-tools/.github/workflows/public_pr-build-test.yaml@workflows-v1
        with:
            # Leaves out the *-without-pr folders, see "Splitting the tests"
            test-files-glob: 'test/platform/{daily,hourly}/**'
        secrets:
            # One entry per secret apify-test-tools.config.json names: each `buildTokenEnvVar` and `testTokenEnvVar`
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
2. `build --version-number default` builds the functionally and the cosmetically changed Actors into their default
   version, the one users run. A push that only changes platform tests builds nothing.
3. [`notify`](cli.md#notifying-notify) posts the release (its changelog additions and its commits, linked to GitHub) to
   `report-slack-channel`. It posts nothing when the channel is empty or the push brought no new commits.
4. [`delete-old-builds`](cli.md#deleting-old-builds-delete-old-builds) deletes old builds of every Actor in the config.

| Input                  | Type   | Default | Description                                      |
| ---------------------- | ------ | ------- | ------------------------------------------------ |
| `report-slack-channel` | string | `''`    | Slack channel for the release. Empty skips Slack |

Secrets: `CONFIG_SECRETS` with each Actor's `buildTokenEnvVar`, `SLACK_BOT_TOKEN` when `report-slack-channel` is set,
and optionally `NPM_TOKEN`.

The next push doesn't retry a failed release: its "before" commit is the failed push's head, so the failed push's
changes are skipped. Re-run the failed workflow run, or release the Actors manually.

```yaml
name: Release latest

on:
    push:
        branches: [master]

jobs:
    buildLatest:
        uses: apify/apify-test-tools/.github/workflows/public_push-build-latest.yaml@workflows-v1
        with:
            report-slack-channel: '#notif-my-repo'
        secrets:
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
            # One entry per secret apify-test-tools.config.json names, here each `buildTokenEnvVar`
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

## `public_platform-tests.yaml`

Runs the platform tests of every Actor in the config against its current default build, by piping
[`get-actor-configs`](cli.md#listing-actors-get-actor-configs) into [`test`](cli.md#running-tests-test). Runs only on
`master` or `main`.

A separate [`notify`](cli.md#notifying-notify) step then posts failures to `report-slack-channel`, titled with the
calling workflow's name and linking to the run, so the Slack token never reaches the tests. It posts nothing when the
tests pass or the channel is empty. The report of `test` and Vitest's JSON report are uploaded as the `vitest-results`
artifact.

| Input                  | Type   | Default            | Description                                                                                                                 |
| ---------------------- | ------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `test-files-glob`      | string | `test/platform/**` | Glob of the test files to run, from the repo root. Empty means the default. See [Splitting the tests](#splitting-the-tests) |
| `report-slack-channel` | string | `''`               | Slack channel for failed tests. Empty skips Slack                                                                           |

Secrets: `CONFIG_SECRETS` with each Actor's `testTokenEnvVar`, `SLACK_BOT_TOKEN` when `report-slack-channel` is set,
and optionally `NPM_TOKEN`.

How often to run which tests is up to you (see [Splitting the tests](#splitting-the-tests)). For example, the daily
tests once a day:

```yaml
name: Platform tests - Daily

on:
    schedule:
        # Runs at 00:00 UTC every day
        - cron: '0 0 * * *'
    workflow_dispatch:

jobs:
    platformTestsDaily:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v1
        with:
            test-files-glob: 'test/platform/{daily,daily-without-pr}/**'
            report-slack-channel: '#notif-my-repo'
        secrets:
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

and a few critical tests every hour:

```yaml
name: Platform tests - Hourly

on:
    schedule:
        # Runs at the start of every hour
        - cron: '0 * * * *'
    workflow_dispatch:

jobs:
    platformTestsHourly:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v1
        with:
            test-files-glob: 'test/platform/{hourly,hourly-without-pr}/**'
            report-slack-channel: '#notif-my-repo'
        secrets:
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }
```

## Splitting the tests

`test-files-glob` is one glob from the repo root, for example `test/platform/**`. Both test workflows take it, and it
only selects which tests run. Which changed files count as test changes is a separate setting, `platformTestsGlob` in
the config file (default `test/platform/**`). So on a PR, a change to a `*-without-pr` test or to a shared helper still
builds and tests the Actors, even though the PR doesn't run that test.

Most repos split `test/platform` into folders by how often the tests run, and by whether a PR runs them:

| Folder                            | Runs                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `test/platform/hourly`            | every hour and on every PR                                      |
| `test/platform/daily`             | once a day and on every PR                                      |
| `test/platform/hourly-without-pr` | every hour only (for example, tests too slow or costly for PRs) |
| `test/platform/daily-without-pr`  | once a day only                                                 |

Each workflow then selects its folders with a brace pattern:

| Job                                   | `test-files-glob`                             |
| ------------------------------------- | --------------------------------------------- |
| PR (`public_pr-build-test.yaml`)      | `test/platform/{daily,hourly}/**`             |
| Hourly (`public_platform-tests.yaml`) | `test/platform/{hourly,hourly-without-pr}/**` |
| Daily (`public_platform-tests.yaml`)  | `test/platform/{daily,daily-without-pr}/**`   |

Write the glob to match files, not folders: `test/platform/hourly` matches no file, `test/platform/hourly/**` matches
every file in it. A glob that matches no file fails the test step, so a typo can't pass as a run with no tests. `test`
only runs the matched files that Vitest sees as test files, so a helper in the glob runs nothing.

## `public_review.yaml`

Optional. Reviews a PR against the shared guidelines when you add the trigger label. The label is removed when the
review finishes, so adding it again asks for another review. A push while the label is still on restarts the review on
the new commit.

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
        uses: apify/apify-test-tools/.github/workflows/public_review.yaml@workflows-v1
        secrets:
            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The review instructions live in `.github/review-prompt.md` in this repo. A reusable workflow doesn't get its own repo
checked out, so they are fetched at run time. When `prompt-ref` is empty, they come from the same commit as the
workflow you're calling.

## `public_claude.yaml`

Optional. Runs Claude Code when someone mentions `@claude` in an issue's title or body, an issue or PR comment, or a PR
review, or labels an issue `claude` (unless it also has `claude:done`). On a PR, Claude pushes to the PR's branch. On
an issue, it opens a PR and, when the run came from the `claude` label, labels the issue `claude:done`. It also acts on
a "changes requested" review of a PR Claude opened.

| Input                 | Type   | Default  | Description                                                                                                         |
| --------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `model`               | string | `sonnet` | Claude Code model (`best`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`)                         |
| `extra_allowed_tools` | string | `''`     | Comma-separated tool patterns appended to `--allowedTools`, for example `Bash(npm run e2e),Bash(npm run typecheck)` |

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
        uses: apify/apify-test-tools/.github/workflows/public_claude.yaml@workflows-v1
        secrets:
            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## `public_platform-tests-claude-investigate-and-fix.yaml`

Optional. Call it after a failed platform test job. It runs in two phases:

1. **Investigate:** Claude reviews the test logs, recent workflow runs, and existing issues, and investigates the
   failing run on the Apify platform (its log, dataset, and key-value store). It opens a GitHub issue with its findings
   and labels it `claude`, or does nothing if a matching issue already exists.
2. **Fix:** runs only when the first phase opened an issue. Claude implements a fix, opens a PR, and labels the issue
   `claude:done`.

Scheduled runs use a `GITHUB_TOKEN` that can't trigger other workflows, so the fix phase is a direct job dependency
rather than a label-triggered run of `public_claude.yaml`.

| Input                | Type   | Default    | Description                                                                                                                                                      |
| -------------------- | ------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`              | string | `sonnet`   | Claude model for both phases                                                                                                                                     |
| `effort`             | string | `''`       | Claude effort level (`low`, `medium`, `high`, `xhigh`, `max`). Empty uses the Claude Code default                                                                |
| `max_flakiness_runs` | number | `200`      | The most times Claude may re-run the failing Actor run to measure how often the failure happens                                                                  |
| `investigate_prompt` | string | (built in) | Prompt for the investigation phase. Override to change how issues are investigated, titled, and described                                                        |
| `priority_prompt`    | string | (built in) | Prompt for setting a new issue's Priority field from its impact and flakiness. Override to change how priority is judged, for example, to set revenue thresholds |
| `humanize_duty`      | string | `''`       | Where to record the developer who rewrites each new issue in plain language. `label` labels the issue `needs-humanize:<login>`. Off when empty                   |

`label` is the only supported `humanize_duty` value. It labels each new issue like `needs-humanize:alice`, in a separate
job that never holds up the investigate or fix phase. Any other value fails that job only.

The developers are the individual users on the `*` rule of the repo's CODEOWNERS (`.github/CODEOWNERS`, `CODEOWNERS`, or
`docs/CODEOWNERS`; the last `*` rule if there are several), in the order listed. Teams and emails are skipped. They take
turns: the next issue goes to the developer after the one most recently labeled `needs-humanize:<login>`. The first
issue, or one after that developer left CODEOWNERS, goes to a developer picked from the repo name, so repos don't all
start with the same person. The rotation reads the labels back from the issues, so removing one gives that developer
their turn again early. Without CODEOWNERS or any individual user on its `*` rule, the job logs a warning and adds no
label. It uses `GITHUB_TOKEN` and needs no extra setup.

Secrets: `ANTHROPIC_API_KEY`, `TESTER_APIFY_TOKEN`, and optionally `NPM_TOKEN`, `REDASH_API_KEY`, and
`AGENT_SKILLS_INTERNAL_GITHUB_TOKEN`.

Runs are private to the account that started them, so `TESTER_APIFY_TOKEN` must be the token the tests ran the failing
Actor with: its `testTokenEnvVar`.

```yaml
jobs:
    platformTestsHourly:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v1
        with:
            test-files-glob: 'test/platform/{hourly,hourly-without-pr}/**'
            report-slack-channel: '#notif-my-repo'
        secrets:
            SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
            CONFIG_SECRETS: |
                {
                    "APIFY_TOKEN_MYTEAM": "${{ secrets.APIFY_TOKEN_MYTEAM }}",
                    "APIFY_TOKEN_PARTNER": "${{ secrets.APIFY_TOKEN_PARTNER }}"
                }

    handle-failure:
        needs: platformTestsHourly
        if: ${{ failure() }}
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests-claude-investigate-and-fix.yaml@workflows-v1
        secrets:
            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
            # The token the tests ran the Actors with, so Claude can read the failing run
            TESTER_APIFY_TOKEN: ${{ secrets.APIFY_TOKEN_MYTEAM }}
```

## `public_stale-issues.yaml`

Optional. Wraps [`actions/stale`](https://github.com/actions/stale) to warn on inactive GitHub issues, then close them
as **not planned** 30 days later if still inactive. Locked issues are skipped. Pull requests use the same thresholds,
with the `Stale` label and no warning or closing comments.

| Input          | Type   | Default | Description                                                 |
| -------------- | ------ | ------- | ----------------------------------------------------------- |
| `stale-months` | number | `6`     | Whole number of inactive months (1–12). One month = 30 days |

```yaml
name: Close stale issues

on:
    schedule:
        - cron: '0 3 * * *'
    workflow_dispatch:

jobs:
    staleIssues:
        permissions:
            issues: write
        uses: apify/apify-test-tools/.github/workflows/public_stale-issues.yaml@workflows-v1
        with:
            stale-months: 6
```

With `stale-months: 6`, an issue is labeled `stale` and warned after 180 days without activity, then closed after
another 30 inactive days. When you adopt the workflow, older issues also get the full 30-day warning. Each scheduled run
acts on the issues past the threshold, and a large backlog is processed over several runs.

The warning comment reaches people through
[GitHub's normal issue notifications](https://docs.github.com/en/subscriptions-and-notifications/reference/inbox-filters)
(including for assigned issues), subject to each user's settings. It adds no @mentions. Any later activity removes the
`stale` label and restarts the inactivity period.

The caller must grant `issues: write`, as shown above. The workflow uses the automatic `GITHUB_TOKEN` and needs no
secrets, checkout, project dependencies, or Apify configuration.

## Secrets

The workflows take two kinds of secrets:

- **Secrets a workflow declares by name**, like `SLACK_BOT_TOKEN` for Slack reports or `NPM_TOKEN` for installing
  private packages. Pass them by name.
- **Secrets your `apify-test-tools.config.json` names**: each Actor's `buildTokenEnvVar` and `testTokenEnvVar`. Their
  names differ per repo, and a reusable workflow only accepts secrets it declares, so they go packed in one JSON object,
  `CONFIG_SECRETS`, with one entry per name the config uses. The workflows read the Apify tokens only from
  `CONFIG_SECRETS`.

The examples above show both. If you'd rather not keep `CONFIG_SECRETS` in sync with the config, pass all of the repo's
secrets in it:

```yaml
secrets:
    CONFIG_SECRETS: ${{ toJSON(secrets) }}
```

Only the names the config declares are used. The cost: every secret the repo can read, deploy keys and publish tokens
included, goes to code at a tag this repo moves, and you trust it to use only those.

`secrets: inherit` doesn't pass the Apify tokens: the workflows read them only from `CONFIG_SECRETS`, and GitHub doesn't
let a job inherit its secrets and list `CONFIG_SECRETS` too. Pass the secrets by name.

The build and test workflows declare every secret optional, and PRs from forks never get secrets. A missing token shows
up where it's needed:

- A name the config declares but `CONFIG_SECRETS` leaves out is a warning in the build or test step.
- A build fails with an error naming the Actor only once it needs the missing build token. A repo can carry an Actor
  whose token isn't set and still build, as long as that Actor never changes.
- The tests of an Actor whose test token is missing fail with a message naming the token.

The values inside `CONFIG_SECRETS` are registered as masks one by one before anything uses them. The runner masks a
secret by its exact value, so otherwise it would only recognize the whole JSON object, not a single token taken out of
it.

The workflows don't turn secrets into job-wide environment variables, so a secret is only visible to the steps that
need it:

| Secret                               | Reaches                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                          | the dependency install steps only, as both `NPM_TOKEN` and `NODE_AUTH_TOKEN`. Use a read-only token: npm granular tokens can be read-only, classic automation tokens can publish                  |
| build tokens (`buildTokenEnvVar`)    | the build and `delete-old-builds` steps only                                                                                                                                                      |
| test tokens (`testTokenEnvVar`)      | the test step only. A token that is also a build token reaches the build steps too                                                                                                                |
| `TESTER_APIFY_TOKEN`                 | the Claude investigation step: the Apify MCP server's token for reading the failing run, its log, and its storages, and Claude's token for re-running it to measure how often the failure happens |
| `SLACK_BOT_TOKEN`                    | the `notify` steps only                                                                                                                                                                           |
| `ANTHROPIC_API_KEY`                  | the Claude steps only                                                                                                                                                                             |
| `REDASH_API_KEY`                     | the Claude investigation step: the Redash MCP server's key for measuring the failure's impact from Snowflake. Optional                                                                            |
| `AGENT_SKILLS_INTERNAL_GITHUB_TOKEN` | the investigation job's checkout of `apify/agent-skills-internal` only, for the `redash-analyst` plugin. Optional                                                                                 |

The build and test steps get only the tokens the config declares for that step: a secret that merely looks like an
Apify token is not passed on, and `CONFIG_SECRETS` itself never reaches the CLI.

To find the token names, the steps read the config with the CLI's own parser, so an invalid config fails them. With
`mode: "grouped"`, each group must declare a nonempty `buildTokenEnvVar` and `testTokenEnvVar` (there is no default),
and an Actor entry can override either. The pre-v1 `tokenEnvVar` field is rejected.

No job runs `npm ci` or `pnpm install` with Apify or Slack credentials in scope, so a postinstall script in the
dependency tree can't read them. The `unitTest` job needs `NPM_TOKEN` only.

## Versioning

The workflows and the Vitest library ship separately:

| What                                             | You get it through                        | Updates when                     |
| ------------------------------------------------ | ----------------------------------------- | -------------------------------- |
| the workflows and the CLI they run               | the `@workflows-v1` tag in `uses:`        | every change merged to this repo |
| the library (`testActor`, `describe`, matchers…) | `apify-test-tools` in your `package.json` | you update the package           |

The workflows bring their own copy of the CLI, so they don't use or change the `apify-test-tools` version in your
`node_modules`, and your tests keep the library version you locked.

Whatever ref you call a workflow at, it runs the setup action and the CLI from that same commit. Pinning a commit SHA or
a branch of this repo gets you that commit's workflows as a whole.

`@workflows-v1` always points at the latest workflows, so fixes and new features reach you with no change on your side.
Changes that would break callers go to a new tag (`@workflows-v2`), and `@workflows-v1` keeps working, so you can
migrate when it suits you.

`@workflows-v1` needs `apify-test-tools` 1.0.0 or newer in your `package.json`. The test step fails on an older one.
