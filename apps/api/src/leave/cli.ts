import { config } from 'dotenv';
import { runLeaveEntitlementsJob } from './leave-jobs.js';

config({ path: '../../.env' });

async function main(): Promise<void> {
  const [command, ...receivedArgs] = process.argv.slice(2);
  const args = receivedArgs[0] === '--' ? receivedArgs.slice(1) : receivedArgs;
  const usage =
    'Usage: leave CLI process-entitlements [--as-of YYYY-MM-DD] [--organization-id <uuid>] [--lookback-days <days>]';
  if (command === '--help' || command === 'help' || args[0] === '--help') {
    console.info(usage);
    return;
  }
  if (command !== 'process-entitlements' || args.length % 2 !== 0)
    throw new Error(usage);
  const data: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (flag === '--as-of') data.asOf = value;
    else if (flag === '--organization-id') data.organizationId = value;
    else if (flag === '--lookback-days') data.lookbackDays = Number(value);
    else throw new Error(usage);
  }
  const outcome = await runLeaveEntitlementsJob(data);
  console.info(JSON.stringify(outcome, null, 2));
  if (outcome.failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error('Leave command failed:', error);
  process.exitCode = 1;
}
