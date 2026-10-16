'use client';

import type { StudentDocStatus } from '@avn-cms/core/schemas';
import { Check, Download, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, CardHeader, Skeleton, type Tone } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatDateTime } from '@/lib/format';

import { DocStateBadge } from './doc-state';
import { FilePicker } from './file-picker';
import { formatBytes, isWorking, type Checklist, type ChecklistItem, type DocView } from './types';
import { DocumentError, useDocumentDownload, useDocumentUpload } from './use-documents';

const STATUS: Record<StudentDocStatus, { label: string; tone: Tone }> = {
  MISSING: { label: 'Missing', tone: 'neutral' },
  UPLOADED: { label: 'Uploaded', tone: 'info' },
  VERIFIED: { label: 'Verified', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
};

type Progress = { percent: number; error?: string };

/**
 * A student's document checklist (passport, marks memo, NEET result …) and their other files.
 * Uploads go straight to storage and are scanned before anyone can download them; a counselor sees
 * this only for their own leads.
 */
export function StudentDocuments({ studentId, canReview }: { studentId: string; canReview: boolean }) {
  const api = useApi();
  const upload = useDocumentUpload();
  const download = useDocumentDownload();
  const [data, setData] = useState<Checklist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [rejecting, setRejecting] = useState<ChecklistItem | null>(null);
  const [removing, setRemoving] = useState<DocView | null>(null);

  const load = useCallback(async () => {
    const res = await api<Checklist>(`/api/students/${studentId}/documents`);
    if (!res.ok) return setError(res.error.message);
    setError(null);
    setData(res.data);
  }, [api, studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A file being scanned finishes on its own; keep the list in step until it does.
  const working = data
    ? data.items.some((i) => isWorking(i.document)) || data.others.some((d) => isWorking(d))
    : false;
  useEffect(() => {
    if (!working) return;
    const timer = setTimeout(() => void load(), 1500);
    return () => clearTimeout(timer);
  }, [working, load, data]);

  async function send(key: string, file: File, docType?: string) {
    setNotice(null);
    setProgress((p) => ({ ...p, [key]: { percent: 0 } }));
    try {
      await upload(file, { studentId, ...(docType ? { docType } : {}) }, (percent) =>
        setProgress((p) => ({ ...p, [key]: { percent } })),
      );
      setProgress((p) => {
        const { [key]: _done, ...rest } = p;
        return rest;
      });
      await load();
    } catch (err) {
      const message = err instanceof DocumentError ? err.message : 'The upload failed. Try again.';
      setProgress((p) => ({ ...p, [key]: { percent: 0, error: message } }));
    }
  }

  async function open(doc: DocView) {
    try {
      await download(doc.id);
    } catch (err) {
      setError(err instanceof DocumentError ? err.message : 'The download failed.');
    }
  }

  async function review(item: ChecklistItem, status: 'VERIFIED' | 'REJECTED' | 'UPLOADED', note?: string) {
    const res = await api(`/api/students/${studentId}/documents/${item.docType}`, {
      method: 'PATCH',
      body: { status, ...(note ? { note } : {}) },
    });
    if (!res.ok) return setError(res.error.message);
    setNotice(
      `${item.label} ${status === 'VERIFIED' ? 'verified' : status === 'REJECTED' ? 'rejected' : 'set back to uploaded'}.`,
    );
    await load();
  }

  async function remove(doc: DocView) {
    const res = await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
    setRemoving(null);
    if (!res.ok) return setError(res.error.message);
    setNotice('Document removed.');
    await load();
  }

  if (error && !data) return <Alert tone="danger">{error}</Alert>;
  if (!data) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      <Card>
        <CardHeader
          title="Document checklist"
          description="Every file is checked for viruses before it can be downloaded."
        />
        <ul className="divide-y divide-border">
          {data.items.map((item) => {
            const doc = item.document;
            const status = STATUS[item.status];
            const p = progress[item.docType];
            return (
              <li key={item.docType} className="space-y-2 px-5 py-4" data-testid={`doc-${item.docType}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-foreground">{item.label}</h3>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {doc?.available && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void open(doc)}
                        aria-label={`Download ${item.label}`}
                      >
                        <Download /> Download
                      </Button>
                    )}
                    {canReview && doc?.available && item.status !== 'VERIFIED' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void review(item, 'VERIFIED')}
                        aria-label={`Verify ${item.label}`}
                      >
                        <Check /> Verify
                      </Button>
                    )}
                    {canReview && doc && item.status !== 'REJECTED' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRejecting(item)}
                        aria-label={`Reject ${item.label}`}
                      >
                        <X /> Reject
                      </Button>
                    )}
                    <FilePicker
                      label={doc ? 'Replace' : 'Upload'}
                      ariaLabel={`${doc ? 'Replace' : 'Upload'} ${item.label}`}
                      busy={Boolean(p && !p.error)}
                      onPick={(file) => void send(item.docType, file, item.docType)}
                    />
                    {doc && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRemoving(doc)}
                        aria-label={`Remove ${item.label}`}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </div>

                {doc && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{doc.filename}</span>
                    <span>
                      {formatBytes(doc.sizeBytes)} · version {doc.version}
                      {item.versionCount > 1 ? ` of ${item.versionCount}` : ''}
                      {doc.uploadedBy ? ` · ${doc.uploadedBy}` : ''} ·{' '}
                      {formatDateTime(doc.uploadedAt ?? doc.createdAt)}
                    </span>
                    <DocStateBadge doc={doc} />
                  </p>
                )}
                {doc?.problem && <p className="text-sm text-danger">{doc.problem}</p>}
                {item.note && (
                  <p className="text-sm text-muted-foreground">
                    {item.reviewedBy ? `${item.reviewedBy}: ` : ''}
                    {item.note}
                  </p>
                )}
                {p && (
                  <div role="status" className="text-sm">
                    {p.error ? (
                      <span className="text-danger">{p.error}</span>
                    ) : (
                      <span className="text-muted-foreground">Uploading… {p.percent}%</span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Other documents"
          actions={
            <FilePicker
              label="Upload"
              ariaLabel="Upload other document"
              busy={Boolean(progress['OTHER'] && !progress['OTHER'].error)}
              onPick={(file) => void send('OTHER', file)}
            />
          }
        />
        {progress['OTHER'] && (
          <div role="status" className="px-5 py-3 text-sm">
            {progress['OTHER'].error ? (
              <span className="text-danger">{progress['OTHER'].error}</span>
            ) : (
              <span className="text-muted-foreground">Uploading… {progress['OTHER'].percent}%</span>
            )}
          </div>
        )}
        {data.others.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            Files that don’t belong on the checklist go here.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {data.others.map((doc) => (
              <li
                key={doc.id}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm"
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-foreground">{doc.filename}</span>
                  <span className="text-muted-foreground">
                    {formatBytes(doc.sizeBytes)} · {formatDateTime(doc.uploadedAt ?? doc.createdAt)}
                  </span>
                  <DocStateBadge doc={doc} />
                </span>
                <span className="flex gap-2">
                  {doc.available && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void open(doc)}
                      aria-label={`Download ${doc.filename}`}
                    >
                      <Download /> Download
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemoving(doc)}
                    aria-label={`Remove ${doc.filename}`}
                  >
                    <Trash2 />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <RejectDialog
        item={rejecting}
        onClose={() => setRejecting(null)}
        onReject={async (note) => {
          if (rejecting) await review(rejecting, 'REJECTED', note);
          setRejecting(null);
        }}
      />
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this document?"
        description={
          removing
            ? `${removing.filename} and all its earlier versions will leave this student’s record.`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              Remove
            </Button>
          </>
        }
      />
    </div>
  );
}

function RejectDialog({
  item,
  onClose,
  onReject,
}: {
  item: ChecklistItem | null;
  onClose: () => void;
  onReject: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) {
          setNote('');
          onClose();
        }
      }}
      title={item ? `Reject ${item.label}` : 'Reject'}
      description="The student will be asked for a new copy. Say what was wrong."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={note.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              await onReject(note.trim());
              setBusy(false);
              setNote('');
            }}
          >
            Reject file
          </Button>
        </>
      }
    >
      <Field id="reject-note" label="Reason" required>
        <Textarea id="reject-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
    </Dialog>
  );
}
