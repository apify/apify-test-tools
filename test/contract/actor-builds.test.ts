// The CLI and the library ship as separate packages, and consumer repos can run any library version
// against the CLI the workflows pin. `ACTOR_BUILDS` is the one value passed between them: the CLI's
// `build` and `build-from-local` print it, and the library reads it to pick which builds to test.
// These checks fail type-check when either side changes its shape in a way the other can't read.
import { describe, expectTypeOf, it } from 'vitest';

import type { BuildData, DryRunPlan } from '../../packages/cli/src/types.js';
import type { ActorBuild } from '../../packages/lib/src/types.js';

describe('ACTOR_BUILDS contract', () => {
    it('CLI build output is readable by the library', () => {
        expectTypeOf<BuildData>().toExtend<ActorBuild>();
    });

    it('library reads no field the CLI does not write', () => {
        expectTypeOf<keyof ActorBuild>().toExtend<keyof BuildData>();
    });

    it('a dry-run plan cannot be passed as builds', () => {
        expectTypeOf<DryRunPlan<BuildData>>().not.toExtend<ActorBuild[]>();
    });
});
