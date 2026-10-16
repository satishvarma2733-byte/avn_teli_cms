import { describe, expect, it } from 'vitest';

import { safeCell } from '../storage/files';
import { localToUtc } from '../shared/time';
import { matchDisposition, matchStage, parseDateParts, suggestMapping } from './fields';
import { normalizeRow, type RowContext } from './normalize';
import { parseCsv } from './parse';

const ctx: RowContext = {
  timezone: 'Asia/Kolkata',
  defaultSourceId: 'src-website',
  sources: [
    { id: 'src-website', code: 'WEBSITE', label: 'Website' },
    { id: 'src-google', code: 'GOOGLE_ADS', label: 'Google Ads' },
    { id: 'src-walkin', code: 'WALK_IN', label: 'Walk-in' },
  ],
  counselors: new Map([
    ['c@agency.test', { id: 'u-c', name: 'Chaitanya' }],
    ['chaitanya', { id: 'u-c', name: 'Chaitanya' }],
  ]),
  telecallers: new Map([['t@agency.test', { id: 'u-t', name: 'Teja' }]]),
};

describe('suggestMapping', () => {
  it('maps the live LeadXP export headers without help', () => {
    const headers = [
      'S.No',
      'Student Name',
      'Mobile No',
      'Father Name',
      'Email ID',
      'City',
      'Status',
      'Followup Status',
      'Lead Source',
      'Counsellor',
      'Next Followup',
      'Remarks',
      'Created On',
    ];
    expect(suggestMapping(headers)).toEqual({
      name: 1,
      phone: 2,
      parentName: 3,
      email: 4,
      town: 5,
      stage: 6,
      disposition: 7,
      source: 8,
      counselor: 9,
      nextCallAt: 10,
      note: 11,
      enquiryDate: 12,
    });
  });
  it('never uses one column twice', () => {
    const m = suggestMapping(['Mobile', 'Mobile number']);
    expect(new Set(Object.values(m)).size).toBe(Object.values(m).length);
  });
});

describe('status migration map', () => {
  it('maps stage-like and call-like LeadXP values', () => {
    expect(matchStage('Long Term')).toEqual({ stage: 'LONG_TERM' });
    expect(matchStage('Not Enrolled')).toEqual({ stage: 'NOT_INTERESTED' });
    expect(matchStage('Follow-up Required')).toEqual({ stage: 'FOLLOW_UP_REQUIRED' });
    expect(matchStage('Awaiting Feedback')).toEqual({
      stage: 'FOLLOW_UP_REQUIRED',
      disposition: 'AWAITING_FEEDBACK',
    });
    expect(matchStage('potential')).toMatchObject({ stage: 'POTENTIAL', potential: true });
    expect(matchStage('Admission confirmed')).toEqual({ stage: 'ADMISSION_CONFIRMED' });
    expect(matchStage('something else')).toBeNull();
    expect(matchDisposition('RNR')).toBe('NO_ANSWER');
    expect(matchDisposition('Call back later')).toBe('CALL_BACK_LATER');
  });
});

describe('dates', () => {
  it('reads day-first Indian dates and Excel ISO cells as agency wall-clock time', () => {
    expect(parseDateParts('15-08-2026')).toEqual({ y: 2026, mo: 8, d: 15, h: 0, mi: 0 });
    expect(parseDateParts('15/08/26 4:30 pm')).toEqual({ y: 2026, mo: 8, d: 15, h: 16, mi: 30 });
    expect(parseDateParts('2026-08-15 10:05')).toEqual({ y: 2026, mo: 8, d: 15, h: 10, mi: 5 });
    expect(parseDateParts('2026-08-15T00:00:00.000Z')).toEqual({ y: 2026, mo: 8, d: 15, h: 0, mi: 0 });
    expect(parseDateParts('next week')).toBeNull();
    expect(localToUtc('Asia/Kolkata', 2026, 8, 15, 10, 30)!.toISOString()).toBe('2026-08-15T05:00:00.000Z');
    expect(localToUtc('Asia/Kolkata', 2026, 2, 31)).toBeNull();
  });
});

describe('normalizeRow', () => {
  const mapping = {
    name: 0,
    phone: 1,
    email: 2,
    source: 3,
    stage: 4,
    counselor: 5,
    nextCallAt: 6,
    note: 7,
    telecaller: 8,
  };
  it('builds a candidate and collects warnings without failing the row', () => {
    const r = normalizeRow(
      [
        'Riya Rao',
        '98765 43210',
        'bad-email',
        'google',
        'Strange status',
        'nobody@x.test',
        '20-10-2026 11:00',
        'Called twice',
        't@agency.test',
      ],
      2,
      mapping,
      ctx,
    );
    expect(r.candidate).toMatchObject({
      name: 'Riya Rao',
      phoneE164: '+919876543210',
      email: null,
      sourceId: 'src-google',
      stage: null,
      counselorId: null,
      telecallerId: 'u-t',
    });
    expect(r.candidate!.nextCallAt!.toISOString()).toBe('2026-10-20T05:30:00.000Z');
    expect(r.candidate!.noteLines[0]).toBe('Called twice');
    expect(r.issues.map((i) => i.field).sort()).toEqual(['counselor', 'email', 'stage']);
    expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
  });
  it('fails a row only for a missing name or an unusable phone', () => {
    expect(normalizeRow(['', '9876543210'], 3, mapping, ctx).candidate).toBeNull();
    expect(normalizeRow(['X', '12345'], 4, mapping, ctx).issues[0]).toMatchObject({
      severity: 'error',
      field: 'phone',
      line: 4,
    });
  });
  it('unknown sources fall back to the default with a warning', () => {
    const r = normalizeRow(['X', '9876543210', '', 'Hoarding near bus stand'], 5, mapping, ctx);
    expect(r.candidate!.sourceId).toBe('src-website');
    expect(r.issues[0]!.field).toBe('source');
  });
});

describe('parseCsv', () => {
  it('handles BOM, semicolons, quotes and ragged rows', () => {
    const csv = '﻿Name;Mobile;Note\n"Rao, Riya";9876543210;"said ""yes"""\nOnly name\n';
    const s = parseCsv(Buffer.from(csv));
    expect(s.headers).toEqual(['Name', 'Mobile', 'Note']);
    expect(s.rows).toEqual([
      ['Rao, Riya', '9876543210', 'said "yes"'],
      ['Only name', '', ''],
    ]);
  });
  it('rejects empty files and header-only files', () => {
    expect(() => parseCsv(Buffer.from(''))).toThrow(/empty/);
    expect(() => parseCsv(Buffer.from('Name,Mobile\n'))).toThrow(/no data rows/);
  });
});

describe('safeCell (spreadsheet formula injection)', () => {
  it('neutralises cells a spreadsheet would execute', () => {
    for (const v of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tx'])
      expect(safeCell(v).startsWith("'")).toBe(true);
    expect(safeCell('+91 98765 43210')).toBe("'+91 98765 43210"); // still readable, and not a formula
    expect(safeCell('Riya')).toBe('Riya');
    expect(safeCell(null)).toBe('');
  });
});
