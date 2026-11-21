import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { UnrecoverableError } from 'bullmq';
import { EXTEND_GENERATED_SHIFTS_JOB } from 'api/scheduling-jobs';
import { DELIVER_PENDING_NOTIFICATIONS_JOB } from 'api/notifications-jobs';
import {
  employeeLifecycleAutomationEnabled,
  RECONCILE_RETAINED_GRANTS_CRON,
  RECONCILE_RETAINED_GRANTS_JOB,
  RECONCILE_RETAINED_GRANTS_SCHEDULER,
  retainedGrantReconciliationCron,
  retainedGrantReconciliationEnabled,
} from 'api/employee-jobs';
import {
  assertJobDataShape,
  createJobProcessor,
  documentHandlers,
  googleHandlers,
  leaveHandlers,
  notificationHandlers,
  onboardingHandlers,
  payrollHandlers,
  performanceHandlers,
  recruitmentHandlers,
  rejectUnknownJob,
  reminderHandlers,
  retentionHandlers,
  accountEmailHandlers,
  authRetentionHandlers,
  safeJobName,
  schedulingHandlers,
  timeHandlers,
  employeeHandlers,
} from './jobs.js';
import {
  createHealthServer,
  createShutdown,
  describeJobFailure,
  DEVELOPMENT_REDIS_URL,
  HEARTBEAT_KEY,
  parseWorkerSettings,
  resolveConnections,
  startHeartbeat,
} from './runtime.js';
import {
  KEEP_COMPLETED_JOBS,
  KEEP_FAILED_JOBS,
  NO_RETRY,
  registerSchedules,
  SCHEDULED_JOBS,
  schedulesFor,
  EMPLOYEE_LIFECYCLE_AUTOMATION_JOBS,
  TIME_ATTENDANCE_AUTOMATION_JOBS,
  scheduledJobTemplate,
} from './schedules.js';

const never = async (): Promise<never> => assert.fail('runner must not run');

describe('worker poison messages', () => {
  it('fails unknown job names at once, without retries or the payload', async () => {
    const processor = createJobProcessor({}, rejectUnknownJob);
    await assert.rejects(
      processor({ name: 'legacy.job', data: { email: 'person@example.com' } }),
      (error: unknown) => {
        assert.ok(error instanceof UnrecoverableError);
        assert.equal(error.message, 'Unknown job name: legacy.job');
        return true;
      },
    );
    assert.equal(safeJobName('bad name\n<script>'), 'bad?name??script?');
    assert.equal(safeJobName(42), '?');
  });

  it('fails non-object job data at once and never runs the handler', async () => {
    const processor = createJobProcessor(schedulingHandlers(never), rejectUnknownJob);
    for (const data of ['text', 7, true, ['a']]) {
      await assert.rejects(
        processor({ name: EXTEND_GENERATED_SHIFTS_JOB, data }),
        UnrecoverableError,
      );
    }
    assert.doesNotThrow(() => assertJobDataShape(undefined));
    assert.doesNotThrow(() => assertJobDataShape(null));
    assert.doesNotThrow(() => assertJobDataShape({ horizonDays: 30 }));
  });

  it('does not route prototype names to a handler', async () => {
    const seen: string[] = [];
    const processor = createJobProcessor({}, async (job) => seen.push(job.name));
    await processor({ name: 'constructor', data: {} });
    await processor({ name: '__proto__', data: {} });
    assert.deepEqual(seen, ['constructor', '__proto__']);
  });
});

