'use client';

import { Laptop } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { MfaCard } from '@/components/account/mfa-card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Badge, Card, CardHeader } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatRelative } from '@/lib/format';

interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

function deviceName(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

export function AccountPanel({
  mfaEnabled,
  recoveryCodesLeft,
  mfaRequired,
}: {
  mfaEnabled: boolean;
  recoveryCodesLeft: number;
  mfaRequired: boolean;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <PasswordCard />
      <MfaCard initiallyEnabled={mfaEnabled} recoveryCodesLeft={recoveryCodesLeft} required={mfaRequired} />
      <div className="lg:col-span-2">
        <SessionsCard />
      </div>
    </div>
  );
}

function PasswordCard() {
  const api = useApi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setFields({});
    setMsg(null);
    if (next !== confirm) return setFields({ confirm: 'The two passwords do not match.' });
    setBusy(true);
    const res = await api('/api/account/password', { body: { currentPassword: current, newPassword: next } });
    setBusy(false);
    if (!res.ok) {
      setFields(res.error.details?.fields ?? {});
      return setMsg({ tone: 'danger', text: res.error.message });
    }
    setCurrent('');
    setNext('');
    setConfirm('');
    setMsg({ tone: 'success', text: 'Password changed. Your other devices were signed out.' });
  }

  return (
    <Card>
      <CardHeader
        title="Password"
        description="At least 12 characters, mixing letters with numbers or symbols."
      />
      <div className="space-y-4 p-5">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Field id="pw-current" label="Current password" error={fields['currentPassword']}>
          <Input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field id="pw-new" label="New password" error={fields['newPassword']}>
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field id="pw-confirm" label="Repeat new password" error={fields['confirm']}>
          <Input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button onClick={save} loading={busy} disabled={!current || !next}>
          Change password
        </Button>
      </div>
    </Card>
  );
}

function SessionsCard() {
  const api = useApi();
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await api<SessionRow[]>('/api/auth/sessions');
    if (res.ok) setRows(res.data);
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <CardHeader
        title="Where you're signed in"
        actions={
          rows.length > 1 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const res = await api<{ revoked: number }>('/api/auth/sessions', { method: 'DELETE' });
                if (res.ok) setMsg(`Signed out ${res.data.revoked} other session(s).`);
                load();
              }}
            >
              Sign out other devices
            </Button>
          )
        }
      />
      {msg && (
        <div className="px-5 pt-4">
          <Alert tone="success">{msg}</Alert>
        </div>
      )}
      <ul className="divide-y divide-border">
        {rows.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
            <div className="flex items-center gap-3">
              <Laptop className="size-4 text-muted-foreground" />
              <div>
                <p className="font-medium">
                  {deviceName(s.userAgent)} {s.current && <Badge tone="success">This device</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {s.ip ?? 'Unknown IP'} · signed in {formatRelative(s.createdAt)} · active{' '}
                  {formatRelative(s.lastSeenAt)}
                </p>
              </div>
            </div>
            {!s.current && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' });
                  load();
                }}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
