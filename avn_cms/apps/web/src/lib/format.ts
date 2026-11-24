/** Display formatting (client and server). Dates show in the viewer's local time. */

import { DISPOSITION_LABEL, STAGE_LABEL } from '@avn-cms/core/schemas';

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });
const rel = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function formatDate(value: string | Date | null | undefined): string {
  return value ? dateFmt.format(new Date(value)) : '—';
}

export function formatDateTime(value: string | Date | null | undefined): string {
  return value ? dateTimeFmt.format(new Date(value)) : '—';
}

export function formatTime(value: string | Date | null | undefined): string {
  return value ? timeFmt.format(new Date(value)) : '—';
}

export function formatRelative(value: string | Date | null | undefined, now = Date.now()): string {
  if (!value) return '—';
  const diff = new Date(value).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return rel.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rel.format(Math.round(diff / 3_600_000), 'hour');
  // Days up to two months ("40 days ago" says more than a date shown next to that same date), then
  // months, and a plain date beyond a year.
  if (abs < 60 * 86_400_000) return rel.format(Math.round(diff / 86_400_000), 'day');
  if (abs < 365 * 86_400_000) return rel.format(Math.round(diff / (30 * 86_400_000)), 'month');
  return formatDate(value);
}

/** +919876543210 → +91 98765 43210 (Indian numbers); others unchanged. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Value for <input type="datetime-local"> from an ISO string (local time). */
export function toLocalInput(value: Date | string): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value → ISO with offset (what the API expects). */
export function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})/g;
const LEGACY_FIELD: Record<string, string> = {
  parentName: 'parent’s name',
  phoneE164: 'phone',
  altPhoneE164: 'alternate phone',
};
const stageLabel = (code: string) => (STAGE_LABEL as Record<string, string>)[code] ?? code;
const dispositionLabel = (code: string) => (DISPOSITION_LABEL as Record<string, string>)[code] ?? code;

/**
 * A stored timeline line made readable. Older lines were written with machine values (an ISO
 * timestamp, a stage or call-outcome code, a database field name); only those system patterns are
 * rewritten, so text a person typed is left exactly as it was.
 */
export function readableSummary(summary: string): string {
  return summary
    .replace(ISO_INSTANT, (iso) => formatDateTime(iso))
    .replace(
      /^Stage changed from ([A-Z_]+) to ([A-Z_]+)\b/,
      (_, from: string, to: string) => `Stage changed from ${stageLabel(from)} to ${stageLabel(to)}`,
    )
    .replace(
      /^(Call(?: logged)?): ([A-Z_]+)\b/,
      (_, lead: string, code: string) => `${lead}: ${dispositionLabel(code)}`,
    )
    .replace(/^Contact details updated \(([^)]*)\)/, (_, fields: string) => {
      const named = fields
        .split(/,\s*/)
        .filter((f) => f && f !== 'phoneRaw')
        .map((f) => LEGACY_FIELD[f] ?? f);
      return `Contact details updated (${named.join(', ')})`;
    });
}

/** One name per role everywhere it is shown (menu, users, reports, audit). */
export const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super admin',
  TENANT_ADMIN: 'Admin',
  COUNSELOR: 'Counselor',
  TELECALLER: 'Telecaller',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? humanizeCode(role);
}

/** "TENANT_ADMIN" → "Tenant admin": a code shown as words when no label exists for it. */
export function humanizeCode(code: string): string {
  const words = code.toLowerCase().replace(/[_.]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
