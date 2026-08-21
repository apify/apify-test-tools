export type NotifyPayload = { summary: string; details?: string[] };
export type NotifyFileContents = NotifyPayload | null;

export interface NotifierOptions {
    target: string;
    dryRun: boolean;
    config: unknown;
}

export type Notifier = (payload: NotifyPayload, options: NotifierOptions) => Promise<void>;