describe('worker schedules', () => {
  const handlerNames = new Set(
    Object.keys({
      ...schedulingHandlers(never),
      ...leaveHandlers(never),
      ...timeHandlers(never),
      ...employeeHandlers(never),
      ...payrollHandlers(never),
      ...performanceHandlers(never),
      ...recruitmentHandlers(never, never),
      ...onboardingHandlers(never),
      ...documentHandlers(never, never, never),
      ...reminderHandlers(never, never),
      ...notificationHandlers(never, never),
      ...googleHandlers(never, never),
      ...retentionHandlers(never),
      ...authRetentionHandlers(never),
    }),
  );
  /** Batch 2: jobs the API enqueues on demand (account recovery email), never scheduled. */
  const onDemand = new Set(Object.keys(accountEmailHandlers(never)));

  it('has one stable scheduler per job, each with a handler', () => {
    const ids = SCHEDULED_JOBS.map((job) => job.schedulerId);
    const names = SCHEDULED_JOBS.map((job) => job.name);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(names).size, names.length);
    for (const job of SCHEDULED_JOBS) {
      assert.ok(handlerNames.has(job.name), `${job.name} has a handler`);
      assert.match(job.pattern, /^\S+ \S+ \S+ \S+ \S+$/);
    }
    // Every handler is scheduled, except the explicit on-demand ones.
    assert.deepEqual([...handlerNames].sort(), [...names].sort());
    for (const name of onDemand) assert.ok(!names.includes(name), name);
  });

  it('bounds retries and keeps failed jobs visible but bounded', () => {
    for (const job of SCHEDULED_JOBS) {
      const template = scheduledJobTemplate(job);
      assert.ok(template.opts.attempts >= 1 && template.opts.attempts <= 3, job.name);
      assert.deepEqual(template.opts.removeOnComplete, KEEP_COMPLETED_JOBS);
      assert.deepEqual(template.opts.removeOnFail, KEEP_FAILED_JOBS);
      assert.deepEqual(template.data, {});
    }
    assert.ok(KEEP_FAILED_JOBS.count >= KEEP_COMPLETED_JOBS.count);
    assert.ok(KEEP_FAILED_JOBS.age >= KEEP_COMPLETED_JOBS.age);
    // The two-minute delivery job is retried by its next run, not by overlapping retries.
    assert.deepEqual(
      SCHEDULED_JOBS.find((job) => job.name === DELIVER_PENDING_NOTIFICATIONS_JOB)?.retry,
      NO_RETRY,
    );
  });

  it('registers every schedule by its stable id in UTC (idempotent upserts)', async () => {
    const calls: Array<[string, { pattern: string; tz: string }, string]> = [];
    const queue = {
      upsertJobScheduler: async (
        id: string,
        repeat: { pattern: string; tz: string },
        template: { name: string },
      ) => {
        calls.push([id, repeat, template.name]);
      },
    };
    await registerSchedules(queue);
    await registerSchedules(queue);
    assert.equal(calls.length, SCHEDULED_JOBS.length * 2);
    assert.equal(new Set(calls.map(([id]) => id)).size, SCHEDULED_JOBS.length);
    assert.ok(calls.every(([, repeat]) => repeat.tz === 'UTC'));
  });
});

