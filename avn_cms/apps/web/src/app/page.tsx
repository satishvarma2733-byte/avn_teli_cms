import { redirect } from 'next/navigation';

import { getPrincipal, landingPath } from '@/lib/session';

/** "/" → role-aware landing (PAGES_AND_ROUTES). */
export default async function Home() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (principal.mfaEnabled && !principal.mfaVerified) redirect('/login/mfa');
  redirect(landingPath(principal));
}
