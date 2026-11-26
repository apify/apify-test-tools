import { afterEach, describe, expect, it, vi } from 'vitest';

import { withTestTokens } from '../../../bin/actor-ids.js';
import { logger } from '../../../bin/logger.js';

const testTokenEnvVars = new Map([
    ['owner/a', 'APIFY_TOKEN_OWNER'],
    ['partner/p', 'APIFY_TOKEN_PARTNER'],
]);
const env = { APIFY_TOKEN_OWNER: 'owner-token', APIFY_TOKEN_PARTNER: 'partner-token' };

const warnings = () => vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

afterEach(() => {
    vi.restoreAllMocks();
});

describe('withTestTokens', () => {
    it("adds each Actor's test token, as get-actor-configs lists them", () => {
        expect(
            withTestTokens([{ actorFullName: 'owner/a' }, { actorFullName: 'partner/p' }], { testTokenEnvVars, env }),
        ).toEqual([
            { actorFullName: 'owner/a', testTokenEnvVar: 'APIFY_TOKEN_OWNER' },
            { actorFullName: 'partner/p', testTokenEnvVar: 'APIFY_TOKEN_PARTNER' },
        ]);
    });

    it('keeps the build of an Actor', () => {
        const build = { actorFullName: 'owner/a', buildId: 'b1', buildNumber: '0.99.1' };
        expect(withTestTokens([build], { testTokenEnvVars, env })).toEqual([
            { ...build, testTokenEnvVar: 'APIFY_TOKEN_OWNER' },
        ]);
    });

    it('passes on an Actor without a token in the config or an unset one with a warning, so only its tests fail', () => {
        const warn = warnings();
        const result = withTestTokens(
            [{ actorFullName: 'stranger/x' }, { actorFullName: 'partner/p' }, { actorFullName: 'owner/a' }],
            { testTokenEnvVars, env: { APIFY_TOKEN_OWNER: 'owner-token' } },
        );
        expect(result).toEqual([
            { actorFullName: 'stranger/x' },
            { actorFullName: 'partner/p', testTokenEnvVar: 'APIFY_TOKEN_PARTNER' },
            { actorFullName: 'owner/a', testTokenEnvVar: 'APIFY_TOKEN_OWNER' },
        ]);
        expect(warn.mock.calls.map(([message]) => message)).toEqual([
            'Actor stranger/x is not in apify-test-tools.config.json, so its tests will fail.',
            'APIFY_TOKEN_PARTNER is not set, so the tests of partner/p will fail.',
        ]);
    });
});
