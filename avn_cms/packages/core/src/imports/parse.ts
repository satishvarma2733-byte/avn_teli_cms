import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

import { invalid } from '../shared/errors';

/** Limits that keep an import a bounded background job. */
export const MAX_ROWS = 100_000;
export const MAX_COLUMNS = 80;
export const MAX_CELL = 5_000;

export interface ParsedSheet {
  headers: string[];
  /** Data rows as strings (dates from XLSX become ISO strings). */
  rows: string[][];
}

export type SheetKind = 'csv' | 'xlsx';

export function sheetKind(filename: string, mimeType: string): SheetKind | null {
  const name = filename.toLowerCase();
  if (name.endsWith('.csv') || mimeType === 'text/csv') return 'csv';
  if (
    name.endsWith('.xlsx') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
    return 'xlsx';
  return null;
}

function clean(v: string): string {
  return v.replaceAll('\u0000', '').trim().slice(0, MAX_CELL);
}

function finish(table: string[][]): ParsedSheet {
  const nonEmpty = table.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) throw invalid('The file is empty.');
  const [head, ...rows] = nonEmpty;
  const headers = head!.map((h, i) => clean(h) || `Column ${i + 1}`);
  if (headers.length > MAX_COLUMNS)
    throw invalid(`The file has ${headers.length} columns; the limit is ${MAX_COLUMNS}.`);
  if (rows.length === 0) throw invalid('The file has a header row but no data rows.');
  if (rows.length > MAX_ROWS)
    throw invalid(
      `The file has ${rows.length.toLocaleString('en-IN')} rows; the limit is ${MAX_ROWS.toLocaleString('en-IN')}. Split it into smaller files.`,
    );
  return { headers, rows: rows.map((r) => headers.map((_, i) => clean(r[i] ?? ''))) };
}

export function parseCsv(buf: Buffer): ParsedSheet {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1'); // Excel "CSV (MS-DOS)" exports
  const sample = text.slice(0, 2000);
  const delimiter = (sample.match(/;/g)?.length ?? 0) > (sample.match(/,/g)?.length ?? 0) ? ';' : ',';
  try {
    const table = parse(text, {
      bom: true,
      delimiter,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    }) as string[][];
    return finish(table);
  } catch (err) {
    if (err instanceof Error && err.name === 'AppError') throw err;
    throw invalid('The CSV file could not be read. Save it again as “CSV UTF-8” and retry.');
  }
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text; // hyperlink
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v)
      return v.result === undefined || v.result === null ? '' : cellText(v.result as ExcelJS.CellValue); // formula
    if ('error' in v) return '';
  }
  return String(v);
}

export async function parseXlsx(buf: Buffer): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw invalid('The Excel file could not be read. Save it as .xlsx and retry.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw invalid('The workbook has no sheets.');
  if (ws.rowCount > MAX_ROWS + 1)
    throw invalid(
      `The sheet has more than ${MAX_ROWS.toLocaleString('en-IN')} rows. Split it into smaller files.`,
    );
  const table: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    const count = Math.min(row.cellCount, MAX_COLUMNS + 1);
    for (let i = 1; i <= count; i++) values.push(cellText(row.getCell(i).value));
    table.push(values);
  });
  return finish(table);
}

export async function parseSheet(buf: Buffer, kind: SheetKind): Promise<ParsedSheet> {
  return kind === 'csv' ? parseCsv(buf) : parseXlsx(buf);
}
