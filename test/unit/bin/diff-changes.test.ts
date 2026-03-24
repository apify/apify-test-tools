import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getChangedActors, maybeParseActorFolder } from '../../../bin/diff-changes.js';
import * as DiffJsonSchema from '../../../bin/diff-json-schema.js';
import type { ActorConfig } from '../../../bin/types.js';

const miniActor: ActorConfig = { actorName: 'foo/bar', folder: 'actors/foo_bar', isStandalone: false };
const standaloneActor: ActorConfig = { actorName: 'standalone', folder: 'standalone-actors/standalone', isStandalone: true };
const actorConfigs = [miniActor, standaloneActor];

const commits = [{ sha: 'Commit1', author: '', date: '', message: '' }];

describe('maybeParseActorFolder', () => {
    it('returns actorName for actors/ path', () => {
        expect(maybeParseActorFolder('actors/foo_bar/actor.json')).toEqual({ isActorFolder: true, actorName: 'foo/bar' });
    });

    it('returns actorName for standalone-actors/ path', () => {
        expect(maybeParseActorFolder('standalone-actors/my_actor/main.ts')).toEqual({ isActorFolder: true, actorName: 'my/actor' });
    });

    it('returns false for top-level file', () => {
        expect(maybeParseActorFolder('package.json')).toEqual({ isActorFolder: false });
    });

    it('returns false for path with no file inside actor folder', () => {
        expect(maybeParseActorFolder('actors/foo_bar')).toEqual({ isActorFolder: false });
    });

    it('returns false for unrelated folder', () => {
        expect(maybeParseActorFolder('src/utils.ts')).toEqual({ isActorFolder: false });
    });
});

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

    it('returns all non-standalone actors when a non-actor-folder functional file changes', () => {
        const result = getChangedActors({
            filepathsChanged: ['shared/utils.ts'],
            actorConfigs,
            commits,
        });
        expect(result).toContainEqual(miniActor);
        expect(result).not.toContainEqual(standaloneActor);
    });

    it('does not include standalone actor in all-actors expansion from changelog', () => {
        const result = getChangedActors({
            filepathsChanged: ['CHANGELOG.md'],
            actorConfigs,
            commits,
            isLatest: true,
        });
        expect(result).toContainEqual(miniActor);
        expect(result).not.toContainEqual(standaloneActor);
    });

    it('includes standalone actor when its own folder changes', () => {
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

    it('handles mixed changes: returns both mini and standalone actors', () => {
        const result = getChangedActors({
            filepathsChanged: [
                'actors/foo_bar/src/main.ts',
                'standalone-actors/standalone/Dockerfile',
            ],
            actorConfigs,
            commits,
        });
        expect(result).toContainEqual(miniActor);
        expect(result).toContainEqual(standaloneActor);
    });

    it('file paths are matched case-insensitively', () => {
        const result = getChangedActors({
            filepathsChanged: ['Actors/FOO_BAR/Main.ts'],
            actorConfigs,
            commits,
        });
        expect(result).toEqual([miniActor]);
    });
});
