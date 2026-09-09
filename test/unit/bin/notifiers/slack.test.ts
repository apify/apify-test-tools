import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SlackNotifierConfig } from '../../../../bin/notifiers/slack.js';
import type { NotifyDocument } from '../../../../bin/notifiers/types.js';

const { postMessageMock, getEnvVarMock } = vi.hoisted(() => ({
    postMessageMock: vi.fn(),
    getEnvVarMock: vi.fn(),
}));

vi.mock('@slack/web-api', () => ({
    WebClient: class WebClientMock {
        chat = { postMessage: postMessageMock };
    },
}));
vi.mock('../../../../bin/utils.js', () => ({ getEnvVar: getEnvVarMock }));

const { SlackNotifier } = await import('../../../../bin/notifiers/slack.js');

afterEach(() => vi.restoreAllMocks());

const validConfig: SlackNotifierConfig = {
    tokenEnvVar: 'SLACK_TOKEN',
    targets: { 'test-report': '#general', 'release-report-dev': '#dev', 'release-report-public': '#public' },
};

describe('slackNotifier', () => {
    const slackNotifier = new SlackNotifier();

    it('throws when the config is missing a tokenEnvVar', async () => {
        await expect(
            slackNotifier.send(
                { summary: 'hi' },
                {
                    target: '#general',
                    dryRun: false,
                    config: { targets: { 'test-report': '#general' } } as unknown as SlackNotifierConfig,
                },
            ),
        ).rejects.toThrow('notifiers.slack.tokenEnvVar');
    });

    it('accepts a config with only some target keys configured', async () => {
        await slackNotifier.send(
            { summary: 'hi' },
            {
                target: '#general',
                dryRun: true,
                config: {
                    tokenEnvVar: 'SLACK_TOKEN',
                    targets: { 'test-report': '#general' },
                },
            },
        );
    });

    it('does not send anything on a dry run', async () => {
        await slackNotifier.send({ summary: 'hi' }, { target: '#general', dryRun: true, config: validConfig });

        expect(postMessageMock).not.toHaveBeenCalled();
    });

    it('sends the summary and, when present, posts details as a threaded reply', async () => {
        getEnvVarMock.mockReturnValue('xoxb-token');
        postMessageMock.mockResolvedValue({ ts: '123.456' });

        await slackNotifier.send(
            { summary: 'hi', details: ['line 1', 'line 2'] },
            { target: '#general', dryRun: false, config: validConfig },
        );

        expect(getEnvVarMock).toHaveBeenCalledWith('SLACK_TOKEN');
        expect(postMessageMock).toHaveBeenNthCalledWith(1, { text: 'hi', channel: '#general' });
        expect(postMessageMock).toHaveBeenNthCalledWith(2, {
            channel: '#general',
            thread_ts: '123.456',
            blocks: [
                { text: { type: 'mrkdwn', text: 'line 1' }, type: 'section' },
                { text: { type: 'mrkdwn', text: 'line 2' }, type: 'section' },
            ],
        });
    });

    it('truncates the logged details to 5 with a "... and (N) more." line, without truncating what is sent', async () => {
        getEnvVarMock.mockReturnValue('xoxb-token');
        postMessageMock.mockResolvedValue({ ts: '123.456' });
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const details = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
        await slackNotifier.send(
            { summary: 'hi', details },
            { target: '#general', dryRun: false, config: validConfig },
        );

        const loggedThreadSection = consoleErrorSpy.mock.calls
            .map(([message]) => message)
            .find((message) => typeof message === 'string' && message.includes('In the thread:'));
        expect(loggedThreadSection).toContain('line 1\nline 2\nline 3\nline 4\nline 5\n... and (3) more.');
        expect(loggedThreadSection).not.toContain('line 6');

        expect(postMessageMock).toHaveBeenNthCalledWith(2, {
            channel: '#general',
            thread_ts: '123.456',
            blocks: details.map((detail) => ({ text: { type: 'mrkdwn', text: detail }, type: 'section' })),
        });
    });

    it('does not post a threaded reply when there are no details', async () => {
        getEnvVarMock.mockReturnValue('xoxb-token');
        postMessageMock.mockResolvedValue({ ts: '123.456' });

        await slackNotifier.send({ summary: 'hi' }, { target: '#general', dryRun: false, config: validConfig });

        expect(postMessageMock).toHaveBeenCalledTimes(1);
    });
});