describe('attendance automation schedules (Batch 4C)', () => {
  const never = async (): Promise<never> => {
    throw new Error('not called');
  };
  const recordingQueue = () => {
    const upserted: string[] = [];
    const removed: string[] = [];
    return {
      upserted,
      removed,
      queue: {
        upsertJobScheduler: async (id: string) => {
          upserted.push(id);
        },
        removeJobScheduler: async (id: string) => {
          removed.push(id);
        },
      },
    };
  };
  const automationIds = TIME_ATTENDANCE_AUTOMATION_JOBS.map((job) => job.schedulerId);
  const lifecycleIds = EMPLOYEE_LIFECYCLE_AUTOMATION_JOBS.map((job) => job.schedulerId);

  it('Batch 5A: lifecycle automation is scheduled only when its own switch is on', async () => {
    const off = recordingQueue();
    const offSchedules = schedulesFor(true, false);
    await registerSchedules(off.queue, offSchedules.jobs, offSchedules.disabled);
    assert.deepEqual(
      off.upserted.filter((id) => lifecycleIds.includes(id)),
      [],
    );
    assert.deepEqual(off.removed.sort(), [...lifecycleIds].sort());
    const on = recordingQueue();
    const onSchedules = schedulesFor(false, true);
    await registerSchedules(on.queue, onSchedules.jobs, onSchedules.disabled);
    for (const id of lifecycleIds) assert.ok(on.upserted.includes(id), id);
    assert.deepEqual(on.removed.sort(), [...automationIds].sort());
    const handlers = employeeHandlers(never, never, never);
    for (const job of EMPLOYEE_LIFECYCLE_AUTOMATION_JOBS) {
      assert.ok(job.name in handlers, job.name);
      assert.match(job.pattern, /^\S+ \S+ \S+ \S+ \S+$/);
    }
  });

  it('Batch 5A: the lifecycle switch accepts only empty, true or false', () => {
    assert.equal(employeeLifecycleAutomationEnabled({}), false);
    assert.equal(
      employeeLifecycleAutomationEnabled({ EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: '' }),
      false,
    );
    assert.equal(
      employeeLifecycleAutomationEnabled({ EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: 'false' }),
      false,
    );
    assert.equal(
      employeeLifecycleAutomationEnabled({ EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: ' TRUE ' }),
      true,
    );
    assert.throws(
      () => employeeLifecycleAutomationEnabled({ EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: 'yes' }),
      /EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED/,
    );
  });

  it('Batch 5A: a lifecycle run with failures is a failed job', async () => {
    const handlers = employeeHandlers(
      never,
      async () => ({
        disabled: false as const,
        scanned: 1,
        completed: [],
        partiallyApplied: [],
        notDue: 0,
        blocked: [],
        failed: [{ terminationId: 't-1', message: 'boom' }],
        retentionsExpired: [],
        retentionsFailed: [],
      }),
      async () => ({
        disabled: false as const,
        scanned: 1,
        ended: [],
        notDue: 0,
        failed: [{ employmentAssignmentId: 'a-1', message: 'boom' }],
      }),
    );
    await assert.rejects(() => handlers['employee.apply-due-terminations']!({}), /t-1/);
    await assert.rejects(() => handlers['employee.end-due-assignments']!({}), /a-1/);
  });

  it('M3: a due termination blocked on grant decisions is reported, not a failed job', async () => {
    const outcome = {
      disabled: false as const,
      scanned: 2,
      completed: ['t-2'],
      partiallyApplied: [],
      notDue: 0,
      blocked: [{ terminationId: 't-1', code: 'TERMINATION_GRANT_DECISION_REQUIRED' }],
      failed: [],
      retentionsExpired: ['e-1'],
      retentionsFailed: [],
    };
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      const handlers = employeeHandlers(never, async () => outcome);
      assert.deepEqual(await handlers['employee.apply-due-terminations']!({}), outcome);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /t-1 \(TERMINATION_GRANT_DECISION_REQUIRED\)/);
  });

  it('M3: a failed expired-retention check fails the job (retried)', async () => {
    const handlers = employeeHandlers(never, async () => ({
      disabled: false as const,
      scanned: 0,
      completed: [],
      partiallyApplied: [],
      notDue: 0,
      blocked: [],
      failed: [],
      retentionsExpired: [],
      retentionsFailed: [{ employeeId: 'e-9', message: 'boom' }],
    }));
    await assert.rejects(() => handlers['employee.apply-due-terminations']!({}), /e-9/);
  });

  it('schedules nothing new by default and removes a previously registered schedule', async () => {
    const { queue, upserted, removed } = recordingQueue();
    const off = schedulesFor(false);
    await registerSchedules(queue, off.jobs, off.disabled);
    assert.deepEqual(
      upserted.filter((id) => automationIds.includes(id)),
      [],
    );
    assert.deepEqual(removed.sort(), [...automationIds, ...lifecycleIds].sort());
    // M3: the retained-grant reconciliation is the one schedule added by default.
    assert.equal(upserted.length, SCHEDULED_JOBS.length + 1);
    assert.ok(upserted.includes(RECONCILE_RETAINED_GRANTS_SCHEDULER));
  });

  it('M3: retained-grant reconciliation is scheduled with lifecycle automation off, and only its own switch removes it', async () => {
    for (const lifecycle of [false, true]) {
      const { queue, upserted, removed } = recordingQueue();
      const schedules = schedulesFor(false, lifecycle);
      await registerSchedules(queue, schedules.jobs, schedules.disabled);
      assert.ok(upserted.includes(RECONCILE_RETAINED_GRANTS_SCHEDULER), String(lifecycle));
      assert.ok(!removed.includes(RECONCILE_RETAINED_GRANTS_SCHEDULER));
    }
    const job = schedulesFor(false).jobs.find(
      (entry) => entry.schedulerId === RECONCILE_RETAINED_GRANTS_SCHEDULER,
    )!;
    assert.equal(job.name, RECONCILE_RETAINED_GRANTS_JOB);
    assert.equal(job.pattern, RECONCILE_RETAINED_GRANTS_CRON);
    assert.equal(job.retry.attempts, 2);
    // Rollback switch: off removes the schedule on the next start.
    const { queue, upserted, removed } = recordingQueue();
    const off = schedulesFor(false, false, {
      enabled: false,
      pattern: RECONCILE_RETAINED_GRANTS_CRON,
    });
    await registerSchedules(queue, off.jobs, off.disabled);
    assert.ok(!upserted.includes(RECONCILE_RETAINED_GRANTS_SCHEDULER));
    assert.ok(removed.includes(RECONCILE_RETAINED_GRANTS_SCHEDULER));
    // The interval can be overridden.
    const custom = schedulesFor(false, false, { enabled: true, pattern: '*/5 * * * *' });
    assert.equal(
      custom.jobs.find((entry) => entry.schedulerId === RECONCILE_RETAINED_GRANTS_SCHEDULER)!
        .pattern,
      '*/5 * * * *',
    );
  });

  it('M3: the reconciliation switch and interval are validated (on unless "false")', () => {
    assert.equal(retainedGrantReconciliationEnabled({}), true);
    assert.equal(
      retainedGrantReconciliationEnabled({ RETAINED_GRANT_RECONCILIATION_ENABLED: ' TRUE ' }),
      true,
    );
    assert.equal(
      retainedGrantReconciliationEnabled({ RETAINED_GRANT_RECONCILIATION_ENABLED: 'false' }),
      false,
    );
    // Independent of the lifecycle switch.
    assert.equal(
      retainedGrantReconciliationEnabled({ EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: 'false' }),
      true,
    );
    assert.throws(
      () => retainedGrantReconciliationEnabled({ RETAINED_GRANT_RECONCILIATION_ENABLED: 'no' }),
      /RETAINED_GRANT_RECONCILIATION_ENABLED/,
    );
    assert.equal(retainedGrantReconciliationCron({}), RECONCILE_RETAINED_GRANTS_CRON);
    assert.equal(
      retainedGrantReconciliationCron({ RETAINED_GRANT_RECONCILIATION_CRON: ' */10  * * * * ' }),
      '*/10 * * * *',
    );
    assert.equal(
      retainedGrantReconciliationCron({
        RETAINED_GRANT_RECONCILIATION_CRON: '5,35 0-23/2 1-31 1-12 0-7',
      }),
      '5,35 0-23/2 1-31 1-12 0-7',
    );
    for (const bad of [
      '* * * *',
      'every 5 minutes',
      '*/5 * * * * *',
      'a b c d e',
      '99 * * * *',
      '0 24 * * *',
      '0 0 0 * *',
      '0 0 * 13 *',
      '0 0 * * 8',
      '*/0 * * * *',
      '30-10 * * * *',
    ])
      assert.throws(
        () => retainedGrantReconciliationCron({ RETAINED_GRANT_RECONCILIATION_CRON: bad }),
        /RETAINED_GRANT_RECONCILIATION_CRON/,
        bad,
      );
  });

  it('M3: a reconciliation run with a failed employee fails the job (retried); a clean run succeeds', async () => {
    const outcome = (failed: Array<{ employeeId: string; message: string }>) => ({
      scanned: 2,
      handled: ['e-1'],
      failed,
    });
    const ok = employeeHandlers(never, undefined, undefined, async () => outcome([]));
    assert.deepEqual(await ok[RECONCILE_RETAINED_GRANTS_JOB]!({}), outcome([]));
    const failing = employeeHandlers(never, undefined, undefined, async () =>
      outcome([{ employeeId: 'e-2', message: 'boom' }]),
    );
    await assert.rejects(() => failing[RECONCILE_RETAINED_GRANTS_JOB]!({}), /e-2/);
  });

  it('schedules both jobs, with handlers, only when switched on', async () => {
    const { queue, upserted, removed } = recordingQueue();
    const on = schedulesFor(true);
    await registerSchedules(queue, on.jobs, on.disabled);
    assert.deepEqual(removed.sort(), [...lifecycleIds].sort());
    for (const id of automationIds) assert.ok(upserted.includes(id), id);
    const handlers = timeHandlers(never, never, never);
    for (const job of TIME_ATTENDANCE_AUTOMATION_JOBS) {
      assert.ok(job.name in handlers, job.name);
      assert.match(job.pattern, /^\S+ \S+ \S+ \S+ \S+$/);
    }
  });

  it('reports a run with failures as a failed job', async () => {
    const handlers = timeHandlers(
      never,
      async () => ({
        disabled: false as const,
        organizations: 1,
        periodsCreated: 0,
        timesheetsCreated: 0,
        skippedPayrollManaged: [],
        failed: [{ organizationId: 'org-1', message: 'overlap' }],
      }),
      async () => ({
        disabled: true as const,
        scanned: 0,
        detected: 0,
        superseded: 0,
        failed: [],
      }),
    );
    await assert.rejects(handlers['time.prepare-attendance-periods']!({}), /org-1/);
    assert.deepEqual(await handlers['time.detect-no-shows']!({}), {
      disabled: true,
      scanned: 0,
      detected: 0,
      superseded: 0,
      failed: [],
    });
  });
});

