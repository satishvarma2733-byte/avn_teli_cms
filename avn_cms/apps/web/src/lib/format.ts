/** Display formatting (client and server). Dates show in the viewer's local time. */

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
  if (abs < 30 * 86_400_000) return rel.format(Math.round(diff / 86_400_000), 'day');
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
