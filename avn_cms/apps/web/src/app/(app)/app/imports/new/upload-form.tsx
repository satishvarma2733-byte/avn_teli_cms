'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Alert, Card } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';

export function UploadForm() {
  const api = useApi();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return setError('Choose a file first.');
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.append('file', file);
    const res = await api<{ id: string }>('/api/imports', { body });
    if (!res.ok) {
      setBusy(false);
      return setError(res.error.message);
    }
    router.push(`/app/imports/${res.data.id}`);
  }

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate className="space-y-5 p-5">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field
          id="import-file"
          label="Spreadsheet file"
          hint="CSV or Excel (.xlsx). Up to 20 MB and 100,000 rows."
        >
          <input
            id="import-file"
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-foreground file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface-muted file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-border"
          />
        </Field>
        {file && (
          <p className="text-sm text-muted-foreground">
            {file.name} · {(file.size / 1024).toFixed(0)} KB
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" loading={busy} disabled={!file}>
            Upload and continue
          </Button>
        </div>
      </form>
    </Card>
  );
}
