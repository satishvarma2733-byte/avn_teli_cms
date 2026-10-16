'use client';

import { Download, Folder, FolderPlus, Pencil, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { DocStateBadge } from '@/components/documents/doc-state';
import { FilePicker } from '@/components/documents/file-picker';
import {
  formatBytes,
  isWorking,
  type DocView,
  type FolderView,
  type StuckScan,
} from '@/components/documents/types';
import { DocumentError, useDocumentDownload, useDocumentUpload } from '@/components/documents/use-documents';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatDate } from '@/lib/format';

import { StuckScansCard } from './stuck-scans';

interface Listing {
  breadcrumb: { id: string; name: string }[];
  folders: FolderView[];
}

type Dialogs =
  | { kind: 'new-folder' }
  | { kind: 'rename-folder'; folder: FolderView }
  | { kind: 'delete-folder'; folder: FolderView }
  | { kind: 'delete-document'; doc: DocView };

/** The agency's own files, in folders. Admins only; students' files live on their leads. */
export function Vault() {
  const api = useApi();
  const upload = useDocumentUpload();
  const download = useDocumentDownload();
  const folderId = useSearchParams().get('folder') ?? undefined;
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [docs, setDocs] = useState<(DocView & { versionCount?: number })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [uploads, setUploads] = useState<Record<string, { percent: number; error?: string }>>({});

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    const searching = query.length > 0;
    if (!searching) {
      const folders = await api<Listing>(`/api/folders${folderId ? `?parentId=${folderId}` : ''}`);
      if (!folders.ok) return setError(folders.error.message);
      setListing(folders.data);
    } else {
      setListing({ breadcrumb: [], folders: [] });
    }
    const files = await api<{ documents: DocView[] }>(
      `/api/documents?${searching ? `q=${encodeURIComponent(query)}` : folderId ? `folderId=${folderId}` : ''}`,
    );
    if (!files.ok) return setError(files.error.message);
    setError(null);
    setDocs(files.data.documents);
  }, [api, folderId, query]);

  useEffect(() => {
    setListing(null);
    setDocs(null);
    void load();
  }, [load]);

  const working = docs?.some((d) => isWorking(d)) ?? false;
  useEffect(() => {
    if (!working) return;
    const timer = setTimeout(() => void load(), 1500);
    return () => clearTimeout(timer);
  }, [working, load, docs]);

  // Files whose virus scan did not finish: blocked until it does, so an admin needs to see them.
  const [stuck, setStuck] = useState<StuckScan[]>([]);
  const [maxAttempts, setMaxAttempts] = useState(5);
  const [rescanning, setRescanning] = useState<string | null>(null);

  const loadStuck = useCallback(async () => {
    const res = await api<{ stuck: StuckScan[]; maxAttempts: number }>('/api/documents/stuck');
    if (!res.ok) return;
    setStuck(res.data.stuck);
    setMaxAttempts(res.data.maxAttempts);
  }, [api]);

  useEffect(() => {
    void loadStuck();
  }, [loadStuck]);

  // While some file is waiting, keep checking: the worker may release it, or another try may work.
  useEffect(() => {
    if (stuck.length === 0) return;
    const timer = setTimeout(() => void loadStuck(), 5000);
    return () => clearTimeout(timer);
  }, [stuck, loadStuck]);

  // A file that got through now belongs in the list below.
  const stuckCount = stuck.length;
  const lastStuckCount = useRef(stuckCount);
  useEffect(() => {
    if (stuckCount < lastStuckCount.current) void load();
    lastStuckCount.current = stuckCount;
  }, [stuckCount, load]);

  async function rescan(item: StuckScan) {
    setRescanning(item.id);
    setNotice(null);
    const res = await api(`/api/documents/${item.id}/rescan`, { method: 'POST', body: {} });
    setRescanning(null);
    if (!res.ok) return setError(res.error.message);
    setNotice(`Checking ${item.filename} again.`);
    setTimeout(() => void loadStuck(), 1500);
  }

  async function send(file: File, replaces?: string) {
    const key = `${file.name}-${Date.now()}`;
    setNotice(null);
    setUploads((u) => ({ ...u, [key]: { percent: 0 } }));
    try {
      await upload(file, replaces ? { replaces } : { folderId: folderId ?? null }, (percent) =>
        setUploads((u) => ({ ...u, [key]: { percent } })),
      );
      setUploads(({ [key]: _done, ...rest }) => rest);
      await load();
    } catch (err) {
      const message = err instanceof DocumentError ? err.message : 'The upload failed. Try again.';
      setUploads((u) => ({ ...u, [key]: { percent: 0, error: `${file.name}: ${message}` } }));
    }
  }

  async function open(doc: DocView) {
    try {
      await download(doc.id);
    } catch (err) {
      setError(err instanceof DocumentError ? err.message : 'The download failed.');
    }
  }

  if (error && !listing)
    return (
      <Alert tone="danger" title="The vault isn’t available">
        {error}
      </Alert>
    );
  const searching = query.length > 0;

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      <StuckScansCard
        items={stuck}
        maxAttempts={maxAttempts}
        busyId={rescanning}
        onRescan={(item) => void rescan(item)}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Folder path">
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            <li>
              {listing?.breadcrumb.length || searching ? (
                <Link href="/app/documents" className="font-medium text-primary hover:underline">
                  All documents
                </Link>
              ) : (
                <span aria-current="page" className="font-medium text-foreground">
                  All documents
                </span>
              )}
            </li>
            {listing?.breadcrumb.map((crumb, i) => (
              <li key={crumb.id} className="flex items-center gap-1">
                <span aria-hidden className="text-muted-foreground">
                  /
                </span>
                {i === listing.breadcrumb.length - 1 && !searching ? (
                  <span aria-current="page" className="font-medium text-foreground">
                    {crumb.name}
                  </span>
                ) : (
                  <Link
                    href={`/app/documents?folder=${crumb.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {crumb.name}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              aria-label="Search files"
              placeholder="Search files"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48 pl-9"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: 'new-folder' })}>
            <FolderPlus /> New folder
          </Button>
          <FilePicker label="Upload file" onPick={(file) => void send(file)} variant="primary" />
        </div>
      </div>

      {Object.entries(uploads).map(([key, u]) => (
        <p
          key={key}
          role="status"
          className={u.error ? 'text-sm text-danger' : 'text-sm text-muted-foreground'}
        >
          {u.error ?? `Uploading… ${u.percent}%`}
        </p>
      ))}

      {!listing || !docs ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          {!searching && listing.folders.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Folders">
              {listing.folders.map((folder) => (
                <li key={folder.id}>
                  <Card className="flex items-center justify-between gap-2 p-3">
                    <Link
                      href={`/app/documents?folder=${folder.id}`}
                      className="flex min-w-0 items-center gap-3 font-medium text-foreground hover:text-primary"
                    >
                      <Folder className="size-5 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate">{folder.name}</span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {folder.folderCount} folder{folder.folderCount === 1 ? '' : 's'} ·{' '}
                          {folder.documentCount} file
                          {folder.documentCount === 1 ? '' : 's'}
                        </span>
                      </span>
                    </Link>
                    <span className="flex shrink-0">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Rename ${folder.name}`}
                        onClick={() => setDialog({ kind: 'rename-folder', folder })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${folder.name}`}
                        onClick={() => setDialog({ kind: 'delete-folder', folder })}
                      >
                        <Trash2 />
                      </Button>
                    </span>
                  </Card>
                </li>
              ))}
            </ul>
          )}

          <Card>
            {docs.length === 0 ? (
              <EmptyState
                icon={<Folder />}
                title={searching ? 'No files match' : 'No files here yet'}
                description={
                  searching ? 'Try a different search.' : 'Upload a file, or make a folder to organise them.'
                }
              />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <caption className="sr-only">Files</caption>
                  <thead className="text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    <tr className="border-b border-border">
                      <th scope="col" className="px-4 py-2.5">
                        File
                      </th>
                      <th scope="col" className="px-4 py-2.5">
                        Size
                      </th>
                      <th scope="col" className="px-4 py-2.5">
                        Added
                      </th>
                      <th scope="col" className="px-4 py-2.5">
                        Status
                      </th>
                      <th scope="col" className="px-4 py-2.5">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((doc) => (
                      <tr key={doc.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3">
                          <span className="font-medium text-foreground">{doc.filename}</span>
                          <Badge className="ml-2">v{doc.version}</Badge>
                          {doc.problem && <div className="text-xs text-danger">{doc.problem}</div>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">
                          {formatBytes(doc.sizeBytes)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {formatDate(doc.uploadedAt ?? doc.createdAt)}
                          {doc.uploadedBy ? ` · ${doc.uploadedBy}` : ''}
                        </td>
                        <td className="px-4 py-3">
                          <DocStateBadge doc={doc} />
                        </td>
                        <td className="px-4 py-3">
                          <span className="flex flex-wrap justify-end gap-2">
                            {doc.available && (
                              <Button
                                size="sm"
                                variant="secondary"
                                aria-label={`Download ${doc.filename}`}
                                onClick={() => void open(doc)}
                              >
                                <Download /> Download
                              </Button>
                            )}
                            <FilePicker
                              label="New version"
                              ariaLabel={`New version of ${doc.filename}`}
                              variant="ghost"
                              onPick={(file) => void send(file, doc.id)}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Delete ${doc.filename}`}
                              onClick={() => setDialog({ kind: 'delete-document', doc })}
                            >
                              <Trash2 />
                            </Button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <VaultDialogs
        dialog={dialog}
        folderId={folderId}
        onClose={() => setDialog(null)}
        onDone={async (message) => {
          setDialog(null);
          setNotice(message);
          await load();
        }}
        onError={setError}
      />
    </div>
  );
}

function VaultDialogs({
  dialog,
  folderId,
  onClose,
  onDone,
  onError,
}: {
  dialog: Dialogs | null;
  folderId: string | undefined;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const api = useApi();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Start each dialog with its own name (rename) or empty (new).
  useEffect(() => {
    setName(dialog?.kind === 'rename-folder' ? dialog.folder.name : '');
    setProblem(null);
  }, [dialog]);

  async function submit() {
    if (!dialog) return;
    setBusy(true);
    setProblem(null);
    let res;
    let message: string;
    if (dialog.kind === 'new-folder') {
      res = await api('/api/folders', { body: { name, parentId: folderId ?? null } });
      message = `Folder “${name.trim()}” created.`;
    } else if (dialog.kind === 'rename-folder') {
      res = await api(`/api/folders/${dialog.folder.id}`, { method: 'PATCH', body: { name } });
      message = 'Folder renamed.';
    } else if (dialog.kind === 'delete-folder') {
      res = await api(`/api/folders/${dialog.folder.id}`, { method: 'DELETE' });
      message = 'Folder deleted.';
    } else {
      res = await api(`/api/documents/${dialog.doc.id}`, { method: 'DELETE' });
      message = 'File deleted.';
    }
    setBusy(false);
    if (!res.ok) {
      // Naming problems stay in the dialog; a refusal to delete is shown on the page.
      if (dialog.kind === 'new-folder' || dialog.kind === 'rename-folder')
        return setProblem(res.error.message);
      onClose();
      return onError(res.error.message);
    }
    await onDone(message);
  }

  const naming = dialog?.kind === 'new-folder' || dialog?.kind === 'rename-folder';
  const title =
    dialog?.kind === 'new-folder'
      ? 'New folder'
      : dialog?.kind === 'rename-folder'
        ? 'Rename folder'
        : dialog?.kind === 'delete-folder'
          ? 'Delete this folder?'
          : 'Delete this file?';
  const description =
    dialog?.kind === 'delete-folder'
      ? `“${dialog.folder.name}” must be empty to be deleted.`
      : dialog?.kind === 'delete-document'
        ? `${dialog.doc.filename} and all its versions leave the vault.`
        : undefined;

  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => !open && onClose()}
      title={title}
      {...(description ? { description } : {})}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={naming ? 'primary' : 'danger'}
            loading={busy}
            disabled={naming && name.trim() === ''}
            onClick={() => void submit()}
          >
            {dialog?.kind === 'new-folder'
              ? 'Create folder'
              : dialog?.kind === 'rename-folder'
                ? 'Save'
                : 'Delete'}
          </Button>
        </>
      }
    >
      {naming && (
        <Field id="folder-name" label="Folder name" required error={problem ?? undefined}>
          <Input
            id="folder-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && void submit()}
            aria-invalid={problem ? true : undefined}
          />
        </Field>
      )}
    </Dialog>
  );
}
