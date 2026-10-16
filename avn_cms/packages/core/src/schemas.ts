/**
 * Zod DTOs shared by API routes, services and client forms. Client-safe: imports only zod
 * and the generated enum constants (no database client, no Node APIs).
 */
import {
  CallDisposition,
  LeadStage,
  Priority,
  RoleCode,
  StudentDocStatus,
  StudentDocType,
  WebLeadStatus,
} from '@avn-cms/db/enums';
import { z } from 'zod';

export { CallDisposition, LeadStage, Priority, RoleCode, StudentDocStatus, StudentDocType, WebLeadStatus };

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const requiredText = (max: number, message: string) =>
  z.string().trim().min(1, message).max(max, `Use at most ${max} characters.`);

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .transform((v) => (v === '' ? null : v))
  .pipe(z.email('Enter a valid email address.').nullable())
  .nullable()
  .optional();

const phoneField = z
  .string()
  .trim()
  .min(1, 'Enter a phone number.')
  .max(20, 'That phone number is too long.');
const uuid = z.uuid('Invalid id.');
const optionalUuid = z
  .union([uuid, z.literal('')])
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

export const LEAD_STAGES = Object.values(LeadStage);
export const POSITIVE_STAGES: LeadStage[] = [
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'FOLLOW_UP_REQUIRED',
  'POTENTIAL',
  'APPLICATION_STARTED',
  'DOCUMENTS_PENDING',
  'APPLICATION_SUBMITTED',
  'OFFER_RECEIVED',
  'ADMISSION_CONFIRMED',
  'ENROLLED',
];
export const NEGATIVE_STAGES: LeadStage[] = [
  'NOT_INTERESTED',
  'INVALID',
  'UNREACHABLE',
  'DUPLICATE',
  'BLOCKED',
  'LOST',
];
/** Stages that count as "active" (not closed) for dashboards and queues. */
export const CLOSED_STAGES: LeadStage[] = [...NEGATIVE_STAGES, 'ENROLLED'];

export const STAGE_LABEL: Record<LeadStage, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  INTERESTED: 'Interested',
  FOLLOW_UP_REQUIRED: 'Follow-up required',
  POTENTIAL: 'Potential',
  APPLICATION_STARTED: 'Application started',
  DOCUMENTS_PENDING: 'Documents pending',
  APPLICATION_SUBMITTED: 'Application submitted',
  OFFER_RECEIVED: 'Offer received',
  ADMISSION_CONFIRMED: 'Admission confirmed',
  ENROLLED: 'Enrolled',
  NOT_INTERESTED: 'Not interested',
  INVALID: 'Invalid',
  UNREACHABLE: 'Unreachable',
  DUPLICATE: 'Duplicate',
  BLOCKED: 'Blocked',
  LOST: 'Lost',
  LONG_TERM: 'Long term',
};

export const DISPOSITION_LABEL: Record<CallDisposition, string> = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Completed',
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  SWITCHED_OFF: 'Switched off',
  CALL_BACK_LATER: 'Call back later',
  INTERESTED: 'Interested',
  NOT_INTERESTED: 'Not interested',
  AWAITING_FEEDBACK: 'Awaiting feedback',
  ESCALATED: 'Escalated',
};

/** A disposition may *suggest* a stage (ARCHITECTURE §7); it never changes it on its own. */
export const DISPOSITION_SUGGESTS: Partial<Record<CallDisposition, LeadStage>> = {
  INTERESTED: 'INTERESTED',
  NOT_INTERESTED: 'NOT_INTERESTED',
  CALL_BACK_LATER: 'FOLLOW_UP_REQUIRED',
  AWAITING_FEEDBACK: 'FOLLOW_UP_REQUIRED',
  COMPLETED: 'CONTACTED',
};

// ── Students / leads ─────────────────────────────────────────────────────────

export const studentCreateSchema = z.object({
  name: requiredText(200, 'Enter the student’s name.'),
  parentName: text(200),
  phone: phoneField,
  altPhone: text(20),
  email: emailField,
  town: text(100),
  district: text(100),
  state: text(100),
  address: text(500),
  sourceId: uuid,
  interestCountry: text(100),
  interestCourse: text(100),
  isPotential: z.boolean().optional(),
  priority: z.enum(Priority).optional(),
  counselorId: optionalUuid,
  telecallerId: optionalUuid,
  note: text(2000),
});
export type StudentCreateInput = z.input<typeof studentCreateSchema>;
export type StudentCreateDTO = z.output<typeof studentCreateSchema>;

