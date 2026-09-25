import fs from 'node:fs';
import path from 'node:path';

import { getChangedActors } from '../../bin/diff-changes.js';
import { readConfigFile } from '../../bin/utils/config/load-config.js';
import { Checks } from './checks.js';
import { REPO_ROOT } from './fixture.js';
import { childEnv, type Git, run } from './git.js';
import { applyMutations, branchNames } from './rewrite.js';
import { ACTORS, buildScenarios } from './scenarios.js';

const CLI = path.join(REPO_ROOT, 'dist/bin/main.js');

/**
 * Plays the pull-request scenarios against a local bare repo and checks that the CLI's change
 * detection picks exactly the Actors each step expects. No credentials, no network, and seconds
 * instead of the sandbox run's twenty minutes, so a wrong expectation (or a change-detection
 * regression) shows up before anything is pushed.
 *
 * It asks the same questions the workflows ask, with the same arguments, but it does not replace
 * the sandbox run: nothing is built, no test runs, and the workflows themselves are not involved.
 */
export const runLocally = async ({ runId, git }: { runId: string; git: Git }) => {
    const branches = branchNames(runId);
    const originDir = `${git.dir}.origin.git`;
    fs.rmSync(originDir, { recursive: true, force: true });
    run('git', ['init', '--quiet', '--bare', originDir], { cwd: REPO_ROOT });
    git.exec('remote', 'add', 'origin', originDir);
    git.push(branches.base, branches.base);

    for (const scenario of buildScenarios(runId)) {
        if (scenario.kind !== 'pull-request') {
            console.error(`Skipping ${scenario.name}: it has no change detection to check offline.`);
            continue;
        }

        const head = branches.head(scenario.name);
        git.checkoutFromRemote(head, branches.base);
        // What the PR workflow caches as the last validated commit. It only moves when a run passes.
        let lastValidated: string | undefined;

        for (const [index, step] of scenario.steps.entries()) {
            applyMutations(git.dir, step.mutations);
            const sha = git.commitAll(`${scenario.name}: ${step.name}`);
            git.push('HEAD', head);

            const affected = JSON.parse(
                run(
                    'node',
                    [
                        CLI,
                        'get-affected-actors',
                        '--source-branch',
                        `origin/${head}`,
                        '--target-branch',
                        `origin/${branches.base}`,
                        ...(lastValidated ? ['--base-commit', lastValidated] : []),
                    ],
                    { cwd: git.dir, env: childEnv({ GITHUB_WORKSPACE: git.dir }), quiet: true },
                ),
            ) as { actorFullName: string }[];

            const checks = new Checks(`${scenario.name} ${index + 1}/${scenario.steps.length}: ${step.name}`);
            checks.sameSet(
                'Actors the PR workflow builds',
                affected.map(({ actorFullName }) => actorFullName),
                step.expect.built.map((actor) => ACTORS[actor]),
            );
            checks.finish();

            if (step.expect.conclusion === 'success') lastValidated = sha;
        }

        if (scenario.merge) {
            const before = git.checkoutFromRemote(branches.base, branches.base);
            git.exec('merge', '--squash', '--quiet', head);
            const after = git.commitAll(`${scenario.title} (squashed)`);
            git.push('HEAD', branches.base);

            const checks = new Checks(`${scenario.name}: release on merge`);
            checks.sameSet(
                'Actors the push workflow releases',
                await releasedActors(git, before, after),
                scenario.merge.released.map((actor) => ACTORS[actor]),
            );
            checks.finish();
        }
    }
};

/**
 * What `apify-test-tools release` would build for a push from `before` to `after`. The command
 * itself can't run offline (it reads the Actors' default versions from the platform), so this
 * calls the same change detection it does. Both read the repo relative to the working directory.
 */
const releasedActors = async (git: Git, before: string, after: string): Promise<string[]> => {
    const cwd = process.cwd();
    process.chdir(git.dir);
    try {
        const changedFiles = git.exec('diff', '--name-only', before, after).split('\n').filter(Boolean);
        const actorConfigs = await readConfigFile({ actors: [], ignore: [] });
        return getChangedActors({
            filepathsChanged: changedFiles,
            actorConfigs,
            isLatest: true,
            commits: [{ sha: after, author: '', date: '', message: '' }],
        }).map(({ actorFullName }) => actorFullName);
    } finally {
        process.chdir(cwd);
    }
};
