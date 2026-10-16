'use client';

import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, CardHeader, EmptyState, type Tone } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatDate } from '@/lib/format';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'TRIAL';
  plan: { name: string; code: string } | null;
  createdAt: string;
  users: number;
  leads: number;
}

const TONE: Record<Tenant['status'], Tone> = { ACTIVE: 'success', TRIAL: 'info', SUSPENDED: 'danger' };

export function TenantsPanel({ initial }: { initial: Tenant[] }) {
  const api = useApi();
  const [items, setItems] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'danger' | 'warning';
    text: React.ReactNode;
  } | null>(null);
  const [confirm, setConfirm] = useState<{ tenant: Tenant; kind: 'suspend' | 'impersonate' } | null>(null);

  async function reload() {
    const res = await api<Tenant[]>('/api/platform/tenants');
    if (res.ok) setItems(res.data);
  }

  async function setStatus(t: Tenant, status: Tenant['status']) {
    const res = await api(`/api/platform/tenants/${t.id}`, { method: 'PATCH', body: { status } });
    setConfirm(null);
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    setNotice({ tone: 'success', text: `${t.name} is now ${status.toLowerCase()}.` });
    reload();
  }

  async function impersonate(t: Tenant) {
    const res = await api<{ redirectTo: string }>(`/api/platform/tenants/${t.id}/impersonate`, {
      method: 'POST',
    });
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    window.location.assign(res.data.redirectTo);
  }

  return (
    <div className="space-y-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader
          title="Agencies"
          actions={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> New agency
            </Button>
          }
        />
        {items.length === 0 ? (
          <EmptyState icon={<Building2 />} title="No agencies yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2.5 font-medium">Agency</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 text-right font-medium">Users</th>
                  <th className="px-4 py-2.5 text-right font-medium">Leads</th>
                  <th className="px-4 py-2.5 font-medium">Since</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs text-muted-foreground">{t.slug}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={TONE[t.status]}>{t.status.toLowerCase()}</Badge>
                    </td>
                    <td className="px-4 py-3">{t.plan?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{t.users}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{t.leads.toLocaleString('en-IN')}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(t.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setConfirm({ tenant: t, kind: 'impersonate' })}
                        >
                          Open as admin
                        </Button>
                        {t.status === 'SUSPENDED' ? (
                          <Button size="sm" variant="ghost" onClick={() => setStatus(t, 'ACTIVE')}>
                            Reactivate
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-danger"
                            onClick={() => setConfirm({ tenant: t, kind: 'suspend' })}
                          >
                            Suspend
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && (
        <CreateTenantDialog
          onClose={() => setCreating(false)}
          onDone={(r) => {
            setCreating(false);
            setNotice(
              r.invite.emailed
                ? {
                    tone: 'success',
                    text: `Workspace “${r.slug}” created. The admin was emailed a link to set their password.`,
                  }
                : {
                    tone: 'warning',
                    text: (
                      <>
                        Workspace “{r.slug}” created. Email isn&apos;t configured — send the admin this
                        one-time link (expires in 72 hours):{' '}
                        <code className="break-all text-xs">{r.invite.link}</code>
                      </>
                    ),
                  },
            );
            reload();
          }}
        />
      )}

      {confirm && (
        <Dialog
          open
          size="sm"
          onOpenChange={() => setConfirm(null)}
          title={
            confirm.kind === 'suspend'
              ? `Suspend ${confirm.tenant.name}?`
              : `Open ${confirm.tenant.name} as admin?`
          }
          description={
            confirm.kind === 'suspend'
              ? 'Everyone in this agency is signed out and can’t sign in. Their website intake stops (401). Data is kept.'
              : 'You will see this agency’s data. The start, everything you do, and the stop are written to the agency’s audit log.'
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={confirm.kind === 'suspend' ? 'danger' : 'primary'}
                onClick={() =>
                  confirm.kind === 'suspend'
                    ? setStatus(confirm.tenant, 'SUSPENDED')
                    : impersonate(confirm.tenant)
                }
              >
                {confirm.kind === 'suspend' ? 'Suspend' : 'Open'}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

function CreateTenantDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (r: { slug: string; invite: { emailed: boolean; link?: string } }) => void;
}) {
  const api = useApi();
  const [f, setF] = useState({ name: '', slug: '', planCode: 'STARTER', adminName: '', adminEmail: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setFields({});
    setError(null);
    const res = await api<{ slug: string; invite: { emailed: boolean; link?: string } }>(
      '/api/platform/tenants',
      { body: f },
    );
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
      title="New agency"
      description="Creates the workspace, its default lead sources and its first admin."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {error && (
          <div className="sm:col-span-2">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
        <Field id="t-name" label="Agency name" required error={fields['name']}>
          <Input id="t-name" value={f.name} onChange={set('name')} />
        </Field>
        <Field
          id="t-slug"
          label="Workspace"
          hint="Used at sign-in, e.g. “ewings”."
          required
          error={fields['slug']}
        >
          <Input id="t-slug" value={f.slug} onChange={set('slug')} />
        </Field>
        <Field id="t-plan" label="Plan">
          <Select id="t-plan" value={f.planCode} onChange={set('planCode')}>
            <option value="STARTER">Starter</option>
            <option value="PROFESSIONAL">Professional</option>
            <option value="ULTRA">Ultra</option>
            <option value="ENTERPRISE">Enterprise</option>
          </Select>
        </Field>
        <div />
        <Field id="t-admin" label="Admin name" required error={fields['adminName']}>
          <Input id="t-admin" value={f.adminName} onChange={set('adminName')} />
        </Field>
        <Field id="t-email" label="Admin email" required error={fields['adminEmail']}>
          <Input id="t-email" type="email" value={f.adminEmail} onChange={set('adminEmail')} />
        </Field>
      </div>
    </Dialog>
  );
}
