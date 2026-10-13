import type { MockInstance } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAffectedActors, toAffectedActorsDocument } from '../../../bin/affected-actors.js';
import * as DiffChanges from '../../../bin/diff-changes.js';
import * as Git from '../../../bin/git.js';
import type { ActorConfig, Commit } from '../../../bin/types.js';
import * as LoadConfig from '../../../bin/utils/config/load-config.js';

const actorA: ActorConfig = {
    actorFullName: 'owner/a',
    folder: 'actors/a',
    tokenEnvVar: 'APIFY_TOKEN_OWNER',
    dockerContextDir: '',
    contextPaths: [''],
};
const actorB: ActorConfig = { ...actorA, actorFullName: 'owner/b', folder: 'actors/b' };

const headSha = 'f'.repeat(40);
const sinceSha = '5'.repeat(40);
const commit = (sha: string): Commit => ({ sha, author: 'Dev<dev@example.com>', date: 'Date', message: 'msg' });
const commits = [commit('1'.repeat(40)), commit('2'.repeat(40))];

const selection = { actors: [], ignore: [] };
const noChanges = { functional: [], cosmetic: [] };

describe('getAffectedActors', () => {
    let readConfigSpy: MockInstance;
    let byImpactSpy: MockInstance;

    beforeEach(() => {
        readConfigSpy = vi.spyOn(LoadConfig, 'readConfigFile').mockResolvedValue([actorA, actorB]);
        byImpactSpy = vi
            .spyOn(DiffChanges, 'getChangedActorsByImpact')
            .mockResolvedValue({ functional: [actorA], cosmetic: [actorB] });
        vi.spyOn(Git, 'resolveCommitSha').mockResolvedValue(headSha);
        vi.spyOn(Git, 'resolveBranchName').mockResolvedValue('feature');
    });

    it('requires --base or --since', async () => {
        const options = { head: 'HEAD', ...selection };
        await expect(getAffectedActors(options)).rejects.toThrow('Pass --base, --since, or both');
        // An empty --since (e.g. from an empty cache file) counts as not passed
        await expect(getAffectedActors({ ...options, since: '' })).rejects.toThrow('Pass --base, --since, or both');
    });

    describe('with --base', () => {
        let getCommitsSpy: MockInstance;

        beforeEach(() => {
            vi.spyOn(Git, 'hasMergeFromTarget').mockResolvedValue(false);
            getCommitsSpy = vi.spyOn(Git, 'getCommits').mockResolvedValue(commits);
            vi.spyOn(Git, 'getChangedFiles').mockResolvedValue(['src/main.ts', 'CHANGELOG.md']);
            vi.spyOn(Git, 'getChangelogAdditions').mockResolvedValue('- Added foo');
        });

        it('inspects the branch commits after --since', async () => {
            const result = await getAffectedActors({
                head: 'origin/feature',
                base: 'origin/master',
                since: sinceSha,
                ...selection,
            });

            expect(result).toStrictEqual({
                headSha,
                ref: 'feature',
                commits,
                changedFiles: ['src/main.ts', 'CHANGELOG.md'],
                changelog: '- Added foo',
                functionallyChangedActors: [actorA],
                cosmeticallyChangedActors: [actorB],
            });
            expect(getCommitsSpy).toHaveBeenCalledWith({
                sourceBranch: 'origin/feature',
                targetBranch: 'origin/master',
                baseCommit: sinceSha,
            });
            // Same range getChangedFiles diffs
            expect(Git.getChangelogAdditions).toHaveBeenCalledWith(`${commits[0].sha}~`, commits[1].sha, [
                'src/main.ts',
                'CHANGELOG.md',
            ]);
            expect(byImpactSpy).toHaveBeenCalledWith({
                filepathsChanged: ['src/main.ts', 'CHANGELOG.md'],
                actorConfigs: [actorA, actorB],
                commits,
            });
        });

        it('reports nothing when the branch has no changes of its own besides merging --base in', async () => {
            vi.spyOn(Git, 'hasMergeFromTarget').mockResolvedValue(true);
            vi.spyOn(Git, 'getBranchOnlyChangedFiles').mockResolvedValue(['test/foo.test.ts']);
            byImpactSpy.mockResolvedValueOnce(noChanges);

            const result = await getAffectedActors({ head: 'feature', base: 'master', since: sinceSha, ...selection });

            expect(result.functionallyChangedActors).toStrictEqual([]);
            expect(result.cosmeticallyChangedActors).toStrictEqual([]);
            // The branch's own files are classified against the whole branch, ignoring --since
            expect(byImpactSpy).toHaveBeenCalledOnce();
            expect(byImpactSpy).toHaveBeenCalledWith({
                filepathsChanged: ['test/foo.test.ts'],
                actorConfigs: [actorA, actorB],
                commits,
            });
            expect(getCommitsSpy).toHaveBeenCalledWith({ sourceBranch: 'feature', targetBranch: 'master' });
            // The range is still reported
            expect(result.commits).toStrictEqual(commits);
        });

        it('reports only cosmetic Actors when the branch has only cosmetic changes besides merging --base in', async () => {
            vi.spyOn(Git, 'hasMergeFromTarget').mockResolvedValue(true);
            vi.spyOn(Git, 'getBranchOnlyChangedFiles').mockResolvedValue(['actors/b/README.md']);
            byImpactSpy.mockResolvedValueOnce({ functional: [], cosmetic: [actorB] });

            const result = await getAffectedActors({ head: 'feature', base: 'master', ...selection });

            // actorA's functional changes came from --base, which is already validated
            expect(result.functionallyChangedActors).toStrictEqual([]);
            expect(result.cosmeticallyChangedActors).toStrictEqual([actorB]);
        });

        it('runs the full check when the branch has functional changes besides the merge', async () => {
            vi.spyOn(Git, 'hasMergeFromTarget').mockResolvedValue(true);
            vi.spyOn(Git, 'getBranchOnlyChangedFiles').mockResolvedValue(['src/main.ts']);
            byImpactSpy.mockResolvedValueOnce({ functional: [actorA], cosmetic: [] });

            const result = await getAffectedActors({ head: 'feature', base: 'master', ...selection });

            expect(result.functionallyChangedActors).toStrictEqual([actorA]);
            expect(result.cosmeticallyChangedActors).toStrictEqual([actorB]);
            expect(byImpactSpy).toHaveBeenCalledTimes(2);
            expect(byImpactSpy).toHaveBeenLastCalledWith(
                expect.objectContaining({ filepathsChanged: ['src/main.ts', 'CHANGELOG.md'] }),
            );
        });
    });

    describe('with --since only', () => {
        let resolveBaseSpy: MockInstance;
        let releaseChangesSpy: MockInstance;

        beforeEach(() => {
            resolveBaseSpy = vi.spyOn(Git, 'resolveReleaseBaseCommit').mockResolvedValue(sinceSha);
            releaseChangesSpy = vi.spyOn(Git, 'getReleaseChanges').mockResolvedValue({
                commits,
                changedFiles: ['actors/b/README.md', 'src/main.ts'],
                changelog: null,
            });
        });

        it('inspects everything after --since up to --head', async () => {
            const result = await getAffectedActors({ head: 'release', since: 'HEAD~2', ...selection });

            expect(result).toStrictEqual({
                headSha,
                ref: 'feature',
                commits,
                changedFiles: ['actors/b/README.md', 'src/main.ts'],
                changelog: null,
                functionallyChangedActors: [actorA],
                cosmeticallyChangedActors: [actorB],
            });
            expect(resolveBaseSpy).toHaveBeenCalledWith('HEAD~2', { head: 'release', optionName: '--since' });
            expect(releaseChangesSpy).toHaveBeenCalledWith(sinceSha, 'release');
            expect(byImpactSpy).toHaveBeenCalledWith({
                filepathsChanged: ['actors/b/README.md', 'src/main.ts'],
                actorConfigs: [actorA, actorB],
                commits,
            });
        });

        it('returns nothing without reading the config when head is the --since commit', async () => {
            releaseChangesSpy.mockResolvedValue(null);

            const result = await getAffectedActors({ head: 'HEAD', since: sinceSha, ...selection });

            expect(result).toStrictEqual({
                headSha,
                ref: 'feature',
                commits: [],
                changedFiles: [],
                changelog: null,
                functionallyChangedActors: [],
                cosmeticallyChangedActors: [],
            });
            expect(readConfigSpy).not.toHaveBeenCalled();
            expect(byImpactSpy).not.toHaveBeenCalled();
        });
    });
});

describe('toAffectedActorsDocument', () => {
    it('keeps only the Actor names, the config file stays the source of truth for the rest', () => {
        expect(
            toAffectedActorsDocument({
                headSha,
                ref: null,
                commits,
                changedFiles: ['src/main.ts'],
                changelog: null,
                functionallyChangedActors: [actorA],
                cosmeticallyChangedActors: [actorB],
            }),
        ).toStrictEqual({
            version: 1,
            ref: null,
            head: headSha,
            commits,
            changedFiles: ['src/main.ts'],
            changelog: null,
            functionallyChangedActors: [{ actorFullName: 'owner/a' }],
            cosmeticallyChangedActors: [{ actorFullName: 'owner/b' }],
        });
    });
});
