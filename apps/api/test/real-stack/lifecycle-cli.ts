import { runReconcileRetainedGrantsJob } from '../../src/employee/employee-jobs.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  assertDisposableDatabase,
  assertDisposableDatabaseUrl,
} from './disposable-database.js';

/**
 * M3 real-stack command (from apps/api, with REAL_STACK_E2E=1 and DATABASE_URL on a marked
 * disposable database) — what the worker's retained-grant reconciliation job does, with
 * EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED explicitly "false" (the job must not depend on it):
 *
 *   tsx test/real-stack/lifecycle-cli.ts reconcile-retained-grants
 */
async function main() {
  if (process.argv[2] !== 'reconcile-retained-grants')
    throw new Error('Usage: lifecycle-cli.ts reconcile-retained-grants');
  const { url } = assertDisposableDatabaseUrl(process.env);
  const prisma = new PrismaService(url);
  try {
    await prisma.$connect();
    await assertDisposableDatabase(prisma, process.env);
    const outcome = await runReconcileRetainedGrantsJob(
      {},
      { prisma, env: { EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: 'false' } },
    );
    console.info(JSON.stringify(outcome));
    if (outcome.failed.length > 0) process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
