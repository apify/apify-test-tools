import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { compileCli } from './compiled-cli.js';

// `get-affected-actors --base` on real git histories. Actors a and c share `src/`, b is standalone.
// `main` is the base branch and `feature` the PR branch, checked out like in the PR workflow.
const CONFIG = {
    actors: [
        {
            folder: 'actors/a',
            actorFullName: 'owner/actor-a',
            tokenEnvVar: 'T',
            overrideActorContext: ['actors/a', 'src'],
        },
        {
            folder: 'actors/c',
            actorFullName: 'owner/actor-c',
            tokenEnvVar: 'T',
            overrideActorContext: ['actors/c', 'src'],
        },
        { folder: 'actors/b', actorFullName: 'owner/actor-b', tokenEnvVar: 'T' },
    ],
};

// Only what node and git need, so nothing from the developer's git config leaks in
const env = { PATH: process.env.PATH ?? '', HOME: os.tmpdir() };
const gitEnv = {
    ...env,
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
};

let cliPath: string;
let cleanup: (() => Promise<void>) | undefined;
let repoDir: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();

const writeFiles = async (content: string, files: string[]) => {
    for (const file of files) {
        await mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
        await writeFile(path.join(repoDir, file), `${content}\n`);
    }
};

/** Commits a change to each file and returns the commit. */
const commit = async (message: string, ...files: string[]) => {
    await writeFiles(message, files);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
};

/** Commits on `main`, then checks `feature` out again. */
const commitOnMain = async (message: string, ...files: string[]) => {
    git('checkout', '-q', 'main');
    await commit(message, ...files);
    git('checkout', '-q', 'feature');
};

const runGetAffectedActors = (...args: string[]) => {
    const result = spawnSync(cliPath, ['get-affected-actors', ...args], { cwd: repoDir, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
};

const getAffectedActors = (...args: string[]) => {
    const document = runGetAffectedActors(...args);
    const names = (actors: { actorFullName: string }[]) =>
        actors.map(({ actorFullName }) => actorFullName.replace('owner/actor-', '')).sort();
    return {
        functional: names(document.functionallyChangedActors),
        cosmetic: names(document.cosmeticallyChangedActors),
    };
};

describe('get-affected-actors CLI on real git histories', () => {
    beforeAll(async () => {
        ({ cliPath, cleanup } = await compileCli());
    });

    afterAll(async () => {
        await cleanup?.();
    });

    beforeEach(async () => {
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-affected-actors-'));
        git('init', '-q', '-b', 'main');
        await writeFile(path.join(repoDir, 'apify-test-tools.config.json'), JSON.stringify(CONFIG));
        for (const { folder } of CONFIG.actors) {
            await mkdir(path.join(repoDir, folder, '.actor'), { recursive: true });
            await writeFile(
                path.join(repoDir, folder, '.actor/actor.json'),
                JSON.stringify({ actorSpecification: 1, name: `actor-${path.basename(folder)}`, version: '0.1' }),
            );
        }
        await commit('chore: init', 'src/shared.ts', 'actors/a/main.ts', 'actors/b/main.ts', 'actors/c/main.ts');
        git('checkout', '-q', '-b', 'feature');
    });

    afterEach(async () => {
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it("tests only what changed since the last validated commit, on the branch's own commits", async () => {
        const validated = await commit('feat(a): validated change', 'actors/a/main.ts');
        await commit('feat(c): new change, docs for a', 'actors/c/main.ts', 'actors/a/README.md');

        // A is still the validated code, only its README changed since
        expect(getAffectedActors('--base', 'main', '--since', validated)).toStrictEqual({
            functional: ['c'],
            cosmetic: ['a'],
        });
    });

    it('tests nothing after merging cosmetic changes from base', async () => {
        const validated = await commit('feat(a): validated change', 'actors/a/main.ts');
        await commitOnMain('docs: readme and changelog', 'actors/a/README.md', 'CHANGELOG.md');
        git('merge', '-q', '--no-edit', 'main');

        expect(getAffectedActors('--base', 'main', '--since', validated)).toStrictEqual({
            functional: [],
            cosmetic: ['a'],
        });
    });

    it("tests the Actors where base's functional change meets the branch's after a merge", async () => {
        const validated = await commit('feat(a): validated change', 'actors/a/main.ts');
        await commitOnMain('feat: shared change', 'src/shared.ts');
        git('merge', '-q', '--no-edit', 'main');

        // Base changed A and C. A can interact with the branch's change, C only has base's, which base validated
        expect(getAffectedActors('--base', 'main', '--since', validated)).toStrictEqual({
            functional: ['a'],
            cosmetic: [],
        });
    });

    it('leaves out Actors that only base changed', async () => {
        await commit('feat: shared change', 'src/shared.ts');
        await commitOnMain('feat(b): base change', 'actors/b/main.ts');
        git('merge', '-q', '--no-edit', 'main');

        expect(getAffectedActors('--base', 'main')).toStrictEqual({ functional: ['a', 'c'], cosmetic: [] });
    });

    it('counts code changed in the merge commit itself', async () => {
        await commit('docs(a): readme', 'actors/a/README.md');
        await commitOnMain('feat(b): base change', 'actors/b/main.ts');
        git('merge', '-q', '--no-commit', '--no-ff', 'main');
        await writeFiles('changed while merging', ['actors/c/main.ts']);
        git('add', '-A');
        git('commit', '-q', '--no-edit');

        expect(getAffectedActors('--base', 'main')).toStrictEqual({ functional: ['c'], cosmetic: ['a'] });
    });

    it('tests nothing after a rebase onto base changes to other Actors', async () => {
        const validated = await commit('feat(a): validated change', 'actors/a/main.ts');
        await commitOnMain('feat(b): base change', 'actors/b/main.ts');
        git('rebase', '-q', 'main');

        expect(getAffectedActors('--base', 'main', '--since', validated)).toStrictEqual({
            functional: [],
            cosmetic: [],
        });
    });

    it('counts a moved file for both the Actor it left and the one it joined', async () => {
        git('mv', 'actors/a/main.ts', 'actors/c/moved.ts');
        git('commit', '-q', '-m', 'refactor: move a file from a to c');

        // With rename detection, git would list only the new path, and A would look unchanged
        expect(getAffectedActors('--base', 'main')).toStrictEqual({ functional: ['a', 'c'], cosmetic: [] });
    });

    it('checks the whole branch on a rerun or when --since is not in the history', async () => {
        await commit('feat(a): validated change', 'actors/a/main.ts');
        const head = await commit('docs(a): readme', 'actors/a/README.md');

        const wholeBranch = { functional: ['a'], cosmetic: [] };
        expect(getAffectedActors('--base', 'main', '--since', head)).toStrictEqual(wholeBranch);
        expect(getAffectedActors('--base', 'main', '--since', 'e'.repeat(40))).toStrictEqual(wholeBranch);
    });

    it('reports nothing for an empty range', async () => {
        const nothing = { commits: [], changedFiles: [], functionallyChangedActors: [], cosmeticallyChangedActors: [] };
        // The branch has no commits of its own yet
        expect(runGetAffectedActors('--base', 'main')).toMatchObject(nothing);
        // A release with nothing new since the last one
        expect(runGetAffectedActors('--since', git('rev-parse', 'HEAD'))).toMatchObject(nothing);
    });
});
