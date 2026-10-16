import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

export type BaseClient = PrismaClient;

export interface ClientOptions {
  /** Most connections this process holds at once (default 10). */
  poolMax?: number;
  /** Longest a single statement may run, in milliseconds (default 30 s). */
  statementTimeoutMs?: number;
}

export function createClient(connectionString: string, options: ClientOptions = {}): BaseClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: options.poolMax ?? 10,
      connectionTimeoutMillis: 10_000,
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    }),
  });
}

/**
 * One client per connection string per process. Next.js dev reloads modules, so the cache
 * lives on globalThis to avoid opening a new pool on every hot reload.
 */
const g = globalThis as unknown as { __avnClients?: Map<string, BaseClient> };

export function sharedClient(connectionString: string, options?: ClientOptions): BaseClient {
  g.__avnClients ??= new Map();
  let client = g.__avnClients.get(connectionString);
  if (!client) {
    client = createClient(connectionString, options);
    g.__avnClients.set(connectionString, client);
  }
  return client;
}

/** Readiness probe: true when a trivial query answers within the timeout. */
export async function pingDatabase(db: BaseClient, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const query = db.$queryRaw`SELECT 1`.then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function disconnectAll(): Promise<void> {
  const clients = g.__avnClients;
  if (!clients) return;
  await Promise.all([...clients.values()].map((c) => c.$disconnect()));
  clients.clear();
}
