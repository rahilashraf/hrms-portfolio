import { PrismaService } from '../../src/database/prisma.service.js';
import {
  assertDisposableDatabase,
  assertDisposableDatabaseUrl,
  markDisposableDatabase,
} from './disposable-database.js';

/**
 * Real-stack database guard commands (from apps/api, with REAL_STACK_E2E=1 and DATABASE_URL):
 *
 *   tsx test/real-stack/disposable-database-cli.ts mark   # once, on a new, migrated database
 *   tsx test/real-stack/disposable-database-cli.ts check  # before seeding or starting the API
 *
 * `mark` writes the disposable marker only on a local `*_disposable` database that holds no
 * accounts; `check` exits non-zero unless the database passes every guard. See
 * disposable-database.ts.
 */
async function main() {
  const command = process.argv[2];
  if (command !== 'mark' && command !== 'check') {
    throw new Error('Usage: disposable-database-cli.ts mark|check');
  }
  const { url, databaseName } = assertDisposableDatabaseUrl(process.env);
  const prisma = new PrismaService(url);
  try {
    await prisma.$connect();
    if (command === 'mark') {
      const { marked } = await markDisposableDatabase(prisma, process.env);
      console.info(
        marked
          ? `Marked "${databaseName}" as a disposable test database.`
          : `"${databaseName}" is already marked as a disposable test database.`,
      );
    } else {
      await assertDisposableDatabase(prisma, process.env);
      console.info(`"${databaseName}" is a disposable test database.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