describe('worker runtime', () => {
  it('parses bounded settings with safe defaults', () => {
    assert.deepEqual(parseWorkerSettings({}), {
      concurrency: 1,
      healthPort: null,
      shutdownTimeoutMs: 30_000,
      heartbeatIntervalMs: 15_000,
    });
    const configured = parseWorkerSettings({
      WORKER_CONCURRENCY: '4',
      WORKER_HEALTH_PORT: '9464',
      WORKER_SHUTDOWN_TIMEOUT_MS: '60000',
    });
    assert.equal(configured.concurrency, 4);
    assert.equal(configured.healthPort, 9464);
    assert.equal(configured.shutdownTimeoutMs, 60_000);
    assert.throws(() => parseWorkerSettings({ WORKER_CONCURRENCY: '0' }), /WORKER_CONCURRENCY/);
    assert.throws(() => parseWorkerSettings({ WORKER_CONCURRENCY: '2.5' }));
    assert.throws(() => parseWorkerSettings({ WORKER_HEALTH_PORT: 'abc' }));
  });

  it('requires REDIS_URL and DATABASE_URL in production only', () => {
    assert.deepEqual(resolveConnections({}), {
      redisUrl: DEVELOPMENT_REDIS_URL,
      databaseUrl: null,
    });
    const urls = {
      REDIS_URL: 'redis://redis.railway.internal:6379?family=0',
      DATABASE_URL: 'postgresql://postgres:secret@postgres.railway.internal:5432/railway',
    };
    assert.deepEqual(resolveConnections({ NODE_ENV: 'production', ...urls }), {
      redisUrl: urls.REDIS_URL,
      databaseUrl: urls.DATABASE_URL,
    });
    assert.throws(
      () => resolveConnections({ NODE_ENV: 'production' }),
      /REDIS_URL and DATABASE_URL must be configured in production/,
    );
    assert.throws(
      () =>
        resolveConnections({
          NODE_ENV: 'production',
          REDIS_URL: urls.REDIS_URL,
          DATABASE_URL: ' ',
        }),
      /DATABASE_URL must be configured/,
    );
  });

  it('describes failures with name, id and attempt, never payload or stack', () => {
    const error = new Error('Shift generation failed for 1 of 2 pattern(s): p-1\n  at x');
    const line = describeJobFailure(
      {
        id: '42',
        name: EXTEND_GENERATED_SHIFTS_JOB,
        attemptsMade: 1,
        opts: { attempts: 3 },
        // Present on real jobs; must never be printed.
        ...{ data: { email: 'person@example.com' } },
      },
      error,
    );
    assert.equal(
      line,
      `Job ${EXTEND_GENERATED_SHIFTS_JOB} (42) failed on attempt 1/3: Error: Shift generation failed for 1 of 2 pattern(s): p-1 at x`,
    );
    assert.doesNotMatch(line, /person@example\.com/);
    assert.match(
      describeJobFailure(
        { id: '7', name: 'x', attemptsMade: 1, opts: { attempts: 3 } },
        new UnrecoverableError('Unknown job name: x'),
      ),
      /\(no further retries\): UnrecoverableError/,
    );
    assert.match(describeJobFailure(undefined, 'boom'), /^Job unknown \(unknown\)/);
    assert.ok(describeJobFailure({}, new Error('x'.repeat(5_000))).length < 700);
  });

  it('writes an expiring heartbeat and survives Redis errors', async () => {
    const writes: Array<[string, string, string, number]> = [];
    const heartbeat = startHeartbeat(
      {
        set: async (key, value, mode, ttl) => {
          writes.push([key, value, mode, ttl]);
        },
      },
      1_000,
      () => new Date('2027-01-04T10:00:00.000Z'),
    );
    await heartbeat.beat();
    heartbeat.stop();
    assert.ok(writes.length >= 1);
    const [key, value, mode, ttl] = writes[0]!;
    assert.equal(key, HEARTBEAT_KEY);
    assert.equal(mode, 'PX');
    assert.equal(ttl, 3_000);
    assert.equal(JSON.parse(value).at, '2027-01-04T10:00:00.000Z');

    const failing = startHeartbeat({ set: async () => Promise.reject(new Error('down')) }, 1_000);
    await failing.beat();
    failing.stop();
  });

  it('serves liveness and readiness without details', async () => {
    let alive = true;
    let ready = true;
    const server = createHealthServer({
      port: 0,
      alive: () => alive,
      ready: async () => ({
        status: ready ? 'ready' : 'not_ready',
        checks: { redis: 'up', database: ready ? 'up' : 'down' },
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: response.status, body: await response.json() };
    };
    try {
      assert.deepEqual(await get('/health'), { status: 200, body: { status: 'ok' } });
      assert.deepEqual(await get('/ready'), {
        status: 200,
        body: { status: 'ready', checks: { redis: 'up', database: 'up' } },
      });
      ready = false;
      assert.equal((await get('/ready')).status, 503);
      assert.equal((await get('/other')).status, 404);
      alive = false;
      assert.equal((await get('/health')).status, 503);
      assert.equal((await get('/ready')).status, 503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('shuts down once, in order, continuing past failures', async () => {
    const order: string[] = [];
    const log: string[] = [];
    const shutdown = createShutdown(
      [
        { name: 'worker', run: async () => order.push('worker') },
        {
          name: 'queue',
          run: async () => {
            order.push('queue');
            throw new Error('already closed');
          },
        },
        { name: 'redis', run: async () => order.push('redis') },
      ],
      5_000,
      (message) => log.push(message),
    );
    const [first, second] = await Promise.all([shutdown(), shutdown()]);
    assert.equal(first, 1);
    assert.equal(second, 1);
    assert.deepEqual(order, ['worker', 'queue', 'redis']);
    assert.ok(log.some((line) => line.includes('step queue failed: Error')));
  });

  it('forces exit when active jobs outlive the timeout', async () => {
    const shutdown = createShutdown(
      [{ name: 'worker', run: () => new Promise(() => undefined) }],
      50,
      () => undefined,
    );
    assert.equal(await shutdown(), 1);
    const clean = createShutdown([{ name: 'worker', run: async () => undefined }], 1_000, () => {});
    assert.equal(await clean(), 0);
  });
});
