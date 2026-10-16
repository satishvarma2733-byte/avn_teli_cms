/** One number with its label, as a description-list pair. */
export function Figure({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
        {(value ?? 0).toLocaleString('en-IN')}
      </dd>
    </div>
  );
}
