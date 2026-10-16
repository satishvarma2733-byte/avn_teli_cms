import type { CallDisposition, LeadStage } from '@avn-cms/db/enums';

/** The lead detail payload as the browser receives it (dates are ISO strings). */
export interface LeadDetailData {
  id: string;
  stage: LeadStage;
  isPotential: boolean;
  priority: 'NORMAL' | 'HOT';
  interestCountry: string | null;
  interestCourse: string | null;
  nextCallAt: string | null;
  lastContactedAt: string | null;
  lostReason: string | null;
  createdAt: string;
  updatedAt: string;
  source: { id: string; code: string; label: string };
  student: {
    id: string;
    name: string;
    parentName: string | null;
    phone: string;
    altPhone: string | null;
    email: string | null;
    town: string | null;
    district: string | null;
    state: string | null;
    address: string | null;
    createdAt: string;
  };
  counselor: { id: string; name: string | null } | null;
  telecaller: { id: string; name: string | null } | null;
  assignmentHistory: {
    id: string;
    roleFunction: 'COUNSELOR' | 'TELECALLER';
    isActive: boolean;
    assignedAt: string;
    endedAt: string | null;
    assigneeName: string | null;
    assignedByName: string | null;
  }[];
  followUps: {
    id: string;
    scheduledAt: string;
    disposition: CallDisposition;
    priority: 'NORMAL' | 'HOT';
    outcomeNote: string | null;
    completedAt: string | null;
    isOverdue: boolean;
    assigneeId: string;
    assigneeName: string | null;
  }[];
  notes: { id: string; body: string; authorName: string | null; createdAt: string }[];
  history: {
    id: string;
    fromStage: LeadStage | null;
    toStage: LeadStage;
    changedByName: string | null;
    note: string | null;
    reason: string | null;
    createdAt: string;
  }[];
  otherLeads: { id: string; stage: LeadStage; createdAt: string; interestCountry: string | null }[];
  permissions: {
    editStudent: boolean;
    editContactOnly: boolean;
    changeStage: boolean;
    markPotential: boolean;
    assignCounselor: boolean;
    assignTelecaller: boolean;
    scheduleFollowup: boolean;
    logDisposition: boolean;
    addNote: boolean;
    delete: boolean;
    documents: boolean;
    verifyDocuments: boolean;
  };
}
