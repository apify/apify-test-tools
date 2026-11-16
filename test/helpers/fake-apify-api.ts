import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';

interface FakeActor {
    id: string;
    username: string;
    name: string;
}

// A stand-in for the Apify API's `GET /v2/actors/:actorId` (also `/v2/acts/`). It serves the Actors given as its
// argument by raw ID or by full name (`owner~name`, as apify-client writes it), answers 404 for anything else, which
// apify-client reads as "not found", and prints the port it listens on. It runs in a process of its own, because the
// tests start the CLI with spawnSync, which blocks the test's own event loop.
const SERVER_SOURCE = `
const http = require('node:http');
const actors = JSON.parse(process.argv[1]);
const server = http.createServer((req, res) => {
    const match = req.method === 'GET' && req.url.match(/^\\/v2\\/act(?:or)?s\\/([^/?]+)/);
    const actorId = match ? decodeURIComponent(match[1]) : '';
    const actor = actors.find(({ id, username, name }) => actorId === id || actorId === username + '~' + name);
    res.setHeader('content-type', 'application/json');
    if (actor) return res.end(JSON.stringify({ data: actor }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { type: 'record-not-found', message: 'Actor was not found' } }));
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

/**
 * Starts a fake Apify API that serves these Actors. Pass `url` to the CLI as `APIFY_API_BASE_URL`, so `test` looks the
 * Actors up there instead of on the network.
 */
export const startFakeApifyApi = async (actors: FakeActor[]) => {
    const child = spawn(process.execPath, ['-e', SERVER_SOURCE, JSON.stringify(actors)], {
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    const [port] = await once(child.stdout!, 'data');
    return {
        url: `http://127.0.0.1:${String(port).trim()}`,
        close: async () => {
            child.kill();
            await once(child, 'exit');
        },
    };
};
