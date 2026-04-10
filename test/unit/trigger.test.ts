import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getCurrentTrigger, shouldRunForTrigger, TRIGGER_ENV_VAR } from '../../lib/trigger.js';

describe('getCurrentTrigger', () => {
    const saved = process.env[TRIGGER_ENV_VAR];

    afterEach(() => {
        if (saved === undefined) {
            delete process.env[TRIGGER_ENV_VAR];
        } else {
            process.env[TRIGGER_ENV_VAR] = saved;
        }
    });

    it('returns undefined when TEST_TRIGGER is not set', () => {
        delete process.env[TRIGGER_ENV_VAR];
        expect(getCurrentTrigger()).toBeUndefined();
    });

    it.each(['hourly', 'daily', 'pullRequest'] as const)('returns $0 when TEST_TRIGGER=$0', (trigger) => {
        process.env[TRIGGER_ENV_VAR] = trigger;
        expect(getCurrentTrigger()).toBe(trigger);
    });

    it.each(['weekly', 'locally', 'on-call', '', ' '])('returns undefined for unrecognized value "%s"', (value) => {
        process.env[TRIGGER_ENV_VAR] = value;
        expect(getCurrentTrigger()).toBeUndefined();
    });
});

describe('shouldRunForTrigger', () => {
    beforeEach(() => {
        delete process.env[TRIGGER_ENV_VAR];
    });

    afterEach(() => {
        delete process.env[TRIGGER_ENV_VAR];
    });

    describe('no runWhen config', () => {
        it('always runs when runWhen is undefined', () => {
            expect(shouldRunForTrigger(undefined)).toBe(true);
        });
    });

    describe('TEST_TRIGGER not set', () => {
        it('runs regardless of runWhen when no trigger is set', () => {
            expect(shouldRunForTrigger({ daily: true })).toBe(true);
            expect(shouldRunForTrigger({ hourly: false })).toBe(true);
            expect(shouldRunForTrigger({})).toBe(true);
        });
    });

    describe('trigger matches runWhen', () => {
        it('runs when the current trigger is explicitly true', () => {
            process.env[TRIGGER_ENV_VAR] = 'daily';
            expect(shouldRunForTrigger({ daily: true })).toBe(true);
        });

        it('runs when multiple triggers are enabled and current one is among them', () => {
            process.env[TRIGGER_ENV_VAR] = 'pullRequest';
            expect(shouldRunForTrigger({ daily: true, pullRequest: true })).toBe(true);
        });
    });

    describe('trigger not in runWhen', () => {
        it('does not run when the current trigger is explicitly false', () => {
            process.env[TRIGGER_ENV_VAR] = 'hourly';
            expect(shouldRunForTrigger({ hourly: false })).toBe(false);
        });

        it('does not run when the current trigger is absent (undefined !== true)', () => {
            process.env[TRIGGER_ENV_VAR] = 'hourly';
            // Note: in practice the merge stack always prepends DEFAULT_TRIGGERS so the
            // merged runWhen passed here will have all triggers explicitly set.
            expect(shouldRunForTrigger({})).toBe(false);
            expect(shouldRunForTrigger({ daily: true })).toBe(false);
        });

        it.each(['hourly', 'daily', 'pullRequest'] as const)(
            'does not run for %s when that trigger is explicitly false',
            (trigger) => {
                process.env[TRIGGER_ENV_VAR] = trigger;
                expect(shouldRunForTrigger({ [trigger]: false })).toBe(false);
            },
        );
    });
});
