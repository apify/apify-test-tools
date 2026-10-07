import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getChangedActors } from '../../../bin/diff-changes.js';
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

const commits = [{ sha: 'Commit1', author: '', date: '', message: '' }];

describe('getChangedActors', () => {
    it('returns empty array when no files changed', () => {
        expect(getChangedActors({ filepathsChanged: [], actorConfigs, commits })).toEqual([]);
    });

    it('returns empty array when only ignored top-level files changed', () => {
        const result = getChangedActors({
            filepathsChanged: ['.gitignore', 'README.md', '.husky/pre-commit', '.vscode/settings.json'],
            actorConfigs,
            commits,
        });
        expect(result).toEqual([]);
    });

    it('does not ignore source files whose names contain an ignored file name', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/.gitignore-helper.ts'],
            actorConfigs,
            commits,
        });
        expect(result).toEqual([miniActor]);
    });

    it('returns the actor when a functional file in its folder changes', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts'],
            actorConfigs,
            commits,
        });
        expect(result).toEqual([miniActor]);
    });

    it('returns actor when isLatest and README in actor folder changed (cosmetic)', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/README.md'],
            actorConfigs,
            commits,
            isLatest: true,
        });
        expect(result).toEqual([miniActor]);
    });

    it('does not return actor when not isLatest and only README changed (cosmetic)', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/README.md'],
            actorConfigs,
            commits,
            isLatest: false,
        });
        expect(result).toEqual([]);
    });

    it('returns actor when isLatest and actor JSON changes', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/.actor/actor.json'],
            actorConfigs,
            commits,
            isLatest: true,
        });
        expect(result).toEqual([miniActor]);
    });

    it('unrelated changelogs are considered functional', () => {
        const result = getChangedActors({
            filepathsChanged: ['some/other/CHANGELOG.md'],
            actorConfigs,
            commits,
            isLatest: false,
        });
        expect(result).toEqual([miniActor]);
    });

    it('returns actor when JSON file has functional changes', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/.actor/actor.json'],
            actorConfigs,
            commits,
        });
        expect(result).toEqual([miniActor]);
    });

    it('JSON file in actor folder but outside .actor/ is functional, not checked for cosmetic', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/package.json'],
            actorConfigs,
            commits,
            isLatest: false,
        });
        expect(result).toEqual([miniActor]);
    });

    it('JSON file under .actor/ inside actor folder is functional', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/.actor/input_schema.json'],
            actorConfigs,
            commits,
            isLatest: true,
        });
        expect(result).toEqual([miniActor]);
    });

    it('does not trigger narrow-context actor when shared file changes', () => {
        const result = getChangedActors({
            filepathsChanged: ['shared/utils.ts'],
            actorConfigs,
            commits,
        });
        expect(result).toContainEqual(miniActor);
        expect(result).not.toContainEqual(standaloneActor);
    });

    it('root-level changelog outside any actor folder is cosmetic for every actor when isLatest', () => {
        const result = getChangedActors({
            filepathsChanged: ['CHANGELOG.md'],
            actorConfigs,
            commits,
            isLatest: true,
        });
        expect(result).toEqual(expect.arrayContaining([miniActor, standaloneActor]));
        expect(result).toHaveLength(2);
    });

    it('root-level changelog is not cosmetic-triggered when not isLatest', () => {
        const result = getChangedActors({
            filepathsChanged: ['CHANGELOG.md'],
            actorConfigs,
            commits,
            isLatest: false,
        });
        expect(result).toEqual([]);
    });

    it('triggers narrow-context actor when its own folder changes', () => {
        const result = getChangedActors({
            filepathsChanged: ['standalone-actors/standalone/src/main.ts'],
            actorConfigs,
            commits,
        });
        expect(result).toContainEqual(standaloneActor);
    });

    it('deduplicates actors when multiple files in same actor folder change', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts', 'actors/foo_bar/package.json'],
            actorConfigs,
            commits,
        });
        expect(result).toHaveLength(1);
        expect(result).toContainEqual(miniActor);
    });

    it('handles mixed changes: returns both broad and narrow-context actors', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts', 'standalone-actors/standalone/Dockerfile'],
            actorConfigs,
            commits,
        });
        expect(result).toContainEqual(miniActor);
        expect(result).toContainEqual(standaloneActor);
    });

    it('matches folder where folder name differs from actor name', () => {
        const ownerlessActor = actorConfig('myteam/shopify-scraper', 'actors/shopify', 'APIFY_TOKEN_MYTEAM', '', ['']);
        const result = getChangedActors({
            filepathsChanged: ['actors/shopify/src/main.ts'],
            actorConfigs: [ownerlessActor],
            commits,
        });
        expect(result).toEqual([ownerlessActor]);
    });

    it('in single-actor repo, .actor/ changes trigger builds', () => {
        const rootActor = actorConfig('myteam/my-actor', '', 'BUILDER_APIFY_TOKEN', '', ['']);
        const result = getChangedActors({
            filepathsChanged: ['.actor/actor.json'],
            actorConfigs: [rootActor],
            commits,
        });
        expect(result).toEqual([rootActor]);
    });

    it('in multi-actor repo, .actor/ changes only trigger broad-context actors', () => {
        const result = getChangedActors({
            filepathsChanged: ['.actor/actor.json'],
            actorConfigs,
            commits,
        });
        expect(result).toEqual([miniActor]);
    });

    it('file paths are matched case-sensitively', () => {
        const narrowActor = actorConfig('foo/bar', 'actors/foo_bar', 'APIFY_TOKEN_FOO', 'actors/foo_bar', [
            'actors/foo_bar',
        ]);
        const result = getChangedActors({
            filepathsChanged: ['Actors/FOO_BAR/Main.ts'],
            actorConfigs: [narrowActor],
            commits,
        });
        expect(result).toEqual([]);
    });

    it('triggers actor with contextPaths override when file matches an override path', () => {
        const overrideActor = actorConfig(
            'team/override-actor',
            'actors/override',
            'APIFY_TOKEN_TEAM',
            'actors/override',
            ['actors/override', 'packages'],
        );
        const result = getChangedActors({
            filepathsChanged: ['packages/shared/utils.ts'],
            actorConfigs: [overrideActor],
            commits,
        });
        expect(result).toEqual([overrideActor]);
    });

    it('does not trigger actor with contextPaths override when file is outside all override paths', () => {
        const overrideActor = actorConfig(
            'team/override-actor',
            'actors/override',
            'APIFY_TOKEN_TEAM',
            'actors/override',
            ['actors/override', 'packages'],
        );
        const result = getChangedActors({
            filepathsChanged: ['other-dir/file.ts'],
            actorConfigs: [overrideActor],
            commits,
        });
        expect(result).toEqual([]);
    });

    it('broad-context actor skips files in sibling actor folders', () => {
        const actorA = actorConfig('team/actor-a', 'actors/a', 'APIFY_TOKEN_TEAM', '', ['']);
        const actorB = actorConfig('team/actor-b', 'actors/b', 'APIFY_TOKEN_TEAM', '', ['']);
        const result = getChangedActors({
            filepathsChanged: ['actors/b/src/main.ts'],
            actorConfigs: [actorA, actorB],
            commits,
        });
        expect(result).toEqual([actorB]);
    });

    it('root actor is excluded from sibling actor folder files', () => {
        const rootActor = actorConfig('team/root', '', 'APIFY_TOKEN_TEAM', '', ['']);
        const childActor = actorConfig('team/child', 'actors/child', 'APIFY_TOKEN_TEAM', 'actors/child', [
            'actors/child',
        ]);
        const result = getChangedActors({
            filepathsChanged: ['actors/child/src/main.ts'],
            actorConfigs: [rootActor, childActor],
            commits,
        });
        expect(result).not.toContainEqual(rootActor);
        expect(result).toContainEqual(childActor);
    });

    it('root actor sees files outside any actor folder', () => {
        const rootActor = actorConfig('team/root', '', 'APIFY_TOKEN_TEAM', '', ['']);
        const childActor = actorConfig('team/child', 'actors/child', 'APIFY_TOKEN_TEAM', 'actors/child', [
            'actors/child',
        ]);
        const result = getChangedActors({
            filepathsChanged: ['lib/shared-utils.ts'],
            actorConfigs: [rootActor, childActor],
            commits,
        });
        expect(result).toContainEqual(rootActor);
        expect(result).not.toContainEqual(childActor);
    });

    it('file matched by .dockerignore is treated as ignored', () => {
        vi.spyOn(Dockerignore, 'loadDockerIgnore').mockReturnValue(
            (filePath) => filePath === 'actors/foo_bar/node_modules/foo.js',
        );
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/node_modules/foo.js'],
            actorConfigs: [miniActor],
            commits,
        });
        expect(result).toEqual([]);
    });

    it('file not matched by .dockerignore is classified normally', () => {
        vi.spyOn(Dockerignore, 'loadDockerIgnore').mockReturnValue((filePath) => filePath.includes('node_modules'));
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts'],
            actorConfigs: [miniActor],
            commits,
        });
        expect(result).toEqual([miniActor]);
    });

    it('JSON file in context but outside actor folder is functional (not checked for cosmetic)', () => {
        const result = getChangedActors({
            filepathsChanged: ['lib/config.json'],
            actorConfigs: [miniActor],
            commits,
        });
        expect(result).toEqual([miniActor]);
    });

    it('README outside actor folder but inside context is ignored (not cosmetic)', () => {
        const result = getChangedActors({
            filepathsChanged: ['docs/README.md'],
            actorConfigs: [miniActor],
            commits,
            isLatest: true,
        });
        expect(result).toEqual([]);
    });

    it('README inside actor folder is cosmetic', () => {
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/README.md'],
            actorConfigs: [miniActor],
            commits,
            isLatest: true,
        });
        expect(result).toEqual([miniActor]);
    });

    it('ignores a standalone actor top-level dev file relative to its context', () => {
        const result = getChangedActors({
            filepathsChanged: ['standalone-actors/standalone/.eslintrc'],
            actorConfigs,
            commits,
        });
        expect(result).toEqual([]);
    });

    it('does not special-case code/ and shared/ prefixes anymore — must be declared via overrideActorContext', () => {
        const result = getChangedActors({
            filepathsChanged: ['code/some/code.ts'],
            actorConfigs: [miniActor],
            commits,
        });
        expect(result).toEqual([miniActor]);
    });

    it('ignores code/.eslintrc when "code" is declared via overrideActorContext', () => {
        const result = getChangedActors({
            filepathsChanged: ['code/.eslintrc'],
            actorConfigs: [amazonActor],
            commits,
        });
        expect(result).toEqual([]);
    });

    it('shared/Dockerfile declared via overrideActorContext is functional', () => {
        const result = getChangedActors({
            filepathsChanged: ['shared/Dockerfile'],
            actorConfigs: [amazonActor],
            commits,
        });
        expect(result).toEqual([amazonActor]);
    });

    it('code/README.md declared via overrideActorContext is ignored (outside actor folder)', () => {
        const result = getChangedActors({
            filepathsChanged: ['code/README.md'],
            actorConfigs: [amazonActor],
            commits,
            isLatest: true,
        });
        expect(result).toEqual([]);
    });
});

