/**
 * What the e2e suite does to the fixture repo, and what it expects the tools to do in response.
 *
 * The suite runs top to bottom against one base branch. Each pull-request scenario opens a PR into
 * that base branch and pushes its steps one commit at a time, the way a developer iterates on a PR,
 * so later steps depend on the "last validated commit" cache the earlier ones left behind. A merged
 * scenario moves the base branch, which is what the next scenario branches from.
 *
 * Expectations are written out by hand on purpose. They are the spec of the change detection, and
 * `npm run e2e -- local` checks them against the CLI in seconds before the sandbox run spends
 * twenty minutes and real Apify builds finding out the same thing.
 */

export const ACTORS = {
    integration: 'lukaskrivka/testing-github-integration',
    integration2: 'lukaskrivka/testing-github-integration-2',
    standalone: 'lukaskrivka/test-standalone',
} as const;

export type ActorKey = keyof typeof ACTORS;

export const ACTOR_KEYS = Object.keys(ACTORS) as ActorKey[];

/** A file edit, applied to the working tree of the fixture repo before a step's commit. */
export type Mutation =
    | { file: string; append: string }
    | {
          file: string;
          /** `from` must occur in the file exactly once, so a fixture edit can't silently miss. */
          replace: { from: string; to: string };
      };

export type PullRequestStep = {
    name: string;
    mutations: Mutation[];
    expect: {
        /** Conclusion of the PR workflow run. */
        conclusion: 'success' | 'failure';
        /** Actors the PR workflow builds from the branch, and then tests against those builds. */
        built: ActorKey[];
        /**
         * Actors tested against their deployed (default) build. That happens when a PR changes only
         * platform tests: there is nothing to rebuild, so the changed tests run on what is deployed.
         */
        testedOnDefaultBuild?: ActorKey[];
    };
};

export type PullRequestScenario = {
    kind: 'pull-request';
    name: string;
    title: string;
    steps: PullRequestStep[];
    /** Squash-merge the PR when its steps pass, and expect the push workflow to release these Actors. */
    merge?: { released: ActorKey[] };
};

export type PlatformTestsScenario = {
    kind: 'platform-tests';
    name: string;
    /** Passed to the scheduled-tests workflow, relative to `test/platform`. */
    testFilesGlob: string;
    expect: { passed: number; failed: number; tested: ActorKey[] };
};

export type Scenario = PullRequestScenario | PlatformTestsScenario;

const ROOT_SOURCE = 'src/main.js';
const STANDALONE_SOURCE = 'standalone-actors/lukaskrivka_test-standalone/src/main.ts';
const INTEGRATION_README = 'actors/lukaskrivka_testing-github-integration/.actor/README.md';
const INTEGRATION_TEST = 'test/platform/testing-github-integration.test.ts';

/**
 * `runId` goes into every edit so each run's commits are unique. Without it, an edit identical to
 * one already on the base branch would produce an empty diff.
 */
export const buildScenarios = (runId: string): Scenario[] => [
    {
        kind: 'pull-request',
        name: 'change-detection',
        title: 'e2e: change detection across pushes',
        steps: [
            {
                // Both root-context Actors share src/, the standalone Actor has its own context.
                name: 'functional change shared by the root-context Actors',
                mutations: [{ file: ROOT_SOURCE, append: `\n// e2e ${runId}: shared source change\n` }],
                expect: { conclusion: 'success', built: ['integration', 'integration2'] },
            },
            {
                // Only commits after the last validated one count, and README/CHANGELOG are cosmetic.
                // If the last validated commit is lost, this rebuilds both Actors from the step above.
                name: 'cosmetic change only',
                mutations: [
                    { file: INTEGRATION_README, append: `\nUpdated by e2e run ${runId}.\n` },
                    { file: 'CHANGELOG.md', append: `\n## e2e ${runId}\n\n- Exercise release notes.\n` },
                ],
                expect: { conclusion: 'success', built: [] },
            },
            {
                // A file inside the standalone Actor's folder is excluded from its siblings, even though
                // their context (the repo root) contains it.
                name: 'functional change in the standalone Actor',
                mutations: [{ file: STANDALONE_SOURCE, append: `\n// e2e ${runId}: standalone change\n` }],
                expect: { conclusion: 'success', built: ['standalone'] },
            },
        ],
        // On push, cosmetic changes count too: the README alone would release `integration`.
        merge: { released: ['integration', 'integration2', 'standalone'] },
    },
    {
        kind: 'platform-tests',
        name: 'scheduled-core-tests',
        testFilesGlob: 'core',
        expect: { passed: 2, failed: 0, tested: ['integration', 'integration2'] },
    },
    {
        kind: 'pull-request',
        name: 'changed-platform-tests',
        title: 'e2e: a PR that only changes platform tests',
        steps: [
            {
                // test/ is in the fixture's .dockerignore, so nothing is rebuilt; the changed test file
                // runs against the deployed build instead.
                name: 'change a platform test',
                mutations: [
                    {
                        file: INTEGRATION_TEST,
                        replace: { from: `'Basic test'`, to: `'Basic test (e2e ${runId})'` },
                    },
                ],
                expect: { conclusion: 'success', built: [], testedOnDefaultBuild: ['integration'] },
            },
            {
                // Proves a failing platform test fails the PR check, i.e. green above was not vacuous.
                name: 'break the changed platform test',
                mutations: [
                    {
                        file: INTEGRATION_TEST,
                        replace: {
                            from: 'datasetItemCount: { min: 1, max: 500 }',
                            to: 'datasetItemCount: { min: 1_000_000 }',
                        },
                    },
                ],
                expect: { conclusion: 'failure', built: [], testedOnDefaultBuild: ['integration'] },
            },
        ],
    },
];
