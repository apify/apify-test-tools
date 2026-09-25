import { describe, expect, test } from 'vitest';

// The workflows' unit-test job runs `npm test`; this gives it something to run.
describe('fixture', () => {
    test('runs unit tests', () => {
        expect(1 + 1).toBe(2);
    });
});
