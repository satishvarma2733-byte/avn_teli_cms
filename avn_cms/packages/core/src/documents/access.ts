import { listScope } from '../policy/index';
import type { Ctx } from '../shared/context';
import { forbidden } from '../shared/errors';

/** Who may manage documents: admins across the workspace, counselors only on their own leads. */
export type Scope = 'tenant' | 'own';

export function manageScope(ctx: Ctx): Scope {
  const scope = listScope(ctx, 'document:manage');
  if (!scope) throw forbidden();
  return scope;
}

export function adminOnly(ctx: Ctx): void {
  if (manageScope(ctx) !== 'tenant') throw forbidden('Only admins manage the folder vault.');
}
