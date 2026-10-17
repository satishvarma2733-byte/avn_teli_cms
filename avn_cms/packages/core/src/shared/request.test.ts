import { describe, expect, it } from 'vitest';

import { clientIpFrom, safeNextPath } from './request';

const headers = (map: Record<string, string>) => (name: string) => map[name] ?? null;

describe('clientIpFrom', () => {
  it('ignores forwarding headers when no proxy of ours is in front', () => {
    expect(clientIpFrom(headers({ 'x-forwarded-for': '203.0.113.9' }), 0)).toBe('local');
    expect(clientIpFrom(headers({ 'x-real-ip': '203.0.113.9' }), 0)).toBe('local');
  });

  it('takes the entry our own proxy added, counted from the right, not what the caller wrote', () => {
    // The caller sent "1.2.3.4"; the load balancer appended the address it actually saw.
    expect(clientIpFrom(headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), 1)).toBe('198.51.100.7');
    // Two proxies (CDN then load balancer): the address the CDN saw is second from the right.
    expect(clientIpFrom(headers({ 'x-forwarded-for': '9.9.9.9, 198.51.100.7, 10.0.0.2' }), 2)).toBe(
      '198.51.100.7',
    );
  });

  it('cannot be steered to an address by making the list longer or shorter', () => {
    const forged = Array.from({ length: 20 }, (_, i) => `1.1.1.${i}`).join(', ');
    expect(clientIpFrom(headers({ 'x-forwarded-for': `${forged}, 198.51.100.7` }), 1)).toBe('198.51.100.7');
    // Fewer entries than proxies: something skipped a proxy; use what there is rather than guess.
    expect(clientIpFrom(headers({ 'x-forwarded-for': '198.51.100.7' }), 3)).toBe('198.51.100.7');
  });

  it('only returns real addresses (IPv4 and IPv6) and falls back to a shared one', () => {
    expect(clientIpFrom(headers({ 'x-forwarded-for': '2001:db8::1' }), 1)).toBe('2001:db8::1');
    expect(clientIpFrom(headers({ 'x-forwarded-for': 'not-an-ip' }), 1)).toBe('local');
    expect(clientIpFrom(headers({ 'x-forwarded-for': "1.2.3.4'; DROP TABLE users;--" }), 1)).toBe('local');
    expect(clientIpFrom(headers({}), 1)).toBe('local');
    expect(clientIpFrom(headers({ 'x-forwarded-for': ' , ' }), 1)).toBe('local');
  });

  it('uses X-Real-IP only when there is no forwarding list', () => {
    expect(clientIpFrom(headers({ 'x-real-ip': '198.51.100.7' }), 1)).toBe('198.51.100.7');
  });
});

describe('safeNextPath', () => {
  it('keeps pages inside the signed-in areas, with their query', () => {
    expect(safeNextPath('/app/leads')).toBe('/app/leads');
    expect(safeNextPath('/app/leads?status=NEW&q=asha')).toBe('/app/leads?status=NEW&q=asha');
    expect(safeNextPath('/app')).toBe('/app');
    expect(safeNextPath('/platform')).toBe('/platform');
    expect(safeNextPath('/app/leads/7d0c6f5e-2b0a-4a51-9c1e-1f2a3b4c5d6e#notes')).toBe(
      '/app/leads/7d0c6f5e-2b0a-4a51-9c1e-1f2a3b4c5d6e#notes',
    );
  });

  it('refuses anything that could land on another site', () => {
    for (const bad of [
      '//evil.example',
      '//evil.example/app',
      '/\\evil.example',
      '/\\/evil.example',
      '\\\\evil.example',
      'https://evil.example/app',
      'http://localhost:3300/app',
      'javascript:alert(1)',
      '/app\\..\\..\\evil',
      '/app/leads\r\nSet-Cookie: x=1',
      '/app/leads\n',
      '/ app',
      '/\tapp',
      'app/leads',
      '',
    ]) {
      expect(safeNextPath(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('refuses pages outside the signed-in areas and things that are not text', () => {
    expect(safeNextPath('/login')).toBeUndefined();
    expect(safeNextPath('/api/auth/logout')).toBeUndefined();
    expect(safeNextPath('/apple')).toBeUndefined();
    expect(safeNextPath('/application')).toBeUndefined();
    expect(safeNextPath(undefined)).toBeUndefined();
    expect(safeNextPath(['/app'])).toBeUndefined();
    expect(safeNextPath(`/app/${'a'.repeat(600)}`)).toBeUndefined();
  });
});
