import type { usage } from '@avn-cms/core';

import { Alert, Badge, Card, CardHeader } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

type Usage = Awaited<ReturnType<typeof usage.getUsage>>;

const bytes = (b: number) =>
  b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(0, Math.round(b / 1024 ** 2)).toLocaleString('en-IN')} MB`;

function show(line: Usage['lines'][number], value: number): string {
  return line.key === 'storage' ? bytes(value) : value.toLocaleString('en-IN');
}

/** The plan, and each thing used against its limit. Shown to admins on the Settings page. */
export function UsageCard({ data }: { data: Usage }) {
  const full = data.lines.filter((l) => l.state === 'full');
  return (
    <Card className="mb-6">
      <CardHeader
        title="Plan and usage"
        description={`This month is ${data.period}. Counts are measured from your workspace’s own records.`}
        actions={<Badge tone="primary">{data.plan ? `${data.plan.name} plan` : 'No plan limits'}</Badge>}
      />
      <div className="space-y-4 p-5">
        {full.length > 0 && (
          <Alert tone="warning" title="A limit has been reached">
            {full.map((l) => l.label.toLowerCase()).join(' and ')} can’t grow until the platform administrator
            moves the workspace to a bigger plan. Nothing already saved is affected, and website enquiries
            keep arriving.
          </Alert>
        )}
        <dl className="grid gap-4 sm:grid-cols-2">
          {data.lines.map((line) => (
            <div key={line.key}>
              <dt className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">{line.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {show(line, line.used)}
                  {line.limit !== null ? ` of ${show(line, line.limit)}` : ' · no limit'}
                </span>
              </dt>
              <dd className="mt-1.5">
                {line.percent !== null ? (
                  <div
                    role="progressbar"
                    aria-label={`${line.label}: ${line.percent}% of the plan`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={line.percent}
                    className="h-2 overflow-hidden rounded-full bg-surface-muted"
                  >
                    <div
                      className={cn(
                        'h-full rounded-full',
                        line.state === 'full'
                          ? 'bg-danger'
                          : line.state === 'near'
                            ? 'bg-warning'
                            : 'bg-primary',
                      )}
                      style={{ width: `${line.percent}%` }}
                    />
                  </div>
                ) : (
                  <div className="h-2 rounded-full bg-surface-muted" aria-hidden />
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}
