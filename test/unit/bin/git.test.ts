import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    findCommitSha,
    getChangedFilesBetween,
    getChangelogAdditions,
    getCommitsBetween,
    getCurrentBranch,
    getRepoName,
    normalizeRepoUrl,
    resolveCommitSha,
    resolveReleaseBaseCommit,
    resolveRepoUrl,
} from '../../../bin/git.js';
import * as Utils from '../../../bin/utils.js';
import { RelativeFile } from '../../../bin/utils/path/repo-relative.js';

describe('getChangelogAdditions', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('combines additions from changed linked changelogs, counting shared paths once', async () => {
        const gitCommandSpy = vi
            .spyOn(Utils, 'runGitCommand')
            .mockResolvedValue(
                [
                    'diff --git a/docs/releases.md b/docs/releases.md',
                    '--- a/docs/releases.md',
                    '+++ b/docs/releases.md',
                    '@@ -1 +1 @@',
                    '-Old',
                    '+New entry',
                    'diff --git a/actors/a/history b/actors/a/history',
                    '--- a/actors/a/history',
                    '+++ b/actors/a/history',
                    '@@ -0,0 +1,2 @@',
                    '+Actor entry',
                    '+++ Literal plus signs',
                ].join('\n'),
            );
        await expect(
            getChangelogAdditions(
                'base',
                'head',
                ['docs/releases.md', 'actors/a/history', 'CHANGELOG.md'],
                ['docs/releases.md', './docs/releases.md', 'actors/a/history', 'unchanged.md'].map(
                    (file) => new RelativeFile(file),
                ),
            ),
        ).resolves.toBe('New entry\nActor entry\n++ Literal plus signs');
        expect(gitCommandSpy).toHaveBeenCalledExactlyOnceWith(
            [
                '--literal-pathspecs',
                'diff',
                '--no-renames',
                'base',
                'head',
                '--',
                'docs/releases.md',
                'actors/a/history',
            ],
            { operation: 'read changelog changes since the last release' },
        );
    });

    it.each([{ files: [] }, { files: [new RelativeFile('docs/unchanged.md')] }])(
        'returns null without reading Git when no linked changelog changed ($files)',
        async ({ files }) => {
            const gitCommandSpy = vi.spyOn(Utils, 'runGitCommand');
            await expect(getChangelogAdditions('base', 'head', ['CHANGELOG.md'], files)).resolves.toBeNull();
            expect(gitCommandSpy).not.toHaveBeenCalled();
        },
    );

    it('returns an empty string when a linked changelog has only deletions', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockResolvedValue(
            ['diff --git a/history b/history', '--- a/history', '+++ /dev/null', '@@ -1 +0,0 @@', '-Old entry'].join(
                '\n',
            ),
        );
        await expect(getChangelogAdditions('base', 'head', ['history'], [new RelativeFile('history')])).resolves.toBe(
            '',
        );
    });
});

describe('getCurrentBranch', () => {
    it('should return the checked-out branch', async () => {
        const gitCommandSpy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue('master');
        await expect(getCurrentBranch()).resolves.toBe('master');
        expect(gitCommandSpy).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD'], {
            operation: 'determine the checked-out branch',
        });
    });

    it('should throw on a detached HEAD', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockResolvedValue('HEAD');
        await expect(getCurrentBranch()).rejects.toThrow('HEAD is detached');
    });
});

describe('resolveRepoUrl', () => {
    it('reads and rewrites the origin URL when no URL is supplied', async () => {
        const gitCommandSpy = vi
            .spyOn(Utils, 'runGitCommand')
            .mockResolvedValue('https://github.com/apify/example.git');

        await expect(resolveRepoUrl(undefined)).resolves.toStrictEqual({
            repoUrl: 'git@github.com:apify/example.git',
            shouldVerifyRepoUrl: true,
        });
        expect(gitCommandSpy).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
            operation: 'read the origin repository URL',
        });
    });

    it('uses an explicit URL without reading Git', async () => {
        const gitCommandSpy = vi.spyOn(Utils, 'runGitCommand');

        await expect(resolveRepoUrl('git@github.com:other/example.git')).resolves.toStrictEqual({
            repoUrl: 'git@github.com:other/example.git',
            shouldVerifyRepoUrl: false,
        });
        expect(gitCommandSpy).not.toHaveBeenCalled();
    });
});

