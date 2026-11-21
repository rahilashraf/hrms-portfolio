import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationCatalogService } from '../src/authorization/authorization-catalog.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { PasswordHasherService } from '../src/security/password-hasher.service.js';
import {
  demoPasswordFor,
  ensureDemoAccounts,
  type DemoCredential,
} from './accounts.js';
import { DEMO_ACCOUNTS } from './dataset.js';
import {
  assertDemoDatabase,
  assertDemoDatabaseUrl,
  assertResetAllowed,
  markDemoDatabase,
  mondayOnOrBefore,
  readDemoIdentity,
} from './demo-database.js';
import { seedDemoWorkflows } from './workflows.js';

/**
 * Batch 11 — demonstration database commands (from apps/api; DATABASE_URL must name a `*_demo`
 * database; see demo-database.ts for every guard):
 *
 *   tsx demo/demo-cli.ts create                      # create the database if it doesn't exist
 *   tsx demo/demo-cli.ts mark                        # once, on the new, migrated, empty database
 *   tsx demo/demo-cli.ts check                       # exit non-zero unless it is a demo database
 *   tsx demo/demo-cli.ts seed --api-url <url>        # accounts, then workflows through the API
 *   tsx demo/demo-cli.ts reset --confirm <db-name>   # drop and recreate (local demo DB only)
 *
 * `pnpm demo` (scripts/demo.mjs) runs these in order; see docs/development/demo.md.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = resolve(here, '../../..');
/** Git-ignored; written with mode 0600. Never commit or share it. */
export const CREDENTIALS_FILE = resolve(REPOSITORY, '.demo/credentials.json');

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** The server's maintenance database (for CREATE/DROP DATABASE), through the API's own client. */
async function withMaintenance<T>(
  url: string,
  run: (client: PrismaService) => Promise<T>,
) {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  const client = new PrismaService(parsed.toString());
  try {
    await client.$connect();
    return await run(client);
  } finally {
    await client.$disconnect();
  }
}

async function databaseExists(url: string, databaseName: string) {
  const rows = await withMaintenance(url, (client) =>
    client.$queryRawUnsafe<Array<{ exists: number }>>(
      'SELECT 1 AS "exists" FROM pg_database WHERE datname = $1',
      databaseName,
    ),
  );
  return rows.length === 1;
}

async function createDatabase(environment: NodeJS.ProcessEnv) {
  const { url, databaseName } = assertDemoDatabaseUrl(environment);
  if (await databaseExists(url, databaseName)) {
    console.info(`Database "${databaseName}" already exists.`);
    return;
  }
  // databaseName matched DEMO_DATABASE_NAME (a plain lowercase identifier).
  await withMaintenance(url, (client) =>
    client.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`),
  );
  console.info(`Created database "${databaseName}".`);
}

async function resetDatabase(
  environment: NodeJS.ProcessEnv,
  confirmation: string | undefined,
) {
  // Configuration and confirmation first: nothing is connected to before both pass.
  const target = assertResetAllowed(environment, confirmation, null);
  let identity = null;
  if (await databaseExists(target.url, target.databaseName)) {
    const prisma = new PrismaService(target.url);
    try {
      await prisma.$connect();
      identity = await readDemoIdentity(prisma);
    } finally {
      await prisma.$disconnect();
    }
  }
  // Now the database's own identity: the demo marker and nothing but demo data.
  assertResetAllowed(environment, confirmation, identity);
  await withMaintenance(target.url, async (client) => {
    await client.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${target.databaseName}" WITH (FORCE)`,
    );
    await client.$executeRawUnsafe(`CREATE DATABASE "${target.databaseName}"`);
  });
  console.info(
    `Dropped and recreated "${target.databaseName}". Next: migrate, mark and seed (pnpm demo does all three).`,
  );
}

