'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, CardHeader } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';

interface Settings {
  timezone: string;
  roundRobin: boolean;
  uncontactedMinutes: number;
  sources: { id: string; code: string; label: string; isActive: boolean }[];
}

const ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Kathmandu',
  'Asia/Dhaka',
  'Asia/Bishkek',
  'Asia/Tbilisi',
  'Europe/London',
  'UTC',
];

export function SettingsForm({ initial }: { initial: Settings }) {
  const api = useApi();
  const [s, setS] = useState(initial);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [newSource, setNewSource] = useState('');

  async function saveGeneral() {
    setSaving(true);
    const res = await api('/api/settings', {
      method: 'PATCH',
      body: { timezone: s.timezone, roundRobin: s.roundRobin, uncontactedMinutes: s.uncontactedMinutes },
    });
    setSaving(false);
    setNotice(
      res.ok ? { tone: 'success', text: 'Settings saved.' } : { tone: 'danger', text: res.error.message },
    );
  }

  async function reloadSources() {
    const res = await api<Settings>('/api/settings');
    if (res.ok) setS((x) => ({ ...x, sources: res.data.sources }));
  }

  async function addSource() {
    const res = await api('/api/settings/sources', { body: { label: newSource } });
    if (!res.ok)
      return setNotice({ tone: 'danger', text: res.error.details?.fields?.['label'] ?? res.error.message });
    setNewSource('');
    setNotice({ tone: 'success', text: 'Source added.' });
    reloadSources();
  }

  async function toggleSource(id: string, isActive: boolean) {
    const res = await api(`/api/settings/sources/${id}`, { method: 'PATCH', body: { isActive } });
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    reloadSources();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {notice && (
        <div className="lg:col-span-2">
          <Alert tone={notice.tone}>{notice.text}</Alert>
        </div>
      )}
      <Card>
        <CardHeader
          title="Lead handling"
          description="How new leads are assigned and when the team is reminded."
        />
        <div className="space-y-4 p-5">
          <Field id="tz" label="Time zone" hint="“Today” in queues and reports follows this zone.">
            <Select id="tz" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>
              {[...new Set([s.timezone, ...ZONES])].map((z) => (
                <option key={z}>{z}</option>
              ))}
            </Select>
          </Field>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={s.roundRobin}
              onChange={(e) => setS({ ...s, roundRobin: e.target.checked })}
            />
            <span>
              <span className="font-medium">Round-robin assignment</span>
              <span className="block text-muted-foreground">
                New students and converted web leads without a chosen counselor go to the next counselor in
                turn.
              </span>
            </span>
          </label>
          <Field
            id="uncontacted"
            label="Uncontacted alert (minutes)"
            hint="Used by the “new lead not contacted” automation."
          >
            <Input
              id="uncontacted"
              type="number"
              min={5}
              max={1440}
              value={s.uncontactedMinutes}
              onChange={(e) => setS({ ...s, uncontactedMinutes: Number(e.target.value) })}
            />
          </Field>
          <Button onClick={saveGeneral} loading={saving}>
            Save
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Lead sources" description="Where enquiries come from. Reports group by these." />
        <ul className="divide-y divide-border">
          {s.sources.map((src) => (
            <li key={src.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
              <span className="flex items-center gap-2">
                {src.label}
                <code className="text-xs text-muted-foreground">{src.code}</code>
                {!src.isActive && <Badge>Hidden</Badge>}
              </span>
              <Button size="sm" variant="ghost" onClick={() => toggleSource(src.id, !src.isActive)}>
                {src.isActive ? 'Hide' : 'Show'}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 border-t border-border p-4">
          <Input
            aria-label="New source name"
            placeholder="e.g. Education fair"
            value={newSource}
            onChange={(e) => setNewSource(e.target.value)}
          />
          <Button variant="secondary" onClick={addSource} disabled={!newSource.trim()}>
            Add
          </Button>
        </div>
      </Card>
    </div>
  );
}
