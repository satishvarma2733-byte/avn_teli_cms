'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/primitives';
import { apiRequest } from '@/lib/client';

/** Second-factor form for a signed-in session that hasn't passed MFA yet. */
export function MfaForm({ csrf }: { csrf: string }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await apiRequest<{ redirectTo: string }>('/api/auth/mfa/verify', { body: { code }, csrf });
    setLoading(false);
    if (res.ok) window.location.assign(res.data.redirectTo);
    else setError(res.error.details?.fields?.['code'] ?? res.error.message);
  }

  async function signOut() {
    await apiRequest('/api/auth/logout', { method: 'POST', csrf });
    window.location.assign('/login');
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field id="code" label="Verification code" required>
        <Input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="text-center text-lg tracking-[0.4em]"
        />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={loading} disabled={code.length !== 6}>
        Verify
      </Button>
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
