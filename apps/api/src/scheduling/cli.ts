import { config } from 'dotenv';
import { runExtendGeneratedShiftsJob } from './generation-job.js';

config({ path: '../../.env' });

async function main(): Promise<void> {
  const [command, ...receivedArgs] = process.argv.slice(2);
  const args = receivedArgs[0] === '--' ? receivedArgs.slice(1) : receivedArgs;
  const usage =
    'Usage: scheduling CLI extend-generated-shifts [--horizon-days <days>]';
  if (command === '--help' || command === 'help' || args[0] === '--help') {
    console.info(usage);
    return;
  }
  if (
    command !== 'extend-generated-shifts' ||
    (args.length !== 0 && (args.length !== 2 || args[0] !== '--horizon-days'))
  ) {
    throw new Error(usage);
  }
  const outcome = await runExtendGeneratedShiftsJob(
    args.length === 2 ? { horizonDays: Number(args[1]) } : {},
  );
  console.info(JSON.stringify(outcome, null, 2));
  if (outcome.failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error('Scheduling command failed:', error);
  process.exitCode = 1;
}
