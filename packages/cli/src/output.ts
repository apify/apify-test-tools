import process from 'node:process';

/** CLI results always go to stdout, independently of the diagnostic log level. */
export const writeJson = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
};
