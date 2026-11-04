'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';

export interface MfaResetOutcome {
  id: string;
  name: string;
  /** Their role has to use two-step verification, so they set it up again at the next sign-in. */
  reenrolmentRequired: boolean;
  sessionsRevoked: number;
  notified: { inApp: boolean; email: boolean };
}

/** What to tell the admin once it is done. */
export function resetMfaMessage(r: MfaResetOutcome): string {
  const told = r.notified.email
    ? 'We emailed them and left a notification.'
    : 'Email isn’t set up, so they will only see the notification in the app after they sign in. Let them know yourself.';
  const next = r.reenrolmentRequired
    ? 'Their role has to use two-step verification, so they set it up again at their next sign-in.'
    : 'They can turn it back on from My account.';
  return `Two-step verification was reset for ${r.name} and they were signed out of every device. ${next} ${told}`;
}

/**
 * Asks why and for the admin's own password, then resets someone's two-step verification. Used by workspace
 * admins (Users) and by super admins (platform console): only the endpoint differs.
 */
export function ResetMfaDialog({
  personName,
  endpoint,
  onClose,
  onDone,
}: {
  personName: string;
  endpoint: string;
  onClose: () => void;
  onDone: (outcome: MfaResetOutcome) => void;
}) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    setFields({});
    setError(null);
    const res = await api<MfaResetOutcome>(endpoint, { body: { reason, currentPassword: password } });
    setBusy(false);
    if (!res.ok) {
      setFields(res.error.details?.fields ?? {});
      if (!res.error.details?.fields) setError(res.error.message);
      return;
    }
    onDone(res.data);
  }

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={`Reset two-step verification for ${personName}?`}
      description="Use this when they have lost their phone and their recovery codes. They are signed out of every device and told by email and in the app."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="reset-mfa-form"
            variant="danger"
            loading={busy}
            disabled={reason.trim().length < 5 || !password}
          >
            Reset two-step verification
          </Button>
        </>
      }
    >
      <form
        id="reset-mfa-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void reset();
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <p className="text-sm text-muted-foreground">
          Make sure it really is them first (a call or in person), not just a message. Anyone who knows their
          password can sign in until they set it up again.
        </p>
        <Field
          id="mfa-reset-reason"
          label="Why are you resetting it?"
          hint="Kept in the audit log."
          required
          error={fields['reason']}
        >
          <Textarea
            id="mfa-reset-reason"
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Field
          id="mfa-reset-password"
          label="Your password"
          hint="Confirm it is you doing this."
          required
          error={fields['currentPassword']}
        >
          <Input
            id="mfa-reset-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
