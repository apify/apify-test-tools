import type { ActorConfig } from '../../../bin/types.js';

export function actor(actorFullName: `${string}/${string}`, override?: Partial<ActorConfig>): ActorConfig {
    return {
        actorFullName,
        folder: `actors/${actorFullName.replace('/', '_')}`,
        tokenEnvVar: 'APIFY_TOKEN_FOO',
        dockerContextDir: '..',
        contextPaths: ['..'],
        actorConfig: {
            actorSpecification: 1,
            name: actorFullName.split('/')[1],
            version: '1.0',
            buildTag: 'latest',
            dockerfile: '../Dockerfile',
            readme: '../README.md',
            dockerContextDir: '..',
        },
        ...override,
    };
}
