import { disconnectAll } from '@avn-cms/db';

import { overdueSweepAllTenants, stuckJobsSweepAllTenants } from './jobs';

/** Run the overdue sweep and the stuck-jobs sweep once without Redis (cron fallback / manual operations). */
const results = await overdueSweepAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'overdue sweep', results }));
const stuck = await stuckJobsSweepAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'stuck jobs sweep', results: stuck }));
await disconnectAll();
