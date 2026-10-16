import { DOCUMENT_FORMATS } from '../schemas';

/**
 * What the vault accepts and how a file is vetted before anyone can download it. The type is
 * decided from the file name, never from what the browser claims; the file's first bytes must
 * then agree (checked by the scan job, because only then is the file in hand).
 */
export interface DocumentFormat {
  mime: string;
  extensions: readonly string[];
  label: string;
  inline: boolean;
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/**
 * The format for a file name, or null when it is not accepted. A declared type must agree with
 * it; browsers send '' or application/octet-stream for types they don't know, which is fine.
 */
export function resolveFormat(filename: string, declaredMime: string): DocumentFormat | null {
  const ext = extensionOf(filename);
  const format = DOCUMENT_FORMATS.find((f) => (f.extensions as readonly string[]).includes(ext));
  if (!format) return null;
  const declared = declaredMime.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== format.mime) {
    // Some browsers say image/jpg; anything else contradicts the extension.
    if (!(declared === 'image/jpg' && format.mime === 'image/jpeg')) return null;
  }
  return format;
}

export function formatFor(mime: string): DocumentFormat | undefined {
  return DOCUMENT_FORMATS.find((f) => f.mime === mime);
}

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const hasPrefix = (head: Buffer, bytes: number[]) => bytes.every((b, i) => head[i] === b);
const ascii = (head: Buffer, text: string, at = 0) =>
  head.length >= at + text.length && head.toString('latin1', at, at + text.length) === text;

const SIGNATURES: Record<string, (head: Buffer) => boolean> = {
  'application/pdf': (h) => h.subarray(0, 1024).includes('%PDF-'),
  'image/jpeg': (h) => hasPrefix(h, [0xff, 0xd8, 0xff]),
  'image/png': (h) => hasPrefix(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (h) => ascii(h, 'RIFF') && ascii(h, 'WEBP', 8),
  'application/msword': (h) => hasPrefix(h, OLE),
  'application/vnd.ms-excel': (h) => hasPrefix(h, OLE),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (h) => hasPrefix(h, ZIP),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (h) => hasPrefix(h, ZIP),
  'text/plain': (h) => !h.includes(0),
};

/** Do the file's first bytes look like the format it was uploaded as? Unknown formats never do. */
export function matchesSignature(mime: string, head: Buffer): boolean {
  const check = SIGNATURES[mime];
  return check ? check(head) : false;
}

/** A file name safe to store and to show: no path, no control characters, bounded length. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let out = '';
  for (const ch of base.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f)) continue;
    out += ch;
  }
  out = out
    .replace(/["<>|*?:]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (out.length > 150) {
    const ext = extensionOf(out);
    out = out.slice(0, 150 - (ext ? ext.length + 1 : 0)) + (ext ? `.${ext}` : '');
  }
  return out || 'document';
}

/** Content-Disposition for a download, with an ASCII fallback and the real name in filename*. */
export function contentDisposition(filename: string, inline: boolean): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