export const studentUpdateSchema = z
  .object({
    name: requiredText(200, 'Enter the student’s name.').optional(),
    parentName: text(200),
    phone: phoneField.optional(),
    altPhone: text(20),
    email: emailField,
    town: text(100),
    district: text(100),
    state: text(100),
    address: text(500),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update.' });
export type StudentUpdateDTO = z.output<typeof studentUpdateSchema>;

export const leadUpdateSchema = z
  .object({
    stage: z.enum(LeadStage).optional(),
    stageNote: text(1000),
    lostReason: text(500),
    isPotential: z.boolean().optional(),
    priority: z.enum(Priority).optional(),
    interestCountry: text(100),
    interestCourse: text(100),
    counselorId: optionalUuid,
    telecallerId: optionalUuid,
  })
  .refine((v) => Object.entries(v).some(([k, x]) => x !== undefined && k !== 'stageNote'), {
    message: 'Nothing to update.',
  });
export type LeadUpdateDTO = z.output<typeof leadUpdateSchema>;

export const LEAD_VIEWS = [
  'all',
  'mine',
  'today',
  'overdue',
  'potential',
  'hot',
  'unassigned',
  'closed',
] as const;
export const LEAD_SORTS = ['newest', 'oldest', 'updated'] as const;

export const leadListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  view: z.enum(LEAD_VIEWS).default('all'),
  stage: z.enum(LeadStage).optional(),
  sourceId: uuid.optional(),
  counselorId: uuid.optional(),
  telecallerId: uuid.optional(),
  state: z.string().trim().max(100).optional(),
  district: z.string().trim().max(100).optional(),
  sort: z.enum(LEAD_SORTS).default('newest'),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type LeadListQuery = z.output<typeof leadListQuerySchema>;

export const bulkActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('reassign'),
    ids: z.array(uuid).min(1).max(1000),
    counselorId: optionalUuid,
    telecallerId: optionalUuid,
  }),
  z.object({
    action: z.literal('setStage'),
    ids: z.array(uuid).min(1).max(1000),
    stage: z.enum(LeadStage),
    note: text(1000),
  }),
  z.object({ action: z.literal('block'), ids: z.array(uuid).min(1).max(1000), note: text(1000) }),
]);
export type BulkActionDTO = z.output<typeof bulkActionSchema>;

export const noteCreateSchema = z.object({ body: requiredText(5000, 'Write a note first.') });

// ── Follow-ups ───────────────────────────────────────────────────────────────

export const FOLLOWUP_BUCKETS = ['today', 'upcoming', 'pending', 'overdue', 'closed'] as const;
export type FollowupBucket = (typeof FOLLOWUP_BUCKETS)[number];

