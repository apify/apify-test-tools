This Actor has essentially 2 separate parts

1. The Actor loads GitHub actions binary on build. When it is started, it will run `runner.ts` which spawns the GitHub actions server as a separate process. Then it only listens for migrations and does nothing else.
2. The GitHub actions server binary (which we don't control) is then triggered by GitHub action and that subsequently calls `main.ts` (via calling it from `.github/workflows/apify.yaml` and `gha:start:build` command). This runs rest of the code in the files.

## Run locally to test
1. Choose if you want to emulate PR or push to master workflow.
2. Copy appropriate example from `./example-github-events` to `INPUT.json`
3. To mimic actual PR or push you care about, you should update the input
    - PR: Update `pull_request.head.ref` (source branch of the PR), `repository.full_name`, `pull_request.base.sha`, `pull_request.head.sha`
    - push: Update `ref`, `repository.full_name`
4. Start the Actor with `TESTER_APIFY_TOKEN=<TOKEN> APIFY_TOKEN_${username}=<TOKEN> apify run -p` (possibly other apify users as well)

## Testing real Actor
Do anything to https://github.com/apify-projects/store-testing-repo-for-github

## Runner on Apify
We run GitHub Actions in Apify Actor that loads the GitHub Actions server binary. This server is then triggered by GitHub Actions and runs the rest of the code. There is one production forever running instance of this Actor (https://console.apify.com/admin/users/xRGg9iAfJSymqartk/actors/ANeZceuSfUd7i64qs/runs/hcTVcLB94TsOvPQFJ#log). If you need to update the build, just abort and resurrect the run with rebuilt `latest` version.

For testing on platform, build the beta version (you can change the branch) and then resurrect the test task of the runner. Don't forget to abort the run after the test is done.

### Multiple production runners
It is possible to run multiple production runners at the same time. We might need this to scale up in the future since we are currently limited by only running one GitHub Action at a time.