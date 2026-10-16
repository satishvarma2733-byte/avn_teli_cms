import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

// Local runs (dev and `next start`) read the workspace-root .env. Values already in the
// environment win, so a host's real configuration is never overridden by a file.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  // Native / Node-only modules stay outside the server bundle.
  serverExternalPackages: ['@node-rs/argon2', 'pg', 'ioredis', 'nodemailer'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
