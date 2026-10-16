/**
 * Creates a platform super admin and prints a one-time "set your password" link (72 hours).
 *
 *   pnpm admin:create-superadmin --email ops@example.com --name "Ops Admin"
 *
 * Run on the server (it needs DATABASE_OWNER_URL and APP_URL). Refuses if the email exists.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(rootEnv) && process.env['NODE_ENV'] !== 'production') process.loadEnvFile(rootEnv);

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const email = arg('email')?.trim().toLowerCase();
const name = arg('name')?.trim();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) {
  console.error('Usage: pnpm admin:create-superadmin --email <email> --name "<name>"');
  process.exit(2);
}

const { hashPassword, issueSetPasswordToken, randomToken, auditAuth } = await import('@avn-cms/auth');
const { getConfig } = await import('@avn-cms/config');
const { ownerDb } = await import('@avn-cms/db/owner');
const { disconnectAll } = await import('@avn-cms/db');

try {
  const db = ownerDb();
  if (await db.user.findFirst({ where: { tenantId: null, email } })) {
    console.error(`A platform account with ${email} already exists.`);
    process.exit(1);
  }
  const user = await db.user.create({
    data: {
      tenantId: null,
      roleCode: 'SUPER_ADMIN',
      name,
      email,
      passwordHash: await hashPassword(randomToken()),
    },
  });
  await auditAuth({
    tenantId: null,
    userId: user.id,
    action: 'platform.superadmin_created',
    newValue: { email },
  });
  const token = await issueSetPasswordToken(user.id);
  console.log(`Super admin ${email} created.`);
  console.log(
    `Set the password (works once, expires in 72 hours):\n${getConfig().APP_URL}/reset-password/${encodeURIComponent(token)}`,
  );
  console.log('Then sign in with an empty workspace field.');
} finally {
  await disconnectAll();
}
