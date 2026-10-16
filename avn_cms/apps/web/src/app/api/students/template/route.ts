import { authorize, imports } from '@avn-cms/core';

import { route } from '@/lib/api';

/** Downloadable CSV template with every importable column and one example row. */
export const GET = route({}, async ({ ctx }) => {
  authorize(ctx, 'import:run');
  return new Response(imports.templateCsv(), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="avn-cms-student-import-template.csv"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
