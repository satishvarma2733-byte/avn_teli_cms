import { disconnectAll } from '@avn-cms/db';

import { documentMaintenanceAllTenants, overdueSweepAllTenants, stuckJobsSweepAllTenants } from './jobs';

/** Run the overdue, stuck-jobs and documents sweeps once without Redis (cron fallback / manual operations). */
const results = await overdueSweepAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'overdue sweep', results }));
const stuck = await stuckJobsSweepAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'stuck jobs sweep', results: stuck }));
const docs = await documentMaintenanceAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'documents sweep', results: docs }));
await disconnectAll();
