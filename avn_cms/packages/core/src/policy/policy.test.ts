import { describe, expect, it } from 'vitest';

import { ACTIONS, MATRIX, can, listScope, type Action } from './index';

/**
 * Independent transcription of docs/RBAC_MATRIX.md (✅ full · 🟡 conditional · ❌ none).
 * Columns: Super Admin, Tenant Admin, Counselor, Telecaller. If this table and matrix.ts
 * disagree, one of them drifted from the doc.
 */
const DOC: Record<Action, [string, string, string, string]> = {
  'tenant:manage': ['✅', '❌', '❌', '❌'],
  'tenant:impersonate': ['✅', '❌', '❌', '❌'],
  'platform:analytics': ['✅', '❌', '❌', '❌'],
  'billing:manage': ['✅', '❌', '❌', '❌'],
  'billing:view': ['🟡 platform', '✅', '❌', '❌'],
  'user:list': ['🟡 platform', '✅', '❌', '❌'],
  'user:manage': ['🟡 platform', '✅', '❌', '❌'],
  'user:delete': ['🟡 platform', '✅', '❌', '❌'],
  'user:resetPassword': ['🟡 platform', '✅', '❌', '❌'],
  'account:manage': ['✅ self', '✅ self', '✅ self', '✅ self'],
  'student:list': ['🟡 platform', '✅', '🟡 own', '🟡 own'],
  'student:read': ['🟡 platform', '✅', '🟡 own', '🟡 own'],
  'student:create': ['❌', '✅', '✅', '❌'],
  'student:update': ['❌', '✅', '🟡 own', '🟡 own'],
  'student:delete': ['❌', '✅', '❌', '❌'],
  'student:bulk': ['❌', '✅', '❌', '❌'],
  'lead:changeStage': ['❌', '✅', '🟡 own', '❌'],
  'lead:markPotential': ['❌', '✅', '🟡 own', '🟡 own'],
  'lead:assignCounselor': ['❌', '✅', '❌', '❌'],
  'lead:assignTelecaller': ['❌', '✅', '🟡 own', '❌'],
  'followup:view': ['🟡 platform', '✅', '🟡 own', '🟡 own'],
  'followup:schedule': ['❌', '✅', '🟡 own', '🟡 own'],
  'followup:logDisposition': ['❌', '✅', '🟡 own', '🟡 own'],
  'note:add': ['❌', '✅', '🟡 own', '🟡 own'],
  'activity:view': ['🟡 platform', '✅', '🟡 own', '🟡 own'],
  'webLead:view': ['❌', '✅', '🟡 own', '❌'],
  'webLead:convert': ['❌', '✅', '🟡 own', '❌'],
  'import:run': ['❌', '✅', '❌', '❌'],
  'export:run': ['🟡 platform', '✅', '🟡 own', '🟡 own'],
  'report:viewTenant': ['🟡 platform', '✅', '❌', '❌'],
  'report:viewOwn': ['❌', '✅', '✅ self', '✅ self'],
  'document:manage': ['❌', '✅', '🟡 own', '❌'],
  'studentDoc:verify': ['❌', '✅', '🟡 own', '❌'],
  'automation:manage': ['❌', '✅', '❌', '❌'],
  'audit:view': ['🟡 platform', '✅', '❌', '❌'],
  'settings:manage': ['❌', '✅', '❌', '❌'],
  'intakeCredential:manage': ['❌', '✅', '❌', '❌'],
};

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN', 'COUNSELOR', 'TELECALLER'] as const;

describe('RBAC matrix', () => {
  it('covers every documented action exactly', () => {
    expect([...ACTIONS].sort()).toEqual(Object.keys(DOC).sort());
  });

  for (const action of ACTIONS) {
    ROLES.forEach((role, col) => {
      const cell = DOC[action][col]!;
      const tenantCtx = { tenantId: T1, userId: ME, role };
      const impersonating = { tenantId: T1, userId: ME, role, impersonatedBy: ME };
      const own = { tenantId: T1, assigneeIds: [ME] };
      const notMine = { tenantId: T1, assigneeIds: [OTHER] };
      const otherTenant = { tenantId: T2, assigneeIds: [ME] };

      it(`${role} × ${action} = ${cell}`, () => {
        if (cell === '❌') {
          expect(can(tenantCtx, action, own)).toBe(false);
          expect(can(impersonating, action, own)).toBe(false);
          return;
        }
        if (role === 'SUPER_ADMIN') {
          if (cell === '✅') {
            // Platform action: allowed without impersonation.
            expect(can({ tenantId: null, userId: ME, role }, action)).toBe(true);
          } else if (cell.includes('self')) {
            expect(can({ tenantId: null, userId: ME, role }, action, { tenantId: T1, userId: ME })).toBe(
              true,
            );
          } else {
            // 🟡 platform: tenant data only while impersonating that tenant.
            expect(can(tenantCtx, action, own)).toBe(false);
            expect(can(impersonating, action, notMine)).toBe(true);
            expect(can(impersonating, action, otherTenant)).toBe(false);
          }
          return;
        }
        // Tenant roles never cross tenants.
        expect(can(tenantCtx, action, otherTenant)).toBe(false);
        if (cell.includes('own')) {
          expect(can(tenantCtx, action, own)).toBe(true);
          expect(can(tenantCtx, action, notMine)).toBe(false);
          expect(listScope(tenantCtx, action)).toBe('own');
        } else if (cell.includes('self')) {
          expect(can(tenantCtx, action, { tenantId: T1, userId: ME })).toBe(true);
          expect(can(tenantCtx, action, { tenantId: T1, userId: OTHER })).toBe(false);
        } else {
          expect(can(tenantCtx, action, notMine)).toBe(true);
          expect(listScope(tenantCtx, action)).toBe('tenant');
        }
      });
    });
  }

  it('has no action that a tenant role can reach outside its tenant', () => {
    for (const action of ACTIONS) {
      for (const role of ['TENANT_ADMIN', 'COUNSELOR', 'TELECALLER'] as const) {
        if (MATRIX[action][role] === null) continue;
        expect(
          can({ tenantId: T1, userId: ME, role }, action, { tenantId: T2, assigneeIds: [ME], userId: ME }),
        ).toBe(false);
      }
    }
  });
});
