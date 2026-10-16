'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/primitives';
import { apiRequest } from '@/lib/client';

const WORKSPACE_KEY = 'avn-cms:last-workspace';

export function LoginForm({ next, reset }: { next?: string | undefined; reset?: boolean }) {
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      setWorkspace(localStorage.getItem(WORKSPACE_KEY) ?? '');
    } catch {
      /* storage unavailable */
    }
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setFields({});
    const res = await apiRequest<{ redirectTo: string }>('/api/auth/login', {
      body: { workspace, email, password },
    });
    if (!res.ok) {
      setLoading(false);
      setFields(res.error.details?.fields ?? {});
      setError(res.error.code === 'VALIDATION_ERROR' ? null : res.error.message);
      return;
    }
    try {
      localStorage.setItem(WORKSPACE_KEY, workspace.trim().toLowerCase());
    } catch {
      /* ignore */
    }
    window.location.assign(
      res.data.redirectTo === '/login/mfa' ? '/login/mfa' : (next ?? res.data.redirectTo),
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
      {reset && <Alert tone="success">Your password was changed. Sign in with the new one.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Field
        id="workspace"
        label="Workspace"
        hint="Your agency's workspace name. Leave empty for platform admins."
        error={fields['workspace']}
      >
        <Input
          id="workspace"
          name="workspace"
          autoComplete="organization"
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder="e.g. demo"
          aria-invalid={Boolean(fields['workspace'])}
        />
      </Field>
      <Field id="email" label="Email" required error={fields['email']}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(fields['email'])}
        />
      </Field>
      <Field id="password" label="Password" required error={fields['password']}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={Boolean(fields['password'])}
        />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={loading}>
        Sign in
      </Button>
      <p className="text-center text-sm">
        <Link href="/forgot-password" className="text-primary hover:underline">
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}
