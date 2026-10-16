import { DISPOSITION_LABEL, STAGE_LABEL } from '@avn-cms/core/schemas';
import type { CallDisposition, LeadStage } from '@avn-cms/db/enums';
import { Flame, Star } from 'lucide-react';

import { Badge, type Tone } from '@/components/ui/primitives';

const STAGE_TONE: Record<LeadStage, Tone> = {
  NEW: 'info',
  CONTACTED: 'primary',
  INTERESTED: 'primary',
  FOLLOW_UP_REQUIRED: 'warning',
  POTENTIAL: 'primary',
  APPLICATION_STARTED: 'primary',
  DOCUMENTS_PENDING: 'warning',
  APPLICATION_SUBMITTED: 'primary',
  OFFER_RECEIVED: 'success',
  ADMISSION_CONFIRMED: 'success',
  ENROLLED: 'success',
  NOT_INTERESTED: 'neutral',
  INVALID: 'danger',
  UNREACHABLE: 'neutral',
  DUPLICATE: 'neutral',
  BLOCKED: 'danger',
  LOST: 'neutral',
  LONG_TERM: 'neutral',
};

export function StageBadge({ stage }: { stage: LeadStage }) {
  return <Badge tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Badge>;
}

const DISPOSITION_TONE: Record<CallDisposition, Tone> = {
  SCHEDULED: 'info',
  COMPLETED: 'success',
  NO_ANSWER: 'warning',
  BUSY: 'warning',
  SWITCHED_OFF: 'warning',
  CALL_BACK_LATER: 'primary',
  INTERESTED: 'success',
  NOT_INTERESTED: 'neutral',
  AWAITING_FEEDBACK: 'primary',
  ESCALATED: 'danger',
};

export function DispositionBadge({ disposition }: { disposition: CallDisposition }) {
  return <Badge tone={DISPOSITION_TONE[disposition]}>{DISPOSITION_LABEL[disposition]}</Badge>;
}

export function LeadFlags({ isPotential, priority }: { isPotential: boolean; priority: 'NORMAL' | 'HOT' }) {
  return (
    <>
      {priority === 'HOT' && (
        <Badge tone="danger">
          <Flame className="size-3" aria-hidden /> HOT
        </Badge>
      )}
      {isPotential && (
        <Badge tone="warning">
          <Star className="size-3" aria-hidden /> Potential
        </Badge>
      )}
    </>
  );
}
