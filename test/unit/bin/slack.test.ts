import { WebClient } from '@slack/web-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notifyToSlack } from '../../../bin/slack.js';

vi.mock('@slack/web-api', () => ({ WebClient: vi.fn() }));

const TOKEN_ENV_VAR = 'SLACK_TOKEN_RELEASES_BOT';
const postMessage = vi.fn();
const authTest = vi.fn();

const notify = async (overrides: Partial<Parameters<typeof notifyToSlack>[0]> = {}) =>
    notifyToSlack({
        repository: 'owner/repo',
        changedFiles: ['src/main.ts'],
        changelog: '- Fixed a bug',
        commits: [{ sha: '1', author: 'Test<test@example.com>', date: '', message: 'fix: bug' }],
        author: 'Test<test@example.com>',
        dryRun: true,
        releaseSlackChannel: '#releases',
        reportSlackChannel: '#notif',
        ...overrides,
    });

describe('notifyToSlack', () => {
    beforeEach(() => {
        vi.stubEnv(TOKEN_ENV_VAR, 'token');
        vi.mocked(WebClient).mockImplementation(function () {
            return { chat: { postMessage }, auth: { test: authTest } };
        } as never);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
    });

    it('should verify the token but post nothing in a dry run', async () => {
        await notify();
        expect(authTest).toHaveBeenCalledTimes(1);
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('should still require the token in a dry run', async () => {
        vi.stubEnv(TOKEN_ENV_VAR, '');
        await expect(notify()).rejects.toThrow(`${TOKEN_ENV_VAR} not defined`);
    });

    it('should fail a dry run when Slack rejects the token', async () => {
        authTest.mockRejectedValueOnce(new Error('An API error occurred: invalid_auth'));
        await expect(notify()).rejects.toThrow(`${TOKEN_ENV_VAR} was rejected by Slack`);
    });

    it('should not need a token when no channel is passed', async () => {
        vi.stubEnv(TOKEN_ENV_VAR, '');
        await notify({ dryRun: false, releaseSlackChannel: undefined, reportSlackChannel: undefined });
        expect(WebClient).not.toHaveBeenCalled();
    });

    it('should post to both channels outside of a dry run', async () => {
        await notify({ dryRun: false });
        expect(authTest).not.toHaveBeenCalled();
        expect(postMessage).toHaveBeenCalledTimes(2);
    });
});
