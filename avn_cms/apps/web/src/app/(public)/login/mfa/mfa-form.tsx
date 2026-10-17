'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/primitives';
import { apiRequest } from '@/lib/client';

interface Verified {
  redirectTo: string;
  usedRecoveryCode: boolean;
  recoveryCodesLeft: number;
}

/** Second-factor form for a signed-in session that hasn't passed MFA yet: an app code or a recovery code. */
export function MfaForm({ csrf }: { csrf: string }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verified, setVerified] = useState<Verified | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await apiRequest<Verified>('/api/auth/mfa/verify', { body: { code }, csrf });
    setLoading(false);
    if (!res.ok) return setError(res.error.details?.fields?.['code'] ?? res.error.message);
    // A recovery code is used up: say so, before moving on.
    if (res.data.usedRecoveryCode) setVerified(res.data);
    else window.location.assign(res.data.redirectTo);
  }

  async function signOut() {
    await apiRequest('/api/auth/logout', { method: 'POST', csrf });
    window.location.assign('/login');
  }

  if (verified) {
    return (
      <div className="mt-6 space-y-4">
        <Alert tone="warning" title="You signed in with a recovery code">
          That code is used up. You have {verified.recoveryCodesLeft} left
          {verified.recoveryCodesLeft <= 3 ? '. Get a new set from My account soon' : ''}.
        </Alert>
        <Button className="w-full" size="lg" onClick={() => window.location.assign(verified.redirectTo)}>
          Continue
        </Button>
      </div>
    );
  }

  const ready = recovery ? code.replace(/[\s-]/g, '').length >= 10 : code.length === 6;
  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field
        id="code"
        label={recovery ? 'Recovery code' : 'Verification code'}
        hint={recovery ? 'One of the codes you saved when you turned this on. Each works once.' : undefined}
        required
      >
        <Input
          id="code"
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          maxLength={recovery ? 14 : 6}
          value={code}
          onChange={(e) =>
            setCode(recovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ''))
          }
          className="text-center text-lg tracking-[0.3em]"
        />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={loading} disabled={!ready}>
        Verify
      </Button>
      <button
        type="button"
        onClick={() => {
          setRecovery((r) => !r);
          setCode('');
          setError(null);
        }}
        className="block w-full text-center text-sm text-primary hover:underline"
      >
        {recovery ? 'Use the code from my app instead' : 'Use a recovery code instead'}
      </button>
      <button
        type="button"
        onClick={signOut}
        className="block w-full text-center text-sm text-muted-foreground hover:text-foreground"
      >
        Use a different account
      </button>
    </form>
  );
}