describe('slackNotifier.format', () => {
    const slackNotifier = new SlackNotifier();

    it('returns null for a test-report document with no failures', () => {
        const document: NotifyDocument = {
            type: 'test-report',
            failed: [],
            failedCount: 0,
            passedCount: 3,
            totalCount: 3,
        };

        expect(slackNotifier.format(document)).toBeNull();
    });

    it('builds a summary and details for a test-report document with failures', () => {
        const document: NotifyDocument = {
            type: 'test-report',
            workflowName: 'nightly',
            jobUrl: 'https://example.com/job',
            passedCount: 2,
            failedCount: 2,
            totalCount: 4,
            failed: [
                {
                    id: 'a1 > suite > fails',
                    message: 'Error: boom',
                    runLink: 'https://example.com/run-1',
                    actorId: 'a1',
                },
                {
                    id: 'a2 > suite > also fails',
                    message: 'Error: kaboom',
                    runLink: 'https://example.com/run-2',
                    actorId: 'a2',
                },
            ],
        };

        const message = slackNotifier.format(document);

        expect(message).not.toBeNull();
        expect(message?.summary).toContain('nightly');
        expect(message?.summary).toContain('2 failed assertions');
        expect(message?.summary).toContain('Failing test suites: 2/4');
        expect(message?.summary).toContain('https://example.com/job');
        expect(message?.details).toEqual(['• Error: kaboom --- <https://example.com/run-2|a2>']);
    });

    it('uses failedCount, not the flattened failure count, for the "Failing test suites" ratio', () => {
        // Both failed entries below come from the same assertion (it produced two failure messages),
        // so failedCount (1) should differ from failed.length (2).
        const document: NotifyDocument = {
            type: 'test-report',
            passedCount: 3,
            failedCount: 1,
            totalCount: 4,
            failed: [
                {
                    id: 'a1 > suite > fails',
                    message: 'Error: first',
                    runLink: 'https://example.com/run-1',
                    actorId: 'a1',
                },
                {
                    id: 'a1 > suite > fails',
                    message: 'Error: second',
                    runLink: 'https://example.com/run-1',
                    actorId: 'a1',
                },
            ],
        };

        const message = slackNotifier.format(document);

        expect(message).not.toBeNull();
        expect(message?.summary).toContain('2 failed assertions');
        expect(message?.summary).toContain('Failing test suites: 1/4');
    });

    it('builds dev summary text for a release-report document with the dev view', () => {
        const document: NotifyDocument = {
            type: 'release-report',
            repository: 'apify/apify-test-tools',
            author: 'luigi',
            changelog: 'Added new feature.',
            commits: [{ sha: 'abc123', author: 'luigi', date: '2026-09-09', message: 'feat: add thing' }],
            changedFiles: ['bin/notify.ts'],
        };

        const message = slackNotifier.format(document, 'dev');

        expect(message).not.toBeNull();
        expect(message?.summary).toContain('apify/apify-test-tools');
        expect(message?.summary).toContain('feat: add thing');
        expect(message?.summary).toContain('bin/notify.ts');
    });

    it('builds public summary text for a release-report document with the public view', () => {
        const document: NotifyDocument = {
            type: 'release-report',
            repository: 'apify/apify-test-tools',
            author: 'luigi',
            changelog: 'Added new feature.',
            commits: [{ sha: 'abc123', author: 'luigi', date: '2026-09-09', message: 'feat: add thing' }],
            changedFiles: ['bin/notify.ts'],
        };

        const devMessage = slackNotifier.format(document, 'dev');
        const publicMessage = slackNotifier.format(document, 'public');

        expect(publicMessage).not.toBeNull();
        expect(publicMessage?.summary).toContain('Added new feature.');
        expect(publicMessage?.summary).not.toContain('bin/notify.ts');
        expect(publicMessage?.summary).not.toEqual(devMessage?.summary);
    });

    it('returns null for a release-report document with no changelog in the public view', () => {
        const document: NotifyDocument = {
            type: 'release-report',
            repository: 'apify/apify-test-tools',
            author: 'luigi',
            changelog: null,
            commits: [{ sha: 'abc123', author: 'luigi', date: '2026-09-09', message: 'feat: add thing' }],
            changedFiles: ['bin/notify.ts'],
        };

        expect(slackNotifier.format(document, 'public')).toBeNull();
    });
});