describe('normalizeRepoUrl', () => {
    it.each([
        'git@github.com:Apify-Store/google-maps.git',
        'git@github.com:apify-store/google-maps',
        'https://github.com/apify-store/google-maps',
        'https://github.com/apify-store/google-maps.git/',
        'ssh://git@github.com/apify-store/google-maps',
        'git@github.com:apify-store/google-maps#master:actors/foo',
        'https://github.com/apify-store/google-maps#master',
    ])('should normalize %s', (url) => {
        expect(normalizeRepoUrl(url)).toBe('github.com/apify-store/google-maps');
    });

    it('should tell different repositories apart', () => {
        expect(normalizeRepoUrl('git@github.com:my-fork/google-maps.git')).not.toBe(
            normalizeRepoUrl('git@github.com:apify-store/google-maps.git'),
        );
    });
});

describe('getRepoName', () => {
    it('should return the repository name', () => {
        expect(getRepoName('git@github.com:apify-store/google-maps.git')).toBe('google-maps');
    });
});

describe('resolveReleaseBaseCommit', () => {
    const baseSha = 'b'.repeat(40);

    it('should return the base commit when it is an ancestor of HEAD', async () => {
        const gitCommandSpy = vi.spyOn(Utils, 'runGitCommand').mockImplementation(async (args: string[]) => {
            if (args[0] === 'rev-parse') return baseSha;
            if (args[0] === 'merge-base') return baseSha;
            return '';
        });
        await expect(resolveReleaseBaseCommit(baseSha)).resolves.toBe(baseSha);
        expect(gitCommandSpy).toHaveBeenCalledWith(['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`], {
            operation: `look up ${baseSha} in local Git history`,
        });
        expect(gitCommandSpy).toHaveBeenCalledWith(['merge-base', baseSha, 'HEAD'], {
            operation: 'check whether the release base commit is an ancestor of HEAD',
        });
    });

    it('should throw on the all-zeros SHA of a newly created branch', async () => {
        const spy = vi.spyOn(Utils, 'runGitCommand');
        await expect(resolveReleaseBaseCommit('0'.repeat(40))).rejects.toThrow('the branch was just created');
        expect(spy).not.toHaveBeenCalled();
    });

    it('should throw when the base commit is missing from the local history', async () => {
        const spy = vi
            .spyOn(Utils, 'runGitCommand')
            .mockRejectedValue(
                new Utils.GitCommandError(
                    ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`],
                    Object.assign(new Error('missing'), { code: 1 }),
                ),
            );
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow('is not in the local git history');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should throw when rev-parse returns an empty result', async () => {
        const spy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue('');
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow('is not in the local git history');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should throw when the base commit is not an ancestor of HEAD (force push)', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockImplementation(async (args: string[]) => {
            if (args[0] === 'rev-parse') return baseSha;
            if (args[0] === 'merge-base') return 'c'.repeat(40);
            return '';
        });
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow('is not an ancestor of HEAD');
    });

    it('should throw when merge-base reports no common ancestor', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockImplementation(async (args: string[]) => {
            if (args[0] === 'rev-parse') return baseSha;
            throw new Utils.GitCommandError(args, Object.assign(new Error('no common ancestor'), { code: 1 }));
        });
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow('is not an ancestor of HEAD');
    });

    it('explains an unexpected merge-base failure', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockImplementation(async (args, options) => {
            if (args[0] === 'rev-parse') return baseSha;
            throw new Utils.GitCommandError(
                args,
                Object.assign(new Error('Git failed'), { code: 128 }),
                options?.operation,
            );
        });
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow(
            'Failed to check whether the release base commit is an ancestor of HEAD.\n' +
                `Command: git "merge-base" "${baseSha}" "HEAD"\nGit error: Git failed`,
        );
    });

    it('should propagate unexpected Git failures', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockRejectedValue(
            new Utils.GitCommandError(
                ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`],
                Object.assign(new Error('Git failed'), { code: 128 }),
                `look up ${baseSha} in local Git history`,
            ),
        );
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow(
            `Failed to look up ${baseSha} in local Git history.\n` +
                `Command: git "rev-parse" "--verify" "--quiet" "${baseSha}^{commit}"\nGit error: Git failed`,
        );
    });

    it('should throw on an invalid SHA', async () => {
        await expect(resolveReleaseBaseCommit('not-a-sha')).rejects.toThrow('Invalid base commit SHA');
    });

    it('checks ancestry against a custom head', async () => {
        const gitCommandSpy = vi.spyOn(Utils, 'runGitCommand').mockImplementation(async (args: string[]) => {
            if (args[0] === 'rev-parse') return baseSha;
            if (args[0] === 'merge-base') return 'c'.repeat(40);
            return '';
        });
        await expect(resolveReleaseBaseCommit(baseSha, 'origin/release')).rejects.toThrow(
            'is not an ancestor of origin/release',
        );
        expect(gitCommandSpy).toHaveBeenCalledWith(['merge-base', baseSha, 'origin/release'], {
            operation: 'check whether the release base commit is an ancestor of origin/release',
        });
    });
});

