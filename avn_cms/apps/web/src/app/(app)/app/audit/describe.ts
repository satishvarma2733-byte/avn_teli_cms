/**
 * Plain-words rendering of audit rows. The stored row is never changed: the code stays visible next
 * to its label (people search for it, and the raw values are one click away), but an admin reading
 * the log sees "Stage changed · Stage: Contacted → Interested" instead of JSON.
 */
import { DISPOSITION_LABEL, STAGE_LABEL } from '@avn-cms/core/schemas';

import { formatDateTime, humanizeCode, roleLabel } from '@/lib/format';

const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.locked': 'Account locked after failed sign-ins',
  'auth.logout': 'Signed out',
  'auth.mfa_enabled': 'Two-step verification turned on',
  'auth.mfa_disabled': 'Two-step verification turned off',
  'auth.mfa_recovery_regenerated': 'New recovery codes made',
  'auth.mfa_recovery_used': 'Signed in with a recovery code',
  'auth.mfa_reset_by_admin': 'Two-step verification reset by an admin',
  'auth.password_changed': 'Password changed',
  'auth.password_reset': 'Password reset',
  'auth.password_reset_requested': 'Password reset requested',
  'auth.sessions_revoked': 'Signed out everywhere',
  'automation.created': 'Automation rule created',
  'automation.updated': 'Automation rule changed',
  'automation.deleted': 'Automation rule deleted',
  'automation.starter_installed': 'Starter automation rules added',
  'document.upload_started': 'Document upload started',
  'document.uploaded': 'Document uploaded',
  'document.scanned': 'Document scanned',
  'document.downloaded': 'Document downloaded',
  'document.reviewed': 'Document reviewed',
  'document.rejected': 'Document rejected',
  'document.rescan_requested': 'Document scan requested again',
  'document.deleted': 'Document deleted',
  'export.requested': 'Export requested',
  'export.run': 'Export finished',
  'folder.created': 'Folder created',
  'folder.renamed': 'Folder renamed',
  'folder.deleted': 'Folder deleted',
  'followup.schedule': 'Call scheduled',
  'followup.reschedule': 'Call rescheduled',
  'followup.log': 'Call logged',
  'impersonation.start': 'Support access started',
  'impersonation.stop': 'Support access ended',
  'import.upload': 'Import file uploaded',
  'import.start': 'Import checked',
  'import.run': 'Import run',
  'import.cancel': 'Import cancelled',
  'intake_credential.create': 'Website key created',
  'intake_credential.rotate': 'Website key replaced',
  'intake_credential.revoke': 'Website key revoked',
  'lead.assign': 'Assignment changed',
  'lead.stage_change': 'Stage changed',
  'lead.update': 'Lead details changed',
  'note.create': 'Note added',
  'platform.admin_mfa_reset': 'Two-step verification reset by the platform',
  'platform.impersonation_start': 'Support access started',
  'platform.impersonation_stop': 'Support access ended',
  'platform.tenant_create': 'Workspace created',
  'platform.tenant_plan': 'Plan changed',
  'platform.tenant_status': 'Workspace status changed',
  'settings.update': 'Settings changed',
  'source.create': 'Lead source added',
  'source.update': 'Lead source changed',
  'student.create': 'Student added',
  'student.update': 'Contact details changed',
  'student.delete': 'Student deleted',
  'user.create': 'Team member added',
  'user.delete': 'Team member removed',
  'user.password_reset_by_admin': 'Password reset by an admin',
  'user.transfer_leads': 'Leads moved to another team member',
  'web_lead.convert': 'Web lead turned into a student',
  'web_lead.status': 'Web lead status changed',
};

const ENTITY_LABEL: Record<string, string> = {
  automation_rule: 'Automation rule',
  document: 'Document',
  export_job: 'Export',
  folder: 'Folder',
  follow_up: 'Call',
  import_job: 'Import',
  intake_credential: 'Website key',
  lead: 'Lead',
  lead_source: 'Lead source',
  note: 'Note',
  student: 'Student',
  student_document: 'Checklist document',
  tenant: 'Workspace',
  user: 'Team member',
  web_lead: 'Web lead',
};

