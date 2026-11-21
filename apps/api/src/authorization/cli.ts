import { ConfigService } from '@nestjs/config';
import { validateEnvironment } from '@hrms/config';
import { config } from 'dotenv';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { PasswordHasherService } from '../security/password-hasher.service.js';
import { createInitialUser } from '../users/initial-user.js';
import { AuthorizationCatalogService } from './authorization-catalog.service.js';
import { AuthorizationService } from './authorization.service.js';
import { RoleManagementService } from './role-management.service.js';

config({ path: '../../.env' });

const INITIAL_USER_FLAGS = ['--email', '--first-name', '--last-name'] as const;

/** `--email a --first-name b --last-name c`, each exactly once and in any order. */
function parseInitialUserArgs(args: string[]): Record<string, string> | null {
  if (args.length !== INITIAL_USER_FLAGS.length * 2) return null;
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (
      !(INITIAL_USER_FLAGS as readonly string[]).includes(flag) ||
      flag in values ||
      !value ||
      value.startsWith('--')
    ) {
      return null;
    }
    values[flag] = value;
  }
  return values;
}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
    const prompt = createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });
    prompt.on('SIGINT', () => {
      prompt.close();
      reject(new Error('Cancelled.'));
    });
    prompt.question('', (answer) => {
      prompt.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/**
 * The password never comes from arguments or the environment (shell history, process list,
 * platform variables): it is typed twice at a terminal, or piped as the first stdin line.
 */
async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  const password = await promptHidden('Password (12 to 128 characters): ');
  const confirmation = await promptHidden('Repeat password: ');
  if (password !== confirmation) {
    throw new Error('Passwords do not match.');
  }
  return password;
}

async function main(): Promise<void> {
  const [command, ...receivedArgs] = process.argv.slice(2);
  const args = receivedArgs[0] === '--' ? receivedArgs.slice(1) : receivedArgs;
  const usage =
    'Usage: authorization CLI sync-permissions | bootstrap-owner --email <active-user-email> | create-initial-user --email <email> --first-name <name> --last-name <name>';
  if (command === '--help' || command === 'help' || args[0] === '--help') {
    console.info(usage);
    return;
  }
  if (command === 'create-initial-user') {
    const values = parseInitialUserArgs(args);
    if (!values) throw new Error(usage);
    // The API's validated configuration, so the Argon2id parameters match exactly.
    const environment = validateEnvironment(process.env);
    const password = await readNewPassword();
    const prisma = new PrismaService(environment.DATABASE_URL);
    try {
      await prisma.$connect();
      const result = await createInitialUser(
        prisma,
        new PasswordHasherService(new ConfigService(environment)),
        new AuditService(prisma),
        {
          email: values['--email'],
          firstName: values['--first-name'],
          lastName: values['--last-name'],
          password,
        },
      );
      console.info(
        `Initial account created (user ${result.userId}). Next: sync-permissions, then bootstrap-owner with the same email.`,
      );
    } finally {
      await prisma.$disconnect();
    }
    return;
  }
  if (
    (command !== 'sync-permissions' || args.length !== 0) &&
    (command !== 'bootstrap-owner' ||
      args.length !== 2 ||
      args[0] !== '--email' ||
      !args[1])
  ) {
    throw new Error(usage);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL must be configured before running authz commands.',
    );
  }

  const prisma = new PrismaService(databaseUrl);
  try {
    await prisma.$connect();
    if (command === 'sync-permissions' && args.length === 0) {
      await new AuthorizationCatalogService(prisma).sync();
      console.info('Authorization permission catalog synchronized.');
      return;
    }

    await new AuthorizationCatalogService(prisma).sync();
    const authorization = new AuthorizationService(prisma);
    const roles = new RoleManagementService(
      prisma,
      authorization,
      new AuditService(prisma),
    );
    const result = await roles.bootstrapSystemOwner(args[1]);
    console.info(
      `System Owner assignment is ready for user ${result.userId} (role ${result.roleId}).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  console.error('Authorization command failed:', error);
  process.exitCode = 1;
}
