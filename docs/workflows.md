# Workflow API

The reusable workflows live in this repo, alongside the package they call. They are the `public_`-prefixed files in
`.github/workflows`; everything else there is this repo's own CI. Call them from a job with `uses:` and pass
`secrets: inherit`:

```yaml
jobs:
    myJob:
        uses: apify/apify-test-tools/.github/workflows/<workflow>.yaml@workflows-v0
        with:
            # inputs, if any
        secrets: inherit
```

Always reference them at the `@workflows-v0` major tag, never at `@master` — see
[Versioning and releases](#versioning-and-releases).

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

The usual setup is two callers: core tests every hour and everything once a day.

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
            test-files-glob: core
        secrets: inherit
```

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
    platformTestsCore:
        uses: apify/apify-test-tools/.github/workflows/public_platform-tests.yaml@workflows-v0
        with:
            test-files-glob: core
        secrets: inherit

    handle-failure:
        needs: platformTestsCore
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

The Actor tokens are the one set that cannot be listed in the workflow, because each Actor names its own token via
`tokenEnvVar` in `apify-test-tools.config.json`. Those steps pass `${{ toJSON(secrets) }}` as `ALL_SECRETS` and run
the command through `.github/scripts/run-with-apify-tokens.mjs`, which reads that same config file to decide which
secrets to pass on:

```yaml
- name: Build
  shell: bash
  env:
      ALL_SECRETS: ${{ toJSON(secrets) }}
  run: |
      jq '{ actors: .functionallyChangedActors }' affected.json \
        | node "${{ steps.setup.outputs.scripts-path }}/run-with-apify-tokens.mjs" \
          apify-test-tools build --version-number 0.99
```

The wrapper passes only the tokens the config declares and drops `ALL_SECRETS`, so neither the CLI nor anything under
`node_modules` sees the blob. Nothing is written to `$GITHUB_ENV`, so the tokens stay inside that one command rather
than leaking into later steps. Reading the same file `apify-test-tools` reads means the two can't drift, and a secret
that merely looks like an Actor token is not passed just because of its name.

A token the config declares but the repo hasn't set is a warning, not a failure: a repo can carry an Actor whose
token isn't configured and still build fine as long as that Actor never changes, and `apify-test-tools` raises a
precise error naming the Actor at the point it actually needs the token.

`scripts-path` comes from the setup action (give the step `id: setup`) and points at this repo's `.github/scripts/`
directory inside the runner's action checkout, so workflows can run these helpers without checking this repo out
again. The caller's workspace holds the caller's repo, not this one.

Two tidier-looking alternatives don't work, so don't reach for them:

- **Exporting to `$GITHUB_ENV`** would let the steps call the CLI directly with no wrapper, but `$GITHUB_ENV`
  applies to every later step in the job. In `pr-build-test` the vitest step runs after the build, so it would
  inherit Actor tokens it has no use for.
- **Returning the tokens as a step output** would be scoped correctly, but the runner refuses to set an output whose
  value contains a registered secret. It logs `Skip output <name> since it may contain secret` and leaves the output
  empty, so anything reading it downstream gets nothing.

The `unitTest` job runs static checks and needs `NPM_TOKEN` only. No job runs `npm ci` or `pnpm install` with Apify
or Slack credentials in scope, so a postinstall script in the dependency tree cannot read them.

## Versioning and releases

The workflows and the npm package live in one repo but ship on their own schedules:

| What                                         | Consumers get it through                   | Ships when              |
| -------------------------------------------- | ------------------------------------------ | ----------------------- |
| the workflows and the CLI they call          | the `@workflows-v0` tag in `uses:`         | every master push       |
| the lib (`testActor`, `describe`, matchers…) | `apify-test-tools` in their `package.json` | a stable release on npm |

The CLI is bundled with its dependencies into `.github/cli/apify-test-tools.mjs` (`npm run bundle`, run by the
pre-commit hook and checked in CI), and the setup action runs it from there. Nothing is installed for it, so a tag is
a complete statement: these workflows and this CLI, with the exact dependency versions from `package-lock.json` at
that commit. The consumer's own `node_modules` is left alone, so their tests keep the lib version they locked.

- **Workflow or CLI change** — merge it. `workflows-v0` moves once checks and tests pass, and it goes live. No
  release needed, even when a workflow starts using a new CLI feature: both are in the same commit.
- **Lib change** — merge it, then cut a release when you want it out. Consumers pick it up when they update
  `apify-test-tools`.

The CLI and the lib in one job can be different versions now, so the formats between them are a contract: the
`ACTOR_BUILDS` JSON that `build` writes and the lib reads, and the vitest JSON report `report-tests` reads. Add
fields freely; renaming or removing one needs a new major tag.

`workflows-v0` moving on every master push means `@workflows-v0` is as live as `@master` was — there's no staging
step. What the tag buys you is a `workflows-v1` for breaking workflow changes, so repos migrate one at a time instead
of all at once, and a way to roll back by pointing the tag at an earlier commit (**Move major version tag**
workflow). Bump `MAJOR_TAG` in `.github/workflows/_move_major_tag.yaml` to cut the next major; the old tag then
freezes where it is and keeps working, CLI included, since the bundle is part of the frozen commit.

The tag tracks the **workflows'** contract, not the npm package version. They move independently on purpose, so
`@workflows-v0` is expected to stay `@workflows-v0` after the package reaches 1.0 — bump it when a workflow breaks
its callers, not when the package does. Because `uses:` cannot take an expression, every ref into this repo repeats
the tag literally; `check-major-tag-refs.mjs` fails the build if `MAJOR_TAG` and those refs disagree, which is the
mistake that would otherwise ship silently during a bump.

### Testing workflow changes

- Point [testing-repo-for-github-actions](https://github.com/apify-store/testing-repo-for-github-actions) at your
  branch (`uses: ...@your-branch`). It has real attached Actors and tests. The branch carries its own CLI bundle, so
  one branch tests the workflows and the CLI together.
- To change the composite action itself, repoint the `uses:` refs inside the reusable workflows at your branch as
  well, and change them back before merging.
- Make sure the shell code actually works on your laptop first.
- After merging, watch the workflow on a real project before moving on.
