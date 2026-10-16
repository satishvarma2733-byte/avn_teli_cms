'use client';

import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Alert, Badge, Card, CardHeader, EmptyState, Skeleton } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatDateTime, formatRelative } from '@/lib/format';

interface Credential {
  id: string;
  name: string;
  username: string;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  revokedAt: string | null;
  previousValidUntil: string | null;
}

interface Revealed {
  name: string;
  username: string;
  secret: string;
  authorization: string;
  rotated?: boolean;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs">
          {value}
        </code>
        <Button
          variant="secondary"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

export function IntegrationsPanel({ endpoint }: { endpoint: string }) {
  const api = useApi();
  const [items, setItems] = useState<Credential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<Credential | null>(null);

  const load = useCallback(async () => {
    const res = await api<Credential[]>('/api/settings/intake-credentials');
    if (res.ok) setItems(res.data);
    else setError(res.error.message);
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    const res = await api<Revealed>('/api/settings/intake-credentials', { body: { name } });
    setBusy(false);
    if (!res.ok) return setError(res.error.details?.fields?.['name'] ?? res.error.message);
    setCreating(false);
    setName('');
    setRevealed({ ...res.data, name });
    load();
  }

  async function rotate(c: Credential) {
    const res = await api<Revealed>(`/api/settings/intake-credentials/${c.id}/rotate`, { method: 'POST' });
    if (!res.ok) return setError(res.error.message);
    setRevealed({ ...res.data, name: c.name, rotated: true });
    load();
  }

  async function revoke(c: Credential) {
    const res = await api(`/api/settings/intake-credentials/${c.id}`, { method: 'DELETE' });
    setConfirmRevoke(null);
    if (!res.ok) return setError(res.error.message);
    load();
  }

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        <CardHeader
          title="Web-lead credentials"
          description="One per website. Each request authenticates with HTTP Basic (username + secret)."
          actions={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> New credential
            </Button>
          }
        />
        {!items ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<KeyRound />}
            title="No websites connected yet"
            description="Create a credential for each site that should send enquiries."
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    {c.revokedAt ? (
                      <Badge tone="danger">Revoked</Badge>
                    ) : (
                      <Badge tone="success">Active</Badge>
                    )}
                    {c.previousValidUntil &&
                      !c.revokedAt &&
                      new Date(c.previousValidUntil).getTime() > Date.now() && (
                        <Badge tone="warning">
                          Old secret valid until {formatDateTime(c.previousValidUntil)}
                        </Badge>
                      )}
                  </div>
                  <p className="text-muted-foreground">
                    <code className="text-xs">{c.username}</code> · {c.useCount.toLocaleString('en-IN')}{' '}
                    requests · last used {c.lastUsedAt ? formatRelative(c.lastUsedAt) : 'never'}
                  </p>
                </div>
                {!c.revokedAt && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => rotate(c)}>
                      Rotate secret
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      onClick={() => setConfirmRevoke(c)}
                    >
                      Revoke
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="How a website sends leads"
          description="Same request format as the LeadXP web-leads API, so existing forms only need new settings."
        />
        <div className="space-y-3 p-5 text-sm">
          <CopyField label="Endpoint (POST, JSON)" value={endpoint} />
          <p className="text-muted-foreground">
            Required fields: <code>name</code> and <code>mobile</code> (or <code>phone</code>). Everything
            else — email, message, NEET score, country, UTM tags, Google click id, page URL — is optional and
            stored for attribution. Responses: <code>201</code> stored, <code>401</code> bad credentials,{' '}
            <code>422</code> missing name/phone, <code>429</code> too many requests.
          </p>
        </div>
      </Card>

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New web-lead credential"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy} disabled={!name.trim()}>
              Create
            </Button>
          </>
        }
      >
        <Field id="cred-name" label="Name" hint="Which website or form uses it, e.g. “Main website”.">
          <Input id="cred-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      </Dialog>

      {revealed && (
        <Dialog
          open
          onOpenChange={() => setRevealed(null)}
          size="lg"
          title={
            revealed.rotated ? `New secret for ${revealed.name}` : `Credential created: ${revealed.name}`
          }
          description="Copy these now. The secret is shown only once and can't be recovered — rotate it if it is lost."
          footer={<Button onClick={() => setRevealed(null)}>I have saved it</Button>}
        >
          <div className="space-y-4">
            {revealed.rotated && (
              <Alert tone="warning">
                The previous secret keeps working for 24 hours so you can update the website without downtime.
              </Alert>
            )}
            <CopyField label="Username" value={revealed.username} />
            <CopyField label="Secret" value={revealed.secret} />
            <CopyField label="Authorization header" value={revealed.authorization} />
          </div>
        </Dialog>
      )}

      {confirmRevoke && (
        <Dialog
          open
          size="sm"
          onOpenChange={() => setConfirmRevoke(null)}
          title={`Revoke “${confirmRevoke.name}”?`}
          description="The website using it will get 401 errors immediately and its enquiries will stop arriving."
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmRevoke(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => revoke(confirmRevoke)}>
                Revoke
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
