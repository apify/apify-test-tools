import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const { fsMock } = vi.hoisted(() => ({ fsMock: { writeFile: vi.fn() } }));

vi.mock('node:fs/promises', () => ({ default: fsMock }));

const { writeReleaseDocument } = await import('../../../bin/release-report.js');

afterEach(() => vi.restoreAllMocks());

const baseOptions = {
    repository: 'myteam/actors',
    changedFiles: ['actors/a/src/main.js'],
    commits: [{ sha: 'abc', author: 'dev', date: '2026-01-01', message: 'feat: add thing' }],
    author: 'dev',
};

describe('writeReleaseDocument', () => {
    let stdoutSpy: MockInstance<typeof console.log>;
    let stderrSpy: MockInstance<typeof console.error>;
    let warnSpy: MockInstance<typeof console.warn>;

    beforeEach(() => {
        stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    it('writes a single release-report document with all fields', async () => {
        await writeReleaseDocument({ ...baseOptions, changelog: '- fixed a bug', dryRun: false });

        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        const document = JSON.parse(stdoutSpy.mock.calls[0][0]);
        expect(document).toEqual({
            type: 'release-report',
            repository: 'myteam/actors',
            author: 'dev',
            changelog: '- fixed a bug',
            commits: baseOptions.commits,
            changedFiles: baseOptions.changedFiles,
        });
        expect(document.view).toBeUndefined();
    });

    it.each([
        { dryRun: false, stream: 'stdout' as const },
        { dryRun: true, stream: 'stderr' as const },
    ])('writes the document to $stream when dryRun is $dryRun', async ({ dryRun, stream }) => {
        await writeReleaseDocument({ ...baseOptions, changelog: '- fixed a bug', dryRun });

        const [documentSpy, silentSpy] = stream === 'stdout' ? [stdoutSpy, stderrSpy] : [stderrSpy, stdoutSpy];
        const documentCall = documentSpy.mock.calls.find((call) => {
            try {
                return JSON.parse(call[0]).type === 'release-report';
            } catch {
                return false;
            }
        });
        expect(documentCall).toBeDefined();
        expect(silentSpy.mock.calls.map((call) => call[0]).join('\n')).not.toContain('"type":"release-report"');
    });

    it('writes the document to the output file on a real run when output is given', async () => {
        await writeReleaseDocument({ ...baseOptions, changelog: '- fixed a bug', dryRun: false, output: 'out.json' });

        expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
        const [file, written] = fsMock.writeFile.mock.calls[0];
        expect(file).toBe('out.json');
        expect(JSON.parse(written)).toMatchObject({ type: 'release-report' });
    });

    it('does not write the output file on a dry run even when output is given', async () => {
        await writeReleaseDocument({ ...baseOptions, changelog: '- fixed a bug', dryRun: true, output: 'out.json' });

        expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('warns when changelog is falsy', async () => {
        await writeReleaseDocument({ ...baseOptions, changelog: null, dryRun: false });

        expect(warnSpy).toHaveBeenCalledWith('No new changelog entries found, did you forget to update it?');
    });

    it('does not warn when changelog is present', async () => {
        await writeReleaseDocument({ ...baseOptions, changelog: '- fixed a bug', dryRun: false });

        expect(warnSpy).not.toHaveBeenCalled();
    });
});
