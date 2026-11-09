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

const names = (actors: { actorFullName: string }[]) =>
    actors.map(({ actorFullName }) => actorFullName.replace('owner/actor-', '')).sort();

/** All three lists, for the tests about test changes */
const getAllChangedActors = (...args: string[]) => {
    const document = runGetAffectedActors(...args);
    return {
        functional: names(document.functionallyChangedActors),
        cosmetic: names(document.cosmeticallyChangedActors),
        test: names(document.testChangedActors),
    };
};

/** Writes the config with actor-a's context also covering `extraContext`. It is committed with the next commit. */
const writeConfigWithTestsInContext = async (extraContext: string, settings: Record<string, unknown> = {}) => {
    const actors = CONFIG.actors.map((actor) =>
        actor.folder === 'actors/a'
            ? { ...actor, overrideActorContext: [...actor.overrideActorContext!, extraContext] }
            : actor,
    );
    await writeFile(path.join(repoDir, 'apify-test-tools.config.json'), JSON.stringify({ ...settings, actors }));
};

const getAffectedActors = (...args: string[]) => {
    const document = runGetAffectedActors(...args);
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

    it('lists Actors whose platform tests changed, and a test change alone is not functional', async () => {
        await writeConfigWithTestsInContext('test');
        await writeFiles('test/', ['.dockerignore']);
        // A test and its helper, both under the default platformTestsGlob test/platform/**
        await commit('test(a): change a test and its helper', 'test/platform/a.test.ts', 'test/platform/utils.ts');

        const testOnly = { functional: [], cosmetic: [], test: ['a'] };
        // A PR runs the tests
        expect(getAllChangedActors('--base', 'main')).toStrictEqual(testOnly);
        // A release builds only the functional and cosmetic lists, so it builds nothing
        expect(getAllChangedActors('--since', git('rev-parse', 'main'))).toStrictEqual(testOnly);
        // The branch didn't change A's code, so its default build can run the tests
        expect(runGetAffectedActors('--base', 'main').testChangedActors).toStrictEqual([
            { actorFullName: 'owner/actor-a', build: 'default' },
        ]);
    });

    it('lists an Actor whose source and tests changed only as functional, since it needs a new build', async () => {
        await writeConfigWithTestsInContext('test');
        await commit('feat(a): change and test it', 'actors/a/main.ts', 'test/platform/a.test.ts');

        expect(getAllChangedActors('--base', 'main')).toStrictEqual({ functional: ['a'], cosmetic: [], test: [] });
    });

    it('lists only the tests changed since the last validated commit', async () => {
        await writeConfigWithTestsInContext('test');
        const validated = await commit('feat(a): validated change', 'actors/a/main.ts');
        await commit('test(a): new test', 'test/platform/a.test.ts');

        // The validated build of A has the branch's code, only the tests changed since
        expect(getAllChangedActors('--base', 'main', '--since', validated)).toStrictEqual({
            functional: [],
            cosmetic: [],
            test: ['a'],
        });
        // The branch changed A's code and no build of it is stored, so build builds it
        expect(runGetAffectedActors('--base', 'main', '--since', validated).testChangedActors).toStrictEqual([
            { actorFullName: 'owner/actor-a' },
        ]);

        // With the build an earlier run stored, the tests run on it
        const storedBuild = {
            actorFullName: 'owner/actor-a',
            buildId: 'b1',
            actorRawId: 'raw-a',
            buildNumber: '0.99.4',
        };
        await writeFile(path.join(repoDir, 'pr-builds.json'), JSON.stringify([storedBuild]));
        const withStored = runGetAffectedActors(
            '--base',
            'main',
            '--since',
            validated,
            '--stored-builds',
            'pr-builds.json',
        );
        expect(withStored.testChangedActors).toStrictEqual([
            { actorFullName: 'owner/actor-a', build: { buildId: 'b1', actorRawId: 'raw-a', buildNumber: '0.99.4' } },
        ]);
    });

    it('reads which files are platform tests from platformTestsGlob in the config', async () => {
        await writeConfigWithTestsInContext('e2e', { platformTestsGlob: 'e2e/platform/**' });
        await commit('test(a): new test', 'e2e/platform/a.test.ts');
        expect(getAllChangedActors('--base', 'main')).toStrictEqual({ functional: [], cosmetic: [], test: ['a'] });

        // Outside the glob, a file in the context is a source change like any other
        await commit('feat(a): other file', 'e2e/fixtures/data.json');
        expect(getAllChangedActors('--base', 'main')).toStrictEqual({ functional: ['a'], cosmetic: [], test: [] });
    });

    it('reports nothing for an empty range', async () => {
        const nothing = {
            commits: [],
            changedFiles: [],
            functionallyChangedActors: [],
            cosmeticallyChangedActors: [],
            testChangedActors: [],
        };
        // The branch has no commits of its own yet
        expect(runGetAffectedActors('--base', 'main')).toMatchObject(nothing);
        // A release with nothing new since the last one
        expect(runGetAffectedActors('--since', git('rev-parse', 'HEAD'))).toMatchObject(nothing);
    });
});
