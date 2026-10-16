/** Filters the leads workspace reads from the URL. The export takes the same ones. */
export const LEAD_FILTER_KEYS = [
  'view',
  'q',
  'stage',
  'sourceId',
  'counselorId',
  'telecallerId',
  'state',
  'sort',
] as const;
