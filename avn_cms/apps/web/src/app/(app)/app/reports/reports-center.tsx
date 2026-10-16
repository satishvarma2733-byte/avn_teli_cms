'use client';

import { DISPOSITION_LABEL, STAGE_LABEL } from '@avn-cms/core/schemas';
import type { CallDisposition, LeadStage } from '@avn-cms/db/enums';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { BarList } from '@/components/charts';
import { Input, Select } from '@/components/ui/field';
import { Alert, Card, CardHeader, Skeleton, StatCard } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/client';
import { useDirectory } from '@/lib/use-directory';

interface Data {
  funnel: { stage: LeadStage; count: number; pctOfTotal: number }[];
  sources: {
    sourceId: string;
    label: string;
    leads: number;
    contacted: number;
    enrolled: number;
    lost: number;
    conversionPct: number;
  }[];
  team: {
    userId: string;
    name: string;
    role: string;
    leads: number;
    active: number;
    potential: number;
    enrolled: number;
    conversionPct: number;
    calls: number;
    connectedPct: number;
    noAnswerPct: number;
    overdue: number;
  }[];
  status: { stage: LeadStage; count: number }[];
  followups: {
    logged: number;
    open: number;
    overdue: number;
    escalated: number;
    byDisposition: { disposition: CallDisposition; count: number }[];
  };
}

const PRESETS = [
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
  { id: 'all', label: 'All time' },
] as const;

function isoDay(d: Date) {
  return new Intl.DateTimeFormat('en-CA').format(d);
}

