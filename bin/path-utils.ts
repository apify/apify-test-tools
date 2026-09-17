import { isAbsolute, relative, sep as pathSeparator } from 'node:path';

export const isParentOf = (parent: string, child: string): boolean => {
    assertRelative(parent);
    assertRelative(child);
    if (isSamePath(parent, child)) return false;
    const relativePath = relative(parent, child);

    if (isRelativeEscape(relativePath)) return false;
    return true;
};

export const isRelativeEscape = (path: string): boolean => path.startsWith(`..${pathSeparator}`) || path === '..';

export const isWithinPath = (base: string, filePath: string): boolean => {
    assertRelative(base);
    assertRelative(filePath);
    return isParentOf(base, filePath) || isSamePath(base, filePath);
};

export const assertRelative = (path: string): void => {
    if (isAbsolute(path)) {
        throw new Error(`Expected ${path} to be relative`);
    }
};

export const isSamePath = (pathA: string, pathB: string): boolean => {
    assertRelative(pathA);
    assertRelative(pathB);
    return relative(pathA, pathB) === '';
};

// filePath and scopePath are both repo-root-relative POSIX paths, already normalized (no trailing slashes).
// scopePath === '' means "matches everything" — the caller's own scope (a context path, an actor's folder,
// a sibling's folder, a docker context dir), not necessarily the repo root.
export const isPathWithinScope = (filePath: string, scopePath: string): boolean =>
    scopePath === '' || filePath === scopePath || filePath.startsWith(`${scopePath}/`);

// Returns the single scopePaths entry filePath falls under, if any.
export const findContainingScope = (filePath: string, scopePaths: string[]): string | undefined =>
    scopePaths.find((scopePath) => isPathWithinScope(filePath, scopePath));

// Returns filePath relative to scopePath (assumes isPathWithinScope(filePath, scopePath) is already true).
export const hoistPath = (filePath: string, scopePath: string): string =>
    scopePath === '' ? filePath : filePath.slice(scopePath.length + 1);
