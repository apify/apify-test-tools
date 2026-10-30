import { describe, expect, it } from 'vitest';

import { toTestReport, type VitestJsonReport } from '../../../bin/test-report.js';

const cwd = '/repo';
const run = { actorId: 'owner/a', runId: 'run1', runLink: 'https://console.apify.com/view/runs/run1' };

const vitestReport = (testResults: VitestJsonReport['testResults'], success = false): VitestJsonReport => ({
    success,
    testResults,
});

describe('toTestReport', () => {
    it('reads each test with its status, first failure lines and run', () => {
        const report = toTestReport(
            vitestReport([
                {
                    name: '/repo/test/platform/a.test.ts',
                    status: 'failed',
                    message: '',
                    assertionResults: [
                        {
                            fullName: 'owner/a: works',
                            status: 'passed',
                            duration: 12.6,
                            failureMessages: [],
                            meta: run,
                        },
                        {
                            fullName: 'owner/a: fails',
                            status: 'failed',
                            duration: 3,
                            // Every failure counts, also the same one twice (e.g. a retry)
                            failureMessages: ['AssertionError: boom\n    at a.test.ts:1:1', 'AssertionError: boom\n'],
                            meta: {},
                        },
                        { fullName: 'owner/a: other', status: 'pending', failureMessages: null },
                    ],
                },
            ]),
            { cwd, exitCode: 1 },
        );
        expect(report).toStrictEqual({
            version: 1,
            success: false,
            summary: { total: 3, passed: 1, failed: 1, skipped: 1 },
            tests: [
                {
                    name: 'owner/a: works',
                    file: 'test/platform/a.test.ts',
                    status: 'passed',
                    durationMs: 13,
                    failureMessages: [],
                    run,
                },
                {
                    name: 'owner/a: fails',
                    file: 'test/platform/a.test.ts',
                    status: 'failed',
                    durationMs: 3,
                    failureMessages: ['AssertionError: boom', 'AssertionError: boom'],
                    run: null,
                },
                {
                    name: 'owner/a: other',
                    file: 'test/platform/a.test.ts',
                    status: 'skipped',
                    durationMs: null,
                    failureMessages: [],
                    run: null,
                },
            ],
            errors: [],
        });
    });

    it('reports a test file that failed to load, which has no test to blame', () => {
        const report = toTestReport(
            vitestReport([
                {
                    name: '/repo/test/platform/b.test.ts',
                    status: 'failed',
                    message: "Cannot find package 'foo'\nmore",
                    assertionResults: [],
                },
            ]),
            { cwd, exitCode: 1 },
        );
        expect(report.success).toBe(false);
        expect(report.errors).toStrictEqual(["test/platform/b.test.ts: Cannot find package 'foo'"]);
    });

    it('fails when vitest does, even if every test passed', () => {
        const report = toTestReport(vitestReport([], true), { cwd, exitCode: 1 });
        expect(report.success).toBe(false);
        expect(report.errors).toStrictEqual(['Vitest exited with code 1, see its output above']);
    });

    it('passes when every test passed or was skipped', () => {
        const report = toTestReport(
            vitestReport(
                [
                    {
                        name: '/repo/test/platform/a.test.ts',
                        status: 'passed',
                        message: '',
                        assertionResults: [{ fullName: 'skipped', status: 'skipped', failureMessages: [] }],
                    },
                ],
                true,
            ),
            { cwd, exitCode: 0 },
        );
        expect(report.success).toBe(true);
        expect(report.summary).toStrictEqual({ total: 1, passed: 0, failed: 0, skipped: 1 });
    });
});
