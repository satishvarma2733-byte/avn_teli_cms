'use client';

import { useEffect, useState } from 'react';

import { useApi } from './client';

export interface Option {
  id: string;
  name?: string;
  label?: string;
  code?: string;
}

/** Loads a picker list once per mount (sources, counselors, telecallers). */
export function useDirectory(kind: 'sources' | 'counselors' | 'telecallers', enabled = true) {
  const api = useApi();
  const [items, setItems] = useState<Option[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    api<Option[]>(`/api/directory?kind=${kind}`, { signal: ctrl.signal })
      .then((res) => {
        if (res.ok) setItems(res.data);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [api, kind, enabled]);
  return items;
}
