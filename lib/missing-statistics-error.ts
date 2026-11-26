/** Thrown by `getStatistics` for the records it was asked for that the run doesn't have */
export class MissingStatisticsError extends Error {
    constructor(readonly keys: string[]) {
        super(`The run has no statistics record ${keys.join(', ')}`);
        this.name = 'MissingStatisticsError';
    }
}
