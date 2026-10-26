import { drainInProcessJobs } from '@avn-cms/core';
import { disconnectAll } from '@avn-cms/db';

import {
  authCleanup,
  automationSweepAllTenants,
  documentMaintenanceAllTenants,
  overdueSweepAllTenants,
  stuckJobsSweepAllTenants,
  usageSnapshot,
} from './jobs';

/** Run the overdue, stuck-jobs and documents sweeps once without Redis (cron fallback / manual operations). */
const results = await overdueSweepAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'overdue sweep', results }));
const stuck = await stuckJobsSweepAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'stuck jobs sweep', results: stuck }));
const docs = await documentMaintenanceAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'documents sweep', results: docs }));
const automation = await automationSweepAllTenants();
console.log(JSON.stringify({ level: 'info', msg: 'automation sweep', results: automation }));
const snapshot = await usageSnapshot();
console.log(JSON.stringify({ level: 'info', msg: 'usage snapshot', results: snapshot }));
const auth = await authCleanup();
console.log(JSON.stringify({ level: 'info', msg: 'auth cleanup', results: auth }));
// Without Redis the runs the sweep found are carried out in this process; let them finish.
await drainInProcessJobs();
await disconnectAll();
