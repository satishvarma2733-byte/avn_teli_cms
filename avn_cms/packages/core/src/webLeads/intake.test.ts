import { describe, expect, it } from 'vitest';

import type { AppError } from '../shared/errors';
import { EWINGS_BLOG, EWINGS_MAIN_SITE } from '../../../../tests/fixtures/ewings-payloads';
import { normalizeIntake, parseBasicAuth, sourceCodeFor } from './intake';

// Fixtures shared with the integration contract tests.
describe('normalizeIntake — LeadXP-compatible shapes', () => {
  it('maps the eWings main-site payload', () => {
    const dto = normalizeIntake(EWINGS_MAIN_SITE);
    expect(dto).toMatchObject({
      name: 'Test Student',
      phoneRaw: '9876543210',
      phoneE164: '+919876543210',
      email: 'student@example.test',
      message: 'Need details for MBBS abroad',
      submittedBy: 'Parent',
      education: 'Intermediate',
      educationGroup: 'BiPC',
      neetStatus: 'Qualified',
      neetScore: 512,
      interestCountry: 'Kyrgyzstan',
      gclid: 'Cj0KCQ-test',
      campaignId: '123456789',
      sourceLabel: 'Landing Page',
      qualityFlags: [],
    });
  });

  it('maps the eWings blog payload (string NEET score, missing email)', () => {
    const dto = normalizeIntake(JSON.parse(JSON.stringify(EWINGS_BLOG)));
    expect(dto).toMatchObject({
      phoneE164: '+919876543211',
      email: null,
      city: 'Guntur',
      neetScore: 498,
      postSlug: 'mbbs-in-georgia-fees',
      sourceLabel: 'blog_inline_cta',
    });
  });

  it('accepts null optional fields exactly as the PHP sender writes them', () => {
    const dto = normalizeIntake({
      ...EWINGS_MAIN_SITE,
      message: null,
      neet_score: null,
      preferred_country: null,
      google_click_id: null,
    });
    expect(dto).toMatchObject({ message: null, neetScore: null, interestCountry: null, gclid: null });
  });

  it('flags instead of rejecting a bad email or score', () => {
    const dto = normalizeIntake({ name: 'X', phone: '9876543210', email: 'not-an-email', neetScore: 'abc' });
    expect(dto.email).toBeNull();
    expect(dto.qualityFlags).toEqual(['INVALID_EMAIL', 'INVALID_NEET_SCORE']);
    expect(
      normalizeIntake({ name: 'X', phone: '9876543210', email: 'info@agency.test' }).qualityFlags,
    ).toEqual(['ROLE_EMAIL']);
  });

  it('rejects only what senders never send: no name, no/invalid phone, non-object', () => {
    const code = (b: unknown) => {
      try {
        normalizeIntake(b);
        return 'OK';
      } catch (e) {
        return (e as AppError).code;
      }
    };
    expect(code({ phone: '9876543210' })).toBe('VALIDATION_ERROR');
    expect(code({ name: 'X' })).toBe('VALIDATION_ERROR');
    expect(code({ name: 'X', mobile: '123' })).toBe('VALIDATION_ERROR');
    expect(code([1, 2])).toBe('VALIDATION_ERROR');
    expect(code('text')).toBe('VALIDATION_ERROR');
  });

  it('accepts utm attribution in either case style', () => {
    expect(
      normalizeIntake({ name: 'X', phone: '9876543210', utm_campaign: 'neet-2026', utmSource: 'google' }),
    ).toMatchObject({
      utmCampaign: 'neet-2026',
      utmSource: 'google',
    });
  });
});

describe('sourceCodeFor', () => {
  it('resolves common sender labels', () => {
    expect(sourceCodeFor('Landing Page')).toBe('WEBSITE');
    expect(sourceCodeFor('blog_inline_cta')).toBe('WEBSITE');
    expect(sourceCodeFor('Landing Page', null, 'gclid-x')).toBe('GOOGLE_ADS');
    expect(sourceCodeFor('Facebook lead form')).toBe('META_ADS');
    expect(sourceCodeFor(null, 'instagram')).toBe('META_ADS');
  });
});

describe('parseBasicAuth', () => {
  it('reads the header exactly as the eWings senders build it', () => {
    const header = 'Basic ' + Buffer.from('wl_abcd1234:s3cr3t:with:colons').toString('base64');
    expect(parseBasicAuth(header)).toEqual({ username: 'wl_abcd1234', secret: 's3cr3t:with:colons' });
    expect(parseBasicAuth('Bearer x')).toBeNull();
    expect(parseBasicAuth('Basic ' + Buffer.from('nocolon').toString('base64'))).toBeNull();
    expect(parseBasicAuth(null)).toBeNull();
  });
});
