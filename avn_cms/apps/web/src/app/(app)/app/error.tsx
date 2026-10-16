'use client';

import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';

/** Route-level error boundary: the shell stays usable and nothing internal is shown. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-lg space-y-4 py-16">
      <Alert tone="danger" title="This page didn't load">
        Something went wrong on our side. Try again; if it keeps happening, share this reference with your
        admin: <code>{error.digest ?? 'n/a'}</code>
      </Alert>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
