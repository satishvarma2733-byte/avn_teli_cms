import { createHmac } from 'node:crypto';

import { safeEqual } from '@avn-cms/auth';
import { getConfig } from '@avn-cms/config';
import type { FilePurpose, Prisma, TenantDb } from '@avn-cms/db';

/**
 * Job files (import uploads, error reports, exports). Stored in Postgres (tenant-scoped, RLS)
 * until object storage arrives with Phase 7; the API here is what an S3 driver will implement.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const EXPORT_TTL_DAYS = 7;

export async function saveFile(
  db: TenantDb,
  file: {
    purpose: FilePurpose;
    filename: string;
    mimeType: string;
    data: Buffer;
    createdById: string | null;
    expiresAt?: Date | null;
  },
): Promise<string> {
  const row = await db.storedFile.create({
    data: {
      purpose: file.purpose,
      filename: file.filename.slice(0, 200),
      mimeType: file.mimeType,
      sizeBytes: file.data.byteLength,
      data: new Uint8Array(file.data),
      createdById: file.createdById,
      expiresAt: file.expiresAt ?? null,
    } as Prisma.StoredFileUncheckedCreateInput,
    select: { id: true },
  });
  return row.id;
}

export async function readFile(db: TenantDb, id: string) {
  return db.storedFile.findFirst({ where: { id } });
}

export async function fileMeta(db: TenantDb, id: string) {
  return db.storedFile.findFirst({
    where: { id },
    select: {
      id: true,
      purpose: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      createdById: true,
      createdAt: true,
      expiresAt: true,
    },
  });
}

export async function deleteExpiredFiles(db: TenantDb, now = new Date()): Promise<number> {
  const res = await db.storedFile.deleteMany({ where: { expiresAt: { lt: now } } });
  return res.count;
}

// ── Signed, expiring download links ─────────────────────────────────────────

const DEFAULT_TTL_SECONDS = 15 * 60;

function signature(fileId: string, userId: string, exp: number): string {
  return createHmac('sha256', Buffer.from(getConfig().SESSION_SECRET, 'base64'))
    .update(`file:${fileId}:${userId}:${exp}`)
    .digest('base64url');
}

/**
 * A link that works for this user only (the download route also requires their session) and
 * only until `exp`. Nothing about the file is guessable from it.
 */
export function signedDownloadPath(fileId: string, userId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `/api/files/${fileId}?exp=${exp}&sig=${signature(fileId, userId, exp)}`;
}

export function verifyDownload(
  fileId: string,
  userId: string,
  exp: string | null,
  sig: string | null,
): 'ok' | 'expired' | 'invalid' {
  if (!exp || !sig || !/^\d{9,11}$/.test(exp)) return 'invalid';
  if (!safeEqual(signature(fileId, userId, Number(exp)), sig)) return 'invalid';
  if (Number(exp) * 1000 < Date.now()) return 'expired';
  return 'ok';
}

// ── Spreadsheet-formula injection (OWASP "CSV injection") ───────────────────

/** Cells that a spreadsheet would execute are prefixed with a quote so they stay text. */
export function safeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
