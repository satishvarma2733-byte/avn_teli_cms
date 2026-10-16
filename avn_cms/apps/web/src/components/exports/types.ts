import type { ExportFormat } from '@avn-cms/core/schemas';

/** An export as the API returns it (dates arrive as strings). Mirrors `ExportView` in core. */
export interface ExportJob {
  id: string;
  entity: 'leads' | 'web_leads';
  format: ExportFormat;
  status: string;
  rows: number | null;
  filename: string | null;
  sizeBytes: number | null;
  error: string | null;
  downloadUrl: string | null;
  expired: boolean;
  createdAt: string;
  finishedAt: string | null;
}

/** Statuses the server is still writing the file for; screens poll while one of these shows. */
export const EXPORT_WORKING = ['QUEUED', 'RUNNING'];

export const ENTITY_LABEL: Record<ExportJob['entity'], string> = {
  leads: 'Leads',
  web_leads: 'Web leads',
};

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: 'CSV',
  xlsx: 'Excel',
  pdf: 'PDF',
};
