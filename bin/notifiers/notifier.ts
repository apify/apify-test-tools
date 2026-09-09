import type { NotifyPayload } from './types.js';

export abstract class Notifier<TConfig = unknown> {
    abstract assertConfig(config: unknown): TConfig;

    abstract send(payload: NotifyPayload, opts: { target: string; dryRun: boolean; config: TConfig }): Promise<void>;
}
