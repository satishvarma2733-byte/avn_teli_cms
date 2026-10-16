'use client';

import { MoreHorizontal, Plus, ShieldCheck, UserPlus } from 'lucide-react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatRelative } from '@/lib/format';

interface User {
  id: string;
  name: string;
  email: string;
  phoneE164: string | null;
  roleCode: 'TENANT_ADMIN' | 'COUNSELOR' | 'TELECALLER';
  status: 'ACTIVE' | 'DISABLED';
  lastLoginAt: string | null;
  mfaEnabled: boolean;
  activeLeads: number;
  openCalls: number;
}

const ROLE: Record<string, string> = {
  TENANT_ADMIN: 'Admin',
  COUNSELOR: 'Counselor',
  TELECALLER: 'Telecaller',
};

type InviteResult = { emailed: true } | { emailed: false; link: string };

export function UsersTable({ currentUserId }: { currentUserId: string }) {
  const api = useApi();
  const [items, setItems] = useState<User[] | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'danger' | 'warning';
    text: React.ReactNode;
  } | null>(null);
  const [dialog, setDialog] = useState<
    null | { kind: 'invite' } | { kind: 'edit' | 'transfer' | 'delete'; user: User }
  >(null);

  const load = useCallback(async () => {
    const res = await api<User[]>('/api/users');
    if (res.ok) setItems(res.data);
    else setNotice({ tone: 'danger', text: res.error.message });
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  const showLink = (prefix: string, r: InviteResult) =>
    r.emailed
      ? setNotice({ tone: 'success', text: `${prefix} We emailed them a link to set their password.` })
      : setNotice({
          tone: 'warning',
          text: (
            <>
              {prefix} Email isn&apos;t configured, so send them this one-time link yourself (expires in 72
              hours): <code className="break-all text-xs">{r.link}</code>
            </>
          ),
        });

  async function resetPassword(u: User) {
    const res = await api<InviteResult>(`/api/users/${u.id}/reset-password`, { method: 'POST' });
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    showLink(`${u.name} has been signed out.`, res.data);
  }

  async function setStatus(u: User, status: 'ACTIVE' | 'DISABLED') {
    const res = await api(`/api/users/${u.id}`, { method: 'PATCH', body: { status } });
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    setNotice({
      tone: 'success',
      text: status === 'DISABLED' ? `${u.name} is disabled and signed out.` : `${u.name} can sign in again.`,
    });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setDialog({ kind: 'invite' })}>
          <UserPlus /> Add user
        </Button>
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        {!items ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Plus />} title="No users yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 text-right font-medium">Leads</th>
                  <th className="px-4 py-2.5 text-right font-medium">Open calls</th>
                  <th className="px-4 py-2.5 font-medium">Last sign-in</th>
                  <th className="w-12 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {items.map((u) => (
                  <tr key={u.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-medium">
                        {u.name}
                        {u.id === currentUserId && <Badge>You</Badge>}
                        {u.status === 'DISABLED' && <Badge tone="danger">Disabled</Badge>}
                        {u.mfaEnabled && (
                          <span title="Two-step verification on">
                            <ShieldCheck
                              className="size-4 text-success"
                              aria-label="Two-step verification on"
                            />
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </td>
                    <td className="px-4 py-3">{ROLE[u.roleCode]}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{u.activeLeads}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{u.openCalls}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {u.lastLoginAt ? formatRelative(u.lastLoginAt) : 'Never'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Menu.Root>
                        <Menu.Trigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${u.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </Menu.Trigger>
                        <Menu.Portal>
                          <Menu.Content
                            align="end"
                            sideOffset={4}
                            className="z-50 min-w-48 rounded-lg border border-border bg-surface p-1 text-sm shadow-xl"
                          >
                            {[
                              { label: 'Edit', run: () => setDialog({ kind: 'edit', user: u }) },
                              { label: 'Send password reset', run: () => resetPassword(u) },
                              {
                                label: 'Transfer leads…',
                                run: () => setDialog({ kind: 'transfer', user: u }),
                                hidden: u.activeLeads + u.openCalls === 0,
                              },
                              {
                                label: u.status === 'ACTIVE' ? 'Disable' : 'Enable',
                                run: () => setStatus(u, u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'),
                                hidden: u.id === currentUserId,
                              },
                              {
                                label: 'Delete…',
                                run: () => setDialog({ kind: 'delete', user: u }),
                                hidden: u.id === currentUserId,
                                danger: true,
                              },
                            ]
                              .filter((i) => !i.hidden)
                              .map((i) => (
                                <Menu.Item
                                  key={i.label}
                                  onSelect={i.run}
                                  className={`cursor-pointer rounded-md px-3 py-2 outline-none data-[highlighted]:bg-surface-muted ${i.danger ? 'text-danger' : ''}`}
                                >
                                  {i.label}
                                </Menu.Item>
                              ))}
                          </Menu.Content>
                        </Menu.Portal>
                      </Menu.Root>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {dialog?.kind === 'invite' && (
        <UserDialog
          onClose={() => setDialog(null)}
          onSaved={(r, name) => {
            setDialog(null);
            showLink(`${name} was added.`, r);
            load();
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <UserDialog
          user={dialog.user}
          self={dialog.user.id === currentUserId}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setNotice({ tone: 'success', text: 'User updated. Role changes apply at their next sign-in.' });
            load();
          }}
        />
      )}
      {dialog?.kind === 'transfer' && items && (
        <TransferDialog
          user={dialog.user}
          others={items.filter((x) => x.id !== dialog.user.id && x.status === 'ACTIVE')}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            setNotice({ tone: 'success', text: msg });
            load();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <Dialog
          open
          size="sm"
          onOpenChange={() => setDialog(null)}
          title={`Delete ${dialog.user.name}?`}
          description={
            dialog.user.activeLeads + dialog.user.openCalls > 0
              ? `They still own ${dialog.user.activeLeads} lead(s) and ${dialog.user.openCalls} open call(s). Transfer those first.`
              : 'They lose access immediately. Their history stays in the audit log and timelines.'
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={dialog.user.activeLeads + dialog.user.openCalls > 0}
                onClick={async () => {
                  const res = await api(`/api/users/${dialog.user.id}`, { method: 'DELETE' });
                  setDialog(null);
                  if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
                  setNotice({ tone: 'success', text: `${dialog.user.name} was deleted.` });
                  load();
                }}
              >
                Delete
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

function UserDialog({
  user,
  self,
  onClose,
  onSaved,
}: {
  user?: User;
  self?: boolean;
  onClose: () => void;
  onSaved: (r: InviteResult, name: string) => void;
}) {
  const api = useApi();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phoneE164 ?? '');
  const [role, setRole] = useState<User['roleCode']>(user?.roleCode ?? 'COUNSELOR');
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setFields({});
    setError(null);
    const res = user
      ? await api(`/api/users/${user.id}`, {
          method: 'PATCH',
          body: { name, phone, ...(self ? {} : { role }) },
        })
      : await api<{ invite: InviteResult }>('/api/users', { body: { name, email, phone, role } });
    setBusy(false);
    if (!res.ok) {
      setFields(res.error.details?.fields ?? {});
      if (!res.error.details?.fields) setError(res.error.message);
      return;
    }
    onSaved(user ? { emailed: true } : (res.data as { invite: InviteResult }).invite, name);
  }

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={user ? `Edit ${user.name}` : 'Add a user'}
      description={user ? undefined : 'They get a one-time link to choose their own password.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            {user ? 'Save' : 'Add user'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field id="u-name" label="Name" required error={fields['name']}>
          <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {!user && (
          <Field id="u-email" label="Email" required error={fields['email']}>
            <Input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        )}
        <Field id="u-phone" label="Phone" error={fields['phone']}>
          <Input id="u-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field
          id="u-role"
          label="Role"
          hint={
            self
              ? 'You can’t change your own role.'
              : 'Admins see everything; counselors and telecallers see only their leads.'
          }
        >
          <Select
            id="u-role"
            value={role}
            disabled={self}
            onChange={(e) => setRole(e.target.value as User['roleCode'])}
          >
            <option value="TENANT_ADMIN">Admin</option>
            <option value="COUNSELOR">Counselor</option>
            <option value="TELECALLER">Telecaller</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function TransferDialog({
  user,
  others,
  onClose,
  onDone,
}: {
  user: User;
  others: User[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const api = useApi();
  const eligible = others.filter((o) =>
    user.roleCode === 'TELECALLER' ? o.roleCode === 'TELECALLER' : o.roleCode !== 'TELECALLER',
  );
  const [to, setTo] = useState(eligible[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    const res = await api<{ assignments: number; openCalls: number }>(
      `/api/users/${user.id}/transfer-leads`,
      { body: { toUserId: to } },
    );
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    onDone(`Moved ${res.data.assignments} lead assignment(s) and ${res.data.openCalls} open call(s).`);
  }
  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={`Transfer ${user.name}'s work`}
      description={`${user.activeLeads} lead(s) and ${user.openCalls} open call(s) move to the person you choose. History is kept.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={go} loading={busy} disabled={!to}>
            Transfer
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <Field id="t-to" label="Transfer to">
        <Select id="t-to" value={to} onChange={(e) => setTo(e.target.value)}>
          {eligible.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} ({ROLE[o.roleCode]})
            </option>
          ))}
        </Select>
      </Field>
    </Dialog>
  );
}
