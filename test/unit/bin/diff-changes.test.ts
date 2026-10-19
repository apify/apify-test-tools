import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getChangedActors } from '../../../bin/diff-changes.js';
import * as DiffJsonSchema from '../../../bin/diff-json-schema.js';
import * as Dockerignore from '../../../bin/dockerignore.js';
import { logger } from '../../../bin/logger.js';
import type { ActorConfig } from '../../../bin/types.js';
import { ExistingDir, RelativeDir, RelativeFile } from '../../../bin/utils/path/repo-relative.js';

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apify-diff-changes-'));
process.chdir(fixtureRoot);
fs.writeFileSync('package.json', '{}');

const actorConfig = (
    actorFullName: string,
    folder: string,
    tokenEnvVar: string,
    dockerContextDir: string,
    contextPaths: string[],
): ActorConfig => {
    const folderPath = folder || '.';
    fs.mkdirSync(folderPath, { recursive: true });
    return {
        actorFullName,
        folder: new ExistingDir(folderPath),
        tokenEnvVar,
        actorJson: {
            file: new RelativeFile(path.join(folderPath, '.actor/actor.json')),
            dockerContextDir: new RelativeDir(dockerContextDir || '.'),
            changelog: new RelativeFile('CHANGELOG.md'),
        },
        dockerContextDir: new RelativeDir(dockerContextDir || '.'),
        contextPaths: contextPaths.map((contextPath) => new RelativeDir(contextPath || '.')),
    };
};

afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

const miniActor = actorConfig('foo/bar', 'actors/foo_bar', 'APIFY_TOKEN_FOO', '', ['']);
const standaloneActor = actorConfig(
    'owner/standalone',
    'standalone-actors/standalone',
    'APIFY_TOKEN_OWNER',
    'standalone-actors/standalone',
    ['standalone-actors/standalone'],
);
const actorConfigs = [miniActor, standaloneActor];
const amazonActor = actorConfig('junglee/amazon-crawler', 'actors/junglee_Amazon-crawler', 'APIFY_TOKEN_JUNGLEE', '', [
    'actors/junglee_Amazon-crawler',
    'code',
    'shared',
]);

const cosmeticDiffRefs = { oldRef: 'Commit1', newRef: 'HEAD' };

