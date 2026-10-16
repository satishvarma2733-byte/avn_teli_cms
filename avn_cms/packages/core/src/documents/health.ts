import { pingObjectStore } from './object-store';
import { pingScanner } from './scanner';

/**
 * Is document storage reachable, and is the virus scanner answering? Each is `up`, `down`, or
 * `not_configured` (documents are optional, so that is not a failure). Probing is bounded (1.5 s each)
 * and never throws.
 *
 * The result is kept for 15 seconds in this process: a load balancer probes every few seconds from
 * every instance, and there is no reason to ask R2 and clamd that often.
 */
export interface DocumentsHealth {
  storage: 'up' | 'down' | 'not_configured';
  scanner: 'up' | 'down' | 'not_configured';
}

const KEEP_MS = 15_000;
const g = globalThis as unknown as { __avnDocsHealth?: { at: number; value: DocumentsHealth } };

export async function documentsHealth(options: { fresh?: boolean } = {}): Promise<DocumentsHealth> {
  const kept = g.__avnDocsHealth;
  if (!options.fresh && kept && Date.now() - kept.at < KEEP_MS) return kept.value;
  const [storage, scanner] = await Promise.all([pingObjectStore(), pingScanner()]);
  const value: DocumentsHealth = { storage, scanner };
  g.__avnDocsHealth = { at: Date.now(), value };
  return value;
}
