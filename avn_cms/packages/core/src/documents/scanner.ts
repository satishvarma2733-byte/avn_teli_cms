import { once } from 'node:events';
import { createConnection } from 'node:net';
import type { Readable } from 'node:stream';

import { getConfig } from '@avn-cms/config';

/**
 * Antivirus for uploaded documents, through clamd (ClamAV) over TCP. A file is only ever served
 * after a scan says it is clean: if no scanner is configured, or it cannot be reached, the file
 * stays pending (never "assumed clean").
 */
export type ScanVerdict = { status: 'CLEAN' } | { status: 'INFECTED'; signature: string };

export interface Scanner {
  scan(stream: Readable): Promise<ScanVerdict>;
}

/** The scanner could not give a verdict (not reachable, timed out, refused the stream). Retried later. */
export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerUnavailableError';
  }
}

const CHUNK = 64 * 1024;

/**
 * clamd's INSTREAM protocol: send `zINSTREAM\0`, then the file as length-prefixed chunks (4 bytes,
 * big-endian) ending with a zero-length chunk; clamd answers `stream: OK` or `stream: <name> FOUND`.
 */
export function clamdScanner(host: string, port: number, timeoutMs = 120_000): Scanner {
  return {
    scan(stream) {
      return new Promise<ScanVerdict>((resolve, reject) => {
        const socket = createConnection({ host, port });
        let reply = '';
        let settled = false;
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(new ScannerUnavailableError(message));
        };
        socket.setTimeout(timeoutMs, () => fail('The scanner took too long to answer.'));
        socket.on('error', (err) => fail(`Could not reach the scanner: ${err.message}`));
        socket.on('data', (data) => {
          reply += data.toString('utf8');
        });
        socket.on('close', () => {
          if (settled) return;
          settled = true;
          const text = reply.replace(/\0/g, '').trim();
          if (/^stream:\s*OK$/i.test(text)) return resolve({ status: 'CLEAN' });
          const found = /^stream:\s*(.+?)\s+FOUND$/i.exec(text);
          if (found) return resolve({ status: 'INFECTED', signature: found[1]! });
          reject(
            new ScannerUnavailableError(
              `The scanner gave no verdict${text ? `: ${text.slice(0, 120)}` : '.'}`,
            ),
          );
        });

        const send = async () => {
          await once(socket, 'connect');
          socket.write('zINSTREAM\0');
          for await (const piece of stream) {
            const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
            for (let at = 0; at < buf.length; at += CHUNK) {
              const part = buf.subarray(at, at + CHUNK);
              const size = Buffer.alloc(4);
              size.writeUInt32BE(part.length);
              socket.write(size);
              if (!socket.write(part)) await once(socket, 'drain');
            }
          }
          socket.write(Buffer.alloc(4)); // end of stream
        };
        send().catch((err: unknown) => fail(`The file could not be sent to the scanner: ${String(err)}`));
      });
    },
  };
}

/**
 * Is clamd answering? Sends `PING` and expects `PONG`. Never throws and never waits longer than
 * `timeoutMs`, so a health check cannot hang on a dead scanner.
 */
export function pingClamd(host: string, port: number, timeoutMs = 1500): Promise<'up' | 'down'> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let reply = '';
    let settled = false;
    const finish = (result: 'up' | 'down') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('down'), timeoutMs);
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (data) => {
      reply += data.toString('utf8');
      if (reply.includes('\0')) finish(reply.replace(/\0/g, '').trim() === 'PONG' ? 'up' : 'down');
    });
    socket.on('error', () => finish('down'));
    socket.on('close', () => finish(reply.replace(/\0/g, '').trim() === 'PONG' ? 'up' : 'down'));
  });
}

/** Health of the configured scanner (ignores the test override): up, down, or not configured. */
export function pingScanner(timeoutMs = 1500): Promise<'up' | 'down' | 'not_configured'> {
  const { CLAMAV_HOST, CLAMAV_PORT } = getConfig();
  return CLAMAV_HOST ? pingClamd(CLAMAV_HOST, CLAMAV_PORT, timeoutMs) : Promise.resolve('not_configured');
}

let override: Scanner | null | undefined;

/** For tests: replace the scanner (null = none configured); `undefined` restores the configured one. */
export function setScannerForTests(scanner: Scanner | null | undefined): void {
  override = scanner;
}

/** The configured scanner, or null when CLAMAV_HOST is not set. */
export function getScanner(): Scanner | null {
  if (override !== undefined) return override;
  const { CLAMAV_HOST, CLAMAV_PORT } = getConfig();
  return CLAMAV_HOST ? clamdScanner(CLAMAV_HOST, CLAMAV_PORT) : null;
}
