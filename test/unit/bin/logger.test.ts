import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger, logLevels } from '../../../bin/logger.js';
import { writeJson } from '../../../bin/output.js';

describe('logger and CLI output', () => {
    beforeEach(() => {
        logger.setLevel('info');
        vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    });

    afterEach(() => {
        logger.setLevel('info');
        vi.restoreAllMocks();
    });

    it.each(logLevels)('filters diagnostics at the %s level without writing to stdout', (level) => {
        logger.setLevel(level);
        logger.debug('debug');
        logger.info('info');
        logger.warn('warn');
        logger.error('error');

        expect(vi.mocked(process.stderr.write).mock.calls.map(([message]) => message)).toEqual(
            logLevels.slice(logLevels.indexOf(level), -1).map((message) => `${message}\n`),
        );
        expect(process.stdout.write).not.toHaveBeenCalled();
    });

    it('defaults to info and preserves formatting, multiple arguments and blank lines', () => {
        logger.debug('hidden');
        logger.info('actor %s: %d', 'owner/name', 3);
        logger.warn('warning', { actor: 'owner/name' });
        logger.error(new Error('failed'));
        logger.info();

        expect(process.stderr.write).toHaveBeenCalledTimes(4);
        expect(process.stderr.write).toHaveBeenNthCalledWith(1, 'actor owner/name: 3\n');
        expect(process.stderr.write).toHaveBeenNthCalledWith(2, "warning { actor: 'owner/name' }\n");
        expect(process.stderr.write).toHaveBeenNthCalledWith(3, expect.stringContaining('Error: failed'));
        expect(process.stderr.write).toHaveBeenNthCalledWith(4, '\n');
    });

    it('writes newline-terminated JSON to stdout even when logging is silent', () => {
        logger.setLevel('silent');
        logger.error('hidden');
        writeJson([{ actor: 'owner/name' }]);

        expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith('[{"actor":"owner/name"}]\n');
        expect(process.stderr.write).not.toHaveBeenCalled();
    });
});
