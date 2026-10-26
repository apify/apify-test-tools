import { WebClient } from '@slack/web-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatSlackMessage, githubRunContext, notifyTestReport } from '../../../bin/notify.js';
import type { TestCaseReport, TestReport } from '../../../bin/test-report.js';

vi.mock('@slack/web-api', () => ({ WebClient: vi.fn() }));

const TOKEN_ENV_VAR = 'SLACK_TOKEN_TESTS_BOT';
const postMessage = vi.fn();
const authTest = vi.fn();

const testCase = (name: string, overrides: Partial<TestCaseReport> = {}): TestCaseReport => ({
    name,
    file: 'test/platform/a.test.ts',
    status: 'passed',
    durationMs: 1,
    failureMessages: [],
    run: { actorId: 'owner/a', runId: name, runLink: `https://console.apify.com/view/runs/${name}` },
    ...overrides,
});

const failing = (name: string, message = 'AssertionError: boom') =>
    testCase(name, { status: 'failed', failureMessages: [message] });

const reportOf = (tests: TestCaseReport[], errors: string[] = []): TestReport => {
    const count = (status: string) => tests.filter((test) => test.status === status).length;
    return {
        version: 1,
        success: count('failed') === 0 && errors.length === 0,
        summary: { total: tests.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped') },
        tests,
        errors,
    };
};

const notify = async (overrides: Partial<Parameters<typeof notifyTestReport>[0]> = {}) =>
    notifyTestReport({
        report: reportOf([testCase('ok'), failing('bad')]),
        on: 'failure',
        slackChannels: ['#notif'],
        title: 'Platform tests',
        dryRun: false,
        ...overrides,
    });

describe('notifyTestReport', () => {
    beforeEach(() => {
        vi.stubEnv(TOKEN_ENV_VAR, 'token');
        postMessage.mockResolvedValue({ ts: '1.1' });
        vi.mocked(WebClient).mockImplementation(function () {
            return { chat: { postMessage }, auth: { test: authTest } };
        } as never);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
    });

    it('posts failures to every channel', async () => {
        await notify({ slackChannels: ['#a', '#b'] });
        expect(postMessage.mock.calls.map(([message]) => message.channel)).toStrictEqual(['#a', '#b']);
    });

    it('puts the failures after the first in the thread', async () => {
        await notify({ report: reportOf([failing('one'), failing('two'), failing('three')]) });
        expect(postMessage).toHaveBeenCalledTimes(2);
        expect(postMessage.mock.calls[1][0]).toMatchObject({ channel: '#notif', thread_ts: '1.1' });
        expect(postMessage.mock.calls[1][0].blocks).toHaveLength(2);
    });

    it('splits a long thread into replies Slack accepts', async () => {
        const tests = Array.from({ length: 120 }, (_, i) => failing(`test ${i}`));
        await notify({ report: reportOf(tests) });
        const replies = postMessage.mock.calls.slice(1).map(([message]) => message.blocks.length);
        expect(replies).toStrictEqual([50, 50, 19]);
    });

    it('posts nothing when the tests passed, but still checks the token', async () => {
        vi.stubEnv(TOKEN_ENV_VAR, '');
        await expect(notify({ report: reportOf([testCase('ok')]) })).rejects.toThrow(`${TOKEN_ENV_VAR} not defined`);

        vi.stubEnv(TOKEN_ENV_VAR, 'token');
        await notify({ report: reportOf([testCase('ok')]) });
        expect(WebClient).toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('posts passing runs too with on: always', async () => {
        await notify({ report: reportOf([testCase('ok')]), on: 'always' });
        expect(postMessage).toHaveBeenCalledWith({ channel: '#notif', text: '`Platform tests`: all 1 tests passed.' });
    });

    it('needs no token without a channel', async () => {
        vi.stubEnv(TOKEN_ENV_VAR, '');
        await notify({ slackChannels: [''] });
        expect(WebClient).not.toHaveBeenCalled();
    });

    it('verifies the token but posts nothing in a dry run', async () => {
        await notify({ dryRun: true });
        expect(authTest).toHaveBeenCalledTimes(1);
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('defaults the title and the link to the GitHub Actions run', async () => {
        vi.stubEnv('GITHUB_WORKFLOW', 'Platform tests - Core');
        vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
        vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
        vi.stubEnv('GITHUB_RUN_ID', '42');
        await notify({ title: undefined });
        expect(postMessage.mock.calls[0][0].text).toContain(
            '`Platform tests - Core`: 1 of 2 tests failed. Check <https://github.com/owner/repo/actions/runs/42|the job>.',
        );
    });
});

describe('formatSlackMessage', () => {
    it('leads with the outcome and the first failure, linked to its run', () => {
        const { text, details } = formatSlackMessage({
            report: reportOf([testCase('ok'), failing('owner/a: fails'), failing('owner/a: also')]),
            title: 'Tests',
            jobUrl: 'https://job',
        });
        expect(text).toBe(
            '`Tests`: 2 of 3 tests failed. Check <https://job|the job>.\n\n' +
                '*owner/a: fails*: AssertionError: boom --- <https://console.apify.com/view/runs/owner/a: fails|owner/a>',
        );
        expect(details).toStrictEqual([
            '• *owner/a: also*: AssertionError: boom --- <https://console.apify.com/view/runs/owner/a: also|owner/a>',
        ]);
    });

    it('reports errors outside of tests, e.g. a test file that failed to load', () => {
        const { text } = formatSlackMessage({ report: reportOf([], ['b.test.ts: Cannot find package']), title: 'T' });
        expect(text).toBe('`T`: the tests failed to run.\n\n*Error*: b.test.ts: Cannot find package');
    });

    it('escapes what Slack would read as markup', () => {
        const report = reportOf([failing('a', 'expected <div> & more')]);
        expect(formatSlackMessage({ report, title: 'T' }).text).toContain('expected &lt;div&gt; &amp; more');
    });
});

describe('githubRunContext', () => {
    it('is empty outside of GitHub Actions', () => {
        expect(githubRunContext({})).toStrictEqual({ title: undefined, jobUrl: undefined });
    });
});
