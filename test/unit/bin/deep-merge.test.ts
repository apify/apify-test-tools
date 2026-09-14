import { describe, expect, it } from 'vitest';

import { deepMerge } from '../../../bin/utils.js';

describe('deepMerge', () => {
    it('recurses into nested plain objects', () => {
        const base = { notifier: { slack: { token: 'base-token', testTarget: '#base' } } };
        const overlay = { notifier: { slack: { token: 'overlay-token' } } };

        expect(deepMerge(base, overlay)).toEqual({
            notifier: { slack: { token: 'overlay-token', testTarget: '#base' } },
        });
    });

    it('appends only overlay-novel base elements after the overlay array, keeping overlay order', () => {
        const base = { paths: ['shared', 'actors/shopify', 'legacy'] };
        const overlay = { paths: ['actors/shopify', 'new'] };

        expect(deepMerge(base, overlay)).toEqual({ paths: ['actors/shopify', 'new', 'shared', 'legacy'] });
    });

    it('inherits a key present on only one side untouched', () => {
        expect(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('replaces a primitive outright', () => {
        expect(deepMerge({ tokenEnvVar: 'BASE_TOKEN' }, { tokenEnvVar: 'OVERLAY_TOKEN' })).toEqual({
            tokenEnvVar: 'OVERLAY_TOKEN',
        });
    });

    it('replaces an array with a primitive outright, and vice versa, without merging', () => {
        expect(deepMerge({ value: ['a', 'b'] }, { value: 'replaced' })).toEqual({ value: 'replaced' });
        expect(deepMerge({ value: 'replaced' }, { value: ['a', 'b'] })).toEqual({ value: ['a', 'b'] });
    });
});
