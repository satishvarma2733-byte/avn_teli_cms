'use client';

import { useCallback } from 'react';

import { useApi } from '@/lib/client';

import type { DocView } from './types';

export interface UploadTarget {
  studentId?: string;
  folderId?: string | null;
  docType?: string;
  /** Upload a new version of this document. */
  replaces?: string;
}

/** A problem to show the person as is (every message is already plain language). */
export class DocumentError extends Error {}

interface InitResult {
  document: DocView;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

/** The browser sends the bytes straight to storage; XHR gives upload progress that fetch cannot. */
function putFile(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new DocumentError('The file could not be sent to storage. Try again.'));
    xhr.onerror = () =>
      reject(new DocumentError('Could not reach file storage. Check your connection and try again.'));
    xhr.send(file);
  });
}

/**
 * Upload in three steps: ask the server for a signed URL, send the file to storage with it, tell the
 * server it is there. The server then scans the file; it is not downloadable until that is clean.
 */
export function useDocumentUpload() {
  const api = useApi();
  return useCallback(
    async (file: File, target: UploadTarget, onProgress: (percent: number) => void): Promise<DocView> => {
      const init = await api<InitResult>('/api/documents', {
        body: { filename: file.name, mimeType: file.type, sizeBytes: file.size, ...target },
      });
      if (!init.ok) throw new DocumentError(init.error.details?.fields?.['filename'] ?? init.error.message);
      await putFile(init.data.upload.url, init.data.upload.headers, file, onProgress);
      const done = await api<DocView>(`/api/documents/${init.data.document.id}/complete`, {
        method: 'POST',
        body: {},
      });
      if (!done.ok) throw new DocumentError(done.error.message);
      return done.data;
    },
    [api],
  );
}

/** Asks for a fresh signed link at the moment of download (links last 5 minutes) and follows it. */
export function useDocumentDownload() {
  const api = useApi();
  return useCallback(
    async (id: string) => {
      const res = await api<{ url: string }>(`/api/documents/${id}/url`);
      if (!res.ok) throw new DocumentError(res.error.message);
      window.location.assign(res.data.url);
    },
    [api],
  );
}
