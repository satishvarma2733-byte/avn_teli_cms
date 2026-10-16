import type { NextRequest } from 'next/server';

import { handleIntake } from '@/lib/intake';

/**
 * LeadXP-compatible intake: same path as https://leadxp.aikosoft.ai/api/webleads, so a site
 * that posts there today can switch by changing LEAD_API_URL + credentials only.
 * Contract: docs/WEBLEADS_COMPATIBILITY.md.
 */
export function POST(req: NextRequest) {
  return handleIntake(req, 'LEADXP_COMPAT');
}
