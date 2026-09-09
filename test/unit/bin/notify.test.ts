import { afterEach, describe, expect, it, vi } from 'vitest';

const { fsMock, notifiersMock, readNotifiersConfigMock } = vi.hoisted(() => ({
    fsMock: { readFile: vi.fn() },
    notifiersMock: { slack: { assertConfig: vi.fn((config: unknown) => config), format: vi.fn(), send: vi.fn() } },
    readNotifiersConfigMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ default: fsMock }));
vi.mock('../../../bin/notifiers/index.js', () => ({ notifiers: notifiersMock }));
vi.mock('../../../bin/utils.js', () => ({ readNotifiersConfig: readNotifiersConfigMock }));

const { notify } = await import('../../../bin/notify.js');

const testReportDocument = { type: 'test-report', failed: [], passedCount: 1, totalCount: 1 };

const createFakeStdin = async (input: string) => {
    const { Readable } = await import('node:stream');
    const stdin = Readable.from([input]) as unknown as typeof process.stdin;
    stdin.isTTY = false;
    return stdin;
};

afterEach(() => vi.restoreAllMocks());

describe('notify', () => {
    it('reads the document from the --input file, formats it, and sends the resulting message', async () => {
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify(testReportDocument)));
        notifiersMock.slack.format.mockReturnValue({ summary: 'hi' });
        readNotifiersConfigMock.mockResolvedValue({
            tokenEnvVar: 'SLACK_TOKEN',
            targets: { 'test-report': '#general' },
        });

        await notify({ input: 'out.json', notifier: 'slack', dryRun: false });

        expect(fsMock.readFile).toHaveBeenCalledWith('out.json');
        expect(readNotifiersConfigMock).toHaveBeenCalledWith('slack');
        expect(notifiersMock.slack.format).toHaveBeenCalledWith(testReportDocument, undefined);
        expect(notifiersMock.slack.send).toHaveBeenCalledWith(
            { summary: 'hi' },
            {
                target: '#general',
                dryRun: false,
                config: { tokenEnvVar: 'SLACK_TOKEN', targets: { 'test-report': '#general' } },
            },
        );
    });

    it('reads the document from stdin when --input is not given', async () => {
        const originalStdin = process.stdin;
        Object.defineProperty(process, 'stdin', {
            value: await createFakeStdin(JSON.stringify(testReportDocument)),
            configurable: true,
        });
        notifiersMock.slack.format.mockReturnValue({ summary: 'hi' });
        readNotifiersConfigMock.mockResolvedValue({
            tokenEnvVar: 'SLACK_TOKEN',
            targets: { 'test-report': '#general' },
        });

        try {
            await notify({ notifier: 'slack', dryRun: false });
        } finally {
            Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
        }

        expect(fsMock.readFile).not.toHaveBeenCalled();
        expect(notifiersMock.slack.send).toHaveBeenCalledWith(
            { summary: 'hi' },
            expect.objectContaining({ target: '#general' }),
        );
    });

    it('throws when there is no --input and stdin is a TTY', async () => {
        const originalStdin = process.stdin;
        Object.defineProperty(process, 'stdin', { value: { isTTY: true }, configurable: true });

        try {
            await expect(notify({ notifier: 'slack', dryRun: false })).rejects.toThrow(
                /no --input file given, and no data piped/,
            );
        } finally {
            Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
        }
    });

    it('skips the notifier and never touches config when format returns null', async () => {
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify(testReportDocument)));
        notifiersMock.slack.format.mockReturnValue(null);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await notify({ input: 'out.json', notifier: 'slack', dryRun: false });

        expect(readNotifiersConfigMock).not.toHaveBeenCalled();
        expect(notifiersMock.slack.send).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith('Nothing to notify, skipping.');
    });

    it('throws on an unknown notifier', async () => {
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify(testReportDocument)));

        await expect(notify({ input: 'out.json', notifier: 'carrier-pigeon', dryRun: false })).rejects.toThrow(
            'Unknown notifier "carrier-pigeon"',
        );
    });

    it('resolves the target key with the view suffix for a release-report document', async () => {
        const releaseDocument = {
            type: 'release-report',
            repository: 'apify/apify-test-tools',
            author: 'luigi',
            changelog: 'stuff',
            commits: [],
            changedFiles: [],
        };
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify(releaseDocument)));
        notifiersMock.slack.format.mockReturnValue({ summary: 'release!' });
        readNotifiersConfigMock.mockResolvedValue({
            tokenEnvVar: 'SLACK_TOKEN',
            targets: { 'release-report-dev': '#dev-channel' },
        });

        await notify({ input: 'out.json', notifier: 'slack', view: 'dev', dryRun: false });

        expect(notifiersMock.slack.format).toHaveBeenCalledWith(releaseDocument, 'dev');
        expect(notifiersMock.slack.send).toHaveBeenCalledWith(
            { summary: 'release!' },
            expect.objectContaining({ target: '#dev-channel' }),
        );
    });

    it('throws when a release-report document is sent without a --view', async () => {
        const releaseDocument = {
            type: 'release-report',
            repository: 'apify/apify-test-tools',
            author: 'luigi',
            changelog: 'stuff',
            commits: [],
            changedFiles: [],
        };
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify(releaseDocument)));
        notifiersMock.slack.format.mockReturnValue({ summary: 'release!' });

        await expect(notify({ input: 'out.json', notifier: 'slack', dryRun: false })).rejects.toThrow(
            /--view is required for release-report documents/,
        );

        expect(readNotifiersConfigMock).not.toHaveBeenCalled();
        expect(notifiersMock.slack.send).not.toHaveBeenCalled();
    });

    it('throws on a document with no "type" field', async () => {
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify({ failed: [] })));

        await expect(notify({ input: 'out.json', notifier: 'slack', dryRun: false })).rejects.toThrow(
            /Malformed notify document/,
        );
        expect(notifiersMock.slack.format).not.toHaveBeenCalled();
    });

    it('throws on a document with an unknown "type" value', async () => {
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify({ type: 'carrier-pigeon-report' })));

        await expect(notify({ input: 'out.json', notifier: 'slack', dryRun: false })).rejects.toThrow(
            /Malformed notify document.*carrier-pigeon-report/,
        );
    });

    it('throws when the parsed input is not an object', async () => {
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify('just a string')));

        await expect(notify({ input: 'out.json', notifier: 'slack', dryRun: false })).rejects.toThrow(
            /Malformed notify document/,
        );
    });

    it('rejects a missing --view before ever formatting the document', async () => {
        const releaseDocument = {
            type: 'release-report',
            repository: 'apify/apify-test-tools',
            author: 'luigi',
            changelog: 'stuff',
            commits: [],
            changedFiles: [],
        };
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify(releaseDocument)));

        await expect(notify({ input: 'out.json', notifier: 'slack', dryRun: false })).rejects.toThrow(
            /--view is required for release-report documents/,
        );

        expect(notifiersMock.slack.format).not.toHaveBeenCalled();
    });

    it.each([
        ['the target key is missing', { tokenEnvVar: 'SLACK_TOKEN', targets: {} }],
        ['"targets" is missing entirely', { tokenEnvVar: 'SLACK_TOKEN' }],
        ['the target key holds a non-string value', { tokenEnvVar: 'SLACK_TOKEN', targets: { 'test-report': 123 } }],
    ])('throws a hard error naming the notifier and expected target key when %s', async (_case, config) => {
        fsMock.readFile.mockResolvedValue(Buffer.from(JSON.stringify(testReportDocument)));
        notifiersMock.slack.format.mockReturnValue({ summary: 'hi' });
        readNotifiersConfigMock.mockResolvedValue(config);

        await expect(notify({ input: 'out.json', notifier: 'slack', dryRun: false })).rejects.toThrow(
            /notifiers\.slack\.targets\.test-report/,
        );
        expect(notifiersMock.slack.send).not.toHaveBeenCalled();
    });
});
