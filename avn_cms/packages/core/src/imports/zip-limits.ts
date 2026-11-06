import { createInflateRaw } from 'node:zlib';

/**
 * An .xlsx file is a zip archive, and ExcelJS unpacks all of it into memory before any of our limits
 * (rows, columns) is checked. A small file can be built to unpack into gigabytes (a "zip bomb") and take
 * the server down. So the archive is measured first: its entries are counted from the central directory,
 * and each entry is actually inflated, counting the bytes without keeping them, because the sizes an
 * archive declares can lie.
 */

/** A workbook is a few dozen parts; even one with many sheets and pictures stays far below this. */
export const MAX_ZIP_ENTRIES = 1_000;
/** Above what any sheet within the import limits (100,000 rows × 80 columns) unpacks to. */
export const MAX_UNZIPPED_BYTES = 300 * 1024 ** 2;

export class ZipTooLarge extends Error {
  constructor(what: string) {
    super(`The archive is too large once unpacked (${what}).`);
    this.name = 'ZipTooLarge';
  }
}
export class ZipUnreadable extends Error {
  constructor(what: string) {
    super(`The archive could not be read (${what}).`);
    this.name = 'ZipUnreadable';
  }
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;

export interface ZipLimits {
  maxEntries: number;
  maxBytes: number;
}

/** Throws ZipTooLarge or ZipUnreadable; otherwise returns what the archive really holds. */
export async function measureZip(
  buf: Buffer,
  limits: ZipLimits = { maxEntries: MAX_ZIP_ENTRIES, maxBytes: MAX_UNZIPPED_BYTES },
): Promise<{ entries: number; unzippedBytes: number }> {
  const u16 = (at: number) => buf.readUInt16LE(at);
  const u32 = (at: number) => buf.readUInt32LE(at);
  const u64 = (at: number) => Number(buf.readBigUInt64LE(at));
  const need = (at: number, length: number, what: string) => {
    if (at < 0 || at + length > buf.length) throw new ZipUnreadable(what);
  };

  // The end-of-central-directory record is the last thing in the file, before an optional comment.
  let end = -1;
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at--) {
    if (u32(at) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipUnreadable('no end record');
  let entries = u16(end + 10);
  let directory = u32(end + 16);
  if (entries === 0xffff || directory === MAX32) {
    need(end - 20, 20, 'zip64 locator');
    if (u32(end - 20) !== ZIP64_LOCATOR) throw new ZipUnreadable('zip64 locator');
    const record = u64(end - 20 + 8);
    need(record, 56, 'zip64 end record');
    if (u32(record) !== ZIP64_EOCD) throw new ZipUnreadable('zip64 end record');
    entries = u64(record + 32);
    directory = u64(record + 48);
  }
  if (entries > limits.maxEntries) throw new ZipTooLarge(`${entries} entries`);

  let total = 0;
  let at = directory;
  for (let i = 0; i < entries; i++) {
    need(at, 46, 'central directory');
    if (u32(at) !== CENTRAL) throw new ZipUnreadable('central directory');
    if (u16(at + 8) & 0x1) throw new ZipUnreadable('encrypted entry');
    const method = u16(at + 10);
    let compressed = u32(at + 20);
    const declared = u32(at + 24); // only located, never trusted: the real size is counted below
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    let local = u32(at + 42);
    if (compressed === MAX32 || declared === MAX32 || local === MAX32) {
      // Zip64: the real values are in the 0x0001 extra field, in this order, for those that overflowed.
      let extra = at + 46 + nameLength;
      const extraEnd = extra + extraLength;
      need(extra, extraLength, 'zip64 sizes');
      for (; extra + 4 <= extraEnd; extra += 4 + u16(extra + 2)) {
        if (u16(extra) !== 0x0001) continue;
        let field = extra + 4;
        if (declared === MAX32) field += 8; // the declared size comes first; skipped
        if (compressed === MAX32) {
          compressed = u64(field);
          field += 8;
        }
        if (local === MAX32) local = u64(field);
        break;
      }
    }
    need(local, 30, 'local header');
    if (u32(local) !== LOCAL) throw new ZipUnreadable('local header');
    const data = local + 30 + u16(local + 26) + u16(local + 28);
    need(data, compressed, 'entry data');
    const budget = limits.maxBytes - total;
    if (method === 0) {
      if (compressed > budget) throw new ZipTooLarge(`more than ${limits.maxBytes} bytes`);
      total += compressed;
    } else if (method === 8) {
      total += await inflatedSize(buf.subarray(data, data + compressed), budget, limits.maxBytes);
    } else {
      throw new ZipUnreadable(`compression method ${method}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, unzippedBytes: total };
}

/** Inflates `data` and counts the bytes, giving up as soon as they pass `budget`. Keeps nothing. */
function inflatedSize(data: Buffer, budget: number, maxBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const inflate = createInflateRaw({ chunkSize: 64 * 1024 });
    let size = 0;
    inflate.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > budget) {
        reject(new ZipTooLarge(`more than ${maxBytes} bytes`));
        inflate.destroy();
      }
    });
    inflate.on('end', () => resolve(size));
    inflate.on('error', () => reject(new ZipUnreadable('bad compressed data')));
    inflate.end(data);
  });
}
