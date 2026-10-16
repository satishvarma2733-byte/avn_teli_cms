'use client';

import { IMPORT_FIELDS } from '@avn-cms/core/import-fields';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Alert, Card, CardHeader } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { useDirectory } from '@/lib/use-directory';

import type { ImportJob } from '../types';

/** Step 2: match each field to a column, then run the check (nothing is saved by it). */
export function MappingForm({
  job,
  onSubmitted,
  onCancel,
}: {
  job: ImportJob;
  onSubmitted: () => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const sources = useDirectory('sources');
  // Remember what the admin chose last time (after a failed check or "Change columns").
  const initial: Record<string, number | null | undefined> = job.options?.mapping ?? job.suggested;
  const [columns, setColumns] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      IMPORT_FIELDS.map((f) => {
        const col = initial[f.key];
        return [f.key, col === undefined || col === null ? '' : String(col)];
      }),
    ),
  );
  const [sourceId, setSourceId] = useState(job.options?.defaultSourceId ?? '');
  const [roundRobin, setRoundRobin] = useState(job.options?.roundRobin ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setColumn(key: string, value: string) {
    setColumns((c) => ({ ...c, [key]: value }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (columns['name'] === '') found['name'] = 'Choose the column with the student’s name.';
    if (columns['phone'] === '') found['phone'] = 'Choose the column with the mobile number.';
    if (!sourceId) found['defaultSourceId'] = 'Choose a source.';
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setError('Fill in the highlighted fields.');
      return;
    }
    setBusy(true);
    setErrors({});
    setError(null);
    const mapping = Object.fromEntries(
      IMPORT_FIELDS.map((f) => {
        const col = columns[f.key];
        return [f.key, col === undefined || col === '' ? null : Number(col)];
      }),
    );
    const res = await api(`/api/imports/${job.id}/validate`, {
      body: { mapping, defaultSourceId: sourceId, duplicateMode: 'skip', roundRobin },
    });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.error.details?.fields ?? {});
      setError(res.error.message);
      return;
    }
    onSubmitted();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      {job.status === 'FAILED' && job.result.error && (
        <Alert tone="danger" title="The last check didn’t finish">
          {job.result.error}
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader title="What’s in your file" description="The first few rows, as we read them." />
        <div className="overflow-x-auto p-5">
          <table className="w-full min-w-max text-left text-sm">
            <caption className="sr-only">First rows of the uploaded file</caption>
            <thead>
              <tr className="border-b border-border">
                {job.headers.map((h, i) => (
                  <th key={i} scope="col" className="px-2 py-1.5 font-medium text-foreground">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {job.sample.map((row, r) => (
                <tr key={r} className="border-b border-border last:border-0">
                  {job.headers.map((_, c) => (
                    <td key={c} className="max-w-48 truncate px-2 py-1.5 text-muted-foreground">
                      {row[c] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Map columns to fields"
          description="We matched the columns we recognise. Check each one."
        />
        <div className="grid gap-x-6 gap-y-5 p-5 sm:grid-cols-2">
          {IMPORT_FIELDS.map((f) => {
            const id = `map-${f.key}`;
            const col = columns[f.key] ?? '';
            const example = col === '' ? undefined : job.sample[0]?.[Number(col)];
            const hint =
              col === ''
                ? 'Not imported'
                : example
                  ? `Example: ${example}`
                  : 'The first row is empty in this column';
            return (
              <Field
                key={f.key}
                id={id}
                label={f.label}
                required={f.required}
                error={errors[f.key]}
                hint={hint}
              >
                <Select
                  id={id}
                  value={col}
                  onChange={(e) => setColumn(f.key, e.target.value)}
                  aria-invalid={errors[f.key] ? true : undefined}
                >
                  <option value="">Don’t import</option>
                  {job.headers.map((h, i) => (
                    <option key={i} value={String(i)}>
                      {`Column ${i + 1}: ${h}`}
                    </option>
                  ))}
                </Select>
              </Field>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader title="Options" />
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <Field
            id="import-source"
            label="Default source"
            required
            error={errors['defaultSourceId']}
            hint="Used for rows that don’t name a source."
          >
            <Select
              id="import-source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              aria-invalid={errors['defaultSourceId'] ? true : undefined}
            >
              <option value="">Choose a source</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label ?? s.name ?? s.code}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-start gap-3 sm:pt-6">
            <input
              id="import-round-robin"
              type="checkbox"
              checked={roundRobin}
              onChange={(e) => setRoundRobin(e.target.checked)}
              className="mt-1 size-4 accent-[var(--primary)]"
            />
            <label htmlFor="import-round-robin" className="text-sm font-medium text-foreground">
              Share students without a counselor between counselors in turn
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                Only rows with no counselor in the file are shared.
              </span>
            </label>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onCancel}>
          Cancel import
        </Button>
        <Button type="submit" loading={busy}>
          Check file
        </Button>
      </div>
    </form>
  );
}
