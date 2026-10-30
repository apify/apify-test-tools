import { WebClient } from '@slack/web-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatReleaseMessage, formatTestMessage, notify } from '../../../bin/notify.js';
import type { ReleaseChanges } from '../../../bin/stdin-input.js';
import type { TestCaseReport, TestReport } from '../../../bin/test-report.js';

vi.mock('@slack/web-api', () => ({ WebClient: vi.fn() }));

// One token for both test reports and releases
const TOKEN = 'SLACK_BOT_TOKEN';
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
    dryRun: false,
} satisfies Partial<NotifyOptions>;

const notifyTests = async (report: TestReport, overrides: Partial<NotifyOptions> = {}) =>
    notify({ ...defaults, title: 'Platform tests', input: { kind: 'tests', report }, ...overrides });

const release = (overrides: Partial<ReleaseChanges> = {}): ReleaseChanges => ({
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
    vi.stubEnv(TOKEN, 'token');
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
        vi.stubEnv(TOKEN, '');
        await expect(notifyTests(passed)).rejects.toThrow(`${TOKEN} not defined`);

        vi.stubEnv(TOKEN, 'token');
        await notifyTests(passed);
        expect(WebClient).toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('posts passing runs too with on: always', async () => {
        await notifyTests(passed, { on: 'always' });
        expect(postMessage).toHaveBeenCalledWith({ channel: '#notif', text: '`Platform tests`: all 1 tests passed.' });
    });

    it('needs no token without a channel', async () => {
        vi.stubEnv(TOKEN, '');
        await notifyTests(failed, { slackChannel: '' });
        expect(WebClient).not.toHaveBeenCalled();
    });

    it('verifies the token but posts nothing in a dry run', async () => {
        await notifyTests(failed, { dryRun: true });
        expect(authTest).toHaveBeenCalledTimes(1);
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('names the run and links the job as the caller passes them', async () => {
        await notifyTests(failed, { title: 'Platform tests - Core', jobUrl: 'https://ci.example.com/jobs/42' });
        expect(postMessage.mock.calls[0][0].text).toContain(
            '`Platform tests - Core`: 1 of 2 tests failed. Check <https://ci.example.com/jobs/42|the job>.',
        );
    });

    it('reads nothing from the CI environment: without a title or a link, there are none', async () => {
        vi.stubEnv('GITHUB_WORKFLOW', 'Platform tests - Core');
        vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
        vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
        vi.stubEnv('GITHUB_RUN_ID', '42');
        await notifyTests(failed, { title: undefined });
        expect(postMessage.mock.calls[0][0].text).toMatch(/^`Tests`: 1 of 2 tests failed\.\n/);
    });

    it('rejects the flags only a release uses', async () => {
        await expect(notifyTests(failed, { repoUrl: 'x' })).rejects.toThrow(
            "--repo-url can't be used with a test report",
        );
        expect(WebClient).not.toHaveBeenCalled();
    });
});

describe('notify about a release', () => {
    it('verifies the token but posts nothing in a dry run', async () => {
        await notifyRelease(release(), { dryRun: true });
        expect(authTest).toHaveBeenCalledTimes(1);
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('still requires the token in a dry run', async () => {
        vi.stubEnv(TOKEN, '');
        await expect(notifyRelease(release(), { dryRun: true })).rejects.toThrow(`${TOKEN} not defined`);
    });

    it('fails a dry run when Slack rejects the token', async () => {
        authTest.mockRejectedValueOnce(new Error('An API error occurred: invalid_auth'));
        await expect(notifyRelease(release(), { dryRun: true })).rejects.toThrow(`${TOKEN} was rejected by Slack`);
    });

    it('needs no token when no channel is passed', async () => {
        vi.stubEnv(TOKEN, '');
        await notifyRelease(release(), { slackChannel: undefined });
        expect(WebClient).not.toHaveBeenCalled();
    });

    it('posts the changelog additions and the commits, linked to their commit pages', async () => {
        await notifyRelease(release());
        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage.mock.calls[0][0]).toStrictEqual({
            channel: '#notif',
            text:
                '*repo* – New release (by Test):\n\n- Fixed a bug\n\n*Commits*:\n' +
                '1. <https://github.com/owner/repo/commit/1|fix: bug> – Test',
        });
    });

    it('announces nothing, and needs no token, when there are no new commits', async () => {
        vi.stubEnv(TOKEN, '');
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

describe('formatReleaseMessage', () => {
    const commit = (sha: string, message: string, author = 'Dev<dev@example.com>') => ({
        sha,
        author,
        date: '',
        message,
    });

    it('lists every commit of a rebase merge, oldest first, and leaves out an empty changelog', () => {
        const text = formatReleaseMessage(
            {
                commits: [commit('a1', 'feat: one'), commit('b2', 'fix: two', 'Last<last@example.com>')],
                changelog: null,
            },
            'https://github.com/owner/repo.git',
        );
        expect(text).toBe(
            '*repo* – New release (by Last):\n\n*Commits*:\n' +
                '1. <https://github.com/owner/repo/commit/a1|feat: one> – Dev\n' +
                '2. <https://github.com/owner/repo/commit/b2|fix: two> – Last',
        );
    });

    it('caps a commit title at 200 characters', () => {
        const text = formatReleaseMessage(
            { commits: [commit('a1', 'x'.repeat(300))], changelog: null },
            'git@github.com:o/r',
        );
        expect(text).toContain(`|${'x'.repeat(199)}…>`);
    });

    it('escapes what Slack would read as markup, so a title cannot break its link', () => {
        const text = formatReleaseMessage(
            { commits: [commit('a1', 'fix: <div> & co')], changelog: null },
            'git@github.com:o/r',
        );
        expect(text).toContain('|fix: &lt;div&gt; &amp; co>');
    });

    it('links nothing on a host other than GitHub', () => {
        const text = formatReleaseMessage(
            { commits: [commit('a1', 'fix: bug')], changelog: null },
            'git@gitlab.com:o/r.git',
        );
        expect(text).toContain('1. fix: bug – Dev');
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
