'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';

/** Client side of the API envelope (ARCHITECTURE §3). */
export interface ApiError {
  code: string;
  message: string;
  details?: { fields?: Record<string, string> } & Record<string, unknown>;
}
export type ApiResult<T> =
  { ok: true; data: T; meta?: Record<string, unknown> } | { ok: false; error: ApiError; status: number };

const CsrfContext = createContext<string>('');

export function CsrfProvider({ token, children }: { token: string; children: ReactNode }) {
  return <CsrfContext.Provider value={token}>{children}</CsrfContext.Provider>;
}

export async function apiRequest<T>(
  path: string,
  init: { method?: string; body?: unknown; csrf?: string; signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  // File uploads go as multipart (the browser sets the boundary header itself).
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  try {
    const res = await fetch(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...(init.csrf ? { 'x-csrf-token': init.csrf } : {}),
      },
      body:
        init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
      credentials: 'same-origin',
      signal: init.signal,
    });
    const json = (await res.json().catch(() => null)) as {
      data?: T;
      meta?: Record<string, unknown>;
      error?: ApiError;
    } | null;
    if (!res.ok || !json || json.error) {
      if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/auth/')) {
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      }
      return {
        ok: false,
        status: res.status,
        error: json?.error ?? {
          code: 'INTERNAL',
          message: 'The server did not answer as expected. Please try again.',
        },
      };
    }
    return { ok: true, data: json.data as T, ...(json.meta ? { meta: json.meta } : {}) };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return {
      ok: false,
      status: 0,
      error: { code: 'NETWORK', message: 'Could not reach the server. Check your connection.' },
    };
  }
}

/** Authenticated API calls: adds the CSRF token to every request. */
export function useApi() {
  const csrf = useContext(CsrfContext);
  return useCallback(
    <T,>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}) =>
      apiRequest<T>(path, { ...init, csrf }),
    [csrf],
  );
}
