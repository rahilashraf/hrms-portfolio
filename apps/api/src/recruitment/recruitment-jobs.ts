import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { RecruitmentAccessService } from './recruitment-access.service.js';
import { RecruitmentApplicationService } from './recruitment-application.service.js';
import { RecruitmentCandidateService } from './recruitment-candidate.service.js';
import { RecruitmentClock } from './recruitment-common.js';
import type { ExternalApplicationProvider } from './recruitment-intake.contract.js';
import { RecruitmentIntakeService } from './recruitment-intake.service.js';
import { RecruitmentOfferService } from './recruitment-offer.service.js';
import { RecruitmentStageService } from './recruitment-stage.service.js';
import {
  RecruitmentReminderProducer,
  type ProducerOutcome,
} from '../notifications/notifications-producers.js';

/**
 * Background job contracts for Recruitment (Phase 13). The worker routes these jobs to the
 * runners below; the API owns the logic (framework-free composition).
 *
 * - Offer expiry: records EXPIRED on sent offers past their acceptance day. Idempotent, and
 *   never required for correctness (expiry is date-derived: an expired offer can never be
 *   accepted, whether or not this has run).
 * - Application sync: feeds external submissions (e.g. Google Forms) through the ingestion
 *   contract; deduplication, opening matching and corrections are the ingestion service's.
 *   Phase 13 registers no provider adapter (no Google OAuth is built here), so every source
 *   is reported as skipped until the shared Google Workspace integration registers one.
 * - Interview reminders and overdue feedback are attention items computed on read by the
 *   dashboard; Phase 16 delivers them (and expiring offers) through the shared notification
 *   framework with the recruitment.reminders job below.
 */
export const RECRUITMENT_QUEUE = 'hrms-default';
export const EXPIRE_RECRUITMENT_OFFERS_JOB = 'recruitment.expire-offers';
export const EXPIRE_RECRUITMENT_OFFERS_SCHEDULER =
  'recruitment.expire-offers.daily';
export const EXPIRE_RECRUITMENT_OFFERS_CRON = '15 5 * * *';
export const SYNC_RECRUITMENT_APPLICATIONS_JOB =
  'recruitment.sync-applications';
export const SYNC_RECRUITMENT_APPLICATIONS_SCHEDULER =
  'recruitment.sync-applications.hourly';
export const SYNC_RECRUITMENT_APPLICATIONS_CRON = '25 * * * *';

/** The provider adapters available to the worker (none in Phase 13). */
export const REGISTERED_APPLICATION_PROVIDERS: readonly ExternalApplicationProvider[] =
  [];

export interface ExpireRecruitmentOffersOutcome {
  scanned: number;
  expired: number;
  failed: Array<{ offerId: string; message: string }>;
}

export interface SyncRecruitmentApplicationsOutcome {
  sources: number;
  synced: number;
  skipped: number;
  received: number;
  /** Phase 18: organizations skipped (Recruitment disabled or recruitment.externalIntake off). */
  skippedOrganizations: string[];
  failed: Array<{ sourceId: string; message: string }>;
}

export function parseNoParameters(
  data: unknown,
  job: string,
): Record<string, never> {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  ) {
    throw new Error('Job data must be an object.');
  }
  if (data && Object.keys(data).length > 0)
    throw new Error(`${job} takes no parameters.`);
  return {};
}

export function recruitmentServices(
  prisma: PrismaService,
  clock = new RecruitmentClock(),
) {
  const access = new RecruitmentAccessService(
    prisma,
    new AuthorizationService(prisma),
  );
  const audit = new AuditService(prisma);
  const stages = new RecruitmentStageService(prisma, access, audit, clock);
  const candidates = new RecruitmentCandidateService(
    prisma,
    access,
    audit,
    clock,
  );
  const applications = new RecruitmentApplicationService(
    prisma,
    access,
    audit,
    clock,
    candidates,
    stages,
  );
  return {
    access,
    audit,
    stages,
    candidates,
    applications,
    offers: new RecruitmentOfferService(prisma, audit, clock, applications),
    intake: new RecruitmentIntakeService(
      prisma,
      access,
      audit,
      clock,
      candidates,
      applications,
    ),
  };
}

