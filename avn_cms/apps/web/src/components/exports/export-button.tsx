'use client';

import type { ExportFormat } from '@avn-cms/core/schemas';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/client';

import { ENTITY_LABEL, EXPORT_WORKING, FORMAT_LABEL, type ExportJob } from './types';

const FORMATS: { id: ExportFormat; label: string; help: string }[] = [
  { id: 'csv', label: 'CSV', help: 'Opens in Excel, Google Sheets or any spreadsheet app.' },
  { id: 'xlsx', label: 'Excel (.xlsx)', help: 'A formatted spreadsheet.' },
  { id: 'pdf', label: 'PDF', help: 'A printable list, up to 5,000 rows.' },
];

/**
 * Exports what the screen shows. The filters come from the URL, so the file matches the list in
 * front of the user; the server applies the same role limits the list does.
 */
export function ExportButton({
  entity,
  keys,
  defaults,
  label = 'Export',
}: {
  entity: ExportJob['entity'];
  keys: readonly string[];
  defaults?: Record<string, string>;
  label?: string;
}) {
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const filters = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const value = params.has(k) ? (params.get(k) ?? '') : (defaults?.[k] ?? '');
      if (value) out[k] = value;
    }
    return out;
  }, [keys, defaults, params]);

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Download /> {label}
      </Button>
      <ExportDialog open={open} onOpenChange={setOpen} entity={entity} filters={filters} />
    </>
  );
}

function ExportDialog({
  open,
  onOpenChange,
  entity,
  filters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: ExportJob['entity'];
  filters: Record<string, string>;
}) {
  const api = useApi();
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [job, setJob] = useState<ExportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the file while the server is still writing it.
  useEffect(() => {
    if (!job || !EXPORT_WORKING.includes(job.status)) return;
    const timer = setTimeout(() => {
      void api<ExportJob>(`/api/exports/${job.id}`).then((res) => {
        if (res.ok) setJob(res.data);
        else setError(res.error.message);
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [job, api]);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await api<ExportJob>('/api/exports', { body: { entity, format, filters } });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setJob(res.data);
  }

  /** Signed links last 15 minutes, so ask for a fresh one at the moment of download. */
  async function download() {
    if (!job) return;
    setBusy(true);
    const res = await api<ExportJob>(`/api/exports/${job.id}`);
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    if (!res.data.downloadUrl) return setError('This file has expired. Prepare it again.');
    window.location.assign(res.data.downloadUrl);
  }

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setJob(null);
      setError(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={`Export ${ENTITY_LABEL[entity].toLowerCase()}`}
      description="Uses the filters on this page. Telecallers get fewer columns."
      footer={
        job ? (
          <>
            <Link href="/app/exports" className={buttonVariants({ variant: 'ghost' })}>
              All exports
            </Link>
            <Button variant="secondary" onClick={() => close(false)}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void submit()}>
              Prepare export
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {job ? (
          <ExportStatus job={job} busy={busy} onDownload={() => void download()} />
        ) : (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium text-foreground">File format</legend>
            {FORMATS.map((f) => (
              <label
                key={f.id}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg border p-3',
                  format === f.id ? 'border-primary bg-primary-soft' : 'border-border',
                )}
              >
                <input
                  type="radio"
                  name="export-format"
                  value={f.id}
                  checked={format === f.id}
                  onChange={() => setFormat(f.id)}
                  className="mt-1 size-4 accent-[var(--primary)]"
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">{f.label}</span>
                  <span className="block text-sm text-muted-foreground">{f.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

function ExportStatus({ job, busy, onDownload }: { job: ExportJob; busy: boolean; onDownload: () => void }) {
  if (EXPORT_WORKING.includes(job.status)) {
    return (
      <Alert tone="info" title="Preparing your file…">
        You can close this window. The file will appear under Exports when it’s ready.
      </Alert>
    );
  }
  if (job.status === 'DONE') {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Your file is ready">
          {(job.rows ?? 0).toLocaleString('en-IN')} rows · {job.filename}
        </Alert>
        <Button loading={busy} onClick={onDownload}>
          <Download /> Download {FORMAT_LABEL[job.format]}
        </Button>
      </div>
    );
  }
  return (
    <Alert tone="danger" title="The export didn’t finish">
      {job.error ?? 'Try again.'}
    </Alert>
  );
}
