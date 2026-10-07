/* eslint-disable max-classes-per-file */
import { statSync } from 'node:fs';
import path from 'node:path';

// Git and the config file always use "/", so paths are POSIX regardless of the host OS.
const { posix } = path;

// A file path cannot end in "/", ".", "..", or be empty: each of those names a directory.
const assertNamesFile = (rawPath: string): void => {
    const lastSegment = rawPath.slice(rawPath.lastIndexOf('/') + 1);
    if (lastSegment === '' || lastSegment === '.' || lastSegment === '..') {
        throw new Error(`Expected a file path, got directory path "${rawPath}".`);
    }
};

// Shared by the file and directory paths. Use it as a parameter type where either kind is fine.
export abstract class AbstractPath {
    readonly #path: string;
    constructor(rawPath: string) {
        if (posix.isAbsolute(rawPath)) {
            throw new Error(`Expected a relative path, got absolute path "${rawPath}".`);
        }
        const normalized = posix.normalize(rawPath);
        // normalize keeps a trailing slash ("actors/foo/"), which would make equal paths compare unequal.
        this.#path = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
        this.assertNoEscape(rawPath);
    }

    // A file and a directory are never equal, even when spelled the same.
    isEqualTo(other: AbstractPath): boolean {
        // inheritance safe check, at least one of the two is a subclass of the other
        const isRelativeOf = this instanceof other.constructor || other instanceof this.constructor;
        return isRelativeOf && this.#path === other.#path;
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

    joinDir(relativePath: string): RelativeDir {
        return new RelativeDir(this.join(relativePath));
    }

    joinFile(relativePath: string): RelativeFile {
        // Must be checked before joining: posix.join('actors/foo', '.') is "actors/foo", which looks like a file.
        assertNamesFile(relativePath);
        return new RelativeFile(this.join(relativePath));
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

    private join(relativePath: string): string {
        // Must be checked here: posix.join('.', '/etc') is "etc", so the constructor would not catch it.
        if (posix.isAbsolute(relativePath)) {
            throw new Error(`Expected a relative path to join with "${this}", got absolute path "${relativePath}".`);
        }
        return posix.join(this.path, relativePath);
    }
}

export class ExistingDir extends RelativeDir {
    constructor(rawPath: string) {
        super(rawPath);
        this.assertIsDir();
    }

    static initialize(dir: RelativeDir): ExistingDir {
        return new ExistingDir(dir.path);
    }
}

export class RelativeFile extends AbstractPath {
    constructor(rawPath: string) {
        assertNamesFile(rawPath);
        super(rawPath);
    }

    // The directory containing this file.
    get parent(): RelativeDir {
        return new RelativeDir(posix.dirname(this.path));
    }

    // Resolves against the file's directory, the way a path written inside the file is meant
    // (e.g. `dockerContextDir: ".."` in `.actor/actor.json` is the actor folder).
    joinDir(relativePath: string): RelativeDir {
        return this.parent.joinDir(relativePath);
    }

    // Resolves against the file's directory, e.g. a sibling file.
    joinFile(relativePath: string): RelativeFile {
        return this.parent.joinFile(relativePath);
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

export class ExistingFile extends RelativeFile {
    constructor(rawPath: string) {
        super(rawPath);
        this.assertIsFile();
    }

    static initialize(file: RelativeFile): ExistingFile {
        return new ExistingFile(file.path);
    }
}
