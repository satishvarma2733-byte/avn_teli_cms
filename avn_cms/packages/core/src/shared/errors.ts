/** Stable error codes (ARCHITECTURE §3): clients branch on these, never on messages. */
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export const notFound = (what = 'Record') => new AppError('NOT_FOUND', `${what} not found.`);
export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError('FORBIDDEN', message);
export const conflict = (message: string, details?: unknown) => new AppError('CONFLICT', message, details);
export const invalid = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, details);
