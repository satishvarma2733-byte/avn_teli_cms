import type { DuplicateMode } from '@avn-cms/core/schemas';

import type { Tone } from '@/components/ui/primitives';

/** Shapes the import API returns to the browser (dates arrive as strings). Mirrors core. */
export interface ImportIssue {
  line: number;
  severity: 'error' | 'warning';
  field: string;
  message: string;
}

export interface ImportResult {
  total?: number;
  processed?: number;
  valid?: number;
  invalid?: number;
  warnings?: number;
  duplicatesInFile?: number;
  existing?: number;
  newRows?: number;
  created?: number;
  updated?: number;
  merged?: number;
  skipped?: number;
  failed?: number;
  issuesSample?: ImportIssue[];
  error?: string;
  /** On a FAILED import: whether it stopped while checking the file or while importing. */
  failedIn?: 'check' | 'run';
}

export interface ImportJob {
  id: string;
  status: string;
  filename: string;
  headers: string[];
  rowCount: number;
  sample: string[][];
  suggested: Record<string, number>;
  options: {
    mapping: Record<string, number | null>;
    defaultSourceId: string;
    duplicateMode: DuplicateMode;
    roundRobin: boolean;
  } | null;
  result: ImportResult;
  errorReportUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ImportListItem {
  id: string;
  status: string;
  filename: string;
  rowCount: number;
  result: ImportResult;
  createdAt: string;
  finishedAt: string | null;
  requestedBy: string;
}

/** Statuses the server is still working on; the screens poll while one of these shows. */
export const WORKING_STATUSES = ['VALIDATING', 'QUEUED', 'RUNNING'];

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Needs columns', tone: 'neutral' },
  VALIDATING: { label: 'Checking', tone: 'info' },
  VALIDATED: { label: 'Ready to review', tone: 'primary' },
  QUEUED: { label: 'Starting', tone: 'info' },
  RUNNING: { label: 'Importing', tone: 'info' },
  DONE: { label: 'Finished', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  CANCELED: { label: 'Canceled', tone: 'neutral' },
};
