'use client';

import Link from 'next/link';

import { MfaCard } from '@/components/account/mfa-card';
import { buttonVariants } from '@/components/ui/button';
import { CsrfProvider } from '@/lib/client';

/** The two-step verification card on its own page, with a way on once it is on. */
export function MfaSetup({
  csrf,
  enabled,
  recoveryCodesLeft,
  next,
}: {
  csrf: string;
  enabled: boolean;
  recoveryCodesLeft: number;
  next: string;
}) {
  return (
    <CsrfProvider token={csrf}>
      <MfaCard initiallyEnabled={enabled} recoveryCodesLeft={recoveryCodesLeft} required />
      <Link href={next} className={`${buttonVariants({ variant: 'secondary' })} mt-4 w-full`}>
        Continue
      </Link>
    </CsrfProvider>
  );
}
