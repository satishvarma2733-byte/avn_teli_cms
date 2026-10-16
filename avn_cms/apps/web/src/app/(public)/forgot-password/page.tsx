'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/primitives';
import { apiRequest } from '@/lib/client';

export default function ForgotPasswordPage() {
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await apiRequest<{ message: string }>('/api/auth/forgot-password', {
      body: { workspace, email },
    });
    setLoading(false);
    if (res.ok) setDone(res.data.message);
    else setError(res.error.details?.fields?.['email'] ?? res.error.message);
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Reset your password</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        We will email you a link that works once and expires in an hour.
      </p>
      {done ? (
        <div className="mt-6 space-y-4">
          <Alert tone="success">{done}</Alert>
          <Link href="/login" className="block text-center text-sm text-primary hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field id="workspace" label="Workspace">
            <Input
              id="workspace"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="e.g. demo"
            />
          </Field>
          <Field id="email" label="Email" required>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full" size="lg" loading={loading}>
            Email me a reset link
          </Button>
          <Link href="/login" className="block text-center text-sm text-primary hover:underline">
            Back to sign in
          </Link>
        </form>
      )}
    </>
  );
}
