import { beforeEach, describe, expect, it } from 'vitest';

import { recordRequest, renderMetrics, resetMetricsForTests, resourceOf } from './metrics';

describe('request metrics', () => {
  beforeEach(resetMetricsForTests);

  it('label a request by its resource, never by an id', () => {
    expect(resourceOf('/api/students')).toBe('/api/students');
    expect(resourceOf('/api/leads/3f2a9c1e-0000-4000-8000-000000000000/notes')).toBe('/api/leads');
    expect(resourceOf('/')).toBe('/');
  });

  it('count requests by method, resource and status class', () => {
    recordRequest('GET', '/api/students', 200, 30);
    recordRequest('GET', '/api/students', 200, 80);
    recordRequest('GET', '/api/leads/abc', 404, 5);
    recordRequest('POST', '/api/students', 500, 1200);
    const text = renderMetrics([]);
    expect(text).toContain('avn_http_requests_total{method="GET",resource="/api/students",status="2xx"} 2');
    expect(text).toContain('avn_http_requests_total{method="GET",resource="/api/leads",status="4xx"} 1');
    expect(text).toContain('avn_http_requests_total{method="POST",resource="/api/students",status="5xx"} 1');
  });

  it('build a cumulative duration histogram', () => {
    recordRequest('GET', '/api/students', 200, 30); // in 0.05 and everything above
    recordRequest('GET', '/api/students', 200, 800); // in 1 and everything above
    const text = renderMetrics([]);
    const bucket = (le: string) => {
      const line = `avn_http_request_duration_seconds_bucket{method="GET",resource="/api/students",status="2xx",le="${le}"} `;
      const start = text.indexOf(line);
      expect(start, `no bucket le=${le}`).toBeGreaterThanOrEqual(0);
      return Number(text.slice(start + line.length).split('\n')[0]);
    };
    expect(bucket('0.025')).toBe(0);
    expect(bucket('0.05')).toBe(1);
    expect(bucket('0.5')).toBe(1);
    expect(bucket('1')).toBe(2);
    expect(bucket('+Inf')).toBe(2);
    expect(text).toContain(
      'avn_http_request_duration_seconds_sum{method="GET",resource="/api/students",status="2xx"} 0.83',
    );
    expect(text).toContain(
      'avn_http_request_duration_seconds_count{method="GET",resource="/api/students",status="2xx"} 2',
    );
  });

  it('print each gauge once with its help text and escape label values', () => {
    const text = renderMetrics([
      {
        name: 'avn_dependency_up',
        help: 'Dependency answers.',
        value: 1,
        labels: { dependency: 'database' },
      },
      { name: 'avn_dependency_up', help: 'Dependency answers.', value: 0, labels: { dependency: 'we"ird' } },
    ]);
    expect(text.match(/# HELP avn_dependency_up/g)).toHaveLength(1);
    expect(text).toContain('avn_dependency_up{dependency="database"} 1');
    expect(text).toContain('avn_dependency_up{dependency="we\\"ird"} 0');
  });

  it('end with a newline, as the text format requires', () => {
    expect(renderMetrics([]).endsWith('\n')).toBe(true);
  });
});
