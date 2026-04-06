export {
    describe,
    testActor,
    testStandbyActor,
    ExpectStatic,
    getCurrentTrigger,
    TRIGGER_ENV_VAR,
    BACKWARD_COMPATIBLE_HOURLY_DIR,
} from './lib/lib.js';
export { RunTestResult } from './lib/run-test-result.js';
export type {
    TriggerType,
    RunWhenConfig,
    AlertsConfig,
    TriggerConfig,
    DescribeConfig,
    DescribeOptions,
    TestActorConfig,
    ActorOptions,
} from './lib/types.js';
