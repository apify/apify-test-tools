import { describe, expect, it } from 'vitest';

import { mergeInheritedConfigs } from '../../lib/lib.js';

describe('mergeInheritedConfigs', () => {
    describe('empty / no layers', () => {
        it('returns empty config for an empty stack', () => {
            expect(mergeInheritedConfigs([])).toEqual({});
        });

        it('returns the single layer as-is', () => {
            expect(mergeInheritedConfigs([{ runWhen: { daily: true } }])).toEqual({
                runWhen: { daily: true },
            });
        });
    });

    describe('runWhen — shallow merge, child keys override', () => {
        it('child runWhen is merged with parent runWhen field-by-field', () => {
            const result = mergeInheritedConfigs([{ runWhen: { daily: true } }, { runWhen: { hourly: true } }]);
            expect(result.runWhen).toEqual({ daily: true, hourly: true });
        });

        it('child can override a specific trigger set by parent', () => {
            const result = mergeInheritedConfigs([{ runWhen: { daily: true } }, { runWhen: { daily: false } }]);
            expect(result.runWhen).toEqual({ daily: false });
        });

        it('grandchild merges across all ancestors', () => {
            const result = mergeInheritedConfigs([
                { runWhen: { daily: true } },
                { runWhen: { hourly: true } },
                { runWhen: { pullRequest: true } },
            ]);
            expect(result.runWhen).toEqual({ daily: true, hourly: true, pullRequest: true });
        });

        it('inherits parent runWhen when child has none', () => {
            const result = mergeInheritedConfigs([
                { runWhen: { daily: true } },
                { alerts: { slack: true } }, // no runWhen
            ]);
            expect(result.runWhen).toEqual({ daily: true });
        });

        it('child can disable a trigger set by grandparent via intermediate layer', () => {
            const result = mergeInheritedConfigs([
                { runWhen: { daily: true, hourly: true } },
                {}, // intermediate — no runWhen
                { runWhen: { hourly: false } },
            ]);
            expect(result.runWhen).toEqual({ daily: true, hourly: false });
        });
    });

    describe('alerts — shallow merge, child keys override', () => {
        it('inherits parent alerts when child has none', () => {
            const result = mergeInheritedConfigs([{ alerts: { slack: true } }, {}]);
            expect(result.alerts).toEqual({ slack: true });
        });

        it('child alerts override parent keys', () => {
            const result = mergeInheritedConfigs([{ alerts: { slack: true } }, { alerts: { slack: false } }]);
            expect(result.alerts).toEqual({ slack: false });
        });

        it('accumulates alerts across layers when keys are disjoint', () => {
            // If we add more alert keys in future, they should accumulate
            const result = mergeInheritedConfigs([
                { alerts: { slack: true } },
                { alerts: {} }, // empty override still triggers shallow merge
            ]);
            // empty override produces { ...{ slack: true }, ...{} } = { slack: true }
            expect(result.alerts).toEqual({ slack: true });
        });

        it('three layers — deepest alerts win per key', () => {
            const result = mergeInheritedConfigs([
                { alerts: { slack: true } },
                { alerts: { slack: false } },
                { alerts: { slack: true } },
            ]);
            expect(result.alerts).toEqual({ slack: true });
        });
    });

    describe('combined runWhen + alerts across layers', () => {
        it('resolves both independently across a realistic describe → testActor stack', () => {
            // Outer describe: daily + slack
            // Inner describe: no extra config
            // testActor: add hourly without losing daily
            const result = mergeInheritedConfigs([
                { runWhen: { daily: true }, alerts: { slack: true } },
                {},
                { runWhen: { hourly: true } },
            ]);
            expect(result).toEqual({
                runWhen: { daily: true, hourly: true }, // merged field-by-field
                alerts: { slack: true }, // inherited from outer describe
            });
        });

        it('testActor can disable a trigger from enclosing describe', () => {
            const result = mergeInheritedConfigs([
                { runWhen: { daily: true, pullRequest: true }, alerts: { slack: true } },
                { runWhen: { pullRequest: false } }, // testActor opts out of pullRequest
            ]);
            expect(result).toEqual({
                runWhen: { daily: true, pullRequest: false },
                alerts: { slack: true },
            });
        });

        it('testActor with no config inherits everything from enclosing describe', () => {
            const result = mergeInheritedConfigs([
                { runWhen: { pullRequest: true }, alerts: { slack: true } },
                {}, // testActor with no overrides
            ]);
            expect(result).toEqual({
                runWhen: { pullRequest: true },
                alerts: { slack: true },
            });
        });
    });
});
