import { createServer, type Socket } from 'node:net';

import { resetConfigForTests } from '@avn-cms/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SMTP_TIMEOUTS, sendMail } from '../../packages/core/src/communications/email';
import { createObjectStore, STORAGE_TIMEOUTS } from '../../packages/core/src/documents/object-store';

/**
 * A mail or storage server that has stopped answering must not hold a request for minutes: both clients
 * wait for ever (storage) or for minutes (mail) by default. Each test talks to a server that accepts the
 * connection and then never says anything, which is how a hung server looks from our side.
 */
async function silentServer() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('calls to outside servers give up', () => {
  afterEach(() => {
    delete process.env['SMTP_HOST'];
    delete process.env['SMTP_PORT'];
    resetConfigForTests();
    vi.restoreAllMocks();
  });

  it('an email to a mail server that never answers is reported as not sent, within seconds', async () => {
    expect(SMTP_TIMEOUTS.greetingTimeout).toBeLessThanOrEqual(10_000);
    const server = await silentServer();
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = String(server.port);
    resetConfigForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // the failure is logged
    try {
      const started = Date.now();
      expect(await sendMail('someone@example.test', 'Hello', 'Hi')).toEqual({
        sent: false,
        reason: 'SEND_FAILED',
      });
      // It waited for the greeting (10 s), not nodemailer's 30 s.
      expect(Date.now() - started).toBeLessThan(SMTP_TIMEOUTS.greetingTimeout + 5_000);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('a storage server that never answers makes the call fail as "unavailable", retries included', async () => {
    expect(STORAGE_TIMEOUTS.connectMs).toBeGreaterThan(0);
    expect(STORAGE_TIMEOUTS.answerMs).toBeGreaterThan(0);
    expect(STORAGE_TIMEOUTS.idleMs).toBeGreaterThan(0);
    const server = await silentServer();
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // the failure is logged
    // Shorter limits than production's, so the SDK's three attempts fit in a test.
    const store = createObjectStore(
      {
        endpoint: `http://127.0.0.1:${server.port}`,
        region: 'auto',
        bucket: 'hung',
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
      { connectMs: 1_000, answerMs: 1_000, idleMs: 2_000 },
    );
    try {
      const started = Date.now();
      await expect(store.head('some/key')).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: 'Document storage did not answer. Try again in a moment.',
      });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await server.close();
    }
  }, 30_000);
});
