import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import AdmZip from 'adm-zip';
import type { ActorVersion } from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';
import { parseSync } from 'oxc-parser';
import { transformSync } from 'oxc-transform';

import type { ACTOR_PERMISSION_LEVEL } from '@apify/consts';

import { ApifyBuilder, LOCAL_SOURCE_VERSION_NUMBER } from '../bin/build.js';
import { collectNonIgnoredFiles } from '../bin/source-files.js';
import type { BuildData } from '../bin/types.js';
import { RelativeDir } from '../bin/utils/path/repo-relative.js';

const execFileAsync = promisify(execFile);

/** One `pnpm pack` result: the package name and the absolute tarball path. */
export interface Pack {
    name: string;
    filename: string;
}

type SourceFiles = Map<string, Buffer>;

const BUILD_RETENTION_DAYS = 3;

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

export interface DefineActorOptions {
    source: ActorSource;
    /** Default memory of the Actor's runs, in MB. */
    memory?: number;
    /** Set as secret environment variables of the build. */
    env?: Record<string, string>;
    /** The platform default is `LIMITED_PERMISSIONS`: the run can only touch its own storages. */
    permissions?: ACTOR_PERMISSION_LEVEL;
    /**
     * How long `run` waits after the run finishes before handing out the result. Default: the same 20 seconds as
     * for Actors given by ID. Set to 0 when the tests poll for what they need.
     */
    syncDelayMs?: number;
}

/** An Actor that exists as a source in the repository instead of as an entry in `apify-test-tools.config.json`. */
export interface DefinedActor extends DefineActorOptions {
    name: string;
}

/**
 * Defines an Actor for `testActor` by its source. It is built from that source on first use, as version `0.98` of
 * the Actor `name` under the account of `TESTER_APIFY_TOKEN`, which is created if it doesn't exist and kept
 * afterwards so its runs stay in the Console.
 *
 * Two overlapping runs of a suite race on the source upload; serialize them (e.g. a CI concurrency group).
 */
export const defineActor = (name: string, options: DefineActorOptions): DefinedActor => ({ name, ...options });

const builds = new Map<string, Promise<BuildData>>();

const build = async (actor: DefinedActor, token: string): Promise<BuildData> => {
    const client = new ApifyClient({ token });
    const zip = new AdmZip();
    for (const [name, content] of await actor.source.files()) zip.addFile(name, content);

    const settings = {
        defaultRunOptions: { build: 'latest', memoryMbytes: actor.memory ?? 256, timeoutSecs: 600 },
        actorPermissionLevel: actor.permissions,
    };
    const { username } = await client.user().get();
    const actorFullName = `${username}/${actor.name}`;
    const existing = await client.actor(actorFullName).get();
    if (existing) await client.actor(existing.id).update(settings);
    else await client.actors().create({ name: actor.name, ...settings });

    const builder = ApifyBuilder.fromToken(token, actorFullName);
    const version: ActorVersion = {
        versionNumber: LOCAL_SOURCE_VERSION_NUMBER,
        buildTag: 'latest',
        sourceType: ActorSourceType.Tarball,
        tarballUrl: await builder.uploadSourceZip(LOCAL_SOURCE_VERSION_NUMBER, zip.toBuffer()),
        envVars: Object.entries(actor.env ?? {}).map(([name, value]) => ({ name, value, isSecret: true })),
    };

    // Platform builds fail spuriously now and then; one retry is cheaper than a red nightly.
    for (let attempt = 1; ; attempt++) {
        const buildData = await builder.createVersionAndBuild(LOCAL_SOURCE_VERSION_NUMBER, version, false);
        try {
            await builder.waitForBuildToFinish(buildData.buildId);
            return buildData;
        } catch (error) {
            if (attempt === 2) throw error;
        }
    }
};

/**
 * Builds the ad-hoc Actor, once per process however many tests ask. `testActor` calls this on the first `run`;
 * call it directly to reach the Actor before that, e.g. to set its pricing in `beforeAll`.
 */
export const buildActor = async (actor: DefinedActor, token = process.env.TESTER_APIFY_TOKEN): Promise<BuildData> => {
    if (!token) throw new Error(`Building the Actor "${actor.name}" needs TESTER_APIFY_TOKEN`);
    let started = builds.get(actor.name);
    if (!started) {
        // A failed build isn't kept, so a retried test builds again.
        started = build(actor, token).catch((error: unknown) => {
            builds.delete(actor.name);
            throw error;
        });
        builds.set(actor.name, started);
    }
    return started;
};

/** Deletes the ad-hoc Actor's builds older than `BUILD_RETENTION_DAYS`. Recent ones stay for comparing runs. */
export const pruneBuilds = async (actor: DefinedActor, token = process.env.TESTER_APIFY_TOKEN): Promise<void> => {
    // Absent when no test ran the Actor or its build failed; either way there is nothing new to weigh against.
    const started = builds.get(actor.name);
    if (!token || !started) return;
    const { actorFullName } = await started;
    await ApifyBuilder.fromToken(token, actorFullName).deleteOldBuilds({
        dryRun: false,
        daysBack: BUILD_RETENTION_DAYS,
    });
};
