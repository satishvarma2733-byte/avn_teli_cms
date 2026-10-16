'use client';

import type { DuplicateMode } from '@avn-cms/core/schemas';
import { Download } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card, CardHeader } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

import { Figure } from '../figure';
import type { ImportJob } from '../types';

const MODES: { id: DuplicateMode; label: string; help: string }[] = [
  {
    id: 'skip',
    label: 'Skip them',
    help: 'Leave their records as they are. The safe choice for a first import.',
  },
  {
    id: 'update',
    label: 'Update them',
    help: 'Replace their details with the values in your file. Stages from the file are applied.',
  },
  {
    id: 'merge',
    label: 'Fill in the gaps',
    help: 'Fill in only the details that are empty today. Stages stay as they are.',
  },
];

/** Step 3: what the check found. Step 4 starts from here. */
export function ReviewPanel({
  job,
  onChange,
  onStart,
  onCancel,
  onDownloadReport,
}: {
  job: ImportJob;
  onChange: () => void;
  onStart: (mode: DuplicateMode) => Promise<void>;
  onCancel: () => void;
  onDownloadReport: () => void;
}) {
  const [mode, setMode] = useState<DuplicateMode>('skip');
  const [busy, setBusy] = useState(false);
  const r = job.result;
  const invalid = r.invalid ?? 0;
  const ready = r.valid ?? 0;
  const issues = [...(r.issuesSample ?? [])]
    .sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))
    .slice(0, 15);

  async function start() {
    setBusy(true);
    await onStart(mode);
    setBusy(false);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Check results" description="Nothing has been saved yet." />
        <dl aria-label="Check summary" className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="Rows in file" value={r.total} />
          <Figure label="Ready to import" value={r.valid} />
          <Figure label="New students" value={r.newRows} />
          <Figure label="Already in aVn CMS" value={r.existing} />
          <Figure label="Need fixing" value={r.invalid} />
          <Figure label="Repeated mobile numbers" value={r.duplicatesInFile} />
        </dl>
      </Card>

      {invalid > 0 && (
        <Alert
          tone="warning"
          title={`${invalid.toLocaleString('en-IN')} ${invalid === 1 ? 'row has' : 'rows have'} a problem and will be skipped`}
        >
          <p>Fix them in your file and upload it again, or import the rest now.</p>
          <button
            type="button"
            onClick={onDownloadReport}
            className="mt-2 inline-flex items-center gap-1.5 font-medium underline underline-offset-4"
          >
            <Download className="size-4" aria-hidden />
            Download the problem report (CSV)
          </button>
        </Alert>
      )}

      {issues.length > 0 && (
        <Card>
          <CardHeader
            title="Problems"
            description="Up to 15 are shown. The problem report lists every row."
          />
          <ul className="divide-y divide-border">
            {issues.map((issue, n) => (
              <li key={`${issue.line}-${issue.field}-${n}`} className="flex gap-4 px-5 py-3 text-sm">
                <span className="w-16 shrink-0 text-muted-foreground tabular-nums">Line {issue.line}</span>
                <span className={issue.severity === 'error' ? 'text-danger' : 'text-foreground'}>
                  {issue.severity === 'error' ? 'Skipped. ' : 'Warning. '}
                  {issue.message}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title="Students already in aVn CMS" description="Matched by mobile number." />
        <fieldset className="space-y-3 p-5">
          <legend className="sr-only">When a student is already in aVn CMS</legend>
          {MODES.map((m) => (
            <label
              key={m.id}
              className={cn(
                'flex cursor-pointer gap-3 rounded-lg border p-3',
                mode === m.id ? 'border-primary bg-primary-soft' : 'border-border',
              )}
            >
              <input
                type="radio"
                name="duplicate-mode"
                value={m.id}
                checked={mode === m.id}
                onChange={() => setMode(m.id)}
                className="mt-1 size-4 accent-[var(--primary)]"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">{m.label}</span>
                <span className="block text-sm text-muted-foreground">{m.help}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </Card>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onChange}>
            Change columns
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel import
          </Button>
        </div>
        <div className="flex flex-col items-stretch gap-1 sm:items-end">
          <Button loading={busy} disabled={ready === 0} onClick={() => void start()}>
            Start import
          </Button>
          {ready === 0 && (
            <p className="text-xs text-muted-foreground">
              Nothing is ready to import yet. Change the columns or fix the file.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
