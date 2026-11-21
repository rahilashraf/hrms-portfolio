import { PrismaService } from '../database/prisma.service.js';
import { addDays } from '../common/domain-support.js';
import {
  isoDate,
  OnboardingClock,
  onboardingToday,
} from './onboarding-common.js';
import { OPEN_TASK } from './onboarding-domain.js';
import { OnboardingTaskReminderNotifier } from '../notifications/notifications-producers.js';
import { FeatureGateService } from '../features/feature-gate.service.js';

/**
 * Background job contract for onboarding / offboarding (Phase 14): task reminders. The worker
 * routes the job to runWorkflowTaskRemindersJob; the API owns the logic.
 *
 * The job only builds, per task owner, a digest of open tasks that are overdue or due soon and
 * hands it to the registered reminder sinks. Phase 16 delivers it through the shared
 * notification framework: the job runner uses defaultReminderSinks() — the static
 * REGISTERED_REMINDER_SINKS plus the notifications sink, which publishes one idempotent
 * 'onboarding.tasks-due' digest per owner and day. Correctness never depends on it: overdue
 * status is date-derived on every read.
 */
export const WORKFLOW_QUEUE = 'hrms-default';
export const WORKFLOW_TASK_REMINDERS_JOB = 'onboarding.task-reminders';
export const WORKFLOW_TASK_REMINDERS_SCHEDULER =
  'onboarding.task-reminders.daily';
export const WORKFLOW_TASK_REMINDERS_CRON = '30 7 * * *';
const DUE_SOON_DAYS = 3;

export interface TaskReminderDigest {
  ownerUserId: string;
  overdue: Array<{
    taskId: string;
    workflowId: string;
    title: string;
    dueDate: string | null;
  }>;
  dueSoon: Array<{
    taskId: string;
    workflowId: string;
    title: string;
    dueDate: string | null;
  }>;
}

/** A reminder delivery channel (email, chat…) registered by a later phase. */
export interface WorkflowReminderSink {
  deliver(digests: readonly TaskReminderDigest[]): Promise<void>;
}

export const REGISTERED_REMINDER_SINKS: readonly WorkflowReminderSink[] = [];

/** The sinks the job uses by default: the registered ones and Phase 16 notifications. */
export function defaultReminderSinks(
  prisma: PrismaService,
  clock: { now(): Date } = new OnboardingClock(),
): readonly WorkflowReminderSink[] {
  return [
    ...REGISTERED_REMINDER_SINKS,
    new OnboardingTaskReminderNotifier(prisma, clock),
  ];
}

export interface WorkflowTaskRemindersOutcome {
  owners: number;
  overdue: number;
  dueSoon: number;
  /** HR-pool / unresolved-owner tasks overdue (shown on the HR dashboard). */
  unownedOverdue: number;
  delivered: number;
  /** Phase 18: organizations skipped because onboarding / offboarding is disabled there. */
  skippedOrganizations: string[];
  failed: Array<{ sink: number; message: string }>;
}

export async function buildTaskReminders(
  prisma: PrismaService,
  clock = new OnboardingClock(),
) {
  const now = clock.now();
  const disabled = await new FeatureGateService(prisma).disabledOrganizations(
    'ONBOARDING',
  );
  const tasks = await prisma.employeeWorkflowTask.findMany({
    where: {
      status: { in: OPEN_TASK },
      dueDate: { not: null },
      workflow: { status: 'ACTIVE', organizationId: { notIn: [...disabled] } },
    },
    include: {
      workflow: { include: { organization: { select: { timezone: true } } } },
    },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
  });
  const digests = new Map<string, TaskReminderDigest>();
  let unownedOverdue = 0;
  for (const task of tasks) {
    const today = onboardingToday(now, task.workflow.organization.timezone);
    const overdue = task.dueDate! < today;
    const dueSoon = !overdue && task.dueDate! <= addDays(today, DUE_SOON_DAYS);
    if (!overdue && !dueSoon) continue;
    if (!task.ownerUserId) {
      if (overdue) unownedOverdue += 1;
      continue;
    }
    const digest = digests.get(task.ownerUserId) ?? {
      ownerUserId: task.ownerUserId,
      overdue: [],
      dueSoon: [],
    };
    (overdue ? digest.overdue : digest.dueSoon).push({
      taskId: task.id,
      workflowId: task.workflowId,
      title: task.title,
      dueDate: isoDate(task.dueDate),
    });
    digests.set(task.ownerUserId, digest);
  }
  return {
    digests: [...digests.values()],
    unownedOverdue,
    skippedOrganizations: [...disabled].sort(),
  };
}

export async function sendTaskReminders(
  prisma: PrismaService,
  sinks: readonly WorkflowReminderSink[] = REGISTERED_REMINDER_SINKS,
  clock = new OnboardingClock(),
): Promise<WorkflowTaskRemindersOutcome> {
  const { digests, unownedOverdue, skippedOrganizations } =
    await buildTaskReminders(prisma, clock);
  const outcome: WorkflowTaskRemindersOutcome = {
    owners: digests.length,
    overdue: digests.reduce((sum, digest) => sum + digest.overdue.length, 0),
    dueSoon: digests.reduce((sum, digest) => sum + digest.dueSoon.length, 0),
    unownedOverdue,
    delivered: 0,
    skippedOrganizations,
    failed: [],
  };
  for (const [index, sink] of sinks.entries()) {
    try {
      await sink.deliver(digests);
      outcome.delivered += 1;
    } catch (error) {
      outcome.failed.push({
        sink: index,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}

export async function runWorkflowTaskRemindersJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    sinks?: readonly WorkflowReminderSink[];
  } = {},
) {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  ) {
    throw new Error('Job data must be an object.');
  }
  if (data && Object.keys(data).length > 0)
    throw new Error('Task reminders take no parameters.');
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error('DATABASE_URL must be configured for onboarding jobs.');
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await sendTaskReminders(
      prisma,
      options.sinks ?? defaultReminderSinks(prisma),
    );
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}
