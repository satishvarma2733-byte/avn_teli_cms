'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/primitives';
import { apiRequest } from '@/lib/client';

export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldError(undefined);
    if (password !== confirm) {
      setFieldError('The two passwords do not match.');
      return;
    }
    setLoading(true);
    const res = await apiRequest<{ redirectTo: string }>('/api/auth/reset-password', {
      body: { token, password },
    });
    setLoading(false);
    if (res.ok) window.location.assign(res.data.redirectTo);
    else {
      setFieldError(res.error.details?.fields?.['password']);
      if (!res.error.details?.fields?.['password']) setError(res.error.message);
    }
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        At least 12 characters, mixing letters with numbers or symbols.
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        {error && (
          <Alert tone="danger">
            {error}{' '}
            <Link href="/forgot-password" className="font-medium underline">
              Request a new link
            </Link>
          </Alert>
        )}
        <Field id="password" label="New password" required error={fieldError}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(fieldError)}
          />
        </Field>
        <Field id="confirm" label="Repeat new password" required>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={loading}>
          Set new password
        </Button>
      </form>
    </>
  );
}
