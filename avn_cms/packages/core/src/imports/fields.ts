import type { CallDisposition, LeadStage } from '@avn-cms/db/enums';

import { DISPOSITION_LABEL, LEAD_STAGES, STAGE_LABEL } from '../schemas';

/**
 * Import targets and the header names they are recognised by — including the column names
 * of the live LeadXP product's exports, so an existing data dump maps without manual work.
 */
export const IMPORT_FIELDS = [
  {
    key: 'name',
    label: 'Student name',
    required: true,
    synonyms: ['name', 'student name', 'student', 'full name', 'candidate', 'candidate name', 'studentname'],
  },
  {
    key: 'phone',
    label: 'Mobile number',
    required: true,
    synonyms: [
      'phone',
      'mobile',
      'mobile number',
      'mobile no',
      'phone number',
      'phone no',
      'contact',
      'contact number',
      'contact no',
      'whatsapp',
      'whatsapp number',
      'student mobile',
    ],
  },
  {
    key: 'altPhone',
    label: 'Alternate number',
    required: false,
    synonyms: [
      'alternate number',
      'alternate mobile',
      'alt phone',
      'alt mobile',
      'other number',
      'parent mobile',
      'father mobile',
      'parent phone',
      'secondary phone',
    ],
  },
  {
    key: 'parentName',
    label: 'Parent name',
    required: false,
    synonyms: ['parent', 'parent name', 'father', 'father name', 'mother name', 'guardian', 'guardian name'],
  },
  {
    key: 'email',
    label: 'Email',
    required: false,
    synonyms: ['email', 'email id', 'e-mail', 'mail', 'email address'],
  },
  {
    key: 'town',
    label: 'Town / city',
    required: false,
    synonyms: ['city', 'town', 'place', 'location', 'village'],
  },
  { key: 'district', label: 'District', required: false, synonyms: ['district'] },
  { key: 'state', label: 'State', required: false, synonyms: ['state'] },
  { key: 'address', label: 'Address', required: false, synonyms: ['address', 'full address'] },
  {
    key: 'source',
    label: 'Lead source',
    required: false,
    synonyms: ['source', 'lead source', 'channel', 'lead from', 'medium'],
  },
  {
    key: 'stage',
    label: 'Stage / status',
    required: false,
    synonyms: ['status', 'stage', 'lead status', 'lead stage'],
  },
  {
    key: 'disposition',
    label: 'Last call outcome',
    required: false,
    synonyms: [
      'followup status',
      'follow up status',
      'follow-up status',
      'quick followup status',
      'call status',
      'disposition',
      'call outcome',
    ],
  },
  {
    key: 'interestCountry',
    label: 'Country of interest',
    required: false,
    synonyms: ['country', 'preferred country', 'interested country', 'destination', 'country of interest'],
  },
  {
    key: 'interestCourse',
    label: 'Course',
    required: false,
    synonyms: ['course', 'program', 'programme', 'interested course'],
  },
  {
    key: 'neetScore',
    label: 'NEET score',
    required: false,
    synonyms: ['neet', 'neet score', 'neet marks', 'neet rank'],
  },
  {
    key: 'counselor',
    label: 'Counselor (email or name)',
    required: false,
    synonyms: ['counselor', 'counsellor', 'assigned to', 'owner', 'counselor email', 'counsellor email'],
  },
  {
    key: 'telecaller',
    label: 'Telecaller (email or name)',
    required: false,
    synonyms: ['telecaller', 'caller', 'telecaller email', 'tele caller'],
  },
  {
    key: 'isPotential',
    label: 'Potential (yes/no)',
    required: false,
    synonyms: ['potential', 'potential lead', 'is potential'],
  },
  { key: 'priority', label: 'Priority (HOT)', required: false, synonyms: ['priority', 'hot', 'is hot'] },
  {
    key: 'nextCallAt',
    label: 'Next call (date/time)',
    required: false,
    synonyms: [
      'next followup',
      'next follow up',
      'next follow-up',
      'next call',
      'followup date',
      'follow up date',
      'callback',
      'call back date',
      'next call date',
    ],
  },
  {
    key: 'enquiryDate',
    label: 'Enquiry date',
    required: false,
    synonyms: [
      'date',
      'created',
      'created at',
      'created on',
      'enquiry date',
      'inquiry date',
      'lead date',
      'registered on',
      'added on',
    ],
  },
  {
    key: 'note',
    label: 'Notes / remarks',
    required: false,
    synonyms: ['note', 'notes', 'remarks', 'remark', 'comment', 'comments', 'message', 'description'],
  },
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];
/** Field → zero-based column index in the file. */
export type ColumnMapping = Partial<Record<ImportFieldKey, number>>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best-guess mapping from the file's headers; each column is used at most once. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map(norm);
  const used = new Set<number>();
  const mapping: ColumnMapping = {};
  // Exact synonym matches first, then "contains" matches, in field order.
  for (const pass of ['exact', 'contains'] as const) {
    for (const f of IMPORT_FIELDS) {
      if (mapping[f.key] !== undefined) continue;
      const syns = f.synonyms.map(norm);
      const idx = normalized.findIndex(
        (h, i) =>
          !used.has(i) &&
          h !== '' &&
          (pass === 'exact' ? syns.includes(h) : syns.some((s) => s.length >= 4 && h.includes(s))),
      );
      if (idx >= 0) {
        mapping[f.key] = idx;
        used.add(idx);
      }
    }
  }
  return mapping;
}