export const followupListQuerySchema = z.object({
  bucket: z.enum(FOLLOWUP_BUCKETS).default('today'),
  assigneeId: uuid.optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const followupCreateSchema = z.object({
  leadId: uuid,
  scheduledAt: z.iso.datetime({ offset: true, message: 'Choose a date and time.' }),
  assigneeId: optionalUuid,
  priority: z.enum(Priority).optional(),
  note: text(1000),
});

export const followupUpdateSchema = z
  .object({
    /** Reschedule. */
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
    /** Log a call outcome. SCHEDULED/ESCALATED are system states and can't be logged. */
    disposition: z
      .enum(CallDisposition)
      .refine((d) => d !== 'SCHEDULED' && d !== 'ESCALATED', 'Choose what happened on the call.')
      .optional(),
    outcomeNote: text(2000),
    /** Book the next call at the same time as logging this one. */
    nextCallAt: z.iso.datetime({ offset: true }).optional(),
    /** Apply the stage the disposition suggests (or another one). */
    applyStage: z.enum(LeadStage).optional(),
    priority: z.enum(Priority).optional(),
  })
  .refine((v) => v.scheduledAt || v.disposition || v.priority, { message: 'Nothing to update.' });

// ── Users ────────────────────────────────────────────────────────────────────

export const TENANT_ROLES = ['TENANT_ADMIN', 'COUNSELOR', 'TELECALLER'] as const;

export const userCreateSchema = z.object({
  name: requiredText(200, 'Enter a name.'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  phone: text(20),
  role: z.enum(TENANT_ROLES),
});

export const userUpdateSchema = z
  .object({
    name: requiredText(200, 'Enter a name.').optional(),
    phone: text(20),
    role: z.enum(TENANT_ROLES).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update.' });

export const transferLeadsSchema = z.object({ toUserId: uuid });

// ── Web leads / intake ───────────────────────────────────────────────────────

export const webLeadListQuerySchema = z.object({
  status: z.enum(WebLeadStatus).optional(),
  sourceId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const webLeadConvertSchema = z.object({
  counselorId: optionalUuid,
  telecallerId: optionalUuid,
  /** Attach to the matched student instead of creating a new one (when a duplicate was found). */
  attachToStudentId: optionalUuid,
});

export const webLeadStatusSchema = z.object({
  status: z.enum(['DUPLICATE', 'SPAM', 'REJECTED', 'NEW']),
});

export const intakeCredentialCreateSchema = z.object({
  name: requiredText(100, 'Name this credential (e.g. “eWings website”).'),
  defaultSourceId: optionalUuid,
});

// ── Import / export ──────────────────────────────────────────────────────────

export const DUPLICATE_MODES = ['skip', 'update', 'merge'] as const;
export type DuplicateMode = (typeof DUPLICATE_MODES)[number];

export const importOptionsSchema = z.object({
  /** Field key → zero-based column index (null = not imported). */
  mapping: z.record(z.string(), z.number().int().min(0).max(200).nullable()),
  defaultSourceId: uuid,
  duplicateMode: z.enum(DUPLICATE_MODES).default('skip'),
  /** Give rows without a counselor to the next counselor in turn. */
  roundRobin: z.boolean().default(false),
});
export type ImportOptions = z.output<typeof importOptionsSchema>;

export const importRunSchema = z.object({ duplicateMode: z.enum(DUPLICATE_MODES) });

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const exportCreateSchema = z.object({
  entity: z.enum(['leads', 'web_leads']),
  format: z.enum(EXPORT_FORMATS),
  /** Same filters as the workspace list (leads) or the inbox (web leads). */
  filters: z.record(z.string(), z.string().max(300)).default({}),
});
export type ExportCreateDTO = z.output<typeof exportCreateSchema>;

// ── Reports ──────────────────────────────────────────────────────────────────

export const reportQuerySchema = z.object({
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  sourceId: uuid.optional(),
  state: z.string().trim().max(100).optional(),
  assigneeId: uuid.optional(),
});
export type ReportQuery = z.output<typeof reportQuerySchema>;

// ── Documents vault (Phase 7) ────────────────────────────────────────────────

/** Largest file the vault takes. The scanner and the upload check enforce it too. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * What the vault accepts. The server decides the type from the file name, then checks that the
 * file's first bytes agree (documents/rules.ts); a client-supplied type is never trusted.
 */
export const DOCUMENT_FORMATS = [
  { mime: 'application/pdf', extensions: ['pdf'], label: 'PDF', inline: true },
  { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'], label: 'JPEG image', inline: true },
  { mime: 'image/png', extensions: ['png'], label: 'PNG image', inline: true },
  { mime: 'image/webp', extensions: ['webp'], label: 'WebP image', inline: true },
  { mime: 'application/msword', extensions: ['doc'], label: 'Word document', inline: false },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    label: 'Word document',
    inline: false,
  },
  { mime: 'application/vnd.ms-excel', extensions: ['xls'], label: 'Excel sheet', inline: false },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
    label: 'Excel sheet',
    inline: false,
  },
  { mime: 'text/plain', extensions: ['txt'], label: 'Text file', inline: false },
] as const;

/** For <input type="file" accept>. */
export const DOCUMENT_ACCEPT = DOCUMENT_FORMATS.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');

export const DOC_TYPE_LABEL: Record<StudentDocType, string> = {
  PASSPORT: 'Passport',
  MARKS_MEMO: 'Marks memo',
  NEET_RESULT: 'NEET result',
  TRANSFER_CERT: 'Transfer certificate',
  PHOTO: 'Photo',
  ADMISSION_LETTER: 'Admission letter',
  VISA: 'Visa',
  PAYMENT_RECEIPT: 'Payment receipt',
  OTHER: 'Other document',
};

/** The items every student's checklist shows (everything but "other"). */
export const CHECKLIST_TYPES: readonly StudentDocType[] = [
  'PASSPORT',
  'MARKS_MEMO',
  'NEET_RESULT',
  'TRANSFER_CERT',
  'PHOTO',
  'ADMISSION_LETTER',
  'VISA',
  'PAYMENT_RECEIPT',
];

export const folderCreateSchema = z.object({
  name: requiredText(100, 'Give the folder a name.'),
  parentId: uuid.nullable().optional(),
});
export type FolderCreateDTO = z.output<typeof folderCreateSchema>;

export const folderUpdateSchema = z.object({ name: requiredText(100, 'Give the folder a name.') });

export const folderListQuerySchema = z.object({ parentId: uuid.optional() });

/**
 * Starts an upload. Put it in a folder (admins), or on a student (with the checklist item it is
 * for). `replaces` uploads a new version of an existing document.
 */
export const documentInitSchema = z.object({
  filename: requiredText(260, 'Choose a file.'),
  mimeType: z.string().trim().max(150).default(''),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'The file is empty.')
    .max(MAX_DOCUMENT_BYTES, 'Files can be at most 20 MB.'),
  folderId: uuid.nullable().optional(),
  studentId: uuid.optional(),
  docType: z.enum(StudentDocType).optional(),
  replaces: uuid.optional(),
});
export type DocumentInitDTO = z.output<typeof documentInitSchema>;

export const documentListQuerySchema = z.object({
  folderId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
});

export const documentUrlQuerySchema = z.object({
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
});

export const checklistReviewSchema = z.object({
  status: z.enum(['UPLOADED', 'VERIFIED', 'REJECTED']),
  note: z.string().trim().max(500).optional(),
});
export type ChecklistReviewDTO = z.output<typeof checklistReviewSchema>;
