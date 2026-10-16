import type { StudentDocStatus, StudentDocType } from '@avn-cms/core/schemas';

/** A document as the API returns it (dates arrive as strings). Mirrors `DocumentView` in core. */
export type DocState = 'uploading' | 'checking' | 'ready' | 'blocked' | 'rejected';

export interface DocView {
  id: string;
  seriesId: string;
  folderId: string | null;
  studentId: string | null;
  docType: StudentDocType | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  state: DocState;
  available: boolean;
  problem: string | null;
  uploadedAt: string | null;
  createdAt: string;
  uploadedBy: string | null;
  versionCount?: number;
}

export interface ChecklistItem {
  docType: StudentDocType;
  label: string;
  status: StudentDocStatus;
  note: string | null;
  reviewedBy: string | null;
  updatedAt: string | null;
  document: DocView | null;
  versionCount: number;
}

export interface Checklist {
  studentId: string;
  items: ChecklistItem[];
  others: DocView[];
}

export interface FolderView {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  folderCount: number;
  documentCount: number;
}

/** A file whose virus scan did not finish. Mirrors `listStuckScans` in core (dates as strings). */
export interface StuckScan {
  id: string;
  filename: string;
  sizeBytes: number;
  version: number;
  attempts: number;
  /** The worker has given up retrying; only "Scan again" will make it try. */
  exhausted: boolean;
  error: string | null;
  lastAttemptAt: string | null;
  uploadedAt: string | null;
  uploadedBy: string | null;
  student: { id: string; name: string; leadId: string | null } | null;
  folder: { id: string; name: string } | null;
}

/** True while the server is still uploading or scanning a file, so screens keep refreshing. */
export const isWorking = (d: Pick<DocView, 'state'> | null | undefined) =>
  d?.state === 'uploading' || d?.state === 'checking';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
