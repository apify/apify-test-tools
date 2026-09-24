import path from 'node:path';

// Git and the config file always use "/", so paths are POSIX regardless of the host OS.
const { posix } = path;

export class RelativePath {
    static readonly ROOT = new RelativePath('.');

    readonly #path: string;
    private constructor(value: string) {
        if (posix.isAbsolute(value)) {
            throw new Error(`Expected a relative path, got absolute path "${value}".`);
        }
        const normalized = posix.normalize(value);
        // normalize keeps a trailing slash ("actors/foo/"), which would make equal paths compare unequal.
        this.#path = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
        this.assertNoEscape(value);
    }

    join(relative: string): RelativePath {
        // Must be checked here: posix.join('.', '/etc') is "etc", so the constructor would not catch it.
        if (posix.isAbsolute(relative)) {
            throw new Error(`Expected a relative path to join with "${this}", got absolute path "${relative}".`);
        }
        return new RelativePath(posix.join(this.#path, relative));
    }

    isEqualTo(other: RelativePath): boolean {
        return this.#path === other.#path;
    }

    isStrictAncestorOf(other: RelativePath): boolean {
        // you are not an ancestor of yourself
        if (this.isEqualTo(other)) return false;
        // if you are root, you are an ancestor of everything (except the root)
        if (this.isEqualTo(RelativePath.ROOT)) return true;
        // other cases
        return other.#path.startsWith(`${this.#path}/`);
    }

    isWithin(scope: RelativePath): boolean {
        return scope.isStrictAncestorOf(this) || this.isEqualTo(scope);
    }

    toString(): string {
        return this.#path;
    }

    toJSON(): string {
        return this.#path;
    }

    private assertNoEscape(raw: string): void {
        if (this.#path === '..' || this.#path.startsWith('../')) {
            throw new Error(`Path "${raw}" escapes the repo root.`);
        }
    }
}
