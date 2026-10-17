import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import { StyleNonce } from '@/components/style-nonce';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'aVn CMS', template: '%s · aVn CMS' },
  description: 'aVn CMS — student lead and admissions CRM for education consultancies.',
  applicationName: 'aVn CMS',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8fa' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1017' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request so Next.js can stamp the CSP nonce from proxy.ts onto its
  // scripts (a prerendered page has no nonce and would be blocked by the strict policy).
  await connection();
  const nonce = (await headers()).get('x-nonce') ?? '';
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <StyleNonce nonce={nonce} />
        {children}
      </body>
    </html>
  );
}
