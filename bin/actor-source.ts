import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import AdmZip from 'adm-zip';

import { collectSourceFiles } from './source-files.js';
import type { ActorConfig } from './types.js';

const execFileAsync = promisify(execFile);

/** One `pnpm pack` result: the package name and the absolute tarball path. */
export interface Pack {
    name: string;
    filename: string;
}

/** Source files keyed by their path inside the Actor. */
export type SourceFiles = Map<string, Buffer>;

/** One step of building an `ActorSource`: adds, rewrites or removes files. */
export type SourceStep = (files: SourceFiles) => Promise<void>;

export const zipFiles = (files: SourceFiles): Buffer => {
    const zip = new AdmZip();
    for (const [name, content] of files) zip.addFile(name, content);
    return zip.toBuffer();
};

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
 * The files an Actor is built from. Building it is lazy: steps are recorded synchronously and applied in order when
 * the source is uploaded.
 */
export class ActorSource {
    private constructor(private readonly steps: SourceStep[]) {}

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

    /**
     * An Actor from `apify-test-tools.config.json` the way `build-from-local` uploads it: its Docker context minus
     * ignored files, flattened when the context lies above the Actor's folder.
     */
    static actor(actorConfig: ActorConfig): ActorSource {
        return new ActorSource([
            async (files) => {
                for (const { name, content } of await collectSourceFiles(actorConfig)) files.set(name, content);
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

    /** Applies a custom step to the files collected so far. */
    with(step: SourceStep): ActorSource {
        return new ActorSource([...this.steps, step]);
    }

    /** Resolves the recorded steps into the files to upload, keyed by their path inside the Actor. */
    async files(): Promise<SourceFiles> {
        const files: SourceFiles = new Map();
        for (const step of this.steps) await step(files);
        return files;
    }

    /** The resolved files as a zip, the form the platform builds a `TARBALL` version from. */
    async zip(): Promise<Buffer> {
        return zipFiles(await this.files());
    }
}
