'use client';

import { Pencil, Plus, Sparkles, Trash2, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Badge, Card, EmptyState, PageHeader, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/client';
import { formatRelative } from '@/lib/format';

import { RuleBuilder } from './rule-builder';
import { RunLog } from './run-log';
import type { Rule } from './types';

type Tab = 'rules' | 'runs';

export function AutomationsView() {
  const api = useApi();
  const [tab, setTab] = useState<Tab>('rules');
  const [runsRule, setRunsRule] = useState('');
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [missingStarters, setMissingStarters] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addingStarters, setAddingStarters] = useState(false);

  const load = useCallback(async () => {
    const res = await api<Rule[]>('/api/automations');
    if (!res.ok) return setError(res.error.message);
    setError(null);
    setRules(res.data);
    setMissingStarters((res.meta?.['missingStarters'] as number | undefined) ?? 0);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(rule: Rule) {
    setBusyId(rule.id);
    const res = await api(`/api/automations/${rule.id}`, {
      method: 'PATCH',
      body: { isActive: !rule.isActive },
    });
    setBusyId(null);
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    setNotice({
      tone: 'success',
      text: rule.isActive
        ? `“${rule.name}” is off. It won’t run until you turn it on.`
        : `“${rule.name}” is on.`,
    });
    void load();
  }

  async function remove(rule: Rule) {
    setBusyId(rule.id);
    const res = await api(`/api/automations/${rule.id}`, { method: 'DELETE' });
    setBusyId(null);
    setDeleting(null);
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    setNotice({ tone: 'success', text: `“${rule.name}” was deleted.` });
    void load();
  }

  async function addStarters() {
    setAddingStarters(true);
    const res = await api<{ added: number }>('/api/automations/starter', { method: 'POST' });
    setAddingStarters(false);
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    setNotice({
      tone: 'success',
      text: res.data.added === 1 ? 'Added 1 starter rule.' : `Added ${res.data.added} starter rules.`,
    });
    void load();
  }

  function showRuns(rule: Rule) {
    setRunsRule(rule.id);
    setTab('runs');
  }

  return (
    <>
      <PageHeader
        title="Automations"
        description="Rules that act for you: when something happens and it fits the conditions, the actions run and are logged."
        actions={
          <>
            {missingStarters > 0 && rules && rules.length > 0 && (
              <Button variant="secondary" loading={addingStarters} onClick={() => void addStarters()}>
                <Sparkles /> Add starter rules
              </Button>
            )}
            <Button onClick={() => setEditing('new')}>
              <Plus /> New rule
            </Button>
          </>
        }
      />

      <div className="mb-4 flex gap-1" role="tablist" aria-label="Automations">
        {(
          [
            ['rules', 'Rules'],
            ['runs', 'Run log'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            id={`automation-tab-${id}`}
            role="tab"
            type="button"
            aria-selected={tab === id}
            aria-controls={`automation-panel-${id}`}
            onClick={() => setTab(id)}
            className={cn(
              'inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium',
              tab === id
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {notice && (
        <div className="mb-4">
          <Alert tone={notice.tone}>{notice.text}</Alert>
        </div>
      )}

      {tab === 'rules' ? (
        <div role="tabpanel" id="automation-panel-rules" aria-labelledby="automation-tab-rules">
          {error ? (
            <Alert tone="danger" title="Couldn’t load the rules">
              {error}
            </Alert>
          ) : !rules ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
          ) : rules.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Zap />}
                title="No rules yet"
                description="Start with the five starter rules (routing web leads, chasing uncontacted leads and more), or build your own."
                action={
                  <Button loading={addingStarters} onClick={() => void addStarters()}>
                    <Sparkles /> Add starter rules
                  </Button>
                }
              />
            </Card>
          ) : (
            <ul className="space-y-3">
              {rules.map((rule) => (
                <li key={rule.id}>
                  <RuleCard
                    rule={rule}
                    busy={busyId === rule.id}
                    onToggle={() => void toggle(rule)}
                    onEdit={() => setEditing(rule)}
                    onDelete={() => setDeleting(rule)}
                    onRuns={() => showRuns(rule)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="automation-panel-runs" aria-labelledby="automation-tab-runs">
          <RunLog rules={rules ?? []} ruleId={runsRule} onRuleChange={setRunsRule} />
        </div>
      )}

      {editing && (
        <RuleBuilder
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            setNotice({
              tone: 'success',
              text: created ? `“${saved.name}” was created.` : `“${saved.name}” was saved.`,
            });
            void load();
          }}
        />
      )}

      {deleting && (
        <Dialog
          open
          onOpenChange={() => setDeleting(null)}
          title={`Delete “${deleting.name}”?`}
          description="The rule and its run log are removed. Things it already did stay as they are."
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button variant="danger" loading={busyId === deleting.id} onClick={() => void remove(deleting)}>
                Delete rule
              </Button>
            </>
          }
        />
      )}
    </>
  );
}

function RuleCard({
  rule,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onRuns,
}: {
  rule: Rule;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRuns: () => void;
}) {
  const { stats } = rule;
  return (
    <Card className={cn('p-4', !rule.isActive && 'bg-surface-muted/40')}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{rule.name}</h2>
            <Badge tone={rule.isActive ? 'success' : 'neutral'}>{rule.isActive ? 'On' : 'Off'}</Badge>
            {rule.starterKey && <Badge tone="primary">Starter</Badge>}
            {!rule.valid && <Badge tone="danger">Needs editing</Badge>}
          </div>
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="w-12 shrink-0 text-muted-foreground">When</dt>
              <dd>
                {rule.when ? `${TRIGGER_TEXT[rule.trigger]} — ${rule.when}` : TRIGGER_TEXT[rule.trigger]}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-12 shrink-0 text-muted-foreground">Then</dt>
              <dd>
                {rule.does.length ? (
                  <ol className="list-inside list-decimal space-y-0.5">
                    {rule.does.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ol>
                ) : (
                  <span className="text-danger">No usable actions. Edit the rule to fix it.</span>
                )}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            {stats.runs === 0
              ? 'No runs in the last 7 days.'
              : `${stats.runs} run${stats.runs === 1 ? '' : 's'} in the last 7 days${
                  stats.failed ? ` · ${stats.failed} failed` : ''
                }${stats.lastRunAt ? ` · last ${formatRelative(stats.lastRunAt)}` : ''}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={onToggle}
            aria-label={`${rule.isActive ? 'Turn off' : 'Turn on'}: ${rule.name}`}
          >
            {rule.isActive ? 'Turn off' : 'Turn on'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onEdit} aria-label={`Edit: ${rule.name}`}>
            <Pencil /> Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={onRuns} aria-label={`Runs: ${rule.name}`}>
            Runs
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete: ${rule.name}`}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

const TRIGGER_TEXT: Record<Rule['trigger'], string> = {
  WEB_LEAD_CREATED: 'A web lead arrives',
  LEAD_UNCONTACTED: 'A lead has not been contacted',
  FOLLOWUP_OVERDUE: 'A follow-up call',
  STAGE_CHANGED: 'A lead’s stage',
};