const FIELD_LABEL: Record<string, string> = {
  altPhoneE164: 'Alternate phone',
  assigneeId: 'Assigned to',
  counselorId: 'Counselor',
  disposition: 'Outcome',
  isActive: 'On',
  isPotential: 'Potential',
  mfaRequired: 'Two-step code asked',
  parentName: 'Parent’s name',
  phoneE164: 'Phone',
  roleCode: 'Role',
  scheduledAt: 'Call time',
  sizeBytes: 'Size',
  telecallerId: 'Telecaller',
};

/** Fields that only make sense to a machine: kept in the raw view, left out of the summary. */
const HIDDEN_FIELDS = new Set(['phoneRaw', 'studentId', 'folderId', 'leadId', 'tenantId', 'id']);

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? humanizeCode(action);
}

export function entityLabel(entityType: string): string {
  return ENTITY_LABEL[entityType] ?? humanizeCode(entityType);
}

function fieldLabel(key: string): string {
  if (FIELD_LABEL[key]) return FIELD_LABEL[key];
  const words = key
    .replace(/E164$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]*$/;

export function formatValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') {
    if (key === 'sizeBytes')
      return v < 1024 * 1024 ? `${Math.max(1, Math.round(v / 1024))} KB` : `${(v / 1048576).toFixed(1)} MB`;
    return v.toLocaleString('en-IN');
  }
  if (typeof v === 'string') {
    if (ISO.test(v)) return formatDateTime(v);
    if (UUID.test(v)) return `#${v.slice(0, 8)}`;
    if (CODE.test(v)) {
      if (key === 'stage' || key === 'toStage' || key === 'fromStage')
        return (STAGE_LABEL as Record<string, string>)[v] ?? humanizeCode(v);
      if (key === 'disposition') return (DISPOSITION_LABEL as Record<string, string>)[v] ?? humanizeCode(v);
      if (key === 'roleCode' || key === 'role') return roleLabel(v);
      return humanizeCode(v);
    }
    return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  if (Array.isArray(v)) return v.length ? v.map((x) => formatValue(key, x)).join(', ') : '—';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['name'] === 'string') return o['name'];
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }
  return String(v);
}

export interface ChangeLine {
  field: string;
  from?: string;
  to?: string;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One line per changed field. A snapshot "before" often carries more fields than were changed, so
 * the "after" side decides which fields to show, and fields that came out the same are left out.
 */
export function describeChanges(oldValue: unknown, newValue: unknown): ChangeLine[] {
  const before = isPlain(oldValue) ? oldValue : null;
  const after = isPlain(newValue) ? newValue : null;
  if (!before && !after) return [];
  const keys = Object.keys(after && Object.keys(after).length ? after : (before ?? {}));
  const lines: ChangeLine[] = [];
  for (const k of keys) {
    if (HIDDEN_FIELDS.has(k)) continue;
    const hasFrom = !!before && k in before;
    const hasTo = !!after && k in after;
    if (hasFrom && hasTo && JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    lines.push({
      field: fieldLabel(k),
      ...(hasFrom ? { from: formatValue(k, before[k]) } : {}),
      ...(hasTo ? { to: formatValue(k, after[k]) } : {}),
    });
  }
  return lines;
}

/** The student page a row is about, when the row says (a lead id, or a lead id in its values). */
export function leadLink(row: {
  entityType: string;
  entityId: string | null;
  newValue: unknown;
  oldValue: unknown;
}): string | null {
  if (row.entityType === 'lead' && row.entityId) return `/app/leads/${row.entityId}`;
  for (const v of [row.newValue, row.oldValue]) {
    if (isPlain(v) && typeof v['leadId'] === 'string' && UUID.test(v['leadId']))
      return `/app/leads/${v['leadId']}`;
  }
  return null;
}
