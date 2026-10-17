import { afterCommit, withTenant } from '@avn-cms/db';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTenant, resetData } from '../fixtures/factory';

/**
 * `afterCommit`: work that must happen only once a change is really saved (handing a run to the job
 * queue, for example). It must never see a change that rolled back, must see one that committed, and
 * must never be able to undo one.
 */
describe('afterCommit', () => {
  let tenant: { id: string };

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('hooks');
  });

  const savedByOthers = (code: string) =>
    ownerDb().leadSource.count({ where: { tenantId: tenant.id, code } });

  it('runs once the transaction has committed, and the change is visible to everyone by then', async () => {
    const seen: number[] = [];
    await withTenant(tenant.id, async (db) => {
      await db.leadSource.create({ data: { code: 'committed', label: 'Committed' } as never });
      afterCommit(async () => {
        seen.push(await savedByOthers('committed'));
      });
      // Still inside the transaction: nobody else can see the row yet, and the hook has not run.
      expect(await savedByOthers('committed')).toBe(0);
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([1]);
  });

  it('runs hooks in the order they were registered, before withTenant returns', async () => {
    const order: string[] = [];
    const result = await withTenant(tenant.id, async () => {
      afterCommit(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('first');
      });
      afterCommit(() => {
        order.push('second');
      });
      return 'value';
    });
    expect(result).toBe('value');
    expect(order).toEqual(['first', 'second']);
  });

  it('never runs when the transaction rolls back', async () => {
    const hook = vi.fn();
    await expect(
      withTenant(tenant.id, async (db) => {
        await db.leadSource.create({ data: { code: 'rolled-back', label: 'Rolled back' } as never });
        afterCommit(hook);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(hook).not.toHaveBeenCalled();
    expect(await savedByOthers('rolled-back')).toBe(0);
  });

  it('cannot undo a commit when it fails, and later hooks still run', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn();
    try {
      await expect(
        withTenant(tenant.id, async (db) => {
          await db.leadSource.create({ data: { code: 'kept', label: 'Kept' } as never });
          afterCommit(() => {
            throw new Error('the hook broke');
          });
          afterCommit(after);
          return 'fine';
        }),
      ).resolves.toBe('fine');
      expect(await savedByOthers('kept')).toBe(1);
      expect(after).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('after-commit hook failed'));
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps one transaction’s hooks apart from another running at the same time', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = withTenant(tenant.id, async () => {
      afterCommit(() => {
        seen.push('slow');
      });
      await gate;
    });
    await withTenant(tenant.id, async () => {
      afterCommit(() => {
        seen.push('quick');
      });
    });
    expect(seen).toEqual(['quick']);
    release();
    await slow;
    expect(seen).toEqual(['quick', 'slow']);
  });

  it('outside any transaction, runs the hook soon after', async () => {
    const hook = vi.fn();
    afterCommit(hook);
    await new Promise((r) => setTimeout(r, 10));
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
