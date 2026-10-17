import type { AutomationAction, AutomationTriggerCode } from '@avn-cms/core/automation';

import type { Tone } from '@/components/ui/primitives';

/** A rule as the API returns it (dates arrive as text). */
export interface Rule {
  id: string;
  name: string;
  isActive: boolean;
  trigger: AutomationTriggerCode;
  conditions: Record<string, unknown>;
  actions: AutomationAction[];
  /** False when the stored actions no longer parse: the rule can't run until it is edited. */
  valid: boolean;
  starterKey: string | null;
  /** The conditions in plain words, and what the rule does. */
  when: string;
  does: string[];
  createdAt: string;
  updatedAt: string;
  stats: {
    runs: number;
    done: number;
    skipped: number;
    failed: number;
    pending: number;
    lastRunAt: string | null;
  };
}

export type RunStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'SKIPPED' | 'FAILED';

export interface Run {
  id: string;
  ruleId: string;
  ruleName: string;
  event: AutomationTriggerCode;
  status: RunStatus;
  summary: string | null;
  actions: { type: string; outcome: string; detail: string }[];
  subject: string | null;
  leadId: string | null;
  webLeadId: string | null;
  attempts: number;
  createdAt: string;
  finishedAt: string | null;
}

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Waiting', tone: 'info' },
  RUNNING: { label: 'Running', tone: 'info' },
  DONE: { label: 'Done', tone: 'success' },
  SKIPPED: { label: 'Nothing to do', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'danger' },
};

/** "90" → "1 hour 30 minutes": shown beside number fields so nobody has to do the sum. */
export function humanMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [
    days ? `${days} day${days === 1 ? '' : 's'}` : '',
    hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '',
    mins ? `${mins} minute${mins === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}
