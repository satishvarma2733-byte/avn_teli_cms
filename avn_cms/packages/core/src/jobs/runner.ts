import { exportRun } from '../exports/export.runner';
import { runImport, validateImport } from '../imports/import.runner';
import { registerLocalHandler, type JobKind, type JobPayload } from './queue';

/** One entry point for every background job (worker and in-process fallback). */
export async function processJob(kind: JobKind, payload: JobPayload): Promise<void> {
  switch (kind) {
    case 'import.validate':
      return validateImport(payload);
    case 'import.run':
      return runImport(payload);
    case 'export.run':
      return exportRun(payload);
  }
}

registerLocalHandler(processJob);
