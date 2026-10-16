import type { NextRequest } from 'next/server';

import { handleIntake } from '@/lib/intake';

/** Generic landing-page webhook (same credentials and pipeline as /api/webleads). */
export function POST(req: NextRequest) {
  return handleIntake(req, 'WEBHOOK');
}
