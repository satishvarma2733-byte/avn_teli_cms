import Link from 'next/link';

import { Brand } from '@/components/brand';
import { buttonVariants } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <Brand />
      <h1 className="text-xl font-semibold">We couldn&apos;t find that page</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        It may have been removed, or you may not have access to it.
      </p>
      <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
        Go to your dashboard
      </Link>
    </main>
  );
}