describe('getChangedActors', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockResolvedValue(false);
    });

    it('returns empty array when no files changed', async () => {
        expect(await getChangedActors({ filepathsChanged: [], actorConfigs, diffRefs: cosmeticDiffRefs })).toEqual([]);
    });

    it('returns empty array when only ignored top-level files changed', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['.gitignore', 'README.md', '.husky/pre-commit', '.vscode/settings.json'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([]);
    });

    it('does not ignore source files whose names contain an ignored file name', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/.gitignore-helper.ts'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([miniActor]);
    });

    it('returns the actor when a functional file in its folder changes', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([miniActor]);
    });

    it('returns actor when isLatest and README in actor folder changed (cosmetic)', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/README.md'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
            isLatest: true,
        });
        expect(result).toEqual([miniActor]);
    });

    it('does not return actor when not isLatest and only README changed (cosmetic)', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/README.md'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
            isLatest: false,
        });
        expect(result).toEqual([]);
    });

    it('returns actor when isLatest and JSON file has only cosmetic changes', async () => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockResolvedValue(true);
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/.actor/actor.json'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
            isLatest: true,
        });
        expect(result).toEqual([miniActor]);
    });

    it('does not return actor when not isLatest and JSON file has only cosmetic changes', async () => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockResolvedValue(true);
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/.actor/actor.json'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
            isLatest: false,
        });
        expect(result).toEqual([]);
    });

    it('returns actor when JSON file has functional changes', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/.actor/actor.json'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([miniActor]);
    });

    it('JSON file in actor folder but outside .actor/ is functional, not checked for cosmetic', async () => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockResolvedValue(true);
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/package.json'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
            isLatest: false,
        });
        expect(result).toEqual([miniActor]);
        expect(DiffJsonSchema.isCosmeticOnlyJsonSchemaChange).not.toHaveBeenCalled();
    });

    it('JSON file under .actor/ inside actor folder is checked for cosmetic changes', async () => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockResolvedValue(true);
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/.actor/input_schema.json'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
            isLatest: false,
        });
        expect(result).toEqual([]);
        expect(DiffJsonSchema.isCosmeticOnlyJsonSchemaChange).toHaveBeenCalledWith(
            cosmeticDiffRefs.oldRef,
            cosmeticDiffRefs.newRef,
            'actors/foo_bar/.actor/input_schema.json',
        );
    });

    it('checks both baselines when the changed files came from an intersection', async () => {
        const cosmeticSpy = vi
            .spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange')
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const filePath = 'actors/foo_bar/.actor/input_schema.json';

        const result = await getChangedActors({
            filepathsChanged: [filePath],
            actorConfigs,
            diffRefs: { oldRef: 'merge-base', newRef: 'HEAD', baseCommit: 'validated-commit' },
        });

        expect(result).toEqual([miniActor]);
        expect(cosmeticSpy).toHaveBeenNthCalledWith(1, 'merge-base', 'HEAD', filePath);
        expect(cosmeticSpy).toHaveBeenNthCalledWith(2, 'validated-commit', 'HEAD', filePath);
    });

    it('skips an intersected JSON change only when both comparisons are cosmetic', async () => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockResolvedValue(true);

        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/.actor/input_schema.json'],
            actorConfigs,
            diffRefs: { oldRef: 'merge-base', newRef: 'HEAD', baseCommit: 'validated-commit' },
        });

        expect(result).toEqual([]);
        expect(DiffJsonSchema.isCosmeticOnlyJsonSchemaChange).toHaveBeenCalledTimes(2);
    });

    it('builds when the whole-branch JSON comparison is functional', async () => {
        const cosmeticSpy = vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockResolvedValue(false);

        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/.actor/input_schema.json'],
            actorConfigs,
            diffRefs: { oldRef: 'merge-base', newRef: 'HEAD', baseCommit: 'validated-commit' },
        });

        expect(result).toEqual([miniActor]);
        expect(cosmeticSpy).toHaveBeenCalledTimes(1);
    });

    it('does not trigger narrow-context actor when shared file changes', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['shared/utils.ts'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toContainEqual(miniActor);
        expect(result).not.toContainEqual(standaloneActor);
    });

    it('root-level changelog outside any actor folder is cosmetic for every actor when isLatest', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['CHANGELOG.md'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
            isLatest: true,
        });
        expect(result).toEqual(expect.arrayContaining([miniActor, standaloneActor]));
        expect(result).toHaveLength(2);
    });

    it('root-level changelog is not cosmetic-triggered when not isLatest', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['CHANGELOG.md'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
            isLatest: false,
        });
        expect(result).toEqual([]);
    });

    it('treats any changelog filename as cosmetic regardless of configured paths', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['docs/CHANGELOG.md'],
            actorConfigs: [miniActor, standaloneActor],
            diffRefs: cosmeticDiffRefs,
            isLatest: true,
        });
        expect(result).toEqual([miniActor, standaloneActor]);
    });

    it('does not special-case a configured readme outside the actor context', async () => {
        const configuredActor: ActorConfig = {
            ...standaloneActor,
            actorJson: { ...standaloneActor.actorJson, readme: new RelativeFile('docs/guide.md') },
        };
        const result = await getChangedActors({
            filepathsChanged: ['docs/guide.md'],
            actorConfigs: [configuredActor],
            diffRefs: cosmeticDiffRefs,
            isLatest: true,
        });
        expect(result).toEqual([]);
    });

    it('triggers narrow-context actor when its own folder changes', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['standalone-actors/standalone/src/main.ts'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toContainEqual(standaloneActor);
    });

    it('deduplicates actors when multiple files in same actor folder change', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts', 'actors/foo_bar/package.json'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toHaveLength(1);
        expect(result).toContainEqual(miniActor);
    });

    it('handles mixed changes: returns both broad and narrow-context actors', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts', 'standalone-actors/standalone/Dockerfile'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toContainEqual(miniActor);
        expect(result).toContainEqual(standaloneActor);
    });

    it('matches folder where folder name differs from actor name', async () => {
        const ownerlessActor = actorConfig('myteam/shopify-scraper', 'actors/shopify', 'APIFY_TOKEN_MYTEAM', '', ['']);
        const result = await getChangedActors({
            filepathsChanged: ['actors/shopify/src/main.ts'],
            actorConfigs: [ownerlessActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([ownerlessActor]);
    });

    it('in single-actor repo, .actor/ changes trigger builds', async () => {
        const rootActor = actorConfig('myteam/my-actor', '', 'BUILDER_APIFY_TOKEN', '', ['']);
        const result = await getChangedActors({
            filepathsChanged: ['.actor/actor.json'],
            actorConfigs: [rootActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([rootActor]);
    });

    it('in multi-actor repo, .actor/ changes only trigger broad-context actors', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['.actor/actor.json'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([miniActor]);
    });

    it('file paths are matched case-sensitively', async () => {
        const narrowActor = actorConfig('foo/bar', 'actors/foo_bar', 'APIFY_TOKEN_FOO', 'actors/foo_bar', [
            'actors/foo_bar',
        ]);
        const result = await getChangedActors({
            filepathsChanged: ['Actors/FOO_BAR/Main.ts'],
            actorConfigs: [narrowActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([]);
    });

    it('triggers actor with contextPaths override when file matches an override path', async () => {
        const overrideActor = actorConfig(
            'team/override-actor',
            'actors/override',
            'APIFY_TOKEN_TEAM',
            'actors/override',
            ['actors/override', 'packages'],
        );
        const result = await getChangedActors({
            filepathsChanged: ['packages/shared/utils.ts'],
            actorConfigs: [overrideActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([overrideActor]);
    });

    it('does not trigger actor with contextPaths override when file is outside all override paths', async () => {
        const overrideActor = actorConfig(
            'team/override-actor',
            'actors/override',
            'APIFY_TOKEN_TEAM',
            'actors/override',
            ['actors/override', 'packages'],
        );
        const result = await getChangedActors({
            filepathsChanged: ['other-dir/file.ts'],
            actorConfigs: [overrideActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([]);
    });

    it('broad-context actor skips files in sibling actor folders', async () => {
        const actorA = actorConfig('team/actor-a', 'actors/a', 'APIFY_TOKEN_TEAM', '', ['']);
        const actorB = actorConfig('team/actor-b', 'actors/b', 'APIFY_TOKEN_TEAM', '', ['']);
        const result = await getChangedActors({
            filepathsChanged: ['actors/b/src/main.ts'],
            actorConfigs: [actorA, actorB],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([actorB]);
    });

    it('root actor is excluded from sibling actor folder files', async () => {
        const rootActor = actorConfig('team/root', '', 'APIFY_TOKEN_TEAM', '', ['']);
        const childActor = actorConfig('team/child', 'actors/child', 'APIFY_TOKEN_TEAM', 'actors/child', [
            'actors/child',
        ]);
        const result = await getChangedActors({
            filepathsChanged: ['actors/child/src/main.ts'],
            actorConfigs: [rootActor, childActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).not.toContainEqual(rootActor);
        expect(result).toContainEqual(childActor);
    });

    it('root actor sees files outside any actor folder', async () => {
        const rootActor = actorConfig('team/root', '', 'APIFY_TOKEN_TEAM', '', ['']);
        const childActor = actorConfig('team/child', 'actors/child', 'APIFY_TOKEN_TEAM', 'actors/child', [
            'actors/child',
        ]);
        const result = await getChangedActors({
            filepathsChanged: ['lib/shared-utils.ts'],
            actorConfigs: [rootActor, childActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toContainEqual(rootActor);
        expect(result).not.toContainEqual(childActor);
    });

    it('file matched by .dockerignore is treated as ignored', async () => {
        vi.spyOn(Dockerignore, 'loadDockerIgnore').mockReturnValue(
            (filePath) => filePath === 'actors/foo_bar/node_modules/foo.js',
        );
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/node_modules/foo.js'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([]);
    });

    it('file not matched by .dockerignore is classified normally', async () => {
        vi.spyOn(Dockerignore, 'loadDockerIgnore').mockReturnValue((filePath) => filePath.includes('node_modules'));
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([miniActor]);
    });

    it('test file listed in .dockerignore triggers a build when it matches the test files glob', async () => {
        vi.spyOn(Dockerignore, 'loadDockerIgnore').mockReturnValue((filePath) => filePath.startsWith('test/'));
        const result = await getChangedActors({
            filepathsChanged: ['test/platform/daily/foo.test.ts'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
            testFilesGlob: 'test/platform/**',
        });
        expect(result).toEqual([miniActor]);
    });

    it('test file listed in .dockerignore stays ignored without a test files glob', async () => {
        vi.spyOn(Dockerignore, 'loadDockerIgnore').mockReturnValue((filePath) => filePath.startsWith('test/'));
        const result = await getChangedActors({
            filepathsChanged: ['test/platform/daily/foo.test.ts'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([]);
    });

    it('test files glob matches case-insensitively and does not bypass .dockerignore for other files', async () => {
        vi.spyOn(Dockerignore, 'loadDockerIgnore').mockReturnValue(() => true);
        const result = await getChangedActors({
            filepathsChanged: ['Test/Platform/Foo.test.ts'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
            testFilesGlob: 'test/platform/**',
        });
        expect(result).toEqual([miniActor]);
        expect(
            await getChangedActors({
                filepathsChanged: ['actors/foo_bar/node_modules/foo.js'],
                actorConfigs: [miniActor],
                diffRefs: cosmeticDiffRefs,
                testFilesGlob: 'test/platform/**',
            }),
        ).toEqual([]);
    });

    it('test file outside an actor context still does not trigger it', async () => {
        vi.spyOn(Dockerignore, 'loadDockerIgnore').mockReturnValue(() => true);
        const result = await getChangedActors({
            filepathsChanged: ['test/platform/daily/foo.test.ts'],
            actorConfigs: [standaloneActor],
            diffRefs: cosmeticDiffRefs,
            testFilesGlob: 'test/platform/**',
        });
        expect(result).toEqual([]);
    });

    it('test file listed in .dockerignore triggers an actor whose overrideActorContext includes it', async () => {
        vi.spyOn(Dockerignore, 'loadDockerIgnore').mockReturnValue(() => true);
        const actorWithTests = {
            ...standaloneActor,
            contextPaths: [...standaloneActor.contextPaths, new RelativeDir('test')],
        };
        const result = await getChangedActors({
            filepathsChanged: ['test/platform/standalone.test.ts'],
            actorConfigs: [actorWithTests],
            diffRefs: cosmeticDiffRefs,
            testFilesGlob: 'test/platform/**',
        });
        expect(result).toEqual([actorWithTests]);
    });

    it('JSON file in context but outside actor folder is functional (not checked for cosmetic)', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['lib/config.json'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([miniActor]);
    });

    it('README outside actor folder but inside context is ignored (not cosmetic)', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['docs/README.md'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
            isLatest: true,
        });
        expect(result).toEqual([]);
    });

    it('README inside actor folder is cosmetic', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['actors/foo_bar/README.md'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
            isLatest: true,
        });
        expect(result).toEqual([miniActor]);
    });

    it('ignores a standalone actor top-level dev file relative to its context', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['standalone-actors/standalone/.eslintrc'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([]);
    });

    it('does not special-case code/ and shared/ prefixes anymore — must be declared via overrideActorContext', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['code/some/code.ts'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([miniActor]);
    });

    it('ignores code/.eslintrc when "code" is declared via overrideActorContext', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['code/.eslintrc'],
            actorConfigs: [amazonActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([]);
    });

    it('shared/Dockerfile declared via overrideActorContext is functional', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['shared/Dockerfile'],
            actorConfigs: [amazonActor],
            diffRefs: cosmeticDiffRefs,
        });
        expect(result).toEqual([amazonActor]);
    });

    it('code/README.md declared via overrideActorContext is ignored (outside actor folder)', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['code/README.md'],
            actorConfigs: [amazonActor],
            diffRefs: cosmeticDiffRefs,
            isLatest: true,
        });
        expect(result).toEqual([]);
    });
});

describe('getChangedActors logging', () => {
    beforeEach(() => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockResolvedValue(false);
        vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });

    it('logs a single "specific" group for a single actor with one functional file', async () => {
        await getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
        });

        expect(logger.info).toHaveBeenCalledWith(
            '[DIFF]: Changes specific to actor foo/bar: actors/foo_bar/src/main.ts',
        );
        expect(logger.info).toHaveBeenCalledWith('[DIFF]: Actors to be built and tested: foo/bar');
    });

    it('logs a single "shared" group when two actors are triggered by the exact same file', async () => {
        const actorA = actorConfig('team/actor-a', 'actors/a', 'APIFY_TOKEN_TEAM', '', ['', 'shared']);
        const actorB = actorConfig('team/actor-b', 'actors/b', 'APIFY_TOKEN_TEAM', '', ['', 'shared']);

        await getChangedActors({
            filepathsChanged: ['shared/shared.ts'],
            actorConfigs: [actorA, actorB],
            diffRefs: cosmeticDiffRefs,
        });

        expect(logger.info).toHaveBeenCalledWith(
            '[DIFF]: Shared changes for actors team/actor-a, team/actor-b: shared/shared.ts',
        );
        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Changes specific to actor'));
        expect(logger.info).toHaveBeenCalledWith('[DIFF]: Actors to be built and tested: team/actor-a, team/actor-b');
    });

    it('logs shared and specific groups in descending-size order for partial overlap across actors', async () => {
        const actorA = actorConfig('team/actor-a', 'actors/a', 'APIFY_TOKEN_TEAM', '', ['']);
        const actorB = actorConfig('team/actor-b', 'actors/b', 'APIFY_TOKEN_TEAM', '', ['']);

        await getChangedActors({
            filepathsChanged: ['shared.ts', 'actors/a/a-only.ts', 'actors/b/b-only.ts'],
            actorConfigs: [actorA, actorB],
            diffRefs: cosmeticDiffRefs,
        });

        const errorCalls = vi.mocked(logger.info).mock.calls.map((call) => call[0]);

        expect(errorCalls).toEqual([
            '[DIFF]: Shared changes for actors team/actor-a, team/actor-b: shared.ts',
            '[DIFF]: Changes specific to actor team/actor-a: actors/a/a-only.ts',
            '[DIFF]: Changes specific to actor team/actor-b: actors/b/b-only.ts',
            '[DIFF]: Actors to be built and tested: team/actor-a, team/actor-b',
        ]);
    });

    const outsideContextWarning = (testFile: string) =>
        `[DIFF]: Test file ${testFile} is outside every Actor's context, so changing only it builds and tests nothing. ` +
        'Add its folder to "overrideActorContext" of the Actors it tests.';

    it('warns about a changed test file outside every Actor context', async () => {
        await getChangedActors({
            filepathsChanged: ['test/platform/standalone.test.ts'],
            actorConfigs: [standaloneActor],
            diffRefs: cosmeticDiffRefs,
            testFilesGlob: 'test/platform/**',
        });

        expect(logger.warn).toHaveBeenCalledWith(outsideContextWarning('test/platform/standalone.test.ts'));
    });

    it('still warns when the same push also rebuilds an Actor', async () => {
        const result = await getChangedActors({
            filepathsChanged: ['test/platform/standalone.test.ts', 'standalone-actors/standalone/src/main.ts'],
            actorConfigs: [standaloneActor],
            diffRefs: cosmeticDiffRefs,
            testFilesGlob: 'test/platform/**',
        });

        expect(result).toEqual([standaloneActor]);
        expect(logger.warn).toHaveBeenCalledWith(outsideContextWarning('test/platform/standalone.test.ts'));
    });

    it('does not warn about test files inside an Actor context, even cosmetic ones', async () => {
        await getChangedActors({
            filepathsChanged: ['test/platform/foo.test.ts', 'test/platform/README.md', 'test/platform/CHANGELOG.md'],
            actorConfigs: [miniActor],
            diffRefs: cosmeticDiffRefs,
            testFilesGlob: 'test/platform/**',
        });

        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs no group lines when zero actors changed', async () => {
        await getChangedActors({
            filepathsChanged: ['.gitignore', '.prettierrc'],
            actorConfigs,
            diffRefs: cosmeticDiffRefs,
        });

        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Shared changes'));
        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Changes specific to'));
        expect(logger.info).toHaveBeenCalledWith('[DIFF]: No relevant files changed, skipping builds and tests');
    });
});
