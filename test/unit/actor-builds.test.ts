import { describe, expect, it } from 'vitest';

import { ActorBuilds } from '../../lib/actor-builds.js';

const build = { actorFullName: 'me/actor', actorRawId: 'rawId', buildId: 'b1', buildNumber: '0.99.1' };

describe('ActorBuilds', () => {
    it('finds a build by full name and by raw ID', () => {
        const builds = new ActorBuilds([build]);
        expect(builds.get('me/actor')).toBe(build);
        expect(builds.get('rawId')).toBe(build);
        expect(builds.has('other/actor')).toBe(false);
    });

    it('is empty when the env variable is unset or empty', () => {
        expect(ActorBuilds.fromEnv({}).has('me/actor')).toBe(false);
        expect(ActorBuilds.fromEnv({ ACTOR_BUILDS: '' }).has('me/actor')).toBe(false);
    });

    it('parses the JSON array from the env variable', () => {
        const builds = ActorBuilds.fromEnv({ ACTOR_BUILDS: JSON.stringify([build]) });
        expect(builds.get('rawId')).toEqual(build);
    });

    it.each([['not json'], ['{"actorFullName":"me/actor"}']])('rejects %s', (raw) => {
        expect(() => ActorBuilds.fromEnv({ ACTOR_BUILDS: raw })).toThrow('Failed to parse ACTOR_BUILDS env variable');
    });
});
