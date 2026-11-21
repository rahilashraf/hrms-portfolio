import { PrismaService } from '../database/prisma.service.js';
import {
  RetentionService,
  type RetentionOptions,
} from './retention.service.js';

/**
 * Background job contract for data retention (Phase 19). The worker routes the job to the
 * runner below; the API owns the logic.
 *
 * `retention.apply` runs daily. It does nothing for organizations that did not opt in (every
 * retention.* setting defaults to 0 = off), skips datasets whose module is disabled, works in
 * bounded batches and is idempotent, so a failed run is safe to retry.
 */
export const RETENTION_QUEUE = 'hrms-default';
export const RETENTION_APPLY_JOB = 'retention.apply';
export const RETENTION_APPLY_SCHEDULER = 'retention.apply.daily';
export const RETENTION_APPLY_CRON = '35 3 * * *';

export async function applyRetention(
  prisma: PrismaService,
  options: RetentionOptions = {},
) {
  return new RetentionService(prisma).apply(options);
}

export async function runRetentionApplyJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
  } & RetentionOptions = {},
) {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  )
    throw new Error('Job data must be an object.');
  if (data && Object.keys(data).length > 0)
    throw new Error('Data retention takes no parameters.');
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error('DATABASE_URL must be configured for the retention job.');
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await applyRetention(prisma, options);
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}
