'use client';

import type { DuplicateMode } from '@avn-cms/core/schemas';
import { Download, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Alert, Card, CardHeader, Skeleton } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { cn } from '@/lib/cn';

import { Figure } from '../figure';
import { WORKING_STATUSES, type ImportJob } from '../types';
import { MappingForm } from './mapping-form';
import { ReviewPanel } from './review-panel';

/** The screen shown for a job: map columns, check, review, import, or finished. */
type Stage = 'map' | 'check' | 'review' | 'run' | 'done';

const STEPS = ['Upload', 'Map columns', 'Check', 'Import'];
/** 1-based step number; 5 means every step is complete. */
const CURRENT_STEP: Record<Stage, number> = { map: 2, check: 3, review: 3, run: 4, done: 5 };

function stageOf(job: ImportJob, changing: boolean): Stage {
  switch (job.status) {
    case 'DRAFT':
    case 'FAILED':
      return 'map';
    case 'VALIDATING':
      return 'check';
    case 'VALIDATED':
      return changing ? 'map' : 'review';
    case 'QUEUED':
    case 'RUNNING':
      return 'run';
    default:
      return 'done';
  }
}

export function ImportWizard({ id }: { id: string }) {
  const api = useApi();
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [changing, setChanging] = useState(false);

  const refresh = useCallback(async (): Promise<ImportJob | null> => {
    const res = await api<ImportJob>(`/api/imports/${id}`);
    if (!res.ok) {
      if (res.status === 404) setMissing(true);
      else setError(res.error.message);
      return null;
    }
    setError(null);
    setJob(res.data);
    return res.data;
  }, [api, id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The server works in the background; keep this page in step while it does.
  useEffect(() => {
    if (!job || !WORKING_STATUSES.includes(job.status)) return;
    const timer = setTimeout(() => void refresh(), 1000);
    return () => clearTimeout(timer);
  }, [job, refresh]);

  async function start(duplicateMode: DuplicateMode) {
    const res = await api(`/api/imports/${id}/run`, { body: { duplicateMode } });
    if (!res.ok) return setError(res.error.message);
    await refresh();
  }

  async function cancel() {
    const res = await api(`/api/imports/${id}`, { method: 'DELETE' });
    if (!res.ok) return setError(res.error.message);
    await refresh();
  }

  /** Signed links last 15 minutes, so ask for a fresh one at the moment of download. */
  async function downloadReport() {
    const fresh = await refresh();
    if (fresh?.errorReportUrl) window.location.assign(fresh.errorReportUrl);
  }

  if (missing) {
    return (
      <Alert tone="danger" title="We couldn’t find this import">
        It may have been removed.{' '}
        <Link href="/app/imports" className="font-medium underline">
          Back to imports
        </Link>
      </Alert>
    );
  }
  if (!job) {
    return error ? <Alert tone="danger">{error}</Alert> : <Skeleton className="h-64 w-full" />;
  }

  const stage = stageOf(job, changing);
  return (
    <div className="space-y-6">
      <Steps current={CURRENT_STEP[stage]} />
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{job.filename}</span> ·{' '}
        {job.rowCount.toLocaleString('en-IN')} rows
      </p>
      {error && (
        <Alert tone="danger" title="That didn’t work">
          {error}
        </Alert>
      )}
      {stage === 'map' && (
        <MappingForm
          job={job}
          onCancel={cancel}
          onSubmitted={() => {
            setChanging(false);
            void refresh();
          }}
        />
      )}
      {stage === 'check' && <Working title="Checking every row…" text="Nothing has been saved yet." />}
      {stage === 'review' && (
        <ReviewPanel
          job={job}
          onChange={() => setChanging(true)}
          onStart={start}
          onCancel={cancel}
          onDownloadReport={() => void downloadReport()}
        />
      )}
      {stage === 'run' && <RunProgress job={job} />}
      {stage === 'done' && <Finished job={job} onDownloadReport={() => void downloadReport()} />}
    </div>
  );
}

function Steps({ current }: { current: number }) {
  return (
    <ol aria-label="Import steps" className="flex flex-wrap gap-2 text-sm">
      {STEPS.map((label, i) => {
        const n = i + 1;
        return (
          <li
            key={label}
            aria-current={n === current ? 'step' : undefined}
            className={cn(
              'rounded-full border px-3 py-1',
              n === current
                ? 'border-primary bg-primary-soft font-medium text-primary'
                : n < current
                  ? 'border-border text-foreground'
                  : 'border-border text-muted-foreground',
            )}
          >
            {n}. {label}
          </li>
        );
      })}
    </ol>
  );
}

function Working({ title, text }: { title: string; text: string }) {
  return (
    <Card>
      <CardHeader title={title} description={text} />
      <div role="status" className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Working on it…
      </div>
    </Card>
  );
}

function RunProgress({ job }: { job: ImportJob }) {
  const r = job.result;
  const running = job.status === 'RUNNING' && r.processed !== undefined;
  const total = r.total ?? job.rowCount;
  const done = running ? (r.processed ?? 0) : 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <Card>
      <CardHeader
        title={job.status === 'QUEUED' ? 'Starting the import…' : 'Importing students'}
        description="You can leave this page. The import keeps running, and the results will be here when you come back."
      />
      <div className="space-y-3 p-5">
        <div
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-sm text-muted-foreground tabular-nums">
          {done.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} rows processed
        </p>
      </div>
    </Card>
  );
}

function Finished({ job, onDownloadReport }: { job: ImportJob; onDownloadReport: () => void }) {
  if (job.status === 'CANCELED') {
    return (
      <Card>
        <CardHeader
          title="Import canceled"
          description="Nothing was saved."
          actions={
            <Link href="/app/imports/new" className={buttonVariants({ variant: 'secondary' })}>
              New import
            </Link>
          }
        />
      </Card>
    );
  }
  const r = job.result;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Import finished"
          description={`${(r.created ?? 0).toLocaleString('en-IN')} new students were added.`}
        />
        <dl aria-label="Import summary" className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-5">
          <Figure label="Created" value={r.created} />
          <Figure label="Updated" value={r.updated} />
          <Figure label="Merged" value={r.merged} />
          <Figure label="Skipped" value={r.skipped} />
          <Figure label="Failed" value={r.failed} />
        </dl>
      </Card>
      <div className="flex flex-wrap gap-2">
        <Link href="/app/leads" className={buttonVariants()}>
          View leads
        </Link>
        {job.errorReportUrl && (
          <Button variant="secondary" onClick={onDownloadReport}>
            <Download /> Download problem list
          </Button>
        )}
        <Link href="/app/imports/new" className={buttonVariants({ variant: 'ghost' })}>
          Import another file
        </Link>
      </div>
    </div>
  );
}
