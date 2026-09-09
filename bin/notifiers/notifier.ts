import type { NotifierMessage, NotifyDocument, NotifyTargetKey } from './types.js';

// Every notifier addresses a document by a target from its own config's "targets" map, keyed by
// document type (e.g. "test-report", "release-report-dev").
export interface NotifierConfig {
    targets: Partial<Record<NotifyTargetKey, string>>;
}

export abstract class Notifier<TConfig extends NotifierConfig = NotifierConfig> {
    abstract assertConfig(config: unknown): TConfig;

    // Turns a structured document into this notifier's own message shape, deciding "nothing to
    // notify" along the way (e.g. a test-report with no failures) by returning null.
    abstract format(document: NotifyDocument, view?: 'dev' | 'public'): NotifierMessage | null;

    abstract send(message: NotifierMessage, opts: { target: string; dryRun: boolean; config: TConfig }): Promise<void>;
}
