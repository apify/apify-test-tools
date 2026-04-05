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

    it.each(['hourly', 'daily', 'pullRequest'] as const)('returns %s when TEST_TRIGGER=%s', (trigger) => {
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
            process.env[TRIGGER_ENV_VAR] = 'hourly';
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
        it('runs when the current trigger is enabled', () => {
            process.env[TRIGGER_ENV_VAR] = 'daily';
            expect(shouldRunForTrigger({ daily: true })).toBe(true);
        });

        it('runs when multiple triggers are enabled and current one is among them', () => {
            process.env[TRIGGER_ENV_VAR] = 'pullRequest';
            expect(shouldRunForTrigger({ daily: true, pullRequest: true })).toBe(true);
        });
    });

    describe('trigger does not match runWhen', () => {
        it('does not run when the current trigger is not listed', () => {
            process.env[TRIGGER_ENV_VAR] = 'hourly';
            expect(shouldRunForTrigger({ daily: true })).toBe(false);
        });

        it('does not run when runWhen is an empty object', () => {
            process.env[TRIGGER_ENV_VAR] = 'hourly';
            expect(shouldRunForTrigger({})).toBe(false);
        });

        it('does not run when the current trigger is explicitly false', () => {
            process.env[TRIGGER_ENV_VAR] = 'hourly';
            expect(shouldRunForTrigger({ hourly: false })).toBe(false);
        });

        it('does not run when a different trigger is enabled', () => {
            process.env[TRIGGER_ENV_VAR] = 'hourly';
            expect(shouldRunForTrigger({ daily: true, pullRequest: true })).toBe(false);
        });
    });
});
