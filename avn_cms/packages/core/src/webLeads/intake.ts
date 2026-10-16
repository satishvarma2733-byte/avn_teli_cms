import { invalid } from '../shared/errors';
import { toE164 } from '../shared/phone';

/**
 * Normalises every supported intake payload into one DTO (docs/WEBLEADS_COMPATIBILITY.md §3):
 *  - the eWings main site (send_email.php → LeadXP shape: mobile, neet_score, preferred_country…)
 *  - the eWings blog (leads.service.ts → phone, neetScore, city, postSlug…)
 *  - aVn CMS's own camelCase / snake_case attribution fields
 * Validation is deliberately lenient: only a missing name or an unusable phone is rejected;
 * everything else is stored (and flagged) so a compatible sender is never silently refused.
 */
export interface IntakeDTO {
  name: string;
  phoneRaw: string;
  phoneE164: string;
  email: string | null;
  message: string | null;
  interestCountry: string | null;
  interestCourse: string | null;
  city: string | null;
  neetScore: number | null;
  neetStatus: string | null;
  education: string | null;
  educationGroup: string | null;
  submittedBy: string | null;
  postSlug: string | null;
  gclid: string | null;
  campaignId: string | null;
  pageUrl: string | null;
  landingPage: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  formId: string | null;
  sessionId: string | null;
  sourceLabel: string | null;
  qualityFlags: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLE_PREFIXES = [
  'info',
  'admin',
  'contact',
  'support',
  'sales',
  'hello',
  'office',
  'noreply',
  'no-reply',
];

function str(body: Record<string, unknown>, keys: string[], max: number): string | null {
  for (const k of keys) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v).trim();
    if (s) return s.slice(0, max);
  }
  return null;
}

export function normalizeIntake(raw: unknown): IntakeDTO {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw invalid('The request body must be a JSON object.');
  const body = raw as Record<string, unknown>;
  const flags: string[] = [];

  const name = str(body, ['name', 'fullName', 'full_name'], 200);
  const phoneRaw = str(body, ['mobile', 'phone', 'phoneNumber', 'phone_number'], 30);
  const fields: Record<string, string> = {};
  if (!name) fields['name'] = 'Name is required.';
  if (!phoneRaw) fields['phone'] = 'Phone is required.';
  const phoneE164 = phoneRaw ? toE164(phoneRaw) : null;
  if (phoneRaw && !phoneE164) fields['phone'] = 'Phone number is not valid.';
  if (Object.keys(fields).length) throw invalid('Missing or invalid required fields.', { fields });

  let email = str(body, ['email'], 254)?.toLowerCase() ?? null;
  if (email && !EMAIL.test(email)) {
    flags.push('INVALID_EMAIL');
    email = null;
  } else if (email && ROLE_PREFIXES.includes(email.split('@')[0]!)) {
    flags.push('ROLE_EMAIL');
  }

  const scoreRaw = body['neet_score'] ?? body['neetScore'];
  let neetScore: number | null = null;
  if (scoreRaw !== undefined && scoreRaw !== null && scoreRaw !== '') {
    const digits = typeof scoreRaw === 'number' ? '' : String(scoreRaw).replace(/[^\d.-]/g, '');
    const n = typeof scoreRaw === 'number' ? scoreRaw : digits === '' ? Number.NaN : Number(digits);
    if (Number.isFinite(n) && n >= -180 && n <= 720) neetScore = Math.round(n);
    else flags.push('INVALID_NEET_SCORE');
  }

  return {
    name: name!,
    phoneRaw: phoneRaw!,
    phoneE164: phoneE164!,
    email,
    message: str(body, ['message', 'comments', 'query'], 5000),
    interestCountry: str(body, ['preferred_country', 'preferredCountry', 'country', 'interestCountry'], 100),
    interestCourse: str(body, ['course', 'interestCourse', 'interest_course'], 100),
    city: str(body, ['city', 'town'], 100),
    neetScore,
    neetStatus: str(body, ['neet_status', 'neetStatus'], 100),
    education: str(body, ['education'], 200),
    educationGroup: str(body, ['group', 'educationGroup', 'education_group'], 100),
    submittedBy: str(body, ['parent_student', 'parentStudent', 'submittedBy'], 50),
    postSlug: str(body, ['postSlug', 'post_slug'], 300),
    gclid: str(body, ['google_click_id', 'gclid'], 300),
    campaignId: str(body, ['campaign_id', 'campaignId'], 200),
    pageUrl: str(body, ['pageUrl', 'page_url'], 2000),
    landingPage: str(body, ['landingPage', 'landing_page'], 2000),
    utmSource: str(body, ['utm_source', 'utmSource'], 200),
    utmMedium: str(body, ['utm_medium', 'utmMedium'], 200),
    utmCampaign: str(body, ['utm_campaign', 'utmCampaign'], 200),
    utmTerm: str(body, ['utm_term', 'utmTerm'], 200),
    utmContent: str(body, ['utm_content', 'utmContent'], 200),
    formId: str(body, ['formId', 'form_id'], 200),
    sessionId: str(body, ['sessionId', 'session_id'], 200),
    sourceLabel: str(body, ['source'], 100),
    qualityFlags: flags,
  };
}

/** Maps a sender's free-text source to a tenant source code (unmapped → WEBSITE). */
export function sourceCodeFor(
  label: string | null,
  utmSource?: string | null,
  gclid?: string | null,
): string {
  const s = `${label ?? ''} ${utmSource ?? ''}`.toLowerCase();
  if (gclid || /google|adwords|gads/.test(s)) return 'GOOGLE_ADS';
  if (/meta|facebook|instagram|fb\b|\big\b/.test(s)) return 'META_ADS';
  if (/walk[\s-]?in/.test(s)) return 'WALK_IN';
  if (/referr|reference/.test(s)) return 'REFERENCE';
  return 'WEBSITE';
}

/** Parses an HTTP Basic Authorization header. */
export function parseBasicAuth(header: string | null): { username: string; secret: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=._-]+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i <= 0) return null;
  return { username: decoded.slice(0, i), secret: decoded.slice(i + 1) };
}
