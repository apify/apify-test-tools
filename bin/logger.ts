import process from 'node:process';
import { formatWithOptions } from 'node:util';

export const logLevels = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof logLevels)[number];

let currentLevel: LogLevel = 'info';

const write = (level: Exclude<LogLevel, 'silent'>, args: unknown[]) => {
    if (logLevels.indexOf(level) < logLevels.indexOf(currentLevel)) return;
    process.stderr.write(`${formatWithOptions({ colors: false }, ...args)}\n`);
};

/** All diagnostics go to stderr, leaving stdout available for machine-readable results. */
export const logger = {
    setLevel(level: LogLevel): void {
        currentLevel = level;
    },
    debug: (...args: unknown[]): void => write('debug', args),
    info: (...args: unknown[]): void => write('info', args),
    warn: (...args: unknown[]): void => write('warn', args),
    error: (...args: unknown[]): void => write('error', args),
};
