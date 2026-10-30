import type { MockInstance } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAffectedActors } from '../../../bin/affected-actors.js';
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
        const mergeBaseSha = 'b'.repeat(40);
        let commitsBetweenSpy: MockInstance;

        beforeEach(() => {
            vi.spyOn(Git, 'getMergeBase').mockResolvedValue(mergeBaseSha);
            commitsBetweenSpy = vi.spyOn(Git, 'getCommitsBetween').mockResolvedValue(commits);
        });

        it("inspects the branch's own changes, from where it forked from or last merged --base", async () => {
            const findCommitSpy = vi.spyOn(Git, 'findCommitSha');

            const result = await getAffectedActors({ base: 'origin/master', ...selection });

            expect(result).toStrictEqual({
                version: 1,
                head: headSha,
                commits,
                changedFiles,
                changelog: '- Added foo',
                // Only the names, the config file stays the source of truth for the rest
                functionallyChangedActors: [{ actorFullName: 'owner/a' }],
                cosmeticallyChangedActors: [{ actorFullName: 'owner/b' }],
            });
            expect(Git.getMergeBase).toHaveBeenCalledWith('origin/master', 'HEAD');
            expect(Git.getChangedFilesBetween).toHaveBeenCalledWith(mergeBaseSha, headSha);
            expect(Git.getChangelogAdditions).toHaveBeenCalledWith(mergeBaseSha, headSha, changedFiles);
            expect(commitsBetweenSpy).toHaveBeenCalledWith(mergeBaseSha, headSha);
            expect(changedActorsSpy).toHaveBeenCalledWith({
                filepathsChanged: changedFiles,
                actorConfigs: [actorA, actorB],
                range: { fromRef: mergeBaseSha, toRef: headSha },
            });
            expect(findCommitSpy).not.toHaveBeenCalled();
        });

        describe('and --since', () => {
            const sinceFiles = ['README.md'];

            beforeEach(() => {
                vi.spyOn(Git, 'findCommitSha').mockResolvedValue(sinceSha);
                vi.spyOn(Git, 'getChangedFilesBetween').mockImplementation(async (fromRef) =>
                    fromRef === sinceSha ? sinceFiles : changedFiles,
                );
            });

            const getNarrowed = async (
                branch: DiffChanges.ChangedActors,
                sinceValidated: DiffChanges.ChangedActors,
            ) => {
                changedActorsSpy.mockImplementation(async ({ range }) =>
                    range.fromRef === sinceSha ? sinceValidated : branch,
                );
                const result = await getAffectedActors({ base: 'origin/master', since: sinceSha, ...selection });
                return {
                    functional: result.functionallyChangedActors.map(({ actorFullName }) => actorFullName),
                    cosmetic: result.cosmeticallyChangedActors.map(({ actorFullName }) => actorFullName),
                };
            };

            it('classifies the changes since --since separately', async () => {
                await getNarrowed({ functional: [actorA], cosmetic: [] }, { functional: [actorA], cosmetic: [] });
                expect(changedActorsSpy).toHaveBeenCalledWith({
                    filepathsChanged: sinceFiles,
                    actorConfigs: [actorA, actorB],
                    range: { fromRef: sinceSha, toRef: headSha },
                });
            });

            it('still describes the whole branch', async () => {
                const result = await getAffectedActors({ base: 'origin/master', since: sinceSha, ...selection });
                expect(result.commits).toStrictEqual(commits);
                expect(result.changedFiles).toStrictEqual(changedFiles);
            });

            it('retests an Actor whose validated change meets a new functional change', async () => {
                await expect(
                    getNarrowed({ functional: [actorA], cosmetic: [] }, { functional: [actorA], cosmetic: [] }),
                ).resolves.toStrictEqual({ functional: ['owner/a'], cosmetic: [] });
            });

            it('leaves out Actors that only the branch changed before --since or only --base changed', async () => {
                await expect(
                    getNarrowed({ functional: [actorA], cosmetic: [] }, { functional: [actorB], cosmetic: [] }),
                ).resolves.toStrictEqual({ functional: [], cosmetic: [] });
            });

            it('takes the less impactful change when the two disagree', async () => {
                // A validated functional change, then only cosmetic changes (e.g. a README merged in from base)
                await expect(
                    getNarrowed({ functional: [actorA], cosmetic: [] }, { functional: [], cosmetic: [actorA] }),
                ).resolves.toStrictEqual({ functional: [], cosmetic: ['owner/a'] });
                // A functional change merged in from base, while the branch only changes the README
                await expect(
                    getNarrowed({ functional: [], cosmetic: [actorA] }, { functional: [actorA], cosmetic: [] }),
                ).resolves.toStrictEqual({ functional: [], cosmetic: ['owner/a'] });
            });

            it.each([
                ['is HEAD (a rerun)', headSha],
                ['is not in the local history', undefined],
            ])('checks the whole branch when --since %s', async (_, found) => {
                vi.spyOn(Git, 'findCommitSha').mockResolvedValue(found);
                const result = await getAffectedActors({ base: 'origin/master', since: sinceSha, ...selection });
                expect(result.functionallyChangedActors).toStrictEqual([{ actorFullName: 'owner/a' }]);
                // With no usable validated commit, the "since" diff falls back to the same range as the
                // base diff, so getChangedActors runs twice for identical ranges instead of once.
                expect(changedActorsSpy).toHaveBeenCalledTimes(2);
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

        it('inspects everything after --since up to HEAD', async () => {
            const result = await getAffectedActors({ since: 'HEAD~2', ...selection });

            expect(result).toStrictEqual({
                version: 1,
                head: headSha,
                commits,
                changedFiles,
                changelog: '- Added foo',
                // Only the names, the config file stays the source of truth for the rest
                functionallyChangedActors: [{ actorFullName: 'owner/a' }],
                cosmeticallyChangedActors: [{ actorFullName: 'owner/b' }],
            });
            expect(resolveBaseSpy).toHaveBeenCalledWith('HEAD~2');
            expect(commitsBetweenSpy).toHaveBeenCalledWith(sinceSha, headSha);
            expect(Git.getChangedFilesBetween).toHaveBeenCalledWith(sinceSha, headSha);
            expect(Git.getChangelogAdditions).toHaveBeenCalledWith(sinceSha, headSha, changedFiles);
        });
    });
});