describe('getChangedActors logging', () => {
    beforeEach(() => {
        vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    });

    it('logs a single "specific" group for a single actor with one functional file', () => {
        getChangedActors({
            filepathsChanged: ['actors/foo_bar/src/main.ts'],
            actorConfigs: [miniActor],
            commits,
        });

        expect(logger.info).toHaveBeenCalledWith(
            '[DIFF]: Changes specific to actor foo/bar: actors/foo_bar/src/main.ts',
        );
        expect(logger.info).toHaveBeenCalledWith('[DIFF]: Actors to be built and tested: foo/bar');
    });

    it('logs a single "shared" group when two actors are triggered by the exact same file', () => {
        const actorA = actorConfig('team/actor-a', 'actors/a', 'APIFY_TOKEN_TEAM', '', ['', 'shared']);
        const actorB = actorConfig('team/actor-b', 'actors/b', 'APIFY_TOKEN_TEAM', '', ['', 'shared']);

        getChangedActors({
            filepathsChanged: ['shared/shared.ts'],
            actorConfigs: [actorA, actorB],
            commits,
        });

        expect(logger.info).toHaveBeenCalledWith(
            '[DIFF]: Shared changes for actors team/actor-a, team/actor-b: shared/shared.ts',
        );
        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Changes specific to actor'));
        expect(logger.info).toHaveBeenCalledWith('[DIFF]: Actors to be built and tested: team/actor-a, team/actor-b');
    });

    it('logs shared and specific groups in descending-size order for partial overlap across actors', () => {
        const actorA = actorConfig('team/actor-a', 'actors/a', 'APIFY_TOKEN_TEAM', '', ['']);
        const actorB = actorConfig('team/actor-b', 'actors/b', 'APIFY_TOKEN_TEAM', '', ['']);

        getChangedActors({
            filepathsChanged: ['shared.ts', 'actors/a/a-only.ts', 'actors/b/b-only.ts'],
            actorConfigs: [actorA, actorB],
            commits,
        });

        const errorCalls = vi.mocked(logger.info).mock.calls.map((call) => call[0]);

        expect(errorCalls).toEqual([
            '[DIFF]: Shared changes for actors team/actor-a, team/actor-b: shared.ts',
            '[DIFF]: Changes specific to actor team/actor-a: actors/a/a-only.ts',
            '[DIFF]: Changes specific to actor team/actor-b: actors/b/b-only.ts',
            '[DIFF]: Actors to be built and tested: team/actor-a, team/actor-b',
        ]);
    });

    it('logs no group lines when zero actors changed', () => {
        getChangedActors({
            filepathsChanged: ['.gitignore', '.prettierrc'],
            actorConfigs,
            commits,
        });

        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Shared changes'));
        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Changes specific to'));
        expect(logger.info).toHaveBeenCalledWith('[DIFF]: No relevant files changed, skipping builds and tests');
    });
});
