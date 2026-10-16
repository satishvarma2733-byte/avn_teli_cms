import { reports } from '@avn-cms/core';
import { reportQuerySchema } from '@avn-cms/core/schemas';

import { errorResponse, ok, query, route } from '@/lib/api';

/** GET /api/reports/{dashboard|funnel|sources|team|status|followups} */
export const GET = route({ limit: 120 }, async ({ req, ctx, params }) => {
  const q = query(req, reportQuerySchema);
  switch (params['report']) {
    case 'dashboard':
      return ok(await reports.dashboard(ctx));
    case 'funnel':
      return ok(await reports.funnel(ctx, q));
    case 'sources':
      return ok(await reports.sources(ctx, q));
    case 'team':
      return ok(await reports.team(ctx, q));
    case 'status':
      return ok(await reports.stageDistribution(ctx, q));
    case 'followups':
      return ok(await reports.followupStats(ctx, q));
    default:
      return errorResponse('NOT_FOUND', 'Unknown report.');
  }
});
