'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Card, CardHeader } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { useDirectory } from '@/lib/use-directory';

const COUNTRIES = [
  'Kyrgyzstan',
  'Georgia',
  'Russia',
  'Kazakhstan',
  'Uzbekistan',
  'Philippines',
  'Armenia',
  'Nepal',
  'Bangladesh',
  'Other',
];

type FormState = Record<string, string | boolean>;

export function StudentForm({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const router = useRouter();
  const sources = useDirectory('sources');
  const counselors = useDirectory('counselors', isAdmin);
  const telecallers = useDirectory('telecallers', isAdmin);
  const [form, setForm] = useState<FormState>({
    interestCourse: 'MBBS',
    priority: 'NORMAL',
    isPotential: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ leadId: string | null; name?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (k: string) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const val = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    setError(null);
    setDuplicate(null);
    const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
    const res = await api<{ leadId: string; possibleDuplicateEmail: boolean }>('/api/students', { body });
    setSaving(false);
    if (!res.ok) {
      setErrors(res.error.details?.fields ?? {});
      if (res.error.code === 'CONFLICT') {
        setDuplicate({
          leadId: (res.error.details?.['leadId'] as string | null) ?? null,
          name: res.error.details?.['name'] as string | undefined,
        });
      } else if (!res.error.details?.fields) {
        setError(res.error.message);
      }
      return;
    }
    router.push(`/app/leads/${res.data.leadId}${res.data.possibleDuplicateEmail ? '?emailWarning=1' : ''}`);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {error && <Alert tone="danger">{error}</Alert>}
        {duplicate && (
          <Alert tone="warning" title="This student is already in aVn CMS">
            {duplicate.name
              ? `${duplicate.name} has this phone number. `
              : 'A student with this phone number exists. '}
            {duplicate.leadId && (
              <Link href={`/app/leads/${duplicate.leadId}`} className="font-medium underline">
                Open the existing lead
              </Link>
            )}
          </Alert>
        )}
        <Card>
          <CardHeader title="Student" description="The person. One record per real student." />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field id="name" label="Student name" required error={errors['name']}>
              <Input
                id="name"
                value={val('name')}
                onChange={set('name')}
                aria-invalid={Boolean(errors['name'])}
                autoFocus
              />
            </Field>
            <Field id="parentName" label="Parent name" error={errors['parentName']}>
              <Input id="parentName" value={val('parentName')} onChange={set('parentName')} />
            </Field>
            <Field
              id="phone"
              label="Mobile number"
              required
              hint="10-digit Indian number, or with country code."
              error={errors['phone']}
            >
              <Input
                id="phone"
                type="tel"
                inputMode="tel"
                value={val('phone')}
                onChange={set('phone')}
                aria-invalid={Boolean(errors['phone'])}
              />
            </Field>
            <Field id="altPhone" label="Alternate number" error={errors['altPhone']}>
              <Input
                id="altPhone"
                type="tel"
                inputMode="tel"
                value={val('altPhone')}
                onChange={set('altPhone')}
              />
            </Field>
            <Field id="email" label="Email" error={errors['email']} className="sm:col-span-2">
              <Input
                id="email"
                type="email"
                value={val('email')}
                onChange={set('email')}
                aria-invalid={Boolean(errors['email'])}
              />
            </Field>
            <Field id="town" label="Town / city" error={errors['town']}>
              <Input id="town" value={val('town')} onChange={set('town')} />
            </Field>
            <Field id="district" label="District" error={errors['district']}>
              <Input id="district" value={val('district')} onChange={set('district')} />
            </Field>
            <Field id="state" label="State" error={errors['state']}>
              <Input
                id="state"
                value={val('state')}
                onChange={set('state')}
                placeholder="e.g. Andhra Pradesh"
              />
            </Field>
            <Field id="address" label="Address" error={errors['address']}>
              <Input id="address" value={val('address')} onChange={set('address')} />
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader title="First note" description="Optional. Appears on the lead's timeline." />
          <div className="p-5">
            <Textarea id="note" aria-label="First note" value={val('note')} onChange={set('note')} rows={3} />
          </div>
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader title="Lead" />
          <div className="space-y-4 p-5">
            <Field id="sourceId" label="Source" required error={errors['sourceId']}>
              <Select
                id="sourceId"
                value={val('sourceId')}
                onChange={set('sourceId')}
                aria-invalid={Boolean(errors['sourceId'])}
              >
                <option value="">Choose…</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="interestCountry" label="Country of interest">
              <Select id="interestCountry" value={val('interestCountry')} onChange={set('interestCountry')}>
                <option value="">Not yet known</option>
                {COUNTRIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
            <Field id="interestCourse" label="Course">
              <Input id="interestCourse" value={val('interestCourse')} onChange={set('interestCourse')} />
            </Field>
            <Field id="priority" label="Priority">
              <Select id="priority" value={val('priority')} onChange={set('priority')}>
                <option value="NORMAL">Normal</option>
                <option value="HOT">HOT</option>
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={form['isPotential'] === true}
                onChange={(e) => setForm((f) => ({ ...f, isPotential: e.target.checked }))}
              />
              Mark as potential lead
            </label>
          </div>
        </Card>
        {isAdmin && (
          <Card>
            <CardHeader title="Assignment" description="Leave empty to use round-robin (if enabled)." />
            <div className="space-y-4 p-5">
              <Field id="counselorId" label="Counselor" error={errors['counselorId']}>
                <Select id="counselorId" value={val('counselorId')} onChange={set('counselorId')}>
                  <option value="">Auto / none</option>
                  {counselors.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="telecallerId" label="Telecaller" error={errors['telecallerId']}>
                <Select id="telecallerId" value={val('telecallerId')} onChange={set('telecallerId')}>
                  <option value="">None</option>
                  {telecallers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>
        )}
        <div className="flex gap-2">
          <Button type="submit" loading={saving} className="flex-1">
            Save student
          </Button>
          <Button type="button" variant="secondary" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}
