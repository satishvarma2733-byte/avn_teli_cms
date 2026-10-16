'use client';

import Link from 'next/link';

import { formatBytes, type StuckScan } from '@/components/documents/types';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';

/**
 * Files that could not be virus-checked. They stay blocked (nothing is ever released unscanned); the
 * worker retries a few times and then gives up. Shown only to admins, and only when there are any.
 */
export function StuckScansCard({
  items,
  maxAttempts,
  busyId,
  onRescan,
}: {
  items: StuckScan[];
  maxAttempts: number;
  busyId: string | null;
  onRescan: (item: StuckScan) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Card data-testid="stuck-scans">
      <CardHeader
        title={`${items.length} file${items.length === 1 ? '' : 's'} couldn’t be checked`}
        description="These files stay blocked until a virus scan finishes. If the scanner was down, scan them again once it is back."
      />
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
            <div className="min-w-0 space-y-0.5">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{item.filename}</span>
                <Badge tone={item.exhausted ? 'danger' : 'warning'}>
                  {item.exhausted ? 'Gave up' : 'Retrying'}
                </Badge>
              </p>
              <p className="text-muted-foreground">
                {item.student ? (
                  <>
                    Student:{' '}
                    {item.student.leadId ? (
                      <Link
                        href={`/app/leads/${item.student.leadId}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {item.student.name}
                      </Link>
                    ) : (
                      item.student.name
                    )}
                  </>
                ) : item.folder ? (
                  <>Folder: {item.folder.name}</>
                ) : (
                  <>Vault</>
                )}
                {' · '}
                {formatBytes(item.sizeBytes)} · {item.attempts} of {maxAttempts} tries
                {item.lastAttemptAt ? ` · last try ${formatDateTime(item.lastAttemptAt)}` : ''}
              </p>
              {item.error && <p className="text-danger">{item.error}</p>}
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={busyId === item.id}
              onClick={() => onRescan(item)}
              aria-label={`Scan again: ${item.filename}`}
            >
              Scan again
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