function writeCredentials(credentials: DemoCredential[]) {
  const previous: Record<string, string> = existsSync(CREDENTIALS_FILE)
    ? ((
        JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as {
          accounts?: Array<{ email: string; password: string }>;
        }
      ).accounts?.reduce<Record<string, string>>(
        (all, entry) => ({ ...all, [entry.email]: entry.password }),
        {},
      ) ?? {})
    : {};
  const accounts = DEMO_ACCOUNTS.map((account) => {
    const fresh = credentials.find(
      (entry) => entry.email === account.email,
    )?.password;
    return {
      role: account.key,
      email: account.email,
      password: fresh ?? previous[account.email] ?? null,
      purpose: account.purpose,
    };
  });
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true });
  writeFileSync(
    CREDENTIALS_FILE,
    `${JSON.stringify({ note: 'Demonstration accounts for a local, synthetic database only. Never reuse these passwords.', accounts }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(CREDENTIALS_FILE, 0o600);
  return accounts;
}

async function seed(
  environment: NodeJS.ProcessEnv,
  apiUrl: string,
  resetPasswords: boolean,
) {
  const prisma = new PrismaService(assertDemoDatabaseUrl(environment).url);
  try {
    await prisma.$connect();
    const { referenceDate } = await assertDemoDatabase(prisma, environment);
    await new AuthorizationCatalogService(prisma).sync();
    const passwords = new PasswordHasherService(new ConfigService(environment));
    const { credentials } = await ensureDemoAccounts(prisma, passwords, {
      sharedPassword: demoPasswordFor(environment),
      resetPasswords,
      now: new Date(),
    });
    // The System Owner, through the same idempotent path as `authz:bootstrap-owner`.
    const authorization = new AuthorizationService(prisma);
    await new RoleManagementService(
      prisma,
      authorization,
      new AuditService(prisma),
    ).bootstrapSystemOwner(
      DEMO_ACCOUNTS.find((account) => account.key === 'owner')!.email,
    );
    const accounts = writeCredentials(credentials);
    const missing = accounts.filter((account) => !account.password);
    if (missing.length > 0) {
      throw new Error(
        `No password is on record for ${missing.map((account) => account.email).join(', ')} (${CREDENTIALS_FILE} was removed?). Rerun with --reset-passwords.`,
      );
    }
    const passwordsByKey = Object.fromEntries(
      accounts.map((account) => [account.role, account.password!]),
    );
    const summary = await seedDemoWorkflows({
      prisma,
      apiUrl,
      referenceDate,
      passwords: passwordsByKey,
      log: (message) => console.info(message),
    });
    console.info(`\nDemo data is ready (reference week of ${referenceDate}).`);
    console.info(JSON.stringify(summary, null, 2));
    console.info(`Sign-in details: ${CREDENTIALS_FILE}`);
  } finally {
    await prisma.$disconnect();
  }
}

/** The repository's migrations: the directories under prisma/migrations with a migration.sql. */
function repositoryMigrations() {
  const directory = resolve(REPOSITORY, 'prisma/migrations');
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(resolve(directory, entry.name, 'migration.sql')),
    )
    .map((entry) => entry.name)
    .sort();
}

async function main() {
  config({ path: resolve(REPOSITORY, '.env') });
  const environment = process.env;
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'create':
      return createDatabase(environment);
    case 'mark': {
      const prisma = new PrismaService(assertDemoDatabaseUrl(environment).url);
      try {
        await prisma.$connect();
        const today = new Date().toISOString().slice(0, 10);
        const result = await markDemoDatabase(
          prisma,
          environment,
          mondayOnOrBefore(today),
          repositoryMigrations(),
        );
        console.info(
          result.marked
            ? `Marked "${result.databaseName}" as a demonstration database (reference week of ${result.referenceDate}).`
            : `"${result.databaseName}" is already a demonstration database (reference week of ${result.referenceDate}).`,
        );
      } finally {
        await prisma.$disconnect();
      }
      return;
    }
    case 'check': {
      const prisma = new PrismaService(assertDemoDatabaseUrl(environment).url);
      try {
        await prisma.$connect();
        const result = await assertDemoDatabase(prisma, environment);
        console.info(
          `"${result.databaseName}" is a demonstration database (reference week of ${result.referenceDate}).`,
        );
      } finally {
        await prisma.$disconnect();
      }
      return;
    }
    case 'reset':
      return resetDatabase(environment, option(args, '--confirm'));
    case 'seed': {
      const apiUrl = option(args, '--api-url');
      if (!apiUrl)
        throw new Error(
          'seed needs --api-url <url of a running API on the demo database>.',
        );
      return seed(
        environment,
        apiUrl.replace(/\/$/, ''),
        args.includes('--reset-passwords'),
      );
    }
    default:
      throw new Error(
        'Usage: demo-cli.ts create | mark | check | seed --api-url <url> [--reset-passwords] | reset --confirm <database>',
      );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
