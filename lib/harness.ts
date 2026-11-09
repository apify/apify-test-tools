import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ActorCallOptions, ActorClient, ActorVersion } from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';
import { parseSync } from 'oxc-parser';
import { transformSync } from 'oxc-transform';

import type { ACTOR_PERMISSION_LEVEL } from '@apify/consts';

import { collectNonIgnoredFiles } from '../bin/source-files.js';
import { RelativeDir } from '../bin/utils/path/repo-relative.js';
import { RunTestResult } from './run-test-result.js';

const execFileAsync = promisify(execFile);

/** One `pnpm pack` result: the package name and the absolute tarball path. */
export interface Pack {
    name: string;
    filename: string;
}

type SourceFiles = Map<string, Buffer>;

const BUILD_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Packs the package at `cwd` (every workspace package with `recursive`) into `destination` and lists the tarballs.
 * Meant for a vitest `globalSetup`, so the code under test is packed once per run.
 */
export const pack = async (cwd: string, destination: string, { recursive = false } = {}): Promise<Pack[]> => {
    const args = [...(recursive ? ['-r'] : []), 'pack', '--json', '--pack-destination', destination];
    const { stdout } = await execFileAsync('pnpm', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    // One object for a single package, an array for `-r`.
    return [JSON.parse(stdout) as Pack | Pack[]].flat().map(({ name, filename }) => ({ name, filename }));
};

const toPosix = (relPath: string) => relPath.split(path.sep).join('/');

export interface PinOptions {
    /** `npm` writes `overrides`, `pnpm` writes `pnpm.overrides`. */
    manager?: 'npm' | 'pnpm';
    /** Package names to pin. Default: every pack. */
    only?: string[];
    /** The `package.json` to rewrite. Default: the root one. */
    packageJson?: string;
}

/**
 * What goes into a throwaway Actor. Building it is lazy: steps are recorded synchronously and applied in order when
 * `createActor` uploads the source.
 */
export class ActorSource {
    private constructor(private readonly steps: ((files: SourceFiles) => Promise<void>)[]) {}

    /** Every file under the directories; later directories win at the same relative path. */
    static dirs(...dirs: string[]): ActorSource {
        return new ActorSource([
            async (files) => {
                for (const dir of dirs) {
                    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
                        if (!entry.isFile()) continue;
                        const absPath = path.join(entry.parentPath, entry.name);
                        files.set(toPosix(path.relative(dir, absPath)), await readFile(absPath));
                    }
                }
            },
        ]);
    }

    /** The repository as a platform build would see it: minus gitignored, dockerignored and secret files. */
    static repo(repoRoot: string): ActorSource {
        return new ActorSource([
            async (files) => {
                for (const absPath of await collectNonIgnoredFiles(RelativeDir.ROOT, repoRoot)) {
                    files.set(toPosix(path.relative(repoRoot, absPath)), await readFile(absPath));
                }
            },
        ]);
    }

    /**
     * Pins packages to the tarballs in `packs`: adds them under `packages/` and rewrites `package.json` so both
     * direct and transitive dependencies on those names resolve to the tarballs. The Dockerfile must copy
     * `packages/` before installing.
     */
    pin(packs: Pack[], { manager = 'npm', only, packageJson = 'package.json' }: PinOptions = {}): ActorSource {
        return new ActorSource([
            ...this.steps,
            async (files) => {
                const raw = files.get(packageJson);
                if (!raw) throw new Error(`Cannot pin packages: ${packageJson} is not among the source files`);
                const pkg = JSON.parse(raw.toString('utf8'));
                const overrides = manager === 'pnpm' ? ((pkg.pnpm ??= {}).overrides ??= {}) : (pkg.overrides ??= {});

                for (const { name, filename } of packs) {
                    if (only && !only.includes(name)) continue;
                    const key = `packages/${path.basename(filename)}`;
                    const spec = `file:./${key}`;
                    // npm refuses an override that disagrees with the direct dependency's spec.
                    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
                        if (pkg[group]?.[name]) pkg[group][name] = spec;
                    }
                    overrides[name] = spec;
                    files.set(key, await readFile(filename));
                }

                files.set(packageJson, Buffer.from(JSON.stringify(pkg, null, 4)));
            },
        ]);
    }

    /**
     * Makes `fn`, a top-level function of the test file at `filename`, the Actor's entry point: its source is
     * read from disk (vitest's transformed code isn't runnable elsewhere), transpiled and written to `path` as an
     * ES module that awaits it. The function must be self-contained: dependencies via `await import()`, nothing
     * from the rest of the file except type-only imports. That is enforced by type-checking the extracted code
     * alone with the project's own `tsc` and the nearest `tsconfig.json`, so a stray reference fails as TS2304.
     */
    main(filename: string, fn: () => unknown, { path: target = 'main.js' } = {}): ActorSource {
        return new ActorSource([
            ...this.steps,
            async (files) => {
                const code = await readFile(filename, 'utf8');
                const source = extractMain(filename, code, fn.name);
                await typeCheckInIsolation(filename, source);
                const { code: js, errors } = transformSync(path.basename(filename), source, { target: 'node22' });
                if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('\n'));
                files.set(target, Buffer.from(js));
            },
        ]);
    }

    /** Resolves the recorded steps into the files to upload, keyed by their path inside the Actor. */
    async files(): Promise<SourceFiles> {
        const files: SourceFiles = new Map();
        for (const step of this.steps) await step(files);
        return files;
    }
}

