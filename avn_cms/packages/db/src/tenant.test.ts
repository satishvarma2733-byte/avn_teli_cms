import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TENANT_MODELS } from './tenant';

describe('TENANT_MODELS', () => {
  it('lists exactly the schema models that carry tenantId', () => {
    const schema = readFileSync(fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url)), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s+tenantId\s/m.test(body!))
      .map(([, name]) => name);
    expect([...TENANT_MODELS].sort()).toEqual(models.sort());
  });
});
