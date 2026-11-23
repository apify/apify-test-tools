import net from 'node:net';

/** Set by the `test` command of the CLI to the address of its memory queue */
const MEMORY_QUEUE_ENV_VAR = 'APIFY_TEST_TOOLS_MEMORY_QUEUE';

/**
 * Waits until the account the token in `tokenEnvVar` belongs to has room for the run in the memory budget of the
 * `test` command, so runs don't fail on the account's memory limit. Returns the function that frees the memory again,
 * to call once the run finished. Without the queue, e.g. under a plain `vitest`, it returns at once.
 */
export const reserveMemory = async (tokenEnvVar: string, memoryMbytes: number): Promise<() => void> => {
    const address = process.env[MEMORY_QUEUE_ENV_VAR];
    if (!address) return () => undefined;

    const [host, port] = address.split(':');
    const socket = net.connect(Number(port), host);
    socket.setEncoding('utf8');
    socket.write(`${JSON.stringify({ tokenEnvVar, memoryMbytes })}\n`);
    const answer = await new Promise<{ start?: true; error?: string }>((resolve, reject) => {
        let buffered = '';
        socket.on('data', (chunk: string) => {
            buffered += chunk;
            const lineEnd = buffered.indexOf('\n');
            if (lineEnd !== -1) resolve(JSON.parse(buffered.slice(0, lineEnd)));
        });
        socket.on('error', (error) => reject(new Error(`The memory queue at ${address} failed: ${error.message}`)));
        socket.on('close', () => reject(new Error(`The memory queue at ${address} closed without an answer`)));
    });
    if (answer.error) {
        socket.destroy();
        throw new Error(`The run was not started: ${answer.error}`);
    }
    return () => socket.destroy();
};
