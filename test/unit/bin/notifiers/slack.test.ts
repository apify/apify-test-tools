import { afterEach, describe, expect, it, vi } from 'vitest';

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

const { slackNotifier } = await import('../../../../bin/notifiers/slack.js');

afterEach(() => vi.restoreAllMocks());

describe('slackNotifier', () => {
    it('does nothing when the payload is null', async () => {
        await slackNotifier(null, { target: '#general', dryRun: false, config: { tokenEnvVar: 'SLACK_TOKEN' } });

        expect(postMessageMock).not.toHaveBeenCalled();
    });

    it('throws when the config is missing a tokenEnvVar', async () => {
        await expect(
            slackNotifier({ summary: 'hi' }, { target: '#general', dryRun: false, config: {} }),
        ).rejects.toThrow('notifiers.slack.tokenEnvVar');
    });

    it('does not send anything on a dry run', async () => {
        await slackNotifier(
            { summary: 'hi' },
            { target: '#general', dryRun: true, config: { tokenEnvVar: 'SLACK_TOKEN' } },
        );

        expect(postMessageMock).not.toHaveBeenCalled();
    });

    it('sends the summary and, when present, posts details as a threaded reply', async () => {
        getEnvVarMock.mockReturnValue('xoxb-token');
        postMessageMock.mockResolvedValue({ ts: '123.456' });

        await slackNotifier(
            { summary: 'hi', details: ['line 1', 'line 2'] },
            { target: '#general', dryRun: false, config: { tokenEnvVar: 'SLACK_TOKEN' } },
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
        await slackNotifier(
            { summary: 'hi', details },
            { target: '#general', dryRun: false, config: { tokenEnvVar: 'SLACK_TOKEN' } },
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

        await slackNotifier(
            { summary: 'hi' },
            { target: '#general', dryRun: false, config: { tokenEnvVar: 'SLACK_TOKEN' } },
        );

        expect(postMessageMock).toHaveBeenCalledTimes(1);
    });
});
