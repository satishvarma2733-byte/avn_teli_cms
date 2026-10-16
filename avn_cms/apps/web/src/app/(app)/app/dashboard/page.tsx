import { reports } from '@avn-cms/core';
import { STAGE_LABEL } from '@avn-cms/core/schemas';
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  Globe,
  GraduationCap,
  PhoneCall,
  PhoneMissed,
  Star,
  Users,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { BarList } from '@/components/charts';
import { StageBadge } from '@/components/leads/stage-badge';
import { Badge, Card, CardHeader, EmptyState, PageHeader, StatCard } from '@/components/ui/primitives';
import { formatPhone, formatRelative, formatTime } from '@/lib/format';
import { requireTenantPage } from '@/lib/session';

import { TrendLabel } from './trend-label';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const { principal, ctx } = await requireTenantPage();
  const d = await reports.dashboard(ctx);
  const c = d.cards;
  const first = principal.name.split(' ')[0];

  const cards =
    d.role === 'TELECALLER'
      ? [
          <StatCard
            key="q"
            label="My queue today"
            value={c.callsToday}
            icon={<PhoneCall />}
            tone="primary"
          />,
          <StatCard
            key="d"
            label="Completed today"
            value={c.completedToday}
            icon={<CheckCircle2 />}
            tone="success"
          />,
          <StatCard
            key="cb"
            label="Callbacks due"
            value={c.callbacksDue}
            hint="Open calls for leads who asked to be called back"
            icon={<CalendarCheck />}
            tone="info"
          />,
          <StatCard
            key="na"
            label="No-answer rate"
            value={c.noAnswerRate7d === null ? '—' : `${c.noAnswerRate7d}%`}
            hint="Logged calls, last 7 days"
            icon={<PhoneMissed />}
            tone="warning"
          />,
        ]
      : [
          <StatCard
            key="a"
            label={d.tenantWide ? 'Total active leads' : 'My active leads'}
            value={c.activeLeads.toLocaleString('en-IN')}
            icon={<Users />}
            tone="primary"
          />,
          <StatCard
            key="t"
            label={d.tenantWide ? 'Calls scheduled today' : 'My calls today'}
            value={c.callsToday}
            icon={<PhoneCall />}
            tone="info"
          />,
          <StatCard
            key="p"
            label={d.tenantWide ? 'Potential leads' : 'My potential'}
            value={c.potential}
            icon={<Star />}
            tone="warning"
          />,
          <StatCard
            key="e"
            label={d.tenantWide ? 'Enrolled' : 'My enrolled'}
            value={c.enrolled}
            icon={<GraduationCap />}
            tone="success"
          />,
          <StatCard
            key="o"
            label={d.tenantWide ? 'Overdue follow-ups' : 'My overdue'}
            value={c.overdue}
            hint="Open calls from earlier days"
            icon={<AlertTriangle />}
            tone={c.overdue ? 'danger' : 'neutral'}
          />,
        ];

  return (
    <>
      <PageHeader
        title={`Good to see you, ${first}`}
        description={d.tenantWide ? 'How the whole agency is doing today.' : 'Your leads and calls today.'}
      />

      <div
        className={`grid gap-4 sm:grid-cols-2 ${cards.length === 5 ? 'xl:grid-cols-5' : 'xl:grid-cols-4'}`}
      >
        {cards}
      </div>

      {(c.newUncontacted > 0 || c.newWebLeads > 0) && (
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          {c.newUncontacted > 0 && (
            <Link
              href="/app/leads?stage=NEW"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-card hover:bg-surface-muted"
            >
              <Badge tone="info">{c.newUncontacted}</Badge> new leads not contacted yet
            </Link>
          )}
          {c.newWebLeads > 0 && (
            <Link
              href="/app/web-leads"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-card hover:bg-surface-muted"
            >
              <Globe className="size-4 text-muted-foreground" />
              <Badge tone="primary">{c.newWebLeads}</Badge> web leads waiting for review
            </Link>
          )}
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title={d.role === 'TELECALLER' ? 'Dialing queue' : 'Calls due today'}
            description="Open calls up to the end of today, oldest first."
            actions={
              <Link href="/app/followups" className="text-sm font-medium text-primary hover:underline">
                Open queue
              </Link>
            }
          />
          {d.queue.length === 0 ? (
            <EmptyState
              icon={<PhoneCall />}
              title="Nothing due"
              description="All of today's calls are done."
            />
          ) : (
            <ul className="divide-y divide-border">
              {d.queue.map((q) => {
                const overdue = new Date(q.scheduledAt).getTime() < Date.now();
                return (
                  <li
                    key={q.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <Link href={`/app/leads/${q.lead.id}`} className="font-medium hover:text-primary">
                        {q.lead.student.name}
                      </Link>
                      <div className="text-muted-foreground">
                        <a
                          href={`tel:${q.lead.student.phoneE164}`}
                          className="tabular-nums hover:text-primary"
                        >
                          {formatPhone(q.lead.student.phoneE164)}
                        </a>
                        {d.tenantWide && q.assigneeName ? ` · ${q.assigneeName}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StageBadge stage={q.lead.stage} />
                      {q.priority === 'HOT' && <Badge tone="danger">HOT</Badge>}
                      <span className={`tabular-nums ${overdue ? 'text-danger' : 'text-muted-foreground'}`}>
                        {overdue ? formatRelative(q.scheduledAt) : formatTime(q.scheduledAt)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          {d.activity.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="divide-y divide-border">
              {d.activity.map((a) => (
                <li key={a.id} className="px-5 py-3 text-sm">
                  <p className="line-clamp-2">
                    {a.leadId ? (
                      <Link href={`/app/leads/${a.leadId}`} className="font-medium hover:text-primary">
                        {a.student.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{a.student.name}</span>
                    )}{' '}
                    <span className="text-muted-foreground">— {a.summary}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {a.actorName} · {formatRelative(a.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {d.role !== 'TELECALLER' && (
        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader
              title="Conversion funnel"
              description={`Leads that reached at least each stage${d.tenantWide ? '' : ' (yours)'}, all time.`}
            />
            <BarList
              ariaLabel="Conversion funnel"
              data={d.funnel.map((f) => ({
                key: f.stage,
                label: STAGE_LABEL[f.stage],
                value: f.count,
                note: `${f.pctOfTotal}%`,
              }))}
            />
          </Card>
          <Card>
            <CardHeader title="New leads per day" description="Last 30 days, by date the lead was created." />
            <TrendLabel data={d.trend} />
          </Card>
        </div>
      )}
    </>
  );
}