export function ReportsCenter({ tenantWide }: { tenantWide: boolean }) {
  const api = useApi();
  const sources = useDirectory('sources');
  const counselors = useDirectory('counselors', tenantWide);
  const telecallers = useDirectory('telecallers', tenantWide);
  const [preset, setPreset] = useState<string>('30');
  const [sourceId, setSourceId] = useState('');
  const [state, setState] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (preset !== 'all') {
      p.set('dateFrom', isoDay(new Date(Date.now() - (Number(preset) - 1) * 86_400_000)));
      p.set('dateTo', isoDay(new Date()));
    }
    if (sourceId) p.set('sourceId', sourceId);
    if (state.trim()) p.set('state', state.trim());
    if (assigneeId) p.set('assigneeId', assigneeId);
    return p.toString();
  }, [preset, sourceId, state, assigneeId]);

  const load = useCallback(async () => {
    setLoading(true);
    const keys = ['funnel', 'sources', 'team', 'status', 'followups'] as const;
    const out: Partial<Data> = {};
    for (const k of keys) {
      const res = await api<unknown>(`/api/reports/${k}?${qs}`);
      if (!res.ok) {
        setError(res.error.message);
        setLoading(false);
        return;
      }
      (out as Record<string, unknown>)[k] = res.data;
    }
    setError(null);
    setData(out as Data);
    setLoading(false);
  }, [api, qs]);

  useEffect(() => {
    const t = setTimeout(load, state ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, state]);

  const team = [...counselors, ...telecallers.filter((t) => !counselors.some((c) => c.id === t.id))];
  const totalLeads = data?.funnel[0]?.count ?? 0;
  const enrolled = data?.funnel.find((f) => f.stage === 'ENROLLED')?.count ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Report filters">
        <div className="flex rounded-lg border border-border bg-surface p-0.5 shadow-card">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              aria-pressed={preset === p.id}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                preset === p.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Select
          aria-label="Source"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          className="w-44"
        >
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Input
          aria-label="State"
          placeholder="State"
          value={state}
          onChange={(e) => setState(e.target.value)}
          className="w-40"
        />
        {tenantWide && (
          <Select
            aria-label="Team member"
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="w-48"
          >
            <option value="">Whole team</option>
            {team.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">
        The date range applies to when leads were created (and, for calls, when they were logged).
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      {!data ? (
        <div className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <div className={cn('space-y-6 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Leads" value={totalLeads.toLocaleString('en-IN')} />
            <StatCard
              label="Enrolled"
              value={enrolled.toLocaleString('en-IN')}
              hint={totalLeads ? `${Math.round((enrolled / totalLeads) * 1000) / 10}% conversion` : undefined}
            />
            <StatCard label="Calls logged" value={data.followups.logged.toLocaleString('en-IN')} />
            <StatCard
              label="Overdue calls now"
              value={data.followups.overdue.toLocaleString('en-IN')}
              hint={`${data.followups.escalated} escalated`}
              tone={data.followups.overdue ? 'danger' : 'neutral'}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader
                title="Conversion funnel"
                description="Leads that reached at least each stage. % of all leads in the range."
              />
              <BarList
                ariaLabel="Conversion funnel"
                data={data.funnel.map((f) => ({
                  key: f.stage,
                  label: STAGE_LABEL[f.stage],
                  value: f.count,
                  note: `${f.pctOfTotal}%`,
                }))}
              />
            </Card>
            <Card>
              <CardHeader title="Current stage" description="Where the leads in the range are now." />
              <BarList
                ariaLabel="Stage distribution"
                data={data.status
                  .filter((s) => s.count > 0)
                  .map((s) => ({ key: s.stage, label: STAGE_LABEL[s.stage], value: s.count }))}
              />
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Sources"
              description="Volume and conversion by lead source. Ad spend isn't recorded in aVn CMS, so cost per enrolment isn't shown."
            />
            <div className="grid gap-0 lg:grid-cols-2">
              <BarList
                ariaLabel="Leads by source"
                data={data.sources.map((s) => ({
                  key: s.sourceId,
                  label: s.label,
                  value: s.leads,
                  note: `${s.conversionPct}% enrolled`,
                }))}
              />
              <div className="overflow-x-auto border-t border-border lg:border-l lg:border-t-0">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-4 py-2 font-medium">Source</th>
                      <th className="px-4 py-2 text-right font-medium">Leads</th>
                      <th className="px-4 py-2 text-right font-medium">Contacted</th>
                      <th className="px-4 py-2 text-right font-medium">Enrolled</th>
                      <th className="px-4 py-2 text-right font-medium">Conv.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s) => (
                      <tr key={s.sourceId} className="border-b border-border last:border-0">
                        <td className="px-4 py-2">{s.label}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{s.leads}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{s.contacted}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{s.enrolled}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{s.conversionPct}%</td>
                      </tr>
                    ))}
                    {data.sources.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                          No leads in this range.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title={tenantWide ? 'Team performance' : 'My numbers'}
              description="Leads currently assigned, enrolments and conversion; calls logged in the range."
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Role</th>
                    <th className="px-4 py-2 text-right font-medium">Leads</th>
                    <th className="px-4 py-2 text-right font-medium">Active</th>
                    <th className="px-4 py-2 text-right font-medium">Enrolled</th>
                    <th className="px-4 py-2 text-right font-medium">Conversion</th>
                    <th className="px-4 py-2 text-right font-medium">Calls</th>
                    <th className="px-4 py-2 text-right font-medium">Connected</th>
                    <th className="px-4 py-2 text-right font-medium">No answer</th>
                    <th className="px-4 py-2 text-right font-medium">Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.team.map((r) => (
                    <tr key={r.userId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 font-medium">{r.name}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {r.role.replace('_', ' ').toLowerCase()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.leads}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.active}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.enrolled}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.conversionPct}%</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.calls}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.connectedPct}%</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.noAnswerPct}%</td>
                      <td className={cn('px-4 py-2 text-right tabular-nums', r.overdue > 0 && 'text-danger')}>
                        {r.overdue}
                      </td>
                    </tr>
                  ))}
                  {data.team.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-4 py-6 text-center text-muted-foreground">
                        No activity in this range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Call outcomes"
              description={`${data.followups.logged} calls logged · ${data.followups.open} open now`}
            />
            <BarList
              ariaLabel="Call outcomes"
              data={data.followups.byDisposition.map((d) => ({
                key: d.disposition,
                label: DISPOSITION_LABEL[d.disposition],
                value: d.count,
              }))}
              empty="No calls logged in this range."
            />
          </Card>
        </div>
      )}
    </div>
  );
}
