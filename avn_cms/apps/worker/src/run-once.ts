import { disconnectAll } from '@avn-cms/db';

import { overdueSweepAllTenants } from './jobs';

/** Run the overdue sweep once without Redis (cron fallback / manual operations). */
const results = await overdueSweepAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'overdue sweep', results }));
await disconnectAll();
