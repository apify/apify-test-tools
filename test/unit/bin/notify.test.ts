import { afterEach, describe, expect, it, vi } from 'vitest';

const { fsMock, notifiersMock, readNotifiersConfigMock } = vi.hoisted(() => ({
    fsMock: { readFile: vi.fn() },
    notifiersMock: { slack: vi.fn() },
    readNotifiersConfigMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ default: fsMock }));
vi.mock('../../../bin/notifiers/index.js', () => ({ notifiers: notifiersMock }));
vi.mock('../../../bin/utils.js', () => ({ readNotifiersConfig: readNotifiersConfigMock }));

const { notify } = await import('../../../bin/notify.js');

afterEach(() => vi.restoreAllMocks());

describe('notify', () => {
    it('reads the notify file and invokes the selected notifier with its config', async () => {
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify({ summary: 'hi' })));
        readNotifiersConfigMock.mockResolvedValue({ slack: { tokenEnvVar: 'SLACK_TOKEN' } });

        await notify({ notifyFile: 'out.json', notifier: 'slack', target: '#general', dryRun: false });

        expect(fsMock.readFile).toHaveBeenCalledWith('out.json');
        expect(notifiersMock.slack).toHaveBeenCalledWith(
            { summary: 'hi' },
            { target: '#general', dryRun: false, config: { tokenEnvVar: 'SLACK_TOKEN' } },
        );
    });

    it('passes a null payload through untouched', async () => {
        fsMock.readFile.mockResolvedValue(Buffer.from('null'));
        readNotifiersConfigMock.mockResolvedValue(undefined);

        await notify({ notifyFile: 'out.json', notifier: 'slack', target: '#general', dryRun: false });

        expect(notifiersMock.slack).toHaveBeenCalledWith(null, {
            target: '#general',
            dryRun: false,
            config: undefined,
        });
    });

    it('throws on an unknown notifier', async () => {
        fsMock.readFile.mockResolvedValue(Buffer.from('null'));

        await expect(
            notify({ notifyFile: 'out.json', notifier: 'carrier-pigeon', target: '#general', dryRun: false }),
        ).rejects.toThrow('Unknown notifier "carrier-pigeon"');
    });
});
