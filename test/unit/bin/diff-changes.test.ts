import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getChangedActors } from '../../../bin/diff-changes.js';
import * as DiffJsonSchema from '../../../bin/diff-json-schema.js';
import * as Dockerignore from '../../../bin/dockerignore.js';
import type { ActorConfig } from '../../../bin/types.js';

const miniActor: ActorConfig = {
    actorName: 'foo/bar',
    folder: 'actors/foo_bar',
    tokenEnvVar: 'APIFY_TOKEN_FOO',
    dockerContextDir: '',
    contextPaths: [''],
};
const standaloneActor: ActorConfig = {
    actorName: 'owner/standalone',
    folder: 'standalone-actors/standalone',
    tokenEnvVar: 'APIFY_TOKEN_OWNER',
    dockerContextDir: 'standalone-actors/standalone',
    contextPaths: ['standalone-actors/standalone'],
};
const actorConfigs = [miniActor, standaloneActor];

const commits = [{ sha: 'Commit1', author: '', date: '', message: '' }];

describe('getChangedActors', () => {
    beforeEach(() => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockReturnValue(false);
    });

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

    it('returns actor when isLatest and JSON file has only cosmetic changes', () => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockReturnValue(true);
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/actor.json'],
            actorConfigs,
            commits,
            isLatest: true,
        });
        expect(result).toEqual([miniActor]);
    });

    it('does not return actor when not isLatest and JSON file has only cosmetic changes', () => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockReturnValue(true);
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/actor.json'],
            actorConfigs,
            commits,
            isLatest: false,
        });
        expect(result).toEqual([]);
    });

    it('returns actor when JSON file has functional changes', () => {
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockReturnValue(false);
        const result = getChangedActors({
            filepathsChanged: ['actors/foo_bar/actor.json'],
            actorConfigs,
            commits,
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

    it('does not trigger narrow-context actor from root changelog', () => {
        const result = getChangedActors({
            filepathsChanged: ['CHANGELOG.md'],
            actorConfigs,
            commits,
            isLatest: true,
        });
        expect(result).toContainEqual(miniActor);
        expect(result).not.toContainEqual(standaloneActor);
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
        const ownerlessActor: ActorConfig = {
            actorName: 'myteam/shopify-scraper',
            folder: 'actors/shopify',
            tokenEnvVar: 'APIFY_TOKEN_MYTEAM',
            dockerContextDir: '',
            contextPaths: [''],
        };
        const result = getChangedActors({
            filepathsChanged: ['actors/shopify/src/main.ts'],
            actorConfigs: [ownerlessActor],
            commits,
        });
        expect(result).toEqual([ownerlessActor]);
    });

    it('in single-actor repo, .actor/ changes trigger builds', () => {
        const rootActor: ActorConfig = {
            actorName: 'myteam/my-actor',
            folder: '',
            tokenEnvVar: 'BUILDER_APIFY_TOKEN',
            dockerContextDir: '',
            contextPaths: [''],
        };
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

    it('file paths are matched case-insensitively', () => {
        const result = getChangedActors({
            filepathsChanged: ['Actors/FOO_BAR/Main.ts'],
            actorConfigs,
            commits,
        });
        expect(result).toEqual([miniActor]);
    });

    it('triggers actor with contextPaths override when file matches an override path', () => {
        const overrideActor: ActorConfig = {
            actorName: 'team/override-actor',
            folder: 'actors/override',
            tokenEnvVar: 'APIFY_TOKEN_TEAM',
            dockerContextDir: 'actors/override',
            contextPaths: ['actors/override', 'packages'],
        };
        const result = getChangedActors({
            filepathsChanged: ['packages/shared/utils.ts'],
            actorConfigs: [overrideActor],
            commits,
        });
        expect(result).toEqual([overrideActor]);
    });

    it('does not trigger actor with contextPaths override when file is outside all override paths', () => {
        const overrideActor: ActorConfig = {
            actorName: 'team/override-actor',
            folder: 'actors/override',
            tokenEnvVar: 'APIFY_TOKEN_TEAM',
            dockerContextDir: 'actors/override',
            contextPaths: ['actors/override', 'packages'],
        };
        const result = getChangedActors({
            filepathsChanged: ['other-dir/file.ts'],
            actorConfigs: [overrideActor],
            commits,
        });
        expect(result).toEqual([]);
    });

    it('broad-context actor skips files in sibling actor folders', () => {
        const actorA: ActorConfig = {
            actorName: 'team/actor-a',
            folder: 'actors/a',
            tokenEnvVar: 'APIFY_TOKEN_TEAM',
            dockerContextDir: '',
            contextPaths: [''],
        };
        const actorB: ActorConfig = {
            actorName: 'team/actor-b',
            folder: 'actors/b',
            tokenEnvVar: 'APIFY_TOKEN_TEAM',
            dockerContextDir: '',
            contextPaths: [''],
        };
        const result = getChangedActors({
            filepathsChanged: ['actors/b/src/main.ts'],
            actorConfigs: [actorA, actorB],
            commits,
        });
        expect(result).toEqual([actorB]);
    });

    it('root actor (folder="") is excluded from sibling actor folder files', () => {
        const rootActor: ActorConfig = {
            actorName: 'team/root',
            folder: '',
            tokenEnvVar: 'APIFY_TOKEN_TEAM',
            dockerContextDir: '',
            contextPaths: [''],
        };
        const childActor: ActorConfig = {
            actorName: 'team/child',
            folder: 'actors/child',
            tokenEnvVar: 'APIFY_TOKEN_TEAM',
            dockerContextDir: 'actors/child',
            contextPaths: ['actors/child'],
        };
        const result = getChangedActors({
            filepathsChanged: ['actors/child/src/main.ts'],
            actorConfigs: [rootActor, childActor],
            commits,
        });
        expect(result).not.toContainEqual(rootActor);
        expect(result).toContainEqual(childActor);
    });

    it('root actor (folder="") sees files outside any actor folder', () => {
        const rootActor: ActorConfig = {
            actorName: 'team/root',
            folder: '',
            tokenEnvVar: 'APIFY_TOKEN_TEAM',
            dockerContextDir: '',
            contextPaths: [''],
        };
        const childActor: ActorConfig = {
            actorName: 'team/child',
            folder: 'actors/child',
            tokenEnvVar: 'APIFY_TOKEN_TEAM',
            dockerContextDir: 'actors/child',
            contextPaths: ['actors/child'],
        };
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
        vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockReturnValue(true);
        const result = getChangedActors({
            filepathsChanged: ['lib/config.json'],
            actorConfigs: [miniActor],
            commits,
        });
        expect(result).toEqual([miniActor]);
    });

    it('README outside actor folder but inside context is cosmetic', () => {
        const result = getChangedActors({
            filepathsChanged: ['docs/README.md'],
            actorConfigs: [miniActor],
            commits,
            isLatest: true,
        });
        expect(result).toEqual([miniActor]);
    });

    it('README outside actor folder but inside context is skipped when not isLatest', () => {
        const result = getChangedActors({
            filepathsChanged: ['docs/README.md'],
            actorConfigs: [miniActor],
            commits,
            isLatest: false,
        });
        expect(result).toEqual([]);
    });
});
