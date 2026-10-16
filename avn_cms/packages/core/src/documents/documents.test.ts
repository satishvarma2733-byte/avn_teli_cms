import { createServer, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';

import { getConfig, objectStorageConfig, resetConfigForTests, type AppConfig } from '@avn-cms/config';
import { afterEach, describe, expect, it } from 'vitest';

import { contentDisposition, matchesSignature, resolveFormat, safeFilename } from './rules';
import { clamdScanner, pingClamd, ScannerUnavailableError } from './scanner';

describe('accepted file types', () => {
  it('decides the type from the file name', () => {
    expect(resolveFormat('Passport.PDF', '')?.mime).toBe('application/pdf');
    expect(resolveFormat('photo.jpeg', 'image/jpeg')?.mime).toBe('image/jpeg');
    expect(resolveFormat('photo.jpg', 'image/jpg')?.mime).toBe('image/jpeg'); // a browser alias
    expect(resolveFormat('scan.png', 'application/octet-stream')?.mime).toBe('image/png');
    expect(resolveFormat('fees.xlsx', '')?.label).toBe('Excel sheet');
  });

  it('refuses unknown extensions and a declared type that contradicts the name', () => {
    for (const name of [
      'virus.exe',
      'page.html',
      'icon.svg',
      'archive.zip',
      'script.js',
      'noextension',
      'x.pdf.exe',
    ]) {
      expect(resolveFormat(name, ''), name).toBeNull();
    }
    expect(resolveFormat('photo.jpg', 'application/pdf')).toBeNull();
    expect(resolveFormat('notes.txt', 'text/html')).toBeNull();
  });
});

describe('file signatures', () => {
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  it('accepts the right bytes for each type', () => {
    expect(matchesSignature('application/pdf', Buffer.from('%PDF-1.7\n'))).toBe(true);
    expect(matchesSignature('application/pdf', Buffer.from('\n\n%PDF-1.4'))).toBe(true);
    expect(matchesSignature('image/png', png)).toBe(true);
    expect(matchesSignature('image/jpeg', jpeg)).toBe(true);
    expect(matchesSignature('image/webp', webp)).toBe(true);
    expect(matchesSignature('application/msword', ole)).toBe(true);
    expect(matchesSignature('application/vnd.ms-excel', ole)).toBe(true);
    expect(matchesSignature(docx, zip)).toBe(true);
    expect(matchesSignature(xlsx, zip)).toBe(true);
    expect(matchesSignature('text/plain', Buffer.from('Just some text\n'))).toBe(true);
  });

  it('rejects bytes that belong to another type', () => {
    expect(matchesSignature('application/pdf', Buffer.from('MZ\x90\x00 an executable'))).toBe(false);
    expect(matchesSignature('image/png', jpeg)).toBe(false);
    expect(matchesSignature('image/jpeg', png)).toBe(false);
    expect(matchesSignature('image/webp', Buffer.from('RIFF....WAVEfmt '))).toBe(false);
    expect(matchesSignature(docx, ole)).toBe(false);
    expect(matchesSignature('application/msword', zip)).toBe(false);
    expect(matchesSignature('text/plain', Buffer.from([0x4d, 0x5a, 0x00, 0x01]))).toBe(false);
    expect(matchesSignature('application/x-msdownload', Buffer.from('MZ'))).toBe(false);
    expect(matchesSignature('application/pdf', Buffer.alloc(0))).toBe(false);
  });
});

describe('file names', () => {
  it('keeps only a safe, readable name', () => {
    expect(safeFilename('C:\\Users\\me\\Passport scan.pdf')).toBe('Passport scan.pdf');
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('  spaced   out  .pdf ')).toBe('spaced out .pdf');
    expect(safeFilename('a\u0000b\u0007c.pdf')).toBe('abc.pdf');
    expect(safeFilename('.hidden.pdf')).toBe('hidden.pdf');
    expect(safeFilename('he said "hi"<b>.txt')).toBe('he said _hi__b_.txt');
    expect(safeFilename('')).toBe('document');
    expect(safeFilename('///')).toBe('document');
    expect(safeFilename('రమేష్ పాస్‌పోర్ట్.pdf')).toBe('రమేష్ పాస్‌పోర్ట్.pdf');
  });

  it('shortens a long name but keeps its extension', () => {
    const name = safeFilename(`${'x'.repeat(400)}.pdf`);
    expect(name).toHaveLength(150);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('builds a download header with an ASCII fallback and the real name', () => {
    expect(contentDisposition('Passport.pdf', false)).toBe(
      `attachment; filename="Passport.pdf"; filename*=UTF-8''Passport.pdf`,
    );
    const header = contentDisposition('Ramesh’s "copy".pdf', true);
    expect(header.startsWith('inline; filename="Ramesh_s _copy_.pdf"')).toBe(true);
    expect(header).toContain(`filename*=UTF-8''Ramesh%E2%80%99s%20%22copy%22.pdf`);
    expect(header).not.toContain('\n');
  });
});

describe('document storage settings', () => {
  const base = {
    R2_BUCKET: 'docs',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
  } as AppConfig;

  it('is off unless every value is present', () => {
    expect(objectStorageConfig({} as AppConfig)).toBeNull();
    expect(objectStorageConfig({ ...base, R2_ACCOUNT_ID: undefined } as AppConfig)).toBeNull();
    expect(
      objectStorageConfig({ ...base, R2_BUCKET: undefined, R2_ACCOUNT_ID: 'abc' } as AppConfig),
    ).toBeNull();
  });

  it('builds the R2 endpoint from the account id, or takes an override', () => {
    expect(objectStorageConfig({ ...base, R2_ACCOUNT_ID: 'abc123' } as AppConfig)).toEqual({
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'docs',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    expect(
      objectStorageConfig({ ...base, R2_ENDPOINT: 'http://127.0.0.1:19000/' } as AppConfig)?.endpoint,
    ).toBe('http://127.0.0.1:19000');
  });

  describe('environment validation', () => {
    afterEach(() => {
      for (const k of [
        'R2_BUCKET',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_ACCOUNT_ID',
        'R2_ENDPOINT',
      ]) {
        delete process.env[k];
      }
      resetConfigForTests();
    });

    it('names what is missing when the settings are only half there', () => {
      process.env['R2_BUCKET'] = 'docs';
      resetConfigForTests();
      expect(() => getConfig()).toThrow(/R2_ACCESS_KEY_ID: is required/);
    });

    it('is fine with none at all', () => {
      resetConfigForTests();
      expect(objectStorageConfig(getConfig())).toBeNull();
    });
  });
});

describe('clamd client', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** A stand-in for clamd: records what it was sent and answers with `reply`. */
  async function fakeClamd(reply: string | null) {
    const received: Buffer[] = [];
    server = createServer((socket) => {
      socket.on('data', (d) => {
        received.push(d);
        const all = Buffer.concat(received);
        if (all.subarray(-4).equals(Buffer.alloc(4)) && all.length > 15) {
          if (reply === null) socket.destroy();
          else socket.end(reply);
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return { port, received };
  }

  it('speaks INSTREAM and reads a clean verdict', async () => {
    const { port, received } = await fakeClamd('stream: OK\0');
    const body = Buffer.from('hello document');
    const verdict = await clamdScanner('127.0.0.1', port).scan(Readable.from([body]));
    expect(verdict).toEqual({ status: 'CLEAN' });
    const sent = Buffer.concat(received);
    expect(sent.subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0');
    expect(sent.readUInt32BE(10)).toBe(body.length); // chunk length
    expect(sent.subarray(14, 14 + body.length)).toEqual(body);
    expect(sent.subarray(-4)).toEqual(Buffer.alloc(4)); // end of stream
  });

  it('splits a large file into chunks', async () => {
    const { port, received } = await fakeClamd('stream: OK\0');
    const big = Buffer.alloc(200 * 1024, 7);
    await clamdScanner('127.0.0.1', port).scan(Readable.from([big]));
    const sent = Buffer.concat(received);
    let at = 10;
    let total = 0;
    let chunks = 0;
    for (;;) {
      const size = sent.readUInt32BE(at);
      if (size === 0) break;
      expect(size).toBeLessThanOrEqual(64 * 1024);
      total += size;
      chunks += 1;
      at += 4 + size;
    }
    expect(total).toBe(big.length);
    expect(chunks).toBe(4);
  });

  it('reports what the scanner found', async () => {
    const { port } = await fakeClamd('stream: Eicar-Test-Signature FOUND\0');
    const verdict = await clamdScanner('127.0.0.1', port).scan(Readable.from([Buffer.from('x')]));
    expect(verdict).toEqual({ status: 'INFECTED', signature: 'Eicar-Test-Signature' });
  });

  it('never calls a file clean when the scanner errors, says nothing, or is not there', async () => {
    const refused = await fakeClamd('INSTREAM size limit exceeded. ERROR\0');
    await expect(
      clamdScanner('127.0.0.1', refused.port).scan(Readable.from([Buffer.from('x')])),
    ).rejects.toThrow(ScannerUnavailableError);
    server?.close();

    const silent = await fakeClamd(null);
    await expect(
      clamdScanner('127.0.0.1', silent.port).scan(Readable.from([Buffer.from('x')])),
    ).rejects.toThrow(/no verdict/);
    server?.close();

    const closed = await fakeClamd('stream: OK\0');
    const { port } = closed;
    server?.close();
    await new Promise((r) => setTimeout(r, 50));
    await expect(clamdScanner('127.0.0.1', port).scan(Readable.from([Buffer.from('x')]))).rejects.toThrow(
      /Could not reach the scanner/,
    );
  });

  it('gives up when the scanner never answers', async () => {
    server = createServer(() => undefined); // accepts, never replies
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await expect(
      clamdScanner('127.0.0.1', port, 150).scan(Readable.from([Buffer.from('x')])),
    ).rejects.toThrow(/took too long/);
  });
});

describe('clamd health probe', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function listen(onData: (socket: Socket, data: Buffer) => void) {
    server = createServer((socket) => socket.on('data', (data) => onData(socket, data)));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as { port: number }).port;
  }

  it('is up when clamd answers PING with PONG', async () => {
    let asked = '';
    const port = await listen((socket, data) => {
      asked = data.toString('latin1');
      socket.end('PONG\0');
    });
    expect(await pingClamd('127.0.0.1', port)).toBe('up');
    expect(asked).toBe('zPING\0');
  });

  it('is down for any other answer, a closed port, or silence (and does not wait for ever)', async () => {
    const wrong = await listen((socket) => socket.end('stream: ERROR\0'));
    expect(await pingClamd('127.0.0.1', wrong)).toBe('down');
    server?.close();

    const hangs = await listen(() => undefined);
    const started = Date.now();
    expect(await pingClamd('127.0.0.1', hangs, 200)).toBe('down');
    expect(Date.now() - started).toBeLessThan(1500);
    server?.close();

    const closed = await listen(() => undefined);
    server?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await pingClamd('127.0.0.1', closed)).toBe('down');
  });
});
