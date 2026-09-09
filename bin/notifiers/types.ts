import type { Commit } from '../types.js';

export type { Commit };

export interface FailedTest {
    id: string;
    message: string;
    runLink: string;
    actorId: string;
}

export type NotifyDocument =
    | {
          type: 'test-report';
          workflowName?: string;
          jobUrl?: string;
          failed: FailedTest[];
          failedCount: number;
          passedCount: number;
          totalCount: number;
      }
    | {
          type: 'release-report';
          repository: string;
          author: string;
          changelog: string | null;
          commits: Commit[];
          changedFiles: string[];
      };

export type NotifierMessage = { summary: string; details?: string[] };

// The keys a notifier's config `targets` map may provide — one per document type, with
// `release-report` further split by view since dev/public delivery usually goes to different places.
export type NotifyTargetKey = 'test-report' | 'release-report-dev' | 'release-report-public';
