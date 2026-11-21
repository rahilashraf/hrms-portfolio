#!/usr/bin/env node
/**
 * One command from a fresh clone (after `pnpm install`) to a running, seeded demo.
 *
 *   pnpm demo                    # services, build, demo database, seed, then run web + API + worker
 *   pnpm demo --setup-only       # everything except starting the applications
 *   pnpm demo --no-docker        # PostgreSQL and Redis are already running (as configured in .env)
 *   pnpm demo --reset-passwords  # give every demo account a new password
 *   pnpm demo:reset              # drop and recreate the local demo database (asks for confirmation)
 *
 * The demo uses its own database (`hrms_demo` on the PostgreSQL from .env, or DEMO_DATABASE_URL)
 * and Redis database 1, so it never touches the development database `hrms`. The database
 * guards in apps/api/demo/demo-database.ts refuse anything that isn't a local, marked demo
 * database. See docs/development/demo.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DIR = resolve(ROOT, '.demo');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const WEB_PORT = Number(process.env.DEMO_WEB_PORT ?? 3000);
const API_PORT = Number(process.env.DEMO_API_PORT ?? 3001);
const SEED_API_PORT = API_PORT + 100;

function step(message) {
  console.info(`\n▸ ${message}`);
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} ${commandArgs.join(' ')} failed (exit ${result.status}).`);
}

function checkPrerequisites() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 10)) {
    fail(`Node.js 24.10 or newer is required (found ${process.versions.node}).`);
  }
  if (spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status !== 0) {
    fail('pnpm is required (corepack enable, then rerun).');
  }
  if (!existsSync(resolve(ROOT, 'node_modules'))) fail('Run `pnpm install` first.');
  if (!flag('--no-docker') && spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    fail(
      'Docker is not running. Start Docker, or pass --no-docker with PostgreSQL and Redis already running.',
    );
  }
}

/** .env from the template when it doesn't exist yet (docker compose reads it too). */
function ensureEnvFile() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) {
    copyFileSync(resolve(ROOT, '.env.example'), envPath);
    console.info('Created .env from .env.example (local values only).');
  }
  return parse(readFileSync(envPath));
}

