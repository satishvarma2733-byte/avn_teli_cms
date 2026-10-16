'use client';

import { Columns } from '@/components/charts';

const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Client wrapper so the date formatter (a function) never crosses the server boundary. */
export function TrendLabel({ data }: { data: { day: string; count: number }[] }) {
  return (
    <Columns
      ariaLabel="New leads per day, last 30 days"
      data={data.map((d) => ({ key: d.day, value: d.count }))}
      formatLabel={(k) => dayFmt.format(new Date(`${k}T00:00:00Z`))}
    />
  );
}