/**
 * The entry-point module for the top-level function `name` of `code`: the file's type-only imports (erased on
 * transpile, kept so annotations resolve), the function as a declaration binding `name`, and a call awaiting it.
 */
const extractMain = (filename: string, code: string, name: string) => {
    const typeImports: string[] = [];
    let declaration: string | undefined;
    for (const statement of parseSync(filename, code).program.body) {
        if (statement.type === 'ImportDeclaration' && statement.importKind === 'type') {
            typeImports.push(code.slice(statement.start, statement.end));
        }
        const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (node?.type === 'FunctionDeclaration' && node.id?.name === name) {
            declaration = code.slice(node.start, node.end);
        }
        if (node?.type === 'VariableDeclaration') {
            for (const { id, init } of node.declarations) {
                if (id.type === 'Identifier' && id.name === name && init) {
                    declaration = `const ${name} = ${code.slice(init.start, init.end)};`;
                }
            }
        }
    }
    if (!declaration) throw new Error(`No top-level function "${name}" in ${filename}`);
    return [...typeImports, declaration, `await ${name}();`, ''].join('\n');
};

const findUp = async (from: string, name: string) => {
    for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, name);
        if (existsSync(candidate)) return candidate;
        if (dir === path.dirname(dir)) throw new Error(`No ${name} above ${from}`);
    }
};

/**
 * Type-checks `source` as its own module next to `filename`, under the nearest `tsconfig.json` as the project
 * configures it (path aliases, ambient declarations). Anything `source` took from the rest of the file is a TS2304
 * here. Only errors in the snippet count: the project's own errors are its type-check's business, and parallel
 * test files drop their own snippets into the same tree.
 */
const typeCheckInIsolation = async (filename: string, source: string) => {
    const tsconfig = await findUp(filename, 'tsconfig.json');
    const tsc = path.join(path.dirname(createRequire(filename).resolve('typescript/package.json')), 'bin', 'tsc');
    const token = randomBytes(4).toString('hex');
    const snippet = path.join(path.dirname(filename), `${path.basename(filename, '.ts')}.${token}.actor-main.mts`);
    await writeFile(snippet, source);
    try {
        await execFileAsync(process.execPath, [tsc, '-p', tsconfig, '--noEmit', '--pretty', 'false'], {
            cwd: path.dirname(tsconfig),
        });
    } catch (error) {
        const { stdout = '' } = error as { stdout?: string };
        const own = stdout.split('\n').filter((line) => line.includes(path.basename(snippet)));
        if (own.length > 0) {
            throw new Error(
                `The Actor entry point in ${filename} does not type-check on its own. It must not use anything from the rest of the file.\n${own.join('\n')}`,
            );
        }
    } finally {
        await rm(snippet, { force: true });
    }
};

const toPlatformFiles = (files: SourceFiles) =>
    [...files].map(([name, buffer]) => {
        const text = buffer.toString('utf8');
        return Buffer.from(text, 'utf8').equals(buffer)
            ? { name, format: 'TEXT' as const, content: text }
            : { name, format: 'BASE64' as const, content: buffer.toString('base64') };
    });

