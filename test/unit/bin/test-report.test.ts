import { afterEach, describe, expect, it, vi } from 'vitest';

const { fsMock } = vi.hoisted(() => ({ fsMock: { readFile: vi.fn(), writeFile: vi.fn() } }));

vi.mock('node:fs/promises', () => ({ default: fsMock }));

const { reportTestResults } = await import('../../../bin/test-report.js');

afterEach(() => vi.restoreAllMocks());

const passedAssertion = {
    ancestorTitles: [],
    fullName: 'passes',
    status: 'passed' as const,
    title: 'passes',
    meta: { runId: 'run-1', runLink: 'https://example.com/run-1', actorId: 'actor-1' },
    failureMessages: null,
};

const failedAssertion = (overrides: Partial<typeof passedAssertion> = {}) => ({
    ...passedAssertion,
    status: 'failed' as const,
    failureMessages: ['Error: boom\n    at somewhere'],
    ...overrides,
});

const mockResults = (testResults: object[]) =>
    fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify({ testResults })));

describe('reportTestResults', () => {
    it('writes a null notify payload when there are no failures', async () => {
        mockResults([{ status: 'passed', assertionResults: [passedAssertion] }]);

        await reportTestResults({ reportFile: 'results.json', notifyFile: 'out.json', dryRun: false });

        expect(fsMock.writeFile).toHaveBeenCalledWith('out.json', 'null');
    });

    it('writes a notify payload summarizing the failures', async () => {
        mockResults([{ status: 'failed', assertionResults: [failedAssertion(), passedAssertion] }]);

        await reportTestResults({
            reportFile: 'results.json',
            notifyFile: 'out.json',
            dryRun: false,
            jobUrl: 'https://example.com/job',
            workflowName: 'nightly',
        });

        const [, written] = fsMock.writeFile.mock.calls[0];
        const payload = JSON.parse(written);
        expect(payload.summary).toContain('nightly');
        expect(payload.summary).toContain('1 failed assertions');
        expect(payload.summary).toContain('Check <https://example.com/job|the job>');
    });

    it('does not write the notify file on a dry run', async () => {
        mockResults([{ status: 'failed', assertionResults: [failedAssertion()] }]);

        await reportTestResults({ reportFile: 'results.json', notifyFile: 'out.json', dryRun: true });

        expect(fsMock.writeFile).not.toHaveBeenCalled();
    });
});
