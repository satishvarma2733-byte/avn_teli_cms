import type { Instrumentation } from 'next';

/**
 * Errors Next.js itself catches (a page that failed to render, a server action) go to the same JSON log as
 * the API's, so one alert on `"level":"error"` sees all of them (docs/RUNBOOK.md "Monitoring"). API routes
 * log their own failures with a request id (lib/api.ts).
 *
 * Only the route, the method and the error are recorded: never headers (they carry the session cookie) or
 * the query string (search text, phone numbers). The `digest` is the id Next shows on its error page.
 */
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  const error = err instanceof Error ? err : new Error(String(err));
  const digest = typeof err === 'object' && err !== null && 'digest' in err ? String(err.digest) : undefined;
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'render error',
      method: request.method,
      path: request.path.split('?')[0],
      route: context.routePath,
      routeType: context.routeType,
      ...(digest ? { digest } : {}),
      error: error.stack ?? error.message,
    }),
  );
};
