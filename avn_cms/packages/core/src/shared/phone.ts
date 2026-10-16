import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * Normalises a phone number to E.164 for dedupe and search. Numbers without a country code
 * are read as Indian (the agencies' home market). Returns null when the input can't be a
 * real number.
 */
export function toE164(raw: string | null | undefined, defaultCountry: 'IN' = 'IN'): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/[^\d+]/g, '');
  if (cleaned.length < 8 || cleaned.length > 16) return null;
  const phone = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (!phone || !phone.isValid()) return null;
  return phone.number;
}

/** Display form, e.g. +91 98765 43210. */
export function formatPhone(e164: string): string {
  const phone = parsePhoneNumberFromString(e164);
  return phone ? phone.formatInternational() : e164;
}
