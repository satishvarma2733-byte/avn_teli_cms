'use client';

import { Download, FileDown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Badge, Alert, Card, EmptyState, Skeleton, type Tone } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatDateTime } from '@/lib/format';
import { ENTITY_LABEL, EXPORT_WORKING, FORMAT_LABEL, type ExportJob } from '@/components/exports/types';

function statusOf(job: ExportJob): { label: string; tone: Tone } {
  if (job.status === 'DONE') {
    return job.expired || !job.downloadUrl
      ? { label: 'Expired', tone: 'neutral' }
      : { label: 'Ready', tone: 'success' };
  }
  if (EXPORT_WORKING.includes(job.status)) return { label: 'Preparing', tone: 'info' };
  if (job.status === 'FAILED') return { label: 'Failed', tone: 'danger' };
  return { label: job.status, tone: 'neutral' };
}

export function ExportsList() {
  const api = useApi();
  const [items, setItems] = useState<ExportJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<ExportJob[]>('/api/exports');
    if (!res.ok) return setError(res.error.message);
    setError(null);
    setItems(res.data);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep checking while any file is still being written.
  const working = items?.some((job) => EXPORT_WORKING.includes(job.status)) ?? false;
  useEffect(() => {
    if (!working) return;
    const timer = setTimeout(() => void load(), 2000);
    return () => clearTimeout(timer);
  }, [working, load, items]);

  /** Signed links last 15 minutes, so ask for a fresh one at the moment of download. */
  async function download(job: ExportJob) {
    setBusyId(job.id);
    const res = await api<ExportJob>(`/api/exports/${job.id}`);
    setBusyId(null);
    if (!res.ok) return setError(res.error.message);
    if (!res.data.downloadUrl) {
      void load();
      return;
    }
    window.location.assign(res.data.downloadUrl);
  }

  if (error)
    return (
      <Alert tone="danger" title="Couldn’t load exports">
        {error}
      </Alert>
    );
  if (!items) return <Skeleton className="h-40 w-full" />;
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<FileDown />}
          title="No exports yet"
          description="Use Export on the Leads or Web leads page to make a file."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Your exports, newest first</caption>
          <thead className="bg-surface text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <tr className="border-b border-border">
              <th scope="col" className="px-4 py-2.5">
                File
              </th>
              <th scope="col" className="px-4 py-2.5">
                Type
              </th>
              <th scope="col" className="px-4 py-2.5">
                Rows
              </th>
              <th scope="col" className="px-4 py-2.5">
                Status
              </th>
              <th scope="col" className="px-4 py-2.5">
                Requested
              </th>
              <th scope="col" className="px-4 py-2.5">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((job) => {
              const status = statusOf(job);
              return (
                <tr key={job.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium text-foreground">{job.filename ?? 'Preparing…'}</td>
                  <td className="whitespace-nowrap px-4 py-3">{`${ENTITY_LABEL[job.entity]} · ${FORMAT_LABEL[job.format]}`}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {job.rows === null ? '—' : job.rows.toLocaleString('en-IN')}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {formatDateTime(job.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {job.status === 'DONE' && !job.expired && job.downloadUrl ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyId === job.id}
                        aria-label={`Download ${job.filename ?? 'export'}`}
                        onClick={() => void download(job)}
                      >
                        <Download /> Download
                      </Button>
                    ) : job.status === 'FAILED' ? (
                      <span className="text-xs text-danger">{job.error}</span>
                    ) : job.status === 'DONE' ? (
                      <span className="text-xs text-muted-foreground">Expired. Export again.</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
