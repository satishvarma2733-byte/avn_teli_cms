import type { CallDisposition, LeadStage } from '@avn-cms/db/enums';

import { toE164 } from '../shared/phone';
import { localToUtc } from '../shared/time';
import { sourceCodeFor } from '../webLeads/intake';
import {
  matchDisposition,
  matchStage,
  parseBool,
  parseDateParts,
  type ColumnMapping,
  type ImportFieldKey,
} from './fields';

/** Lookups a row needs, loaded once per job. */
export interface RowContext {
  timezone: string;
  defaultSourceId: string;
  sources: { id: string; code: string; label: string }[];
  /** Assignable users: lower-cased email and name → user. */
  counselors: Map<string, { id: string; name: string }>;
  telecallers: Map<string, { id: string; name: string }>;
}

export interface ImportCandidate {
  name: string;
  phoneRaw: string;
  phoneE164: string;
  altPhoneE164: string | null;
  parentName: string | null;
  email: string | null;
  town: string | null;
  district: string | null;
  state: string | null;
  address: string | null;
  sourceId: string;
  stage: LeadStage | null;
  disposition: CallDisposition | null;
  isPotential: boolean | null;
  priority: 'NORMAL' | 'HOT' | null;
  interestCountry: string | null;
  interestCourse: string | null;
  counselorId: string | null;
  telecallerId: string | null;
  nextCallAt: Date | null;
  enquiryDate: Date | null;
  /** Free text kept on the lead: the note column plus anything that had no field. */
  noteLines: string[];
}

export interface RowIssue {
  /** 1-based line number in the file (header = line 1). */
  line: number;
  severity: 'error' | 'warning';
  field: ImportFieldKey | 'row';
  message: string;
}

