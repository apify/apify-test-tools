/* eslint-disable max-classes-per-file */
import { statSync } from 'node:fs';
import path from 'node:path';

// Git and the config file always use "/", so paths are POSIX regardless of the host OS.
const { posix } = path;

// Shared by the file and directory paths. Use it as a parameter type where either kind is fine.
export abstract class AbstractPath {
    readonly #path: string;
    constructor(value: string) {
        if (posix.isAbsolute(value)) {
            throw new Error(`Expected a relative path, got absolute path "${value}".`);
        }
        const normalized = posix.normalize(value);
        // normalize keeps a trailing slash ("actors/foo/"), which would make equal paths compare unequal.
        this.#path = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
        this.assertNoEscape(value);
    }

    isEqualTo(other: AbstractPath): boolean {
        return this.#path === other.#path;
    }

    get path(): string {
        return this.#path;
    }

    toString(): string {
        return this.path;
    }

    toJSON(): string {
        return this.path;
    }

    private assertNoEscape(raw: string): void {
        if (this.#path === '..' || this.#path.startsWith('../')) {
            throw new Error(`Path "${raw}" escapes the repo root.`);
        }
    }
}

export class RelativeDir extends AbstractPath {
    static readonly ROOT = new RelativeDir('.');

    joinDir(relative: string): RelativeDir {
        return new RelativeDir(this.join(relative));
    }

    joinFile(relative: string): RelativeFile {
        return new RelativeFile(this.join(relative));
    }

    // True when `other` is this directory itself or lies inside it.
    contains(other: AbstractPath): boolean {
        // the root contains every path
        if (this.path === '.') return true;
        return this.isEqualTo(other) || other.path.startsWith(`${this.path}/`);
    }

    isStrictAncestorOf(other: AbstractPath): boolean {
        // you are not an ancestor of yourself
        return !this.isEqualTo(other) && this.contains(other);
    }

    // Throws unless this path exists and is a directory. Paths resolve against the process working
    // directory, which is the repo root.
    assertIsDir(): this {
        // `stat`, not `lstat`: a symlink must resolve to its target, matching what reading it does.
        const stats = statSync(this.path, { throwIfNoEntry: false });
        if (!stats) throw new Error(`Expected directory "${this}" to exist.`);
        if (!stats.isDirectory()) throw new Error(`Expected "${this}" to be a directory.`);
        return this;
    }

    private join(relative: string): string {
        // Must be checked here: posix.join('.', '/etc') is "etc", so the constructor would not catch it.
        if (posix.isAbsolute(relative)) {
            throw new Error(`Expected a relative path to join with "${this}", got absolute path "${relative}".`);
        }
        return posix.join(this.path, relative);
    }
}

export class RelativeFile extends AbstractPath {
    // The directory containing this file.
    get parent(): RelativeDir {
        return new RelativeDir(posix.dirname(this.path));
    }

    // Resolves against the file's directory, the way a path written inside the file is meant
    // (e.g. `dockerContextDir: ".."` in `.actor/actor.json` is the actor folder).
    joinDir(relative: string): RelativeDir {
        return this.parent.joinDir(relative);
    }

    // Resolves against the file's directory, e.g. a sibling file.
    joinFile(relative: string): RelativeFile {
        return this.parent.joinFile(relative);
    }

    isWithin(scope: RelativeDir): boolean {
        return scope.contains(this);
    }

    // Throws unless this path exists and is a file. Paths resolve against the process working
    // directory, which is the repo root.
    assertIsFile(): this {
        // `stat`, not `lstat`: a symlink must resolve to its target, matching what reading it does.
        const stats = statSync(this.path, { throwIfNoEntry: false });
        if (!stats) throw new Error(`Expected file "${this}" to exist.`);
        if (!stats.isFile()) throw new Error(`Expected "${this}" to be a file.`);
        return this;
    }
}
