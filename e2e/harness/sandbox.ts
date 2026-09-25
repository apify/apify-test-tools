import { ApifyObserver } from './apify.js';
import { Checks } from './checks.js';
import { SANDBOX_REPO } from './fixture.js';
import { Git, githubAuthEnv } from './git.js';
import { GitHubRepo, type WorkflowRun } from './github.js';
import { applyMutations, branchNames } from './rewrite.js';
import {
    ACTOR_KEYS,
    type ActorKey,
    ACTORS,
    buildScenarios,
    type PlatformTestsScenario,
    type PullRequestScenario,
    type PullRequestStep,
} from './scenarios.js';

/** The fixture's caller workflows, in e2e/fixture/.github/workflows. */
const FIXTURE_WORKFLOWS = {
    pullRequest: 'pr-build-test.yaml',
    release: 'release-latest.yaml',
    platformTests: 'platform-tests.yaml',
} as const;

// The version `apify-test-tools build` builds PR branches as (DEFAULT_TEST_VERSION_NUMBER in bin/build.ts).
const PR_BUILD_VERSION = '0.99';

type Context = {
    git: Git;
    github: GitHubRepo;
    apify: ApifyObserver;
    branches: ReturnType<typeof branchNames>;
};

export type SandboxCredentials = { githubToken: string; ownerToken: string; testerToken: string };

/**
 * Runs the scenarios for real: pushes the prepared base branch to the sandbox repo, drives PRs,
 * merges and dispatches there, and checks each resulting workflow run against the platform.
 */
export const runInSandbox = async ({
    runId,
    workDir,
    credentials,
}: {
    runId: string;
    workDir: string;
    credentials: SandboxCredentials;
}) => {
    const branches = branchNames(runId);
    const git = new Git(workDir, githubAuthEnv(credentials.githubToken));
    if (git.exec('remote').split('\n').includes('origin')) git.exec('remote', 'remove', 'origin');
    git.exec('remote', 'add', 'origin', `https://github.com/${SANDBOX_REPO}.git`);
    git.push(branches.base, branches.base);
    console.error(`Pushed https://github.com/${SANDBOX_REPO}/tree/${branches.base}`);

    const context: Context = {
        git,
        github: new GitHubRepo(credentials.githubToken, SANDBOX_REPO),
        apify: new ApifyObserver({ ownerToken: credentials.ownerToken, testerToken: credentials.testerToken }),
        branches,
    };

    for (const scenario of buildScenarios(runId)) {
        console.error(`\n=== ${scenario.name} ===`);
        if (scenario.kind === 'pull-request') {
            await runPullRequestScenario(context, scenario);
        } else {
            await runPlatformTestsScenario(context, scenario);
        }
    }
};

const runPullRequestScenario = async (context: Context, scenario: PullRequestScenario) => {
    const { git, github, branches } = context;
    const head = branches.head(scenario.name);
    git.checkoutFromRemote(head, branches.base);

    let pull: { number: number; html_url: string } | undefined;
    for (const [index, step] of scenario.steps.entries()) {
        applyMutations(git.dir, step.mutations);
        const sha = git.commitAll(`${scenario.name}: ${step.name}`);
        const since = new Date();
        git.push('HEAD', head);
        pull ??= await github.createPull({
            head,
            base: branches.base,
            title: scenario.title,
            body: 'Opened by the apify-test-tools e2e harness. Closed or merged by it, too.',
        });
        console.error(`  step ${index + 1}: ${step.name} (${pull.html_url})`);

        const run = await github.waitForRun({
            workflowFile: FIXTURE_WORKFLOWS.pullRequest,
            event: 'pull_request',
            headSha: sha,
        });
        await verifyPullRequestStep(context, {
            title: `${scenario.name} ${index + 1}/${scenario.steps.length}: ${step.name}`,
            step,
            run,
            since,
        });
    }
    if (!pull) throw new Error(`Scenario ${scenario.name} has no steps.`);

    if (!scenario.merge) {
        await github.closePull(pull.number);
        return;
    }

    const since = new Date();
    const mergeSha = await github.squashMerge(pull.number, `${scenario.title} (#${pull.number})`);
    console.error(`  merged into ${branches.base} as ${mergeSha}`);
    const run = await github.waitForRun({ workflowFile: FIXTURE_WORKFLOWS.release, event: 'push', headSha: mergeSha });
    await verifyRelease(context, {
        title: `${scenario.name}: release on merge`,
        released: scenario.merge.released,
        run,
        since,
    });
};

