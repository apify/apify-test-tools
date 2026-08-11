import { describe, expect, it } from 'vitest';

import { findContainingScope, hoistPath, isPathWithinScope } from '../../../bin/path-utils.js';

describe('path-utils', () => {
    it('isPathWithinScope matches a scope entry that names an exact file, not just a directory prefix', () => {
        expect(isPathWithinScope('shared/utils.ts', 'shared/utils.ts')).toBe(true);
    });

    it('findContainingScope picks the exact-file entry out of a list of scope paths', () => {
        expect(findContainingScope('shared/utils.ts', ['actors/foo', 'shared/utils.ts'])).toBe('shared/utils.ts');
    });

    it('hoistPath resolves an exact-file scope match to an empty string, not an out-of-bounds slice', () => {
        expect(hoistPath('shared/utils.ts', 'shared/utils.ts')).toBe('');
    });
});