/** Per-clone demo secrets, generated once and kept in the git-ignored .demo folder. */
function demoSecrets() {
  mkdirSync(DEMO_DIR, { recursive: true });
  const file = resolve(DEMO_DIR, 'secrets.json');
  if (!existsSync(file)) {
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          jwtAccessSecret: randomBytes(48).toString('base64'),
          documentUrlSigningKey: randomBytes(32).toString('base64'),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function withRedisDatabase(url, index) {
  const parsed = new URL(url);
  parsed.pathname = `/${index}`;
  return parsed.toString();
}

function demoEnvironment(base) {
  const databaseUrl = process.env.DEMO_DATABASE_URL ?? withDatabase(base.DATABASE_URL, 'hrms_demo');
  const redisUrl = process.env.DEMO_REDIS_URL ?? withRedisDatabase(base.REDIS_URL, 1);
  const secrets = demoSecrets();
  const environment = {
    ...base,
    ...process.env,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    JWT_ACCESS_SECRET: base.JWT_ACCESS_SECRET || secrets.jwtAccessSecret,
    WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
    NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
    // Synthetic sample files are stored on this machine only.
    DOCUMENT_STORAGE_DRIVER: 'local',
    DOCUMENT_STORAGE_LOCAL_DIR: resolve(DEMO_DIR, 'documents'),
    DOCUMENT_URL_SIGNING_KEY: secrets.documentUrlSigningKey,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  delete environment.NODE_ENV;
  delete environment.PORT;
  return environment;
}

const demoCli = (environment, commandArgs) =>
  run('pnpm', ['--dir', 'apps/api', 'exec', 'tsx', 'demo/demo-cli.ts', ...commandArgs], {
    env: environment,
  });

async function waitFor(url, label, seconds = 60) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`${label} did not become ready at ${url}.`);
}

function startApi(environment, port, quiet) {
  return spawn('node', ['dist/main.js'], {
    cwd: resolve(ROOT, 'apps/api'),
    env: { ...environment, PORT: String(port) },
    stdio: quiet ? 'ignore' : 'inherit',
  });
}

function printAccounts() {
  const file = resolve(DEMO_DIR, 'credentials.json');
  if (!existsSync(file)) return;
  const { accounts } = JSON.parse(readFileSync(file, 'utf8'));
  // In CI the console is a shared job log (and the demo log can be kept as an artifact), so the
  // generated passwords stay in .demo/credentials.json only.
  const showPasswords = !process.env.CI;
  console.info(
    showPasswords
      ? '\nDemo accounts (passwords are also in .demo/credentials.json, never committed):'
      : '\nDemo accounts (CI: passwords are not printed; they are in .demo/credentials.json):',
  );
  for (const account of accounts) {
    const password = showPasswords ? ` ${account.password}` : '';
    console.info(`  ${account.role.padEnd(11)} ${account.email.padEnd(36)}${password}`.trimEnd());
  }
}

async function reset(base) {
  const environment = demoEnvironment(base);
  const databaseName = new URL(environment.DATABASE_URL).pathname.slice(1);
  let confirmation = value('--confirm');
  if (!confirmation && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    confirmation = (
      await prompt.question(
        `This drops and recreates the local demo database "${databaseName}". Type its name to confirm: `,
      )
    ).trim();
    prompt.close();
  }
  // The CLI re-checks everything (local *_demo database, demo marker, demo-only data, confirmation).
  demoCli(environment, ['reset', '--confirm', confirmation ?? '']);
}

async function main() {
  const command = args[0] === 'reset' ? 'reset' : 'up';
  checkPrerequisites();
  const base = ensureEnvFile();
  if (!base.DATABASE_URL || !base.REDIS_URL) fail('.env must define DATABASE_URL and REDIS_URL.');

  if (!flag('--no-docker')) {
    step('Starting PostgreSQL and Redis (docker compose)');
    run('docker', ['compose', 'up', '-d', '--wait']);
  }
  if (command === 'reset') return reset(base);

  const environment = demoEnvironment(base);
  // The same steps as `pnpm build:worker` (Prisma client, API build, worker build), run directly
  // so the demo doesn't depend on how Turborepo spawns the package manager on this machine.
  step('Building the API and worker (Prisma client, NestJS, worker)');
  run('pnpm', ['db:generate'], { env: environment });
  run('pnpm', ['--filter', 'api', 'build'], { env: environment });
  run('pnpm', ['--filter', 'worker', 'build'], { env: environment });

  step(`Preparing the demo database (${new URL(environment.DATABASE_URL).pathname.slice(1)})`);
  demoCli(environment, ['create']);
  run('pnpm', ['db:migrate:deploy'], { env: environment });
  demoCli(environment, ['mark']);

  step('Seeding the demonstration data through the API');
  const seedApi = startApi(environment, SEED_API_PORT, true);
  try {
    await waitFor(`http://localhost:${SEED_API_PORT}/ready`, 'The API');
    demoCli(environment, [
      'seed',
      '--api-url',
      `http://localhost:${SEED_API_PORT}`,
      ...(flag('--reset-passwords') ? ['--reset-passwords'] : []),
    ]);
  } finally {
    seedApi.kill('SIGTERM');
  }
  printAccounts();
  if (flag('--setup-only')) {
    console.info('\nSetup complete. Run `pnpm demo` again to start the applications.');
    return;
  }

  step(
    `Starting the API (:${API_PORT}), the worker and the web app (:${WEB_PORT}); Ctrl+C stops all three`,
  );
  const children = [
    startApi(environment, API_PORT, false),
    spawn('node', ['dist/index.js'], {
      cwd: resolve(ROOT, 'apps/worker'),
      env: environment,
      stdio: 'inherit',
    }),
    spawn('pnpm', ['exec', 'next', 'dev', '--port', String(WEB_PORT)], {
      cwd: resolve(ROOT, 'apps/web'),
      env: environment,
      stdio: 'inherit',
    }),
  ];
  const stop = () => {
    for (const child of children) child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await waitFor(`http://localhost:${WEB_PORT}`, 'The web app', 180);
  console.info(`\n✔ Demo running: http://localhost:${WEB_PORT} (sign in with an account above).`);
  printAccounts();
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
