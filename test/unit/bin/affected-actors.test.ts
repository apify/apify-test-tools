import type { MockInstance } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAffectedActors, toAffectedActorsDocument } from '../../../bin/affected-actors.js';
import * as DiffChanges from '../../../bin/diff-changes.js';
import * as Git from '../../../bin/git.js';
import type { ActorConfig, Commit } from '../../../bin/types.js';
import * as LoadConfig from '../../../bin/utils/config/load-config.js';

// Everything that reads the configs is mocked, so only the identity and name of an Actor matter here
const actorA = { actorFullName: 'owner/a' } as ActorConfig;
const actorB = { actorFullName: 'owner/b' } as ActorConfig;

const headSha = 'f'.repeat(40);
const sinceSha = '5'.repeat(40);
const commit = (sha: string): Commit => ({ sha, author: 'Dev<dev@example.com>', date: 'Date', message: 'msg' });
const commits = [commit('1'.repeat(40)), commit('2'.repeat(40))];
const changedFiles = ['src/main.ts', 'CHANGELOG.md'];

const selection = { actors: [], ignore: [] };

describe('getAffectedActors', () => {
    let changedActorsSpy: MockInstance;

    beforeEach(() => {
        vi.spyOn(LoadConfig, 'readConfigFile').mockResolvedValue([actorA, actorB]);
        changedActorsSpy = vi
            .spyOn(DiffChanges, 'getChangedActors')
            .mockResolvedValue({ functional: [actorA], cosmetic: [actorB] });
        vi.spyOn(Git, 'resolveCommitSha').mockResolvedValue(headSha);
        vi.spyOn(Git, 'getChangedFilesBetween').mockResolvedValue(changedFiles);
        vi.spyOn(Git, 'getChangelogAdditions').mockResolvedValue('- Added foo');
    });

    it('requires --base or --since', async () => {
        const options = { ...selection };
        await expect(getAffectedActors(options)).rejects.toThrow('Pass --base, --since, or both');
        // An empty --since (e.g. from an empty cache file) counts as not passed
        await expect(getAffectedActors({ ...options, since: '' })).rejects.toThrow('Pass --base, --since, or both');
    });

    describe('with --base', () => {
        let getCommitsSpy: MockInstance;

        beforeEach(() => {
            vi.spyOn(Git, 'hasMergeFromTarget').mockResolvedValue(false);
            getCommitsSpy = vi.spyOn(Git, 'getCommits').mockResolvedValue(commits);
        });

        it('inspects the branch commits after --since', async () => {
            const result = await getAffectedActors({
                base: 'origin/master',
                since: sinceSha,
                ...selection,
            });

            expect(result).toStrictEqual({
                headSha,
                commits,
                changedFiles,
                changelog: '- Added foo',
                functionallyChangedActors: [actorA],
                cosmeticallyChangedActors: [actorB],
            });
            expect(getCommitsSpy).toHaveBeenCalledWith({
                sourceBranch: 'HEAD',
                targetBranch: 'origin/master',
                baseCommit: sinceSha,
            });
            // From the parent of the oldest commit to the newest one, for the files and the changelog alike
            expect(Git.getChangedFilesBetween).toHaveBeenCalledWith(`${commits[0].sha}~`, commits[1].sha);
            expect(Git.getChangelogAdditions).toHaveBeenCalledWith(`${commits[0].sha}~`, commits[1].sha, changedFiles);
            expect(changedActorsSpy).toHaveBeenCalledWith({
                filepathsChanged: changedFiles,
                actorConfigs: [actorA, actorB],
                commits,
            });
        });

        describe('when the branch merged --base in', () => {
            beforeEach(() => {
                vi.spyOn(Git, 'hasMergeFromTarget').mockResolvedValue(true);
                vi.spyOn(Git, 'getBranchOnlyChangedFiles').mockResolvedValue(['own-file']);
            });

            const getWithOwnChanges = async (own: DiffChanges.ChangedActors) => {
                changedActorsSpy.mockImplementation(async ({ filepathsChanged }) =>
                    filepathsChanged[0] === 'own-file' ? own : { functional: [actorA], cosmetic: [actorB] },
                );
                return getAffectedActors({ base: 'master', since: sinceSha, ...selection });
            };

            it("classifies the branch's own files against the whole branch, ignoring --since", async () => {
                await getWithOwnChanges({ functional: [actorA], cosmetic: [] });
                expect(changedActorsSpy).toHaveBeenCalledWith({
                    filepathsChanged: ['own-file'],
                    actorConfigs: [actorA, actorB],
                    commits,
                });
                expect(getCommitsSpy).toHaveBeenCalledWith({ sourceBranch: 'HEAD', targetBranch: 'master' });
            });

            it('reports everything when the branch has functional changes of its own', async () => {
                const result = await getWithOwnChanges({ functional: [actorA], cosmetic: [] });
                expect(result.functionallyChangedActors).toStrictEqual([actorA]);
                expect(result.cosmeticallyChangedActors).toStrictEqual([actorB]);
            });

            it('reports only cosmetic Actors when its own changes are only cosmetic', async () => {
                const result = await getWithOwnChanges({ functional: [], cosmetic: [actorB] });
                expect(result.functionallyChangedActors).toStrictEqual([]);
                expect(result.cosmeticallyChangedActors).toStrictEqual([actorB]);
            });

            it('reports nothing when it has no changes of its own', async () => {
                const result = await getWithOwnChanges({ functional: [], cosmetic: [] });
                expect(result.functionallyChangedActors).toStrictEqual([]);
                expect(result.cosmeticallyChangedActors).toStrictEqual([]);
                // The range is still reported
                expect(result.commits).toStrictEqual(commits);
            });
        });
    });

    describe('with --since only', () => {
        let resolveBaseSpy: MockInstance;
        let commitsBetweenSpy: MockInstance;

        beforeEach(() => {
            resolveBaseSpy = vi.spyOn(Git, 'resolveReleaseBaseCommit').mockResolvedValue(sinceSha);
            commitsBetweenSpy = vi.spyOn(Git, 'getCommitsBetween').mockResolvedValue(commits);
        });

        it('inspects everything after --since up to --head', async () => {
            const result = await getAffectedActors({ since: 'HEAD~2', ...selection });

            expect(result).toStrictEqual({
                headSha,
                commits,
                changedFiles,
                changelog: '- Added foo',
                functionallyChangedActors: [actorA],
                cosmeticallyChangedActors: [actorB],
            });
            expect(resolveBaseSpy).toHaveBeenCalledWith('HEAD~2');
            expect(commitsBetweenSpy).toHaveBeenCalledWith(sinceSha, headSha);
            expect(Git.getChangedFilesBetween).toHaveBeenCalledWith(sinceSha, headSha);
            expect(Git.getChangelogAdditions).toHaveBeenCalledWith(sinceSha, headSha, changedFiles);
        });

        it('has no commits when head is the --since commit', async () => {
            resolveBaseSpy.mockResolvedValue(headSha);

            const result = await getAffectedActors({ since: headSha, ...selection });

            expect(result.commits).toStrictEqual([]);
            // Empty `git log x..x` output doesn't parse as a commit, so it's never run
            expect(commitsBetweenSpy).not.toHaveBeenCalled();
        });
    });
});

describe('toAffectedActorsDocument', () => {
    it('keeps only the Actor names, the config file stays the source of truth for the rest', () => {
        expect(
            toAffectedActorsDocument({
                headSha,
                commits,
                changedFiles: ['src/main.ts'],
                changelog: null,
                functionallyChangedActors: [actorA],
                cosmeticallyChangedActors: [actorB],
            }),
        ).toStrictEqual({
            version: 1,
            head: headSha,
            commits,
            changedFiles: ['src/main.ts'],
            changelog: null,
            functionallyChangedActors: [{ actorFullName: 'owner/a' }],
            cosmeticallyChangedActors: [{ actorFullName: 'owner/b' }],
        });
    });
});