/**
 * The live product's status values (DATABASE_SCHEMA "migration map"): stage-like values become
 * a pipeline stage; call-like values become a stage plus the call outcome they describe.
 */
const STAGE_SYNONYMS: Record<
  string,
  { stage: LeadStage; disposition?: CallDisposition; potential?: boolean }
> = {
  new: { stage: 'NEW' },
  fresh: { stage: 'NEW' },
  contacted: { stage: 'CONTACTED' },
  interested: { stage: 'INTERESTED' },
  followuprequired: { stage: 'FOLLOW_UP_REQUIRED' },
  followup: { stage: 'FOLLOW_UP_REQUIRED' },
  awaitingfeedback: { stage: 'FOLLOW_UP_REQUIRED', disposition: 'AWAITING_FEEDBACK' },
  callbacklater: { stage: 'FOLLOW_UP_REQUIRED', disposition: 'CALL_BACK_LATER' },
  potential: { stage: 'POTENTIAL', potential: true },
  potentiallead: { stage: 'POTENTIAL', potential: true },
  longterm: { stage: 'LONG_TERM' },
  notenrolled: { stage: 'NOT_INTERESTED' },
  notinterested: { stage: 'NOT_INTERESTED' },
  enrolled: { stage: 'ENROLLED' },
  admitted: { stage: 'ENROLLED' },
  joined: { stage: 'ENROLLED' },
  invalid: { stage: 'INVALID' },
  wrongnumber: { stage: 'INVALID' },
  unreachable: { stage: 'UNREACHABLE' },
  notreachable: { stage: 'UNREACHABLE' },
  switchedoff: { stage: 'UNREACHABLE', disposition: 'SWITCHED_OFF' },
  duplicate: { stage: 'DUPLICATE' },
  lost: { stage: 'LOST' },
  blocked: { stage: 'BLOCKED' },
};
for (const s of LEAD_STAGES) {
  STAGE_SYNONYMS[norm(s)] ??= { stage: s };
  STAGE_SYNONYMS[norm(STAGE_LABEL[s])] ??= { stage: s };
}

export function matchStage(
  value: string,
): { stage: LeadStage; disposition?: CallDisposition; potential?: boolean } | null {
  return STAGE_SYNONYMS[norm(value)] ?? null;
}

const DISPOSITION_SYNONYMS: Record<string, CallDisposition> = {
  noanswer: 'NO_ANSWER',
  notanswered: 'NO_ANSWER',
  rnr: 'NO_ANSWER',
  ringing: 'NO_ANSWER',
  busy: 'BUSY',
  switchedoff: 'SWITCHED_OFF',
  notreachable: 'SWITCHED_OFF',
  callbacklater: 'CALL_BACK_LATER',
  callback: 'CALL_BACK_LATER',
  callagain: 'CALL_BACK_LATER',
  interested: 'INTERESTED',
  notinterested: 'NOT_INTERESTED',
  awaitingfeedback: 'AWAITING_FEEDBACK',
  completed: 'COMPLETED',
  spoke: 'COMPLETED',
  connected: 'COMPLETED',
  contacted: 'COMPLETED',
};
for (const [code, label] of Object.entries(DISPOSITION_LABEL)) {
  if (code === 'SCHEDULED' || code === 'ESCALATED') continue;
  DISPOSITION_SYNONYMS[norm(code)] ??= code as CallDisposition;
  DISPOSITION_SYNONYMS[norm(label)] ??= code as CallDisposition;
}

export function matchDisposition(value: string): CallDisposition | null {
  return DISPOSITION_SYNONYMS[norm(value)] ?? null;
}

export function parseBool(value: string): boolean | null {
  const v = norm(value);
  if (['yes', 'y', 'true', '1', 'potential', 'hot', 'high'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'normal', 'low', ''].includes(v)) return false;
  return null;
}

/**
 * Dates as agencies type them: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, optional HH:MM (24 h or
 * am/pm), or the ISO strings Excel cells become. Day-first, as in India.
 */
export function parseDateParts(
  value: string,
): { y: number; mo: number; d: number; h: number; mi: number } | null {
  const v = value.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) {
    const iso = new Date(v);
    // Excel date cells arrive as UTC midnight of the calendar day: keep the wall-clock parts.
    return {
      y: iso.getUTCFullYear(),
      mo: iso.getUTCMonth() + 1,
      d: iso.getUTCDate(),
      h: iso.getUTCHours(),
      mi: iso.getUTCMinutes(),
    };
  }
  const m =
    /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T]+(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?)?$/i.exec(
      v,
    ) ?? null;
  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]+(\d{1,2})[:.](\d{2}))?/.exec(v);
  let y: number,
    mo: number,
    d: number,
    h = 0,
    mi = 0;
  if (m) {
    d = Number(m[1]);
    mo = Number(m[2]);
    y = Number(m[3]);
    if (y < 100) y += 2000;
    if (m[4]) {
      h = Number(m[4]);
      mi = Number(m[5]);
      const ap = m[6]?.toLowerCase().replace(/\./g, '');
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
    }
  } else if (ymd) {
    y = Number(ymd[1]);
    mo = Number(ymd[2]);
    d = Number(ymd[3]);
    if (ymd[4]) {
      h = Number(ymd[4]);
      mi = Number(ymd[5]);
    }
  } else {
    return null;
  }
  if (y < 1990 || y > 2100) return null;
  return { y, mo, d, h, mi };
}
