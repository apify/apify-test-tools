import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const { fsMock } = vi.hoisted(() => ({ fsMock: { readFile: vi.fn(), writeFile: vi.fn() } }));

vi.mock('node:fs/promises', () => ({ default: fsMock }));

const { reportTestResults } = await import('../../../bin/test-report.js');

afterEach(() => vi.restoreAllMocks());

const passedAssertion = {
    ancestorTitles: [] as string[],
    fullName: 'passes',
    status: 'passed' as const,
    title: 'passes',
    meta: { runId: 'run-1', runLink: 'https://example.com/run-1', actorId: 'actor-1' },
    failureMessages: null as string[] | null,
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
    let stdoutSpy: MockInstance<typeof console.log>;
    let stderrSpy: MockInstance<typeof console.error>;

    beforeEach(() => {
        stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('emits a full test-report document with an empty failed list when there are no failures', async () => {
        mockResults([{ status: 'passed', assertionResults: [passedAssertion] }]);

        await reportTestResults({ input: 'results.json', dryRun: false });

        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        const document = JSON.parse(stdoutSpy.mock.calls[0][0]);
        expect(document).toMatchObject({ type: 'test-report', failed: [], passedCount: 1, totalCount: 1 });
    });

    it('includes a stable id for each failure, built from actorId/fullName', async () => {
        mockResults([
            {
                status: 'failed',
                assertionResults: [
                    failedAssertion({
                        fullName: 'suite does the thing',
                        meta: { runId: 'run-1', runLink: 'https://example.com/run-1', actorId: 'actor-1' },
                    }),
                ],
            },
        ]);

        await reportTestResults({ input: 'results.json', dryRun: false });

        const document = JSON.parse(stdoutSpy.mock.calls[0][0]);
        expect(document.failed[0].id).toBe('actor-1 > suite does the thing');
    });

    it('gives every flattened failure message from the same assertion the same id', async () => {
        mockResults([
            {
                status: 'failed',
                assertionResults: [
                    failedAssertion({
                        fullName: 'suite does the thing',
                        failureMessages: ['Error: first\n    at somewhere', 'Error: second\n    at elsewhere'],
                        meta: { runId: 'run-1', runLink: 'https://example.com/run-1', actorId: 'actor-1' },
                    }),
                ],
            },
        ]);

        await reportTestResults({ input: 'results.json', dryRun: false });

        const document = JSON.parse(stdoutSpy.mock.calls[0][0]);
        expect(document.failed).toHaveLength(2);
        expect(document.failed[0].id).toBe('actor-1 > suite does the thing');
        expect(document.failed[1].id).toBe('actor-1 > suite does the thing');
        // One assertion produced two failure messages: failedCount counts the assertion, not the messages.
        expect(document.failedCount).toBe(1);
    });

    it.each([
        { dryRun: false, stream: 'stdout' as const },
        { dryRun: true, stream: 'stderr' as const },
    ])('writes the document to $stream when dryRun is $dryRun', async ({ dryRun, stream }) => {
        mockResults([{ status: 'failed', assertionResults: [failedAssertion()] }]);

        await reportTestResults({ input: 'results.json', dryRun });

        const [documentSpy, silentSpy] = stream === 'stdout' ? [stdoutSpy, stderrSpy] : [stderrSpy, stdoutSpy];
        const documentCall = documentSpy.mock.calls.find((call) => {
            try {
                return JSON.parse(call[0]).type === 'test-report';
            } catch {
                return false;
            }
        });
        expect(documentCall).toBeDefined();
        expect(silentSpy.mock.calls.map((call) => call[0]).join('\n')).not.toContain('"type":"test-report"');
    });

    it('writes the document to the output file on a real run when output is given', async () => {
        mockResults([{ status: 'failed', assertionResults: [failedAssertion()] }]);

        await reportTestResults({ input: 'results.json', output: 'out.json', dryRun: false });

        expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
        const [file, written] = fsMock.writeFile.mock.calls[0];
        expect(file).toBe('out.json');
        expect(JSON.parse(written)).toMatchObject({ type: 'test-report' });
    });

    it('does not write the output file on a dry run even when output is given', async () => {
        mockResults([{ status: 'failed', assertionResults: [failedAssertion()] }]);

        await reportTestResults({ input: 'results.json', output: 'out.json', dryRun: true });

        expect(fsMock.writeFile).not.toHaveBeenCalled();
    });
});
