import 'server-only';

/**
 * Request counters for GET /api/metrics (Prometheus text format). Kept in this process only: Prometheus
 * scrapes every instance and sums them. Labels are the method, the resource (`/api/students`, never an id)
 * and the status class, so the number of series stays small however many people use the app.
 */
const BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000] as const;

interface Series {
  count: number;
  sumMs: number;
  /** Cumulative: how many requests took at most BUCKETS_MS[i]. */
  buckets: number[];
}

const g = globalThis as unknown as { __avnMetrics?: Map<string, Series> };
const series = (): Map<string, Series> => (g.__avnMetrics ??= new Map());

/** `/api/leads/3f2…/notes` → `/api/leads`: the resource, without ids. */
export function resourceOf(pathname: string): string {
  return pathname.split('/').slice(0, 3).join('/') || '/';
}

export function recordRequest(method: string, pathname: string, status: number, ms: number): void {
  const key = `${method}|${resourceOf(pathname)}|${Math.floor(status / 100)}xx`;
  let s = series().get(key);
  if (!s) {
    s = { count: 0, sumMs: 0, buckets: BUCKETS_MS.map(() => 0) };
    series().set(key, s);
  }
  s.count += 1;
  s.sumMs += ms;
  BUCKETS_MS.forEach((limit, i) => {
    if (ms <= limit) s.buckets[i]! += 1;
  });
}

export interface Gauge {
  name: string;
  help: string;
  value: number;
  labels?: Record<string, string>;
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** The Prometheus exposition text for the request counters plus the gauges the caller measured. */
export function renderMetrics(gauges: Gauge[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const gauge of gauges) {
    if (!seen.has(gauge.name)) {
      out.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`);
      seen.add(gauge.name);
    }
    const labels = gauge.labels
      ? `{${Object.entries(gauge.labels)
          .map(([k, v]) => `${k}="${esc(v)}"`)
          .join(',')}}`
      : '';
    out.push(`${gauge.name}${labels} ${gauge.value}`);
  }

  out.push('# HELP avn_http_requests_total API requests handled.', '# TYPE avn_http_requests_total counter');
  const entries = [...series().entries()].sort(([a], [b]) => a.localeCompare(b));
  const labelsOf = (key: string) => {
    const [method, resource, status] = key.split('|');
    return `method="${esc(method!)}",resource="${esc(resource!)}",status="${status}"`;
  };
  for (const [key, s] of entries) out.push(`avn_http_requests_total{${labelsOf(key)}} ${s.count}`);

  out.push(
    '# HELP avn_http_request_duration_seconds API request time.',
    '# TYPE avn_http_request_duration_seconds histogram',
  );
  for (const [key, s] of entries) {
    BUCKETS_MS.forEach((limit, i) =>
      out.push(
        `avn_http_request_duration_seconds_bucket{${labelsOf(key)},le="${limit / 1000}"} ${s.buckets[i]}`,
      ),
    );
    out.push(`avn_http_request_duration_seconds_bucket{${labelsOf(key)},le="+Inf"} ${s.count}`);
    out.push(`avn_http_request_duration_seconds_sum{${labelsOf(key)}} ${s.sumMs / 1000}`);
    out.push(`avn_http_request_duration_seconds_count{${labelsOf(key)}} ${s.count}`);
  }
  return `${out.join('\n')}\n`;
}

/** For tests. */
export function resetMetricsForTests(): void {
  series().clear();
}
