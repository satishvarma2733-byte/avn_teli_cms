import { crc32, deflateRawSync } from 'node:zlib';

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { AppError } from '../shared/errors';
import { parseXlsx } from './parse';
import { MAX_ZIP_ENTRIES, measureZip, ZipTooLarge, ZipUnreadable } from './zip-limits';

/** A minimal zip writer, so a test can build an archive that is huge once unpacked, or that lies. */
function zip(files: { name: string; data: Buffer; declaredSize?: number }[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const body = deflateRawSync(file.data);
    const size = file.declaredSize ?? file.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc32(file.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(file.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    directory.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const MB = 1024 ** 2;
const small = { maxEntries: MAX_ZIP_ENTRIES, maxBytes: 1 * MB };
const zeros = (bytes: number) => Buffer.alloc(bytes);

describe('zip limits for .xlsx imports', () => {
  it('measures a real workbook and lets it through', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Leads');
    ws.addRow(['Student name', 'Mobile number']);
    for (let i = 0; i < 500; i++) ws.addRow([`Student ${i}`, `98${String(10_000_000 + i)}`]);
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    const measured = await measureZip(file);
    expect(measured.entries).toBeGreaterThan(3);
    expect(measured.entries).toBeLessThan(50);
    expect(measured.unzippedBytes).toBeGreaterThan(file.length);
    expect((await parseXlsx(file)).rows).toHaveLength(500);
  });

  it('counts what an entry really unpacks to', async () => {
    expect(await measureZip(zip([{ name: 'a.txt', data: Buffer.from('hello') }]))).toEqual({
      entries: 1,
      unzippedBytes: 5,
    });
  });

  it('refuses an archive that unpacks past the limit (a zip bomb)', async () => {
    const bomb = zip([{ name: 'xl/worksheets/sheet1.xml', data: zeros(8 * MB) }]);
    expect(bomb.length).toBeLessThan(64 * 1024); // 8 MB of zeros packs into a few KB
    await expect(measureZip(bomb, small)).rejects.toBeInstanceOf(ZipTooLarge);
  });

  it('is not fooled by an archive that declares small sizes', async () => {
    const liar = zip([{ name: 'xl/worksheets/sheet1.xml', data: zeros(8 * MB), declaredSize: 100 }]);
    await expect(measureZip(liar, small)).rejects.toBeInstanceOf(ZipTooLarge);
  });

  it('adds up every entry, not only the largest', async () => {
    const many = zip(Array.from({ length: 4 }, (_, i) => ({ name: `xl/part${i}.xml`, data: zeros(MB / 2) })));
    await expect(measureZip(many, small)).rejects.toBeInstanceOf(ZipTooLarge);
    await expect(measureZip(many, { maxEntries: 10, maxBytes: 3 * MB })).resolves.toMatchObject({
      entries: 4,
    });
  });

  it('refuses too many entries before unpacking any', async () => {
    const crowd = zip(
      Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `p${i}`, data: Buffer.from('x') })),
    );
    await expect(measureZip(crowd)).rejects.toBeInstanceOf(ZipTooLarge);
  });

  it('refuses something that is not a zip', async () => {
    await expect(measureZip(Buffer.from('Student name,Mobile\nA,9800000001'))).rejects.toBeInstanceOf(
      ZipUnreadable,
    );
  });

  it('the import says so in plain words, before ExcelJS sees the file', async () => {
    const crowd = zip(
      Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `p${i}`, data: Buffer.from('x') })),
    );
    const tooBig = await parseXlsx(crowd).catch((e: unknown) => e);
    expect(tooBig).toBeInstanceOf(AppError);
    expect((tooBig as AppError).message).toContain('unpacks to more than 300 MB');

    const broken = await parseXlsx(Buffer.from('not a workbook')).catch((e: unknown) => e);
    expect((broken as AppError).message).toBe(
      'The Excel file could not be read. Save it as .xlsx and retry.',
    );
  });
});
