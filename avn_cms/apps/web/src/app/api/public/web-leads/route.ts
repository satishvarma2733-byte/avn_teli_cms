import type { NextRequest } from 'next/server';

import { handleIntake } from '@/lib/intake';

/** aVn CMS's own public intake (same credentials and pipeline as /api/webleads). */
export function POST(req: NextRequest) {
  return handleIntake(req, 'PUBLIC_API');
}