export interface RowResult {
  line: number;
  candidate: ImportCandidate | null;
  issues: RowIssue[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function sourceFor(raw: string, ctx: RowContext): { id: string; known: boolean } {
  const v = raw.trim().toLowerCase();
  const direct = ctx.sources.find(
    (s) =>
      s.code.toLowerCase() === v ||
      s.label.toLowerCase() === v ||
      s.code.toLowerCase() === v.replace(/[\s-]+/g, '_'),
  );
  if (direct) return { id: direct.id, known: true };
  const code = sourceCodeFor(raw);
  const guessed = ctx.sources.find((s) => s.code === code);
  // sourceCodeFor falls back to WEBSITE for anything unknown; only trust a real match.
  if (guessed && code !== 'WEBSITE') return { id: guessed.id, known: true };
  if (guessed && /web|site|online|landing|form|blog/.test(v)) return { id: guessed.id, known: true };
  return { id: ctx.defaultSourceId, known: false };
}

function dateFrom(raw: string, tz: string): Date | null | 'invalid' {
  if (!raw.trim()) return null;
  const p = parseDateParts(raw);
  if (!p) return 'invalid';
  return localToUtc(tz, p.y, p.mo, p.d, p.h, p.mi) ?? 'invalid';
}

export function normalizeRow(
  cells: string[],
  line: number,
  mapping: ColumnMapping,
  ctx: RowContext,
): RowResult {
  const issues: RowIssue[] = [];
  const get = (k: ImportFieldKey) => {
    const i = mapping[k];
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };
  const issue = (severity: RowIssue['severity'], field: RowIssue['field'], message: string) =>
    issues.push({ line, severity, field, message });
  const text = (k: ImportFieldKey, max: number) => {
    const v = get(k);
    return v ? v.slice(0, max) : null;
  };

  const name = get('name').slice(0, 200);
  const phoneRaw = get('phone');
  if (!name) issue('error', 'name', 'Student name is empty.');
  const phoneE164 = phoneRaw ? toE164(phoneRaw) : null;
  if (!phoneRaw) issue('error', 'phone', 'Mobile number is empty.');
  else if (!phoneE164) issue('error', 'phone', `“${phoneRaw}” is not a valid mobile number.`);

  const noteLines: string[] = [];
  const altRaw = get('altPhone');
  let altPhoneE164: string | null = null;
  if (altRaw) {
    altPhoneE164 = toE164(altRaw);
    if (!altPhoneE164) {
      issue('warning', 'altPhone', `Alternate number “${altRaw}” is not valid; kept in the note.`);
      noteLines.push(`Alternate number (as given): ${altRaw}`);
    }
  }

  let email = get('email').toLowerCase() || null;
  if (email && !EMAIL.test(email)) {
    issue('warning', 'email', `“${email}” is not a valid email; kept in the note.`);
    noteLines.push(`Email (as given): ${email}`);
    email = null;
  }

  const sourceRaw = get('source');
  let sourceId = ctx.defaultSourceId;
  if (sourceRaw) {
    const s = sourceFor(sourceRaw, ctx);
    sourceId = s.id;
    if (!s.known) issue('warning', 'source', `Unknown source “${sourceRaw}”; used the default source.`);
  }

  let stage: LeadStage | null = null;
  let disposition: CallDisposition | null = null;
  let isPotential: boolean | null = null;
  const stageRaw = get('stage');
  if (stageRaw) {
    const m = matchStage(stageRaw);
    if (m) {
      stage = m.stage;
      if (m.disposition) disposition = m.disposition;
      if (m.potential) isPotential = true;
    } else {
      issue('warning', 'stage', `Unknown status “${stageRaw}”; imported as New with the status in the note.`);
      noteLines.push(`Status in the old system: ${stageRaw}`);
    }
  }
  const dispRaw = get('disposition');
  if (dispRaw) {
    const d = matchDisposition(dispRaw);
    if (d) disposition = d;
    else {
      issue('warning', 'disposition', `Unknown call outcome “${dispRaw}”; kept in the note.`);
      noteLines.push(`Last call outcome in the old system: ${dispRaw}`);
    }
  }

  const potRaw = get('isPotential');
  if (potRaw) {
    const b = parseBool(potRaw);
    if (b === null) issue('warning', 'isPotential', `“${potRaw}” isn't yes/no; ignored.`);
    else isPotential = b || isPotential === true;
  }
  let priority: 'NORMAL' | 'HOT' | null = null;
  const prRaw = get('priority');
  if (prRaw) {
    const b = parseBool(prRaw);
    if (b === null) issue('warning', 'priority', `“${prRaw}” isn't a priority (use HOT or Normal); ignored.`);
    else priority = b ? 'HOT' : 'NORMAL';
  }

  const assignee = (k: 'counselor' | 'telecaller', map: RowContext['counselors']) => {
    const v = get(k);
    if (!v) return null;
    const u = map.get(v.toLowerCase());
    if (!u) {
      issue('warning', k, `No active ${k} called “${v}”; left unassigned.`);
      return null;
    }
    return u.id;
  };
  const counselorId = assignee('counselor', ctx.counselors);
  const telecallerId = assignee('telecaller', ctx.telecallers);

  const next = dateFrom(get('nextCallAt'), ctx.timezone);
  if (next === 'invalid')
    issue(
      'warning',
      'nextCallAt',
      `“${get('nextCallAt')}” isn't a date (use DD-MM-YYYY HH:MM); no call scheduled.`,
    );
  const enquiry = dateFrom(get('enquiryDate'), ctx.timezone);
  if (enquiry === 'invalid')
    issue('warning', 'enquiryDate', `“${get('enquiryDate')}” isn't a date; used today.`);
  const enquiryDate = enquiry instanceof Date && enquiry.getTime() <= Date.now() ? enquiry : null;
  if (enquiry instanceof Date && enquiry.getTime() > Date.now())
    issue('warning', 'enquiryDate', 'Enquiry date is in the future; used today.');

  const neet = get('neetScore');
  if (neet) noteLines.push(`NEET score: ${neet}`);
  const note = get('note');
  if (note) noteLines.unshift(note.slice(0, 4000));

  const failed = issues.some((i) => i.severity === 'error');
  return {
    line,
    issues,
    candidate: failed
      ? null
      : {
          name,
          phoneRaw,
          phoneE164: phoneE164!,
          altPhoneE164,
          parentName: text('parentName', 200),
          email,
          town: text('town', 100),
          district: text('district', 100),
          state: text('state', 100),
          address: text('address', 500),
          sourceId,
          stage,
          disposition,
          isPotential,
          priority,
          interestCountry: text('interestCountry', 100),
          interestCourse: text('interestCourse', 100),
          counselorId,
          telecallerId,
          nextCallAt: next instanceof Date ? next : null,
          enquiryDate,
          noteLines,
        },
  };
}