describe('getCommitsBetween', () => {
    it('lists the commits after fromRef up to toRef, oldest first', async () => {
        const older = `${'1'.repeat(40)}»¦«Dev<dev@example.com>»¦«Date1»¦«first`;
        const newer = `${'2'.repeat(40)}»¦«Dev<dev@example.com>»¦«Date2»¦«second`;
        const spy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue(`${newer}\n${older}`);

        const commits = await getCommitsBetween('base-sha', 'head-sha');

        expect(commits.map((c) => c.message)).toStrictEqual(['first', 'second']);
        expect(spy).toHaveBeenCalledWith(['log', '--pretty=format:%H»¦«%aN<%aE>»¦«%aD»¦«%s', 'base-sha..head-sha'], {
            operation: 'list commits reachable from the source ref but absent from the target ref',
        });
    });
});
describe('empty commit ranges', () => {
    // Real git on this repository's own history: HEAD..HEAD has no commits
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('getCommitsBetween returns no commits', async () => {
        await expect(getCommitsBetween('HEAD', 'HEAD')).resolves.toStrictEqual([]);
    });
});

describe('getChangedFilesBetween', () => {
    it('diffs the two endpoints directly', async () => {
        const spy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue('src/main.ts\nCHANGELOG.md');

        await expect(getChangedFilesBetween('base-sha', 'head-sha')).resolves.toStrictEqual([
            'src/main.ts',
            'CHANGELOG.md',
        ]);
        expect(spy).toHaveBeenCalledWith(['diff', '--name-only', '--no-renames', 'base-sha..head-sha'], {
            operation: 'get the list of changed files between commits',
        });
    });
});

describe('resolveCommitSha', () => {
    it('resolves a ref to the commit it points to', async () => {
        const sha = 'a'.repeat(40);
        const spy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue(sha);
        await expect(resolveCommitSha('origin/feature')).resolves.toBe(sha);
        expect(spy).toHaveBeenCalledWith(['rev-parse', '--verify', 'origin/feature^{commit}'], {
            operation: 'resolve origin/feature to a commit',
        });
    });
});

describe('findCommitSha', () => {
    // Real git on this repository's own history, since what matters is how git answers
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('resolves a ref in the local history to its commit', async () => {
        await expect(findCommitSha('HEAD')).resolves.toMatch(/^[0-9a-f]{40}$/);
    });

    it('returns undefined for a commit missing from the local history', async () => {
        await expect(findCommitSha('d'.repeat(40))).resolves.toBeUndefined();
    });

    it('rethrows other git failures', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockRejectedValue(new Error('not a git repository'));
        await expect(findCommitSha('HEAD')).rejects.toThrow('not a git repository');
    });
});
