import { describe, expect, it } from 'vitest';

import { shouldNotifySlack } from '../../bin/test-report.js';

describe('shouldNotifySlack', () => {
    describe('no alerts config (backward compatibility)', () => {
        it('notifies when alerts is undefined', () => {
            expect(shouldNotifySlack(undefined)).toBe(true);
        });

        it('notifies when alerts object has no slack key', () => {
            expect(shouldNotifySlack({})).toBe(true);
        });
    });

    describe('explicit opt-in', () => {
        it('notifies when slack is true', () => {
            expect(shouldNotifySlack({ slack: true })).toBe(true);
        });
    });

    describe('explicit opt-out', () => {
        it('suppresses when slack is false', () => {
            expect(shouldNotifySlack({ slack: false })).toBe(false);
        });
    });
});
