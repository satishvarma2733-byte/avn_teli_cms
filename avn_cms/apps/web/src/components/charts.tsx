'use client';

import { useState } from 'react';

import { cn } from '@/lib/cn';

/**
 * Small HTML chart primitives following the dataviz method: one data hue (--chart-1, validated
 * against both surfaces), bars ≤ 24px with a 4px rounded data-end and a square baseline,
 * hairline recessive grid, text in text tokens (never the data colour), a hover/focus tooltip
 * on every mark, and every value also reachable without hovering (labels or a table view).
 */

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  /** Secondary text shown after the value, e.g. "62%". */
  note?: string;
}

const fmt = (v: number) => v.toLocaleString('en-IN');

/** Horizontal bars, value at the tip. Single series, so no legend: the card title names it. */
export function BarList({
  data,
  ariaLabel,
  empty = 'No data for this period.',
}: {
  data: BarDatum[];
  ariaLabel: string;
  empty?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.every((d) => d.value === 0))
    return <p className="px-5 py-8 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul aria-label={ariaLabel} className="space-y-1 p-5">
      {data.map((d) => {
        const pct = (d.value / max) * 100;
        return (
          <li
            key={d.key}
            tabIndex={0}
            onPointerEnter={() => setHover(d.key)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(d.key)}
            onBlur={() => setHover(null)}
            className="group relative grid grid-cols-[minmax(7rem,11rem)_1fr] items-center gap-3 rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${d.label}: ${fmt(d.value)}${d.note ? `, ${d.note}` : ''}`}
          >
            <span className="truncate text-sm text-muted-foreground" title={d.label}>
              {d.label}
            </span>
            <span className="flex items-center gap-2">
              <span className="relative h-5 flex-1">
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 rounded-r-[4px] bg-chart-1 transition-opacity',
                    hover && hover !== d.key && 'opacity-60',
                  )}
                  style={{ width: `max(${d.value > 0 ? 2 : 0}px, ${pct}%)`, maxWidth: 'calc(100% - 4.5rem)' }}
                />
                <span
                  className="absolute inset-y-0 flex items-center whitespace-nowrap pl-2 text-sm font-medium tabular-nums text-foreground"
                  style={{ left: `min(${pct}%, calc(100% - 4.5rem))` }}
                >
                  {fmt(d.value)}
                  {d.note && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">{d.note}</span>
                  )}
                </span>
              </span>
            </span>
            {hover === d.key && (
              <span
                role="tooltip"
                className="pointer-events-none absolute -top-8 left-[11rem] z-10 rounded-md border border-border bg-surface px-2 py-1 text-xs shadow-card"
              >
                <strong className="tabular-nums">{fmt(d.value)}</strong>{' '}
                <span className="text-muted-foreground">{d.label}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((s) => s * mag >= v) ?? 10) * mag;
}

/** Vertical columns over time (one per day). Tooltip per column; table view behind a toggle. */
export function Columns({
  data,
  ariaLabel,
  formatLabel,
}: {
  data: { key: string; value: number }[];
  ariaLabel: string;
  formatLabel: (key: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const top = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const ticks = [0, top / 2, top];
  const total = data.reduce((a, b) => a + b.value, 0);

  return (
    <div className="p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-sm text-muted-foreground">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{fmt(total)}</span> in{' '}
          {data.length} days
        </p>
        <button
          className="text-xs font-medium text-primary hover:underline"
          onClick={() => setTable((t) => !t)}
          aria-pressed={table}
        >
          {table ? 'Show chart' : 'View as table'}
        </button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Day</th>
                <th className="py-1 text-right font-medium">Leads</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.key} className="border-t border-border">
                  <td className="py-1">{formatLabel(d.key)}</td>
                  <td className="py-1 text-right tabular-nums">{fmt(d.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          className="relative"
          role="img"
          aria-label={`${ariaLabel}. ${fmt(total)} in total; use “View as table” for every day.`}
        >
          <div className="relative ml-8 h-40">
            {ticks.map((t) => (
              <div
                key={t}
                className="absolute inset-x-0 border-t border-chart-grid"
                style={{ bottom: `${(t / top) * 100}%` }}
              >
                <span className="absolute -left-8 -translate-y-1/2 text-[11px] tabular-nums text-muted-foreground">
                  {fmt(t)}
                </span>
              </div>
            ))}
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {data.map((d, i) => (
                <div
                  key={d.key}
                  className="relative flex h-full flex-1 items-end justify-center"
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                >
                  <div
                    className={cn(
                      'w-full max-w-6 rounded-t-[4px] bg-chart-1 transition-opacity',
                      hover !== null && hover !== i && 'opacity-60',
                    )}
                    style={{ height: `${top ? (d.value / top) * 100 : 0}%`, minHeight: d.value > 0 ? 2 : 0 }}
                  />
                  {hover === i && (
                    <div
                      role="tooltip"
                      className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs shadow-card"
                    >
                      <strong className="tabular-nums">{fmt(d.value)}</strong>{' '}
                      <span className="text-muted-foreground">{formatLabel(d.key)}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="ml-8 mt-1 flex justify-between text-[11px] text-muted-foreground">
            <span>{data[0] ? formatLabel(data[0].key) : ''}</span>
            <span>{data[data.length - 1] ? formatLabel(data[data.length - 1]!.key) : ''}</span>
          </div>
        </div>
      )}
    </div>
  );
}
