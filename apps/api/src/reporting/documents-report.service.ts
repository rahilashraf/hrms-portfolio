import { Injectable } from '@nestjs/common';
import { addDays } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  EXPIRING_SOON_DAYS,
  levelWithin,
  requirementApplies,
  satisfies,
} from '../documents/documents-domain.js';
import { Prisma } from '../generated/prisma/client.js';
import type { DocumentConfidentiality } from '../generated/prisma/client.js';
import {
  assignmentWhere,
  sqlDate,
  uuids,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import { percent } from './reporting-domain.js';

const LEVELS: readonly DocumentConfidentiality[] = [
  'EMPLOYEE_VISIBLE',
  'MANAGER_VISIBLE',
  'HR_ONLY',
  'RESTRICTED',
];

/**
 * Documents reports (document.read), placed through the employee's assignments like the
 * documents domain. Confidentiality is enforced, not hidden: a document — and a requirement
 * whose type defaults to a level — is counted only where the caller may read that level
 * (HR-only needs document.confidential.read, restricted needs document.restricted.read, each
 * together with report.read on the same placement). The caller's own records are left out
 * (document grants never reach one's own records).
 */
@Injectable()
export class DocumentsReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    switch (scope.definition.key) {
      case 'documents.requirements':
        return this.requirements(scope);
      case 'documents.expiry':
        return this.expiry(scope);
      default:
        return this.acknowledgements(scope);
    }
  }

  /** In-scope assignments (optionally only current ones) with each employee's clearance. */
  private async employees(scope: ReportScope, currentOnly: boolean) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        employeeId: string;
        employmentType: string;
        positionId: string;
        departmentId: string | null;
      }>
    >(Prisma.sql`
      SELECT ea."employeeId" AS "employeeId", ea."employmentType"::text AS "employmentType",
        ea."positionId" AS "positionId", p."departmentId" AS "departmentId"
      FROM "EmploymentAssignment" ea
      JOIN "Position" p ON p."id" = ea."positionId"
      WHERE ${assignmentWhere(scope)}
        AND ${currentOnly ? Prisma.sql`ea."status" IN ('ACTIVE', 'PLANNED')` : Prisma.sql`ea."status" <> 'CANCELLED'`}`);
    const employees = new Map<
      string,
      { clearance: number; assignments: typeof rows }
    >();
    for (const row of rows) {
      const entry = employees.get(row.employeeId) ?? {
        clearance: -1,
        assignments: [],
      };
      entry.clearance = Math.max(
        entry.clearance,
        scope.documentClearance.get(row.positionId) ?? -1,
      );
      entry.assignments.push(row);
      employees.set(row.employeeId, entry);
    }
    for (const [id, entry] of employees)
      if (entry.clearance < 0) employees.delete(id);
    return employees;
  }

  private async requirements(scope: ReportScope): Promise<ReportOutput> {
    const [employees, requirements] = await Promise.all([
      this.employees(scope, true),
      this.prisma.documentRequirement.findMany({
        where: { organizationId: scope.organizationId, archivedAt: null },
        select: {
          typeId: true,
          employmentType: true,
          departmentId: true,
          positionId: true,
          type: {
            select: { code: true, name: true, defaultConfidentiality: true },
          },
        },
      }),
    ]);
    const typeIds = [...new Set(requirements.map((r) => r.typeId))];
    const documents =
      typeIds.length && employees.size
        ? await this.prisma.employeeDocument.findMany({
            where: {
              organizationId: scope.organizationId,
              employeeId: { in: [...employees.keys()] },
              typeId: { in: typeIds },
            },
            select: {
              employeeId: true,
              typeId: true,
              status: true,
              confidentiality: true,
              versions: {
                where: { supersededAt: null },
                select: { expiresOn: true },
              },
            },
          })
        : [];
    const byEmployeeType = new Map<string, typeof documents>();
    for (const document of documents) {
      const key = `${document.employeeId}:${document.typeId}`;
      byEmployeeType.set(key, [...(byEmployeeType.get(key) ?? []), document]);
    }
    const totals = new Map<
      string,
      {
        code: string;
        name: string;
        employees: number;
        satisfied: number;
        missing: number;
        expired: number;
      }
    >();
    for (const [employeeId, employee] of employees) {
      const applicable = new Map<string, (typeof requirements)[number]>();
      for (const requirement of requirements) {
        // A requirement whose type defaults above the caller's clearance is not counted.
        if (
          !levelWithin(
            requirement.type.defaultConfidentiality,
            employee.clearance,
          )
        )
          continue;
        if (
          employee.assignments.some((assignment) =>
            requirementApplies(requirement, assignment),
          )
        )
          applicable.set(requirement.typeId, requirement);
      }
      for (const [typeId, requirement] of applicable) {
        const ofType = (
          byEmployeeType.get(`${employeeId}:${typeId}`) ?? []
        ).filter((document) =>
          levelWithin(document.confidentiality, employee.clearance),
        );
        const satisfied = ofType.some((document) =>
          satisfies(
            {
              status: document.status,
              expiresOn: document.versions[0]?.expiresOn ?? null,
            },
            scope.today,
          ),
        );
        const expired =
          !satisfied && ofType.some((document) => document.status === 'ACTIVE');
        const total = totals.get(typeId) ?? {
          code: requirement.type.code,
          name: requirement.type.name,
          employees: 0,
          satisfied: 0,
          missing: 0,
          expired: 0,
        };
        total.employees += 1;
        if (satisfied) total.satisfied += 1;
        else if (expired) total.expired += 1;
        else total.missing += 1;
        totals.set(typeId, total);
      }
    }
    return {
      rows: [...totals.values()]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((total) => ({
          typeCode: total.code,
          typeName: total.name,
          employees: total.employees,
          satisfied: total.satisfied,
          missing: total.missing,
          expired: total.expired,
          completionRate: percent(total.satisfied, total.employees),
        })),
      notes: [
        'Requirements apply to current (active or planned) in-scope assignments. A requirement is satisfied by an active, unexpired document of its type the caller may read; types defaulting above the caller’s clearance are not counted, and a document stored above it does not count as satisfying.',
      ],
    };
  }

  private async expiry(scope: ReportScope): Promise<ReportOutput> {
    const employees = await this.employees(scope, false);
    const readers = (level: DocumentConfidentiality) =>
      [...employees.entries()]
        .filter(([, employee]) => levelWithin(level, employee.clearance))
        .map(([id]) => id);
    const visible = Prisma.join(
      LEVELS.map(
        (level) =>
          Prisma.sql`(d."confidentiality"::text = ${level}::text AND d."employeeId" = ANY(${uuids(readers(level))}))`,
      ),
      ' OR ',
    );
    const today = scope.today;
    const soon = addDays(today, EXPIRING_SOON_DAYS);
    const rows = await this.prisma.$queryRaw<
      Array<{
        code: string;
        name: string;
        confidentiality: string;
        documents: number;
        expired: number;
        expiringSoon: number;
        valid: number;
      }>
    >(Prisma.sql`
      SELECT dt."code", dt."name", d."confidentiality"::text AS confidentiality,
        COUNT(*)::int AS documents,
        COUNT(*) FILTER (WHERE v."expiresOn" < ${sqlDate(today)})::int AS expired,
        COUNT(*) FILTER (WHERE v."expiresOn" >= ${sqlDate(today)} AND v."expiresOn" <= ${sqlDate(soon)})::int AS "expiringSoon",
        COUNT(*) FILTER (WHERE v."expiresOn" > ${sqlDate(soon)})::int AS valid
      FROM "EmployeeDocument" d
      JOIN "EmployeeDocumentVersion" v ON v."documentId" = d."id" AND v."supersededAt" IS NULL
      JOIN "DocumentType" dt ON dt."id" = d."typeId"
      WHERE d."organizationId" = ${scope.organizationId}::uuid
        AND d."status" = 'ACTIVE' AND v."expiresOn" IS NOT NULL
        AND (${visible})
      GROUP BY dt."id", dt."code", dt."name", d."confidentiality"
      ORDER BY dt."code", d."confidentiality"`);
    return {
      rows: rows.map((row) => ({
        typeCode: row.code,
        typeName: row.name,
        confidentiality: row.confidentiality,
        documents: row.documents,
        expired: row.expired,
        expiringSoon: row.expiringSoon,
        valid: row.valid,
      })),
      notes: [
        `Expiring soon = expiring within ${EXPIRING_SOON_DAYS} days. Documents above the caller's confidentiality clearance are excluded.`,
      ],
    };
  }

  private async acknowledgements(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        code: string;
        title: string;
        versionNumber: number;
        versionLabel: string;
        current: boolean;
        audience: number;
        acknowledged: number;
      }>
    >(Prisma.sql`
      SELECT pol."code", pol."title", pv."versionNumber" AS "versionNumber",
        pv."versionLabel" AS "versionLabel",
        (pv."supersededAt" IS NULL AND pol."status" = 'PUBLISHED') AS current,
        COUNT(DISTINCT aud."employeeId")::int AS audience,
        COUNT(DISTINCT aud."employeeId") FILTER (WHERE ack."id" IS NOT NULL)::int AS acknowledged
      FROM "PolicyDocumentVersion" pv
      JOIN "PolicyDocument" pol ON pol."id" = pv."policyId"
      LEFT JOIN LATERAL (
        SELECT DISTINCT ea."employeeId"
        FROM "EmploymentAssignment" ea
        JOIN "Position" p ON p."id" = ea."positionId"
        WHERE ${assignmentWhere(scope)}
          AND ea."status" IN ('ACTIVE', 'PLANNED')
          AND (pol."audienceEmploymentType" IS NULL OR ea."employmentType" = pol."audienceEmploymentType")
          AND (pol."audienceDepartmentId" IS NULL OR p."departmentId" = pol."audienceDepartmentId")
      ) aud ON true
      LEFT JOIN "DocumentAcknowledgement" ack
        ON ack."policyVersionId" = pv."id" AND ack."employeeId" = aud."employeeId"
      WHERE pv."organizationId" = ${scope.organizationId}::uuid
        AND pv."publishedAt" IS NOT NULL AND pol."acknowledgementRequired"
      GROUP BY pv."id", pol."code", pol."title", pv."versionNumber", pv."versionLabel", pv."supersededAt", pol."status"
      ORDER BY pol."code", pv."versionNumber"`);
    return {
      rows: rows.map((row) => ({
        policyCode: row.code,
        policyTitle: row.title,
        versionNumber: row.versionNumber,
        versionLabel: row.versionLabel,
        current: row.current,
        audience: row.audience,
        acknowledged: row.acknowledged,
        pending: row.audience - row.acknowledged,
        completionRate: percent(row.acknowledged, row.audience),
      })),
      notes: [
        'The audience is today’s in-scope employees with a current assignment matching the policy audience, also for earlier versions.',
      ],
    };
  }
}