export interface CreateActorOptions {
    source: ActorSource;
    memory?: number;
    /** Set as secret environment variables of the build. */
    env?: Record<string, string>;
    /** The platform default is `LIMITED_PERMISSIONS`: the run can only touch its own storages. */
    permissions?: ACTOR_PERMISSION_LEVEL;
}

export interface Harness {
    /** Uploads and builds the scenario's source into the Actor `<namePrefix>-<label>`, creating it the first time. */
    createActor(label: string, options: CreateActorOptions): Promise<ActorClient>;
    /** Runs the build `createActor` made and wraps the run in a `RunTestResult`. */
    runActor(actor: ActorClient, input?: unknown, options?: ActorCallOptions): Promise<RunTestResult>;
    /** Deletes builds of the Actors `createActor` touched that are older than three days. */
    cleanup(): Promise<void>;
}

export interface HarnessOptions {
    /** Token of the account that owns the test Actors. */
    token: string;
    /** Prefix of every Actor name, so they group together in the Console. */
    namePrefix: string;
}

/**
 * Test Actors for library repositories: one Actor per scenario, kept between runs so its history stays in the
 * Console; each run uploads the local source as version `0.0`, builds it, runs against that build and prunes builds
 * older than three days with `cleanup`. `useHarness` from the main entry point wires `cleanup` to vitest; this module stays
 * vitest-free so `pack` can run in `globalSetup`.
 *
 * Two overlapping runs of the suite race on the `0.0` upload; serialize them (e.g. a CI concurrency group).
 */
export const createHarness = ({ token, namePrefix }: HarnessOptions): Harness => {
    // Checked when first used, not here: `describe.runIf(token)` still runs the suite factory this is called from.
    const client = new ApifyClient({ token });
    const builds = new Map<ActorClient, { id: string; buildNumber: string }>();

    // Recent builds stay so a regression can be compared against the last few runs; the newest is the version's
    // default and can't be deleted anyway.
    const cleanup = async () => {
        const actors = [...builds.keys()];
        builds.clear();
        const cutoff = Date.now() - BUILD_RETENTION_MS;
        await Promise.all(
            actors.map(async (actor) => {
                const { items } = await actor.builds().list({ limit: 1000 });
                await Promise.all(
                    items
                        .filter((build) => build.startedAt.getTime() < cutoff)
                        .map(async (build) => client.build(build.id).delete()),
                );
            }),
        );
    };

    const createActor = async (label: string, { source, memory = 256, env = {}, permissions }: CreateActorOptions) => {
        if (!token) throw new Error('The harness needs an Apify token');
        const name = `${namePrefix}-${label}`.replaceAll('_', '-');
        const version: ActorVersion = {
            versionNumber: '0.0',
            buildTag: 'latest',
            sourceType: ActorSourceType.SourceFiles,
            sourceFiles: toPlatformFiles(await source.files()),
            envVars: Object.entries(env).map(([envName, value]) => ({ name: envName, value, isSecret: true })),
        };
        const settings = {
            defaultRunOptions: { build: 'latest', memoryMbytes: memory, timeoutSecs: 600 },
            actorPermissionLevel: permissions,
        };

        const { username } = await client.user().get();
        const existing = await client.actor(`${username}/${name}`).get();
        let actor: ActorClient;
        if (existing) {
            actor = client.actor(existing.id);
            await Promise.all([actor.update(settings), actor.version('0.0').update(version)]);
        } else {
            const { id } = await client.actors().create({ name, ...settings, versions: [version] });
            actor = client.actor(id);
        }

        // Platform builds fail spuriously now and then; one retry is cheaper than a red nightly.
        for (let attempt = 1; ; attempt++) {
            const build = await actor.build('0.0');
            const { status } = await client.build(build.id).waitForFinish({ waitSecs: 1800 });
            if (status === 'SUCCEEDED') {
                builds.set(actor, { id: build.id, buildNumber: build.buildNumber });
                return actor;
            }
            if (attempt === 2) throw new Error(`Build of ${name} ${status}: https://api.apify.com/v2/logs/${build.id}`);
        }
    };

    // Pinned to the build, so a concurrent re-upload of `0.0` can't change what this test runs.
    const runActor = async (actor: ActorClient, input?: unknown, options?: ActorCallOptions) => {
        const run = await actor.call(input, { waitSecs: 600, build: builds.get(actor)?.buildNumber, ...options });
        return new RunTestResult(client, run);
    };

    return { createActor, runActor, cleanup };
};
