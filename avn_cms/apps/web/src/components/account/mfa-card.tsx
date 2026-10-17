'use client';

import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Badge, Card, CardHeader } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';

/**
 * Two-step verification: turn it on (password → authenticator app → recovery codes), get new recovery
 * codes, turn it off. Shared by My account and the setup page for roles that must use it.
 */
export function MfaCard({
  initiallyEnabled,
  recoveryCodesLeft,
  required = false,
  onEnabled,
}: {
  initiallyEnabled: boolean;
  recoveryCodesLeft: number;
  /** The role has to use it: it can be turned on but not off. */
  required?: boolean;
  onEnabled?: () => void;
}) {
  const api = useApi();
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [left, setLeft] = useState(recoveryCodesLeft);
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'codes' | 'disable' | 'regenerate'>('idle');
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setStep('idle');
    setPassword('');
    setCode('');
    setFieldError(undefined);
  };

  async function begin() {
    setBusy(true);
    setMsg(null);
    setFieldError(undefined);
    const res = await api<{ secret: string; qr: string }>('/api/auth/mfa/enroll', {
      body: { currentPassword: password },
    });
    setBusy(false);
    if (!res.ok) return setFieldError(res.error.details?.fields?.['currentPassword'] ?? res.error.message);
    setSetup(res.data);
    setPassword('');
    setStep('scan');
  }

  async function confirm() {
    setBusy(true);
    setMsg(null);
    const res = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/confirm', { body: { code } });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: 'danger', text: res.error.message });
    setEnabled(true);
    setLeft(res.data.recoveryCodes.length);
    setSetup(null);
    setCode('');
    setCodes(res.data.recoveryCodes);
    setSaved(false);
    setStep('codes');
  }

  async function regenerate() {
    setBusy(true);
    setMsg(null);
    const res = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', { body: { code } });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: 'danger', text: res.error.message });
    setLeft(res.data.recoveryCodes.length);
    setCode('');
    setCodes(res.data.recoveryCodes);
    setSaved(false);
    setStep('codes');
  }

  async function disable() {
    setBusy(true);
    setMsg(null);
    const res = await api('/api/auth/mfa/disable', { body: { code } });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: 'danger', text: res.error.message });
    setEnabled(false);
    setLeft(0);
    reset();
    setMsg({ tone: 'success', text: 'Two-step verification is off. Your other devices were signed out.' });
  }

  function finishCodes() {
    setCodes(null);
    setStep('idle');
    setMsg({
      tone: 'success',
      text: 'Two-step verification is on. You will be asked for a code at each sign-in.',
    });
    onEnabled?.();
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText((codes ?? []).join('\n'));
      setMsg({ tone: 'success', text: 'Recovery codes copied.' });
    } catch {
      setMsg({ tone: 'danger', text: 'Could not copy. Write the codes down or download them instead.' });
    }
  }

  function downloadCodes() {
    const text = `aVn CMS recovery codes\nEach code works once. Keep this file somewhere safe.\n\n${(codes ?? []).join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'avn-cms-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  const codeInput = (label: string) => (
    <Field id="mfa-code" label={label} error={undefined}>
      <Input
        id="mfa-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={20}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="w-48 text-center tracking-[0.2em]"
      />
    </Field>
  );

  return (
    <Card>
      <CardHeader
        title="Two-step verification"
        description="A 6-digit code from an authenticator app at each sign-in."
        actions={
          enabled ? (
            <Badge tone="success">
              <ShieldCheck className="size-3" /> On
            </Badge>
          ) : (
            <Badge>
              <ShieldOff className="size-3" /> Off
            </Badge>
          )
        }
      />
      <div className="space-y-4 p-5 text-sm">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {required && !enabled && (
          <Alert tone="warning" title="Your role has to use two-step verification">
            Turn it on to keep using aVn CMS.
          </Alert>
        )}

        {!enabled && step === 'idle' && (
          <Button onClick={() => setStep('password')}>Set up two-step verification</Button>
        )}

        {!enabled && step === 'password' && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void begin();
            }}
          >
            <Field
              id="mfa-password"
              label="Your password"
              hint="Confirm it is you before adding a code generator."
              error={fieldError}
            >
              <Input
                id="mfa-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" loading={busy} disabled={!password}>
                Continue
              </Button>
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {step === 'scan' && setup && (
          <div className="space-y-4">
            <p>
              Scan this with Google Authenticator, Microsoft Authenticator or similar, then enter the code it
              shows.
            </p>
            {/* A data: image of the QR code made by our own server. */}
            <img
              src={setup.qr}
              alt="QR code for your authenticator app"
              className="size-48 rounded-lg border border-border bg-white p-2"
            />
            <p className="text-muted-foreground">
              Can&apos;t scan? Enter this key:{' '}
              <code className="break-all text-foreground">{setup.secret}</code>
            </p>
            <div className="flex items-end gap-2">
              <Field id="mfa-confirm" label="Verification code">
                <Input
                  id="mfa-confirm"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="w-36 text-center tracking-[0.3em]"
                />
              </Field>
              <Button onClick={confirm} loading={busy} disabled={code.length !== 6}>
                Turn on
              </Button>
            </div>
          </div>
        )}

        {step === 'codes' && codes && (
          <div className="space-y-4">
            <Alert tone="warning" title="Save your recovery codes now">
              Each code works once, if you lose your phone. They are shown only this one time.
            </Alert>
            <ol className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-muted p-3 font-mono text-sm">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={copyCodes}>
                <Copy /> Copy
              </Button>
              <Button variant="secondary" size="sm" onClick={downloadCodes}>
                <Download /> Download
              </Button>
            </div>
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
              />
              I have saved my recovery codes
            </label>
            <Button onClick={finishCodes} disabled={!saved}>
              Done
            </Button>
          </div>
        )}

        {enabled && step === 'idle' && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-muted-foreground">
              <KeyRound className="size-4" aria-hidden />
              {left === 0
                ? 'You have no recovery codes left.'
                : `${left} recovery ${left === 1 ? 'code' : 'codes'} left.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setStep('regenerate')}>
                Get new recovery codes
              </Button>
              {!required && (
                <Button variant="secondary" onClick={() => setStep('disable')}>
                  Turn off
                </Button>
              )}
            </div>
          </div>
        )}

        {enabled && step === 'regenerate' && (
          <div className="space-y-2">
            <p>Enter a current code. The old recovery codes stop working.</p>
            <div className="flex items-end gap-2">
              {codeInput('Verification code')}
              <Button onClick={regenerate} loading={busy} disabled={code.trim().length < 6}>
                Get new codes
              </Button>
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {enabled && step === 'disable' && (
          <div className="space-y-2">
            <p>Enter a current code (or a recovery code) to turn two-step verification off.</p>
            <div className="flex items-end gap-2">
              {codeInput('Verification code')}
              <Button variant="danger" onClick={disable} loading={busy} disabled={code.trim().length < 6}>
                Turn off
              </Button>
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
