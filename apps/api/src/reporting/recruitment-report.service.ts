import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  localDateSql,
  num,
  nullableNum,
  sqlDate,
  uuids,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import { percent, round2 } from './reporting-domain.js';

const SOURCES = [
  'DIRECT',
  'REFERRAL',
  'JOB_BOARD',
  'AGENCY',
  'INTERNAL',
  'CAREERS_SITE',
  'EXTERNAL_FORM',
  'OTHER',
] as const;
const OFFER_STATUSES = [
  'DRAFT',
  'APPROVED',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'WITHDRAWN',
  'EXPIRED',
] as const;

/**
 * Recruitment reports (recruitment.read), placed through the job opening's own placement as
 * the recruitment domain does. Aggregates only — never a candidate row. Nobody reaches their
 * own candidacy: applications whose candidate is the caller (internal employee, same person or
 * same e-mail — the recruitment domain's isSelf rule) are left out.
 */
@Injectable()
export class RecruitmentReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    switch (scope.definition.key) {
      case 'recruitment.openings':
        return this.openings(scope);
      case 'recruitment.sources':
        return this.sources(scope);
      case 'recruitment.stages':
        return this.stages(scope);
      default:
        return this.offers(scope);
    }
  }

  /** Not the caller's own candidacy (alias `cand`). */
  private notSelf(scope: ReportScope) {
    const { employeeId, personId, email } = scope.self;
    return Prisma.sql`NOT (
      COALESCE(${employeeId}::uuid IS NOT NULL AND cand."internalEmployeeId" = ${employeeId}::uuid, false)
      OR COALESCE(${email}::text IS NOT NULL AND cand."normalizedEmail" = ${email}::text, false)
      OR COALESCE(${personId}::uuid IS NOT NULL AND cand."personId" = ${personId}::uuid, false)
    )`;
  }

  private inRange(scope: ReportScope, expression: Prisma.Sql) {
    return Prisma.sql`${localDateSql(scope, expression)} BETWEEN ${sqlDate(scope.filters.from!)} AND ${sqlDate(scope.filters.to!)}`;
  }

  private async openings(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        code: string;
        title: string;
        status: string;
        openingCount: number;
        hiredCount: number;
        applications: number;
        active: number;
        offered: number;
        hired: number;
        rejected: number;
        withdrawn: number;
      }>
    >(Prisma.sql`
      SELECT o."code", o."title", o."status"::text AS status,
        o."openingCount" AS "openingCount", o."hiredCount" AS "hiredCount",
        COUNT(a."id")::int AS applications,
        COUNT(a."id") FILTER (WHERE a."status" = 'ACTIVE')::int AS active,
        COUNT(a."id") FILTER (WHERE a."status" = 'OFFERED')::int AS offered,
        COUNT(a."id") FILTER (WHERE a."status" = 'HIRED')::int AS hired,
        COUNT(a."id") FILTER (WHERE a."status" = 'REJECTED')::int AS rejected,
        COUNT(a."id") FILTER (WHERE a."status" = 'WITHDRAWN')::int AS withdrawn
      FROM "JobOpening" o
      LEFT JOIN (
        "RecruitmentApplication" a
        JOIN "RecruitmentCandidate" cand ON cand."id" = a."candidateId"
      ) ON a."openingId" = o."id"
        AND ${this.inRange(scope, Prisma.sql`a."appliedAt"`)}
        AND ${this.notSelf(scope)}
      WHERE o."id" = ANY(${uuids(scope.openingIds)})
      GROUP BY o."id", o."code", o."title", o."status", o."openingCount", o."hiredCount"
      ORDER BY o."code"`);
    return {
      rows: rows.map((row) => ({
        openingCode: row.code,
        openingTitle: row.title,
        status: row.status,
        openingCount: row.openingCount,
        hiredCount: row.hiredCount,
        remaining: Math.max(0, row.openingCount - row.hiredCount),
        applications: row.applications,
        active: row.active,
        offered: row.offered,
        hired: row.hired,
        rejected: row.rejected,
        withdrawn: row.withdrawn,
      })),
      notes: [
        'Fill status is the opening’s own (all hires); application counts are applications received in the range.',
      ],
    };
  }

  private async sources(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{ source: string; applications: number; hired: number }>
    >(Prisma.sql`
      SELECT a."source"::text AS source,
        COUNT(*)::int AS applications,
        COUNT(*) FILTER (WHERE a."status" = 'HIRED')::int AS hired
      FROM "RecruitmentApplication" a
      JOIN "RecruitmentCandidate" cand ON cand."id" = a."candidateId"
      WHERE a."openingId" = ANY(${uuids(scope.openingIds)})
        AND ${this.inRange(scope, Prisma.sql`a."appliedAt"`)}
        AND ${this.notSelf(scope)}
      GROUP BY 1`);
    return {
      rows: SOURCES.map((source) => {
        const row = rows.find((r) => r.source === source);
        const applications = num(row?.applications);
        const hired = num(row?.hired);
        return {
          source,
          applications,
          hired,
          hireRate: percent(hired, applications),
        };
      }),
    };
  }

  private async stages(scope: ReportScope): Promise<ReportOutput> {
    const [stages, current, transitions] = await Promise.all([
      this.prisma.recruitmentStage.findMany({
        where: { organizationId: scope.organizationId },
        select: { id: true, code: true, name: true, kind: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
      this.prisma.$queryRaw<Array<{ stageId: string; count: number }>>(
        Prisma.sql`
        SELECT a."stageId" AS "stageId", COUNT(*)::int AS count
        FROM "RecruitmentApplication" a
        JOIN "RecruitmentCandidate" cand ON cand."id" = a."candidateId"
        WHERE a."openingId" = ANY(${uuids(scope.openingIds)})
          AND a."status" IN ('ACTIVE', 'OFFERED')
          AND ${this.notSelf(scope)}
        GROUP BY 1`,
      ),
      this.prisma.$queryRaw<
        Array<{
          stageId: string;
          entered: number;
          completed: number;
          averageDays: string | number | null;
        }>
      >(Prisma.sql`
        WITH stays AS (
          SELECT t."toStageId" AS stage, t."createdAt" AS entered_at,
            LEAD(t."createdAt") OVER (PARTITION BY t."applicationId" ORDER BY t."createdAt", t."id") AS left_at
          FROM "RecruitmentStageTransition" t
          JOIN "RecruitmentApplication" a ON a."id" = t."applicationId"
          JOIN "RecruitmentCandidate" cand ON cand."id" = a."candidateId"
          WHERE a."openingId" = ANY(${uuids(scope.openingIds)})
            AND ${this.notSelf(scope)}
        )
        SELECT stage AS "stageId",
          COUNT(*) FILTER (WHERE ${this.inRange(scope, Prisma.sql`entered_at`)})::int AS entered,
          COUNT(*) FILTER (WHERE left_at IS NOT NULL AND ${this.inRange(scope, Prisma.sql`left_at`)})::int AS completed,
          AVG(EXTRACT(EPOCH FROM (left_at - entered_at)) / 86400)
            FILTER (WHERE left_at IS NOT NULL AND ${this.inRange(scope, Prisma.sql`left_at`)}) AS "averageDays"
        FROM stays
        GROUP BY 1`),
    ]);
    return {
      rows: stages.map((stage) => {
        const t = transitions.find((r) => r.stageId === stage.id);
        const average = nullableNum(t?.averageDays);
        return {
          stageCode: stage.code,
          stageName: stage.name,
          stageKind: stage.kind,
          currentApplications: num(
            current.find((r) => r.stageId === stage.id)?.count,
          ),
          entered: num(t?.entered),
          completedStays: num(t?.completed),
          averageDaysInStage: average === null ? null : round2(average),
        };
      }),
      notes: [
        'Time in stage is measured between consecutive stage transitions; a stay counts when it ended in the range. "Active now" ignores the range.',
      ],
    };
  }

  private async offers(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{ status: string; offers: number }>
    >(Prisma.sql`
      SELECT off."status"::text AS status, COUNT(*)::int AS offers
      FROM "RecruitmentOffer" off
      JOIN "RecruitmentApplication" a ON a."id" = off."applicationId"
      JOIN "RecruitmentCandidate" cand ON cand."id" = a."candidateId"
      WHERE a."openingId" = ANY(${uuids(scope.openingIds)})
        AND ${this.inRange(scope, Prisma.sql`off."createdAt"`)}
        AND ${this.notSelf(scope)}
      GROUP BY 1`);
    const total = rows.reduce((sum, row) => sum + row.offers, 0);
    return {
      rows: OFFER_STATUSES.map((status) => {
        const offers = num(rows.find((r) => r.status === status)?.offers);
        return { status, offers, share: percent(offers, total) };
      }),
      notes: ['Offers created in the range, by their current status.'],
    };
  }
}
