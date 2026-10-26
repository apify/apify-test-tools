import { WebClient } from '@slack/web-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatTestMessage, githubRunContext, notify } from '../../../bin/notify.js';
import type { ReleaseChanges } from '../../../bin/stdin-input.js';
import type { TestCaseReport, TestReport } from '../../../bin/test-report.js';

vi.mock('@slack/web-api', () => ({ WebClient: vi.fn() }));

const TESTS_TOKEN = 'SLACK_TOKEN_TESTS_BOT';
const RELEASES_TOKEN = 'SLACK_TOKEN_RELEASES_BOT';
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

type NotifyOptions = Parameters<typeof notify>[0];

const defaults = {
    slackChannel: '#notif',
    on: 'failure',
    changelogOnly: false,
    dryRun: false,
} satisfies Partial<NotifyOptions>;

const notifyTests = async (report: TestReport, overrides: Partial<NotifyOptions> = {}) =>
    notify({ ...defaults, title: 'Platform tests', input: { kind: 'tests', report }, ...overrides });

const release = (overrides: Partial<ReleaseChanges> = {}): ReleaseChanges => ({
    changedFiles: ['src/main.ts'],
    changelog: '- Fixed a bug',
    commits: [{ sha: '1', author: 'Test<test@example.com>', date: '', message: 'fix: bug' }],
    ...overrides,
});

const notifyRelease = async (changes: ReleaseChanges, overrides: Partial<NotifyOptions> = {}) =>
    notify({
        ...defaults,
        repoUrl: 'git@github.com:owner/repo',
        input: { kind: 'release', changes },
        ...overrides,
    });

beforeEach(() => {
    vi.stubEnv(TESTS_TOKEN, 'token');
    vi.stubEnv(RELEASES_TOKEN, 'token');
    postMessage.mockResolvedValue({ ts: '1.1' });
    vi.mocked(WebClient).mockImplementation(function () {
        return { chat: { postMessage }, auth: { test: authTest } };
    } as never);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});

