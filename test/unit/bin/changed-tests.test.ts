import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorGetter } from '../../../bin/actor-ids.js';
import { selectChangedTests } from '../../../bin/changed-tests.js';
import type { ActorConfig } from '../../../bin/types.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const libPath = path.join(projectRoot, 'lib/lib.ts');

// Only the names matter, select-changed-tests reads nothing else from the configs
const actorConfigs = ['owner/a', 'owner/b', 'owner/c'].map((actorFullName) => ({ actorFullName }) as ActorConfig);

// owner/c is named by its raw ID in its test, the lookup gives the ID for the full name
const client: ActorGetter = {
    actor: (id: string) =>
        ({
            get: async () => {
                const [username, name] = id.split('/');
                return { id: name === 'c' ? 'rawC' : `raw-${name}`, username, name };
            },
        }) as never,
};

const gitEnv = {
    PATH: process.env.PATH ?? '',
    HOME: os.tmpdir(),
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
};

let repoDir: string;
const originalCwd = process.cwd();
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();

const writeRepoFile = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
    await writeFile(path.join(repoDir, file), content);
};

const testFile = (tests: string) => `import { testActor } from ${JSON.stringify(libPath)};
import { helper } from '../helper';
${tests}
`;

/** Commits a change to each file, returns the commit before it */
const commitChange = async (...files: string[]) => {
    const before = git('rev-parse', 'HEAD');
    for (const file of files) {
        if (file.endsWith('.json')) await writeRepoFile(file, '{"v":2}');
        else await appendFile(path.join(repoDir, file), '\n// changed\n');
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
    return before;
};

/** The document get-affected-actors prints for a branch that changed the tests of every Actor */
const affected = (testChangesSince: string) => ({
    version: 1,
    head: git('rev-parse', 'HEAD'),
    functionallyChangedActors: [],
    testChangedActors: actorConfigs.map(({ actorFullName }) => ({ actorFullName, build: 'default' })),
    testChangesSince,
});

const select = async (testChangesSince: string) =>
    selectChangedTests({
        affected: affected(testChangesSince),
        platformTestsGlob: 'test/platform/**',
        actorConfigs,
        cwd: repoDir,
        client,
    });

describe('selectChangedTests', () => {
    beforeAll(async () => {
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-changed-tests-'));
        git('init', '-q', '-b', 'main');
        await symlink(path.join(projectRoot, 'node_modules'), path.join(repoDir, 'node_modules'), 'dir');
        await writeRepoFile('.gitignore', 'node_modules\n');
        await writeRepoFile('test/platform/helper.ts', 'export const helper = 1;\n');
        await writeRepoFile(
            'test/platform/only-a/uses-helper.test.ts',
            testFile(`testActor('owner/a', 'a', async () => { console.log(helper); });`),
        );
        await writeRepoFile(
            'test/platform/both/b-and-c.test.ts',
            `import { testActor } from ${JSON.stringify(libPath)};
testActor('owner/b', 'b', async () => {});
testActor('rawC', 'c by raw ID', async () => {});
`,
        );
        await writeRepoFile('test/platform/fixtures/data.json', '{"v":1}');
        await writeRepoFile('test/platform/README.md', '# Tests\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'init');
        // getChangedFilesBetween runs git in the working directory
        process.chdir(repoDir);
    });

    afterAll(async () => {
        process.chdir(originalCwd);
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        // Each test starts from the commit before its change, so earlier changes don't leak in
        git('reset', '-q', '--hard', git('rev-list', '--max-parents=0', 'HEAD'));
    });

    it('selects the Actors and files of a changed test file, mapping a raw ID to the full name', async () => {
        const result = await select(await commitChange('test/platform/both/b-and-c.test.ts'));
        expect(result.changedTests).toStrictEqual({ narrowed: true });
        expect(result.testChangedActors).toStrictEqual([
            { actorFullName: 'owner/b', build: 'default', testFiles: ['test/platform/both/b-and-c.test.ts'] },
            { actorFullName: 'owner/c', build: 'default', testFiles: ['test/platform/both/b-and-c.test.ts'] },
        ]);
    });

    it('selects the test files that import a changed helper', async () => {
        const result = await select(await commitChange('test/platform/helper.ts'));
        expect(result.testChangedActors).toStrictEqual([
            {
                actorFullName: 'owner/a',
                build: 'default',
                testFiles: ['test/platform/only-a/uses-helper.test.ts'],
            },
        ]);
    });

    it('selects nothing for a changed README', async () => {
        const result = await select(await commitChange('test/platform/README.md'));
        expect(result).toMatchObject({ changedTests: { narrowed: true }, testChangedActors: [] });
    });

    it('runs every test when a changed file could be read at run time, out of sight of vitest', async () => {
        const result = await select(await commitChange('test/platform/fixtures/data.json'));
        expect(result.changedTests).toStrictEqual({
            narrowed: false,
            reason: "vitest can't see which tests read test/platform/fixtures/data.json",
        });
        expect(result.testChangedActors).toHaveLength(3);
    });

    it('runs every test when a changed test names no Actor of the config', async () => {
        const since = git('rev-parse', 'HEAD');
        await writeRepoFile(
            'test/platform/other/unknown.test.ts',
            `import { testActor } from ${JSON.stringify(libPath)};
testActor('owner/unknown', 'x', async () => {});
`,
        );
        git('add', '-A');
        git('commit', '-q', '-m', 'unknown');

        const result = await select(since);
        expect(result.changedTests).toStrictEqual({
            narrowed: false,
            reason: "can't tell which Actors test/platform/other/unknown.test.ts tests",
        });
    });
});
