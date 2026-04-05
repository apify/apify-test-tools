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

    describe('runWhen — innermost wins entirely', () => {
        it('child runWhen replaces parent runWhen completely', () => {
            const result = mergeInheritedConfigs([{ runWhen: { daily: true } }, { runWhen: { hourly: true } }]);
            expect(result.runWhen).toEqual({ hourly: true });
        });

        it('grandchild wins over both ancestors', () => {
            const result = mergeInheritedConfigs([
                { runWhen: { daily: true } },
                { runWhen: { hourly: true } },
                { runWhen: { pullRequest: true } },
            ]);
            expect(result.runWhen).toEqual({ pullRequest: true });
        });

        it('inherits parent runWhen when child has none', () => {
            const result = mergeInheritedConfigs([
                { runWhen: { daily: true } },
                { alerts: { slack: true } }, // no runWhen
            ]);
            expect(result.runWhen).toEqual({ daily: true });
        });

        it('innermost explicit runWhen beats grandparent even if intermediate has none', () => {
            const result = mergeInheritedConfigs([
                { runWhen: { daily: true } },
                {}, // intermediate — no runWhen
                { runWhen: { hourly: true } },
            ]);
            expect(result.runWhen).toEqual({ hourly: true });
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
            // testActor: hourly-only override
            const result = mergeInheritedConfigs([
                { runWhen: { daily: true }, alerts: { slack: true } },
                {},
                { runWhen: { hourly: true } },
            ]);
            expect(result).toEqual({
                runWhen: { hourly: true }, // innermost wins
                alerts: { slack: true }, // inherited from outer describe
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