const runPlatformTestsScenario = async (context: Context, scenario: PlatformTestsScenario) => {
    const { git, github, apify, branches } = context;
    const baseSha = git.exec('ls-remote', 'origin', `refs/heads/${branches.base}`).split(/\s/)[0];

    const since = new Date();
    await github.dispatchWorkflow(FIXTURE_WORKFLOWS.platformTests, branches.base, {
        'test-files-glob': scenario.testFilesGlob,
    });
    const run = await github.waitForRun({
        workflowFile: FIXTURE_WORKFLOWS.platformTests,
        event: 'workflow_dispatch',
        headSha: baseSha,
    });

    const checks = new Checks(`${scenario.name}: scheduled tests on ${scenario.testFilesGlob || 'everything'}`);
    checks.check(run.conclusion === 'success', `workflow concluded ${run.conclusion}, expected success`);

    // Uploaded by public_platform-tests.yaml, whose report-tests step reads the same file.
    const report = JSON.parse(await github.readArtifactFile(run.id, 'vitest-results', 'test-output.json')) as {
        numPassedTests: number;
        numFailedTests: number;
    };
    checks.check(
        report.numPassedTests === scenario.expect.passed && report.numFailedTests === scenario.expect.failed,
        `vitest report: ${report.numPassedTests} passed, ${report.numFailedTests} failed; ` +
            `expected ${scenario.expect.passed} passed, ${scenario.expect.failed} failed`,
    );

    for (const actor of ACTOR_KEYS) {
        const runs = await apify.testRunsSince(actor, since);
        if (scenario.expect.tested.includes(actor)) {
            const { tag, buildId, buildNumber } = await apify.defaultBuild(actor);
            checks.check(
                runs.some((testRun) => testRun.buildId === buildId),
                `${ACTORS[actor]} tested on its default build (${tag}, ${buildNumber})`,
            );
        } else {
            checks.check(runs.length === 0, `${ACTORS[actor]} not tested (${runs.length} runs)`);
        }
    }

    checks.finish([`Workflow run: ${run.html_url}`]);
};