export function expireRecruitmentOffers(
  prisma: PrismaService,
  clock = new RecruitmentClock(),
) {
  return recruitmentServices(prisma, clock).offers.expireDue();
}

export async function syncRecruitmentApplications(
  prisma: PrismaService,
  providers: readonly ExternalApplicationProvider[] = REGISTERED_APPLICATION_PROVIDERS,
  clock = new RecruitmentClock(),
): Promise<SyncRecruitmentApplicationsOutcome> {
  const { intake, access } = recruitmentServices(prisma, clock);
  const skippedOrganizations = [
    ...new Set([
      ...(await access.disabledOrganizations()),
      ...(await access.features.settingOffOrganizations(
        'recruitment.externalIntake',
      )),
    ]),
  ].sort();
  const outcome: SyncRecruitmentApplicationsOutcome = {
    sources: 0,
    synced: 0,
    skipped: 0,
    received: 0,
    skippedOrganizations,
    failed: [],
  };
  const sources = await prisma.recruitmentIntakeSource.findMany({
    where: {
      archivedAt: null,
      organizationId: { notIn: skippedOrganizations },
      externalResourceId: { not: null },
      provider: { not: 'MANUAL_IMPORT' },
    },
    orderBy: { id: 'asc' },
  });
  for (const source of sources) {
    outcome.sources += 1;
    const adapter = providers.find(
      (candidate) => candidate.provider === source.provider,
    );
    if (!adapter) {
      outcome.skipped += 1;
      continue;
    }
    try {
      const submissions = await adapter.fetchSubmissions(
        {
          id: source.id,
          externalResourceId: source.externalResourceId!,
          lastSyncedAt: source.lastSyncedAt,
        },
        source.lastSyncedAt,
      );
      const report = await intake.ingest(source.id, submissions, 'SYNC', null);
      outcome.received += report.received;
      outcome.synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.failed.push({ sourceId: source.id, message });
      await prisma.recruitmentIntakeSource.update({
        where: { id: source.id },
        data: {
          lastSyncStatus: 'FAILED',
          lastSyncMessage: message.slice(0, 500),
        },
      });
    }
  }
  return outcome;
}

async function withPrisma<T>(
  options: { prisma?: PrismaService; databaseUrl?: string },
  run: (prisma: PrismaService) => Promise<T>,
) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error('DATABASE_URL must be configured for recruitment jobs.');
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await run(prisma);
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

export async function runExpireRecruitmentOffersJob(
  data: unknown,
  options: { prisma?: PrismaService; databaseUrl?: string } = {},
): Promise<ExpireRecruitmentOffersOutcome> {
  parseNoParameters(data, 'Offer expiry');
  return withPrisma(options, (prisma) => expireRecruitmentOffers(prisma));
}

export async function runSyncRecruitmentApplicationsJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    providers?: readonly ExternalApplicationProvider[];
  } = {},
): Promise<SyncRecruitmentApplicationsOutcome> {
  parseNoParameters(data, 'Application synchronization');
  return withPrisma(options, (prisma) =>
    syncRecruitmentApplications(prisma, options.providers),
  );
}

/**
 * Phase 16 — recruitment reminders through the shared notification framework (the attention
 * items above, delivered): upcoming interviews and overdue feedback to interviewers, expiring
 * offers to their creators and approvers. Idempotent (dedupe keys); content never includes
 * candidate details, compensation, screening or feedback.
 */
export const RECRUITMENT_REMINDERS_JOB = 'recruitment.reminders';
export const RECRUITMENT_REMINDERS_SCHEDULER = 'recruitment.reminders.hourly';
export const RECRUITMENT_REMINDERS_CRON = '35 * * * *';

export function sendRecruitmentReminders(
  prisma: PrismaService,
  clock: { now(): Date } = new RecruitmentClock(),
): Promise<ProducerOutcome> {
  return new RecruitmentReminderProducer(prisma, clock).run();
}

export async function runRecruitmentRemindersJob(
  data: unknown,
  options: { prisma?: PrismaService; databaseUrl?: string } = {},
): Promise<ProducerOutcome> {
  parseNoParameters(data, 'Recruitment reminders');
  return withPrisma(options, (prisma) => sendRecruitmentReminders(prisma));
}
