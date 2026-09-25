# End-to-end tests

Unit tests cover the CLI and the library one function at a time. These tests cover what they can't:
the three parts shipping together. The `public_` workflows call the CLI, the CLI builds real Actors
on Apify, and the library runs platform tests against those builds. They run on every PR that
touches one of those parts, against the code in the PR.

This replaces the old manual process of pointing
[testing-repo-for-github-actions](https://github.com/apify-store/testing-repo-for-github-actions)
at a branch and pushing commits to a PR there by hand. That repo is now the **sandbox**: the harness
pushes throwaway branches to it and deletes them afterwards. Nothing in it needs editing.

## What a run does

`npm run e2e -- run` goes through these steps, in order, in the sandbox repo:

1. **Prepare.** Build and `npm pack` this checkout. Copy `fixture/` (a small consumer repo with three
   real Actors) and this checkout's `public_pr-build-test`, `public_push-build-latest` and
   `public_platform-tests` workflows, composite action and scripts into one commit. Push it as
   `e2e/<run-id>/base`. The packed tarball goes in as `vendor/apify-test-tools.tgz`, so the sandbox
   installs exactly this code.
2. **`change-detection` PR.** Three pushes to one PR: a shared source change, then a cosmetic-only
   change, then a change to the standalone Actor. Each push has to build and test exactly the
   expected Actors. The later pushes only pass if the "last validated commit" cache works.
3. **Merge.** Squash-merge the PR. The push workflow has to release all three Actors and move their
   `latest` tag.
4. **Scheduled tests.** Dispatch the platform-tests workflow for `core`. The two core tests have to
   pass against the released builds.
5. **`changed-platform-tests` PR.** A PR that only edits a platform test. Nothing is built, and the
   changed test runs against the deployed build. The next push breaks that test, and the PR check has
   to fail. This proves the green results above weren't vacuous.

The expectations are in [`harness/scenarios.ts`](harness/scenarios.ts). After each workflow run, the
harness checks the platform directly for which builds were started and which runs the tests made,
instead of reading logs. It also checks that Actors a step doesn't touch were neither built nor
tested.

A full run takes about half an hour. Runs from different PRs queue behind each other, because they
build the same Actors (see [Limitations](#limitations)).

### The offline check

`npm run e2e -- local` plays the same PR scenarios against a local bare repo and checks the CLI's
`get-affected-actors` output after every push. For the merge step it checks what `release` would
build. It needs no credentials and takes seconds. It runs first on every PR, fork PRs included, so a
wrong expectation or a change-detection regression fails before the sandbox run starts.

### What the harness changes in the copied workflows

Only what it must, and each change fails loudly if its target text moves
([`harness/rewrite.ts`](harness/rewrite.ts)):

- `apify/apify-test-tools/.github/...@<ref>` becomes the copy in the sandbox branch. `uses:` takes no
  expressions, so rewriting the ref is the only way to run an unreleased composite action.
- `public_platform-tests.yaml` only runs on `master`/`main`. Its guard is pointed at the run's base
  branch instead.

The composite action keeps a lockfile entry installed from a `file:` tarball as it is, instead of
swapping it for the version in `.github/workflows-package-version`. That is the one change in the
workflows themselves that makes this possible.

## Setup

These are needed once, and are already done if the sandbox job runs on PRs.

**In this repo** (Settings → Secrets and variables → Actions):

| Name                         | Kind     | What                                                                                                                   |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `E2E_GITHUB_APP_ID`          | variable | ID of a GitHub App installed on `apify-store/testing-repo-for-github-actions`. The sandbox job is skipped while unset. |
| `E2E_GITHUB_APP_PRIVATE_KEY` | secret   | That app's private key.                                                                                                |
| `E2E_APIFY_TOKEN`            | secret   | Token of the user owning the fixture Actors (`lukaskrivka`). The harness only reads with it: builds and default tags.  |
| `E2E_TESTER_APIFY_TOKEN`     | secret   | The tester account's token, the one the sandbox has as `TESTER_APIFY_TOKEN`. Lists the runs the tests made.            |

The app needs these repository permissions: **Contents**, **Pull requests** and **Workflows**, all
read and write (Workflows because the harness pushes workflow files), and **Actions**, read and
write (it reads runs and artifacts, dispatches, and cancels on cleanup). Events it causes trigger
workflows, which `GITHUB_TOKEN` events wouldn't. A personal access token works too for local runs
(below).

**In the sandbox repo**, the same secrets a consumer repo has: `APIFY_TOKEN_LUKASKRIVKA`,
`TESTER_APIFY_TOKEN`, `SLACK_TOKEN_TESTS_BOT` and `SLACK_TOKEN_RELEASES_BOT`. Slack messages go to
`#notif-testing-repo-for-github-actions`. The Apify git integration also needs read access to the
sandbox repo, as it would for any consumer.

## Running it yourself

```bash
npm run e2e -- local      # offline check

SANDBOX_GITHUB_TOKEN=$(gh auth token) \
E2E_APIFY_TOKEN=<owner token> \
E2E_TESTER_APIFY_TOKEN=<tester token> \
  npm run e2e -- run --run-id my-try-1

SANDBOX_GITHUB_TOKEN=$(gh auth token) npm run e2e -- cleanup --run-id my-try-1
```

`run` prepares the checkout in `e2e/.work/<run-id>` (gitignored) unless it already exists. Use a
new run id for each attempt. `cleanup` closes the run's PRs, cancels its workflow runs and deletes
its branches. CI always runs it at the end. Don't run the sandbox suite while CI is running it, for
the reason under Limitations.

## Changing things

- **A change to change detection** usually changes an expectation. Update `harness/scenarios.ts` and
  check it with `npm run e2e -- local`.
- **A new scenario** goes into `buildScenarios`. Scenarios run in order on one base branch, so a
  merged scenario changes what later ones start from. Edits must include the run id (see the
  existing ones), or they can end up as empty diffs.
- **A fixture change** goes in `fixture/`, which is also what the sandbox gets. It is not formatted
  or linted by this repo (see `.prettierignore`), because scenario edits match exact strings in it.
  The unit tests in `harness/rewrite.test.ts` check that every edit still applies.
- **A new public workflow** that the fixture should call needs a caller in
  `fixture/.github/workflows`, an entry in `CALLED_WORKFLOWS`, and a scenario.

## Limitations

- **One run at a time.** Every run builds version `0.99` of the same Actors. Two builds of one
  version at once race for its source, in the sandbox as in any consumer repo. The job queues on a
  concurrency group. GitHub keeps only one pending run per group, so when a third run arrives while
  one is waiting, the waiting one is cancelled. Pushing to that PR again re-queues it.
- **Real resources.** Each run makes six builds and about ten test runs of the fixture Actors.
  `delete-old-builds` in the release step prunes the builds over time.
- **Not covered:** `public_review`, `public_claude` and
  `public_platform-tests-claude-investigate-and-fix`, which need Anthropic credentials and are not
  about the package. The merge-from-target optimization and `build-from-local` are also not covered
  yet. Both are unit tested.