describe('notify about tests', () => {
    const failed = reportOf([testCase('ok'), failing('bad')]);
    const passed = reportOf([testCase('ok')]);

    it('posts failures to the channel', async () => {
        await notifyTests(failed, { slackChannel: '#a' });
        expect(postMessage.mock.calls.map(([message]) => message.channel)).toStrictEqual(['#a']);
    });

    it('puts the failures after the first in the thread', async () => {
        await notifyTests(reportOf([failing('one'), failing('two'), failing('three')]));
        expect(postMessage).toHaveBeenCalledTimes(2);
        expect(postMessage.mock.calls[1][0]).toMatchObject({ channel: '#notif', thread_ts: '1.1' });
        expect(postMessage.mock.calls[1][0].blocks).toHaveLength(2);
    });

    it('splits a long thread into replies Slack accepts', async () => {
        await notifyTests(reportOf(Array.from({ length: 120 }, (_, i) => failing(`test ${i}`))));
        const replies = postMessage.mock.calls.slice(1).map(([message]) => message.blocks.length);
        expect(replies).toStrictEqual([50, 50, 19]);
    });

    it('posts nothing when the tests passed, but still checks the token', async () => {
        vi.stubEnv(TESTS_TOKEN, '');
        await expect(notifyTests(passed)).rejects.toThrow(`${TESTS_TOKEN} not defined`);

        vi.stubEnv(TESTS_TOKEN, 'token');
        await notifyTests(passed);
        expect(WebClient).toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('posts passing runs too with on: always', async () => {
        await notifyTests(passed, { on: 'always' });
        expect(postMessage).toHaveBeenCalledWith({ channel: '#notif', text: '`Platform tests`: all 1 tests passed.' });
    });

    it('needs no token without a channel', async () => {
        vi.stubEnv(TESTS_TOKEN, '');
        await notifyTests(failed, { slackChannel: '' });
        expect(WebClient).not.toHaveBeenCalled();
    });

    it('verifies the token but posts nothing in a dry run', async () => {
        await notifyTests(failed, { dryRun: true });
        expect(authTest).toHaveBeenCalledTimes(1);
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('defaults the title and the link to the GitHub Actions run', async () => {
        vi.stubEnv('GITHUB_WORKFLOW', 'Platform tests - Core');
        vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
        vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
        vi.stubEnv('GITHUB_RUN_ID', '42');
        await notifyTests(failed, { title: undefined });
        expect(postMessage.mock.calls[0][0].text).toContain(
            '`Platform tests - Core`: 1 of 2 tests failed. Check <https://github.com/owner/repo/actions/runs/42|the job>.',
        );
    });

    it('rejects the flags only a release uses', async () => {
        await expect(notifyTests(failed, { changelogOnly: true, repoUrl: 'x' })).rejects.toThrow(
            "--changelog-only, --repo-url can't be used with a test report",
        );
        expect(WebClient).not.toHaveBeenCalled();
    });
});

describe('notify about a release', () => {
    it('verifies the releases token but posts nothing in a dry run', async () => {
        await notifyRelease(release(), { dryRun: true });
        expect(authTest).toHaveBeenCalledTimes(1);
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('still requires the token in a dry run', async () => {
        vi.stubEnv(RELEASES_TOKEN, '');
        await expect(notifyRelease(release(), { dryRun: true })).rejects.toThrow(`${RELEASES_TOKEN} not defined`);
    });

    it('fails a dry run when Slack rejects the token', async () => {
        authTest.mockRejectedValueOnce(new Error('An API error occurred: invalid_auth'));
        await expect(notifyRelease(release(), { dryRun: true })).rejects.toThrow(
            `${RELEASES_TOKEN} was rejected by Slack`,
        );
    });

    it('needs no token when no channel is passed', async () => {
        vi.stubEnv(RELEASES_TOKEN, '');
        await notifyRelease(release(), { slackChannel: undefined });
        expect(WebClient).not.toHaveBeenCalled();
    });

    it('posts the full report: the changelog additions, the commits and the changed files', async () => {
        await notifyRelease(release());
        expect(postMessage).toHaveBeenCalledTimes(1);
        const { channel, text } = postMessage.mock.calls[0][0];
        expect(channel).toBe('#notif');
        expect(text).toContain('*Additions to the changelog*:\n\n- Fixed a bug');
        expect(text).toContain('*Commit list*:\n1. Commit message: fix: bug');
        expect(text).toContain('*Files changed*: `src/main.ts`');
    });

    it('posts just the changelog additions with changelogOnly', async () => {
        await notifyRelease(release(), { changelogOnly: true, slackChannel: '#releases' });
        const { channel, text } = postMessage.mock.calls[0][0];
        expect(channel).toBe('#releases');
        expect(text).toContain('*Additions to the changelog*:\n\n- Fixed a bug');
        expect(text).not.toContain('Commit list');
    });

    it('posts nothing with changelogOnly when the changelog did not change, but still checks the token', async () => {
        await notifyRelease(release({ changelog: null }), { changelogOnly: true, dryRun: true });
        expect(authTest).toHaveBeenCalledTimes(1);
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('announces nothing, and needs no token, when there are no new commits', async () => {
        vi.stubEnv(RELEASES_TOKEN, '');
        await notifyRelease(release({ commits: [] }));
        expect(WebClient).not.toHaveBeenCalled();
    });

    it('announces the release by the author of the newest commit, named after the repository', async () => {
        const commit = (author: string, message: string) => ({ sha: '1', author, date: '', message });
        await notifyRelease(
            release({
                commits: [commit('Old<old@example.com>', 'fix: older'), commit('New<new@example.com>', 'feat: newer')],
            }),
            { repoUrl: 'git@github.com:owner/my-repo' },
        );
        expect(postMessage).toHaveBeenCalledWith({
            channel: '#notif',
            text: expect.stringContaining('*my-repo* – New release (by New)'),
        });
    });

    it('rejects the flags only tests use', async () => {
        await expect(notifyRelease(release(), { on: 'always', title: 'T', jobUrl: 'https://job' })).rejects.toThrow(
            "--on, --title, --job-url can't be used with a release",
        );
    });
});

describe('formatTestMessage', () => {
    it('leads with the outcome and the first failure, linked to its run', () => {
        const { text, details } = formatTestMessage({
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
        const { text } = formatTestMessage({ report: reportOf([], ['b.test.ts: Cannot find package']), title: 'T' });
        expect(text).toBe('`T`: the tests failed to run.\n\n*Error*: b.test.ts: Cannot find package');
    });

    it('escapes what Slack would read as markup', () => {
        const report = reportOf([failing('a', 'expected <div> & more')]);
        expect(formatTestMessage({ report, title: 'T' }).text).toContain('expected &lt;div&gt; &amp; more');
    });
});

describe('githubRunContext', () => {
    it('is empty outside of GitHub Actions', () => {
        expect(githubRunContext({})).toStrictEqual({ title: undefined, jobUrl: undefined });
    });
});