const verifyPullRequestStep = async (
    { github, apify }: Context,
    { title, step, run, since }: { title: string; step: PullRequestStep; run: WorkflowRun; since: Date },
) => {
    const { expect } = step;
    const checks = new Checks(title);
    checks.check(
        run.conclusion === expect.conclusion,
        `workflow concluded ${run.conclusion}, expected ${expect.conclusion}`,
    );

    // Job names come out as "<caller job> / <reusable workflow job>".
    const jobs = await github.listJobs(run.id);
    const jobConclusion = (jobId: string) =>
        jobs.find(({ name }) => name.endsWith(`/ ${jobId}`))?.conclusion ?? 'missing';
    checks.check(
        jobConclusion('unitTest') === 'success',
        `unitTest job: ${jobConclusion('unitTest')}, expected success`,
    );
    checks.check(
        jobConclusion('platformTest') === expect.conclusion,
        `platformTest job: ${jobConclusion('platformTest')}, expected ${expect.conclusion}`,
    );

    const buildsByActor = new Map<ActorKey, Awaited<ReturnType<ApifyObserver['buildsSince']>>>();
    for (const actor of ACTOR_KEYS) {
        const builds = (await apify.buildsSince(actor, since)).filter(({ buildNumber }) =>
            buildNumber.startsWith(`${PR_BUILD_VERSION}.`),
        );
        if (builds.length > 0) buildsByActor.set(actor, builds);
    }
    checks.sameSet(
        'Actors built from the branch',
        [...buildsByActor.keys()].map((actor) => ACTORS[actor]),
        expect.built.map((actor) => ACTORS[actor]),
    );

    const testedOnDefaultBuild = expect.testedOnDefaultBuild ?? [];
    for (const actor of ACTOR_KEYS) {
        const runs = await apify.testRunsSince(actor, since);
        const [build] = buildsByActor.get(actor) ?? [];

        if (expect.built.includes(actor) && build) {
            checks.check(build.status === 'SUCCEEDED', `${ACTORS[actor]} build ${build.buildNumber}: ${build.status}`);
            checks.check(
                runs.some((testRun) => testRun.buildId === build.id),
                `${ACTORS[actor]} tested on its PR build ${build.buildNumber}`,
            );
        } else if (testedOnDefaultBuild.includes(actor)) {
            const { tag, buildId, buildNumber } = await apify.defaultBuild(actor);
            checks.check(
                runs.some((testRun) => testRun.buildId === buildId),
                `${ACTORS[actor]} tested on its default build (${tag}, ${buildNumber})`,
            );
        } else if (!expect.built.includes(actor)) {
            // Tests of Actors the PR didn't build must be skipped, not run against something else.
            checks.check(runs.length === 0, `${ACTORS[actor]} not tested (${runs.length} runs)`);
        }
    }

    checks.finish([`Workflow run: ${run.html_url}`]);
};

const verifyRelease = async (
    { apify }: Context,
    { title, released, run, since }: { title: string; released: ActorKey[]; run: WorkflowRun; since: Date },
) => {
    const checks = new Checks(title);
    checks.check(run.conclusion === 'success', `workflow concluded ${run.conclusion}, expected success`);

    const releasedActors: ActorKey[] = [];
    for (const actor of ACTOR_KEYS) {
        const [build] = await apify.buildsSince(actor, since);
        if (!build) continue;
        releasedActors.push(actor);

        const { tag, buildId } = await apify.defaultBuild(actor);
        checks.check(
            build.status === 'SUCCEEDED' && !build.buildNumber.startsWith(`${PR_BUILD_VERSION}.`),
            `${ACTORS[actor]} build ${build.buildNumber}: ${build.status}`,
        );
        checks.check(buildId === build.id, `${ACTORS[actor]}: "${tag}" points at the new build ${build.buildNumber}`);
    }
    checks.sameSet(
        'Actors released',
        releasedActors.map((actor) => ACTORS[actor]),
        released.map((actor) => ACTORS[actor]),
    );

    checks.finish([`Workflow run: ${run.html_url}`]);
};

/**
 * Removes everything a run left in the sandbox repo: cancels its workflow runs, closes its PRs and
 * deletes its branches. Safe to run more than once, and after a run that never got going.
 */
export const cleanUpSandbox = async ({ runId, githubToken }: { runId: string; githubToken: string }) => {
    const github = new GitHubRepo(githubToken, SANDBOX_REPO);
    const { prefix } = branchNames(runId);
    const branches = await github.listBranches(prefix);

    for (const branch of branches) {
        for (const run of await github.listRuns({ branch })) {
            if (run.status !== 'completed') {
                console.error(`Cancelling ${run.html_url}`);
                await github.cancelRun(run.id).catch((error) => console.error(`  ${error}`));
            }
        }
    }
    for (const pull of await github.listOpenPulls()) {
        if (pull.head.ref.startsWith(prefix)) {
            console.error(`Closing PR #${pull.number}`);
            await github.closePull(pull.number);
        }
    }
    for (const branch of branches) {
        console.error(`Deleting ${branch}`);
        await github.deleteBranch(branch);
    }
};
