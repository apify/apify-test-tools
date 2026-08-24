import { afterEach, describe, expect, it, vi } from 'vitest';

const { fsMock } = vi.hoisted(() => ({ fsMock: { writeFile: vi.fn() } }));

vi.mock('node:fs/promises', () => ({ default: fsMock }));

const { writeReleaseNotifyFiles } = await import('../../../bin/release-report.js');

afterEach(() => vi.restoreAllMocks());

const baseOptions = {
    repository: 'myteam/actors',
    changedFiles: ['actors/a/src/main.js'],
    commits: [{ sha: 'abc', author: 'dev', date: '2026-01-01', message: 'feat: add thing' }],
    author: 'dev',
    reportNotifyFile: 'report.json',
    releaseNotifyFile: 'release.json',
};

describe('writeReleaseNotifyFiles', () => {
    it('writes a report notify file with the commit list and changed files', async () => {
        await writeReleaseNotifyFiles({ ...baseOptions, changelog: null, dryRun: false });

        const [file, written] = fsMock.writeFile.mock.calls.find(([f]) => f === 'report.json')!;
        expect(file).toBe('report.json');
        const payload = JSON.parse(written);
        expect(payload.summary).toContain('myteam/actors');
        expect(payload.summary).toContain('feat: add thing');
        expect(payload.summary).toContain('actors/a/src/main.js');
    });

    it('writes a null release notify file when there is no changelog', async () => {
        await writeReleaseNotifyFiles({ ...baseOptions, changelog: null, dryRun: false });

        expect(fsMock.writeFile).toHaveBeenCalledWith('release.json', 'null');
    });

    it('writes a release notify file with the changelog when present', async () => {
        await writeReleaseNotifyFiles({ ...baseOptions, changelog: '- fixed a bug', dryRun: false });

        const [, written] = fsMock.writeFile.mock.calls.find(([f]) => f === 'release.json')!;
        const payload = JSON.parse(written);
        expect(payload.summary).toContain('fixed a bug');
    });

    it('does not write any files on a dry run', async () => {
        await writeReleaseNotifyFiles({ ...baseOptions, changelog: '- fixed a bug', dryRun: true });

        expect(fsMock.writeFile).not.toHaveBeenCalled();
    });
});
