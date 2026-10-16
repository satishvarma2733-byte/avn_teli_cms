import type { Readable } from 'node:stream';

import { getConfig, objectStorageConfig, type ObjectStorageConfig } from '@avn-cms/config';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { unavailable } from '../shared/errors';
import { contentDisposition } from './rules';

/**
 * Object storage for documents: Cloudflare R2 in production, any S3-compatible server locally
 * (MinIO). The bucket is private; browsers reach it only through short-lived presigned URLs this
 * module signs, so nothing about the bucket is public and no key is ever sent to the browser.
 */
export interface ObjectStore {
  readonly bucket: string;
  /** URL the browser PUTs the file to. The type and exact size are part of the signature. */
  presignPut(
    key: string,
    o: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<string>;
  /** URL the browser opens to receive the file (attachment, or inline for safe types). */
  presignGet(
    key: string,
    o: { filename: string; contentType: string; inline: boolean; expiresInSeconds: number },
  ): Promise<string>;
  /** Size of the stored object, or null when there is none. */
  head(key: string): Promise<{ size: number } | null>;
  /** The first `bytes` bytes of the object. */
  readStart(key: string, bytes: number): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Can the bucket be reached with these credentials? Never throws; gives up after `timeoutMs`. */
  ping(timeoutMs: number): Promise<boolean>;
}

const NOT_SET_UP = 'Document storage is not set up on this server.';

const notFound = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
};

/** Anything but "no such object" means storage is down or misconfigured; say so, keep the detail in the log. */
function storageDown(what: string, err: unknown): never {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: `document storage: ${what} failed`,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  throw unavailable('Document storage did not answer. Try again in a moment.');
}

function makeClient(cfg: ObjectStorageConfig): S3Client {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // R2 and MinIO both take path-style URLs, which keeps one predictable origin (the CSP needs it).
    forcePathStyle: true,
    // Newer SDKs add CRC checksums to every request; R2 does not accept them on presigned uploads.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function createObjectStore(cfg: ObjectStorageConfig): ObjectStore {
  const client = makeClient(cfg);
  const Bucket = cfg.bucket;
  return {
    bucket: Bucket,
    async presignPut(key, o) {
      const command = new PutObjectCommand({
        Bucket,
        Key: key,
        ContentType: o.contentType,
        ContentLength: o.contentLength,
      });
      return getSignedUrl(client, command, {
        expiresIn: o.expiresInSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      });
    },
    async presignGet(key, o) {
      const command = new GetObjectCommand({
        Bucket,
        Key: key,
        ResponseContentType: o.contentType,
        ResponseContentDisposition: contentDisposition(o.filename, o.inline),
      });
      return getSignedUrl(client, command, { expiresIn: o.expiresInSeconds });
    },
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: res.ContentLength ?? 0 };
      } catch (err) {
        if (notFound(err)) return null;
        return storageDown('head', err);
      }
    },
    async readStart(key, bytes) {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
        );
        return Buffer.from((await res.Body?.transformToByteArray()) ?? []);
      } catch (err) {
        return storageDown('read', err);
      }
    },
    async stream(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return res.Body as Readable;
      } catch (err) {
        return storageDown('read', err);
      }
    },
    async put(key, body, contentType) {
      try {
        await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
      } catch (err) {
        return storageDown('write', err);
      }
    },
    async ping(timeoutMs) {
      try {
        await client.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(timeoutMs) });
        return true;
      } catch {
        return false;
      }
    },
    async remove(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch (err) {
        return storageDown('delete', err);
      }
    },
  };
}

const g = globalThis as unknown as { __avnObjectStore?: { id: string; store: ObjectStore } };

/** The configured store. Throws "unavailable" (503) when no storage settings are present. */
export function getObjectStore(): ObjectStore {
  const cfg = objectStorageConfig(getConfig());
  if (!cfg) throw unavailable(NOT_SET_UP);
  const id = `${cfg.endpoint}|${cfg.bucket}|${cfg.accessKeyId}`;
  if (g.__avnObjectStore?.id !== id) g.__avnObjectStore = { id, store: createObjectStore(cfg) };
  return g.__avnObjectStore.store;
}

/** Health of the configured storage: up, down, or not configured. */
export async function pingObjectStore(timeoutMs = 1500): Promise<'up' | 'down' | 'not_configured'> {
  if (!objectStoreConfigured()) return 'not_configured';
  return (await getObjectStore().ping(timeoutMs)) ? 'up' : 'down';
}

/** True when storage settings are present (does not contact the server). */
export function objectStoreConfigured(): boolean {
  return objectStorageConfig(getConfig()) !== null;
}

/**
 * Setup helpers for development, tests and the storage:setup script. Production code never calls
 * these: on R2 the bucket and its CORS rules are created once in the Cloudflare dashboard (or with
 * an admin token through the script).
 */
export async function ensureBucket(): Promise<'existed' | 'created'> {
  const cfg = objectStorageConfig(getConfig());
  if (!cfg) throw unavailable(NOT_SET_UP);
  const client = makeClient(cfg);
  try {
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    return 'existed';
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
    return 'created';
  }
}

export async function applyBucketCors(origins: string[]): Promise<void> {
  const cfg = objectStorageConfig(getConfig());
  if (!cfg) throw unavailable(NOT_SET_UP);
  await makeClient(cfg).send(
    new PutBucketCorsCommand({
      Bucket: cfg.bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['content-type'],
            ExposeHeaders: ['etag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
}
