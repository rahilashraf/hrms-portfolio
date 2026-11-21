import { Prisma } from '../generated/prisma/client.js';

/**
 * Phase 19 — organization tagging of audit entries. The audit viewer and audit retention read
 * an entry's organization from `metadata.organizationId` (AuditLog has no column; see
 * `AuditLog_metadata_organizationId_occurredAt_idx`). Phase 13+ writers set it themselves; the
 * earlier modules (organization structure, roles, Core HR assignments, time, scheduling, leave,
 * compensation, payroll, benefits, kiosk devices, holidays) did not. For those entity types
 * the organization is resolved here, from the audited row, inside the writer's own
 * transaction (so a row created in that transaction is visible). Identifiers only.
 *
 * Table and column names below are fixed constants; the id is always a bound parameter.
 */
type Resolver = (id: string) => Prisma.Sql;

const direct =
  (table: string, column = 'organizationId'): Resolver =>
  (id) =>
    Prisma.sql`SELECT ${Prisma.raw(`"${column}"`)}::text AS "organizationId" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}::uuid`;

/** Rows that belong to an EmploymentAssignment: the organization of its position. */
const viaAssignment =
  (table: string): Resolver =>
  (id) =>
    Prisma.sql`SELECT p."organizationId"::text AS "organizationId" FROM ${Prisma.raw(`"${table}"`)} t
      JOIN "EmploymentAssignment" a ON a."id" = t."employmentAssignmentId"
      JOIN "Position" p ON p."id" = a."positionId"
      WHERE t."id" = ${id}::uuid`;

const viaParent =
  (table: string, column: string, parent: string): Resolver =>
  (id) =>
    Prisma.sql`SELECT x."organizationId"::text AS "organizationId" FROM ${Prisma.raw(`"${table}"`)} t
      JOIN ${Prisma.raw(`"${parent}"`)} x ON x."id" = t.${Prisma.raw(`"${column}"`)}
      WHERE t."id" = ${id}::uuid`;

export const AUDIT_ORGANIZATION_RESOLVERS: Readonly<Record<string, Resolver>> =
  Object.freeze({
    Organization: (id) =>
      Prisma.sql`SELECT "id"::text AS "organizationId" FROM "Organization" WHERE "id" = ${id}::uuid`,
    OrganizationalUnit: direct('OrganizationalUnit'),
    OrganizationBranding: direct('OrganizationBranding'),
    Department: direct('Department'),
    Team: direct('Team'),
    JobTitle: direct('JobTitle'),
    Position: direct('Position'),
    WorkLocation: direct('WorkLocation'),
    Role: direct('Role'),
    RoleAssignment: direct('RoleAssignment', 'roleOrganizationId'),
    EmploymentAssignment: (id) =>
      Prisma.sql`SELECT p."organizationId"::text AS "organizationId" FROM "EmploymentAssignment" a
        JOIN "Position" p ON p."id" = a."positionId" WHERE a."id" = ${id}::uuid`,
    OrganizationHoliday: direct('OrganizationHoliday'),
    CompensationRecord: direct('CompensationRecord'),
    PayGroup: direct('PayGroup'),
    PayrollRun: direct('PayrollRun'),
    PayrollAdjustment: direct('PayrollAdjustment'),
    PayrollPeriod: direct('PayrollPeriod'),
    PayrollCalendar: direct('PayrollCalendar'),
    BenefitPlan: direct('BenefitPlan'),
    BenefitEnrollment: direct('BenefitEnrollment'),
    BenefitEligibilityRule: direct('BenefitEligibilityRule'),
    BenefitCoverageOption: viaParent(
      'BenefitCoverageOption',
      'planId',
      'BenefitPlan',
    ),
    BenefitRate: viaParent('BenefitRate', 'planId', 'BenefitPlan'),
    LeaveType: direct('LeaveType'),
    LeavePolicy: direct('LeavePolicy'),
    LeaveRequest: viaAssignment('LeaveRequest'),
    LeaveLedgerEntry: viaAssignment('LeaveLedgerEntry'),
    Schedule: direct('Schedule'),
    ScheduledShift: viaParent('ScheduledShift', 'scheduleId', 'Schedule'),
    ScheduleTemplate: direct('ScheduleTemplate'),
    SchedulePolicy: direct('SchedulePolicy'),
    EmployeeSchedulePattern: viaAssignment('EmployeeSchedulePattern'),
    TimeAttendancePolicy: direct('TimeAttendancePolicy'),
    AttendanceDevice: direct('AttendanceDevice'),
    TimePeriod: direct('TimePeriod'),
    Timesheet: viaParent('Timesheet', 'timePeriodId', 'TimePeriod'),
    TimesheetSegment: viaAssignment('TimesheetSegment'),
    TimeEntry: viaAssignment('TimeEntry'),
    TimeCorrectionRequest: viaAssignment('TimeCorrectionRequest'),
    TimeAdjustment: viaAssignment('TimeAdjustment'),
    AttendanceSignIn: viaAssignment('AttendanceSignIn'),
    AttendanceException: viaAssignment('AttendanceException'),
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QueryClient = { $queryRaw?: Prisma.TransactionClient['$queryRaw'] };

/** The entry's organization when it carries none and its entity type is resolvable. */
export async function auditOrganizationOf(
  client: QueryClient,
  input: {
    entityType?: string | null;
    entityId?: string | null;
    metadata?: unknown;
  },
): Promise<string | null> {
  const metadata = input.metadata;
  if (
    metadata !== undefined &&
    metadata !== null &&
    (typeof metadata !== 'object' || Array.isArray(metadata))
  )
    return null;
  if (metadata && 'organizationId' in (metadata as Record<string, unknown>))
    return null;
  const resolver = input.entityType
    ? AUDIT_ORGANIZATION_RESOLVERS[input.entityType]
    : undefined;
  if (!resolver || !input.entityId || !UUID.test(input.entityId)) return null;
  if (typeof client.$queryRaw !== 'function') return null;
  const rows: unknown = await client.$queryRaw(resolver(input.entityId));
  const value =
    Array.isArray(rows) && rows.length === 1
      ? (rows[0] as { organizationId?: unknown }).organizationId
      : null;
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/**
 * Batch 2 — entries about an account (a login or one of its sessions). An account is not owned
 * by one organization: it belongs to every organization its person works in (PLANNED or ACTIVE
 * employment assignments) or that it administers (effective, non-System role assignments),
 * evaluated when the event happens. AuditService writes one copy per such organization, each
 * tagged with it, so every organization sees its people's account events — and no organization
 * sees those of an account that does not work in or for it. An account with no organization
 * (e.g. a deployment administrator) gets one untagged entry, visible in the System view.
 */
export const ACCOUNT_AUDIT_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'User',
  'AuthSession',
]);

/**
 * The organizations of the account an entry is about, or null when the entry is not about an
 * account (or names its organization itself, or the client cannot query).
 */
export async function accountOrganizationsOf(
  client: QueryClient,
  input: {
    entityType?: string | null;
    entityId?: string | null;
    metadata?: unknown;
  },
): Promise<string[] | null> {
  if (!input.entityType || !ACCOUNT_AUDIT_ENTITY_TYPES.has(input.entityType))
    return null;
  const metadata = input.metadata;
  if (
    metadata !== undefined &&
    metadata !== null &&
    (typeof metadata !== 'object' || Array.isArray(metadata))
  )
    return null;
  if (metadata && 'organizationId' in (metadata as Record<string, unknown>))
    return null;
  if (!input.entityId || !UUID.test(input.entityId)) return null;
  if (typeof client.$queryRaw !== 'function') return null;
  let userId: string | null = input.entityId;
  if (input.entityType === 'AuthSession') {
    const sessions: unknown = await client.$queryRaw(
      Prisma.sql`SELECT "userId"::text AS "userId" FROM "AuthSession" WHERE "id" = ${input.entityId}::uuid`,
    );
    const value =
      Array.isArray(sessions) && sessions.length === 1
        ? (sessions[0] as { userId?: unknown }).userId
        : null;
    userId = typeof value === 'string' && UUID.test(value) ? value : null;
  }
  if (!userId) return [];
  // The application clock, as authorization evaluates role assignments (inside a transaction
  // the database's now() is the transaction's start).
  const now = new Date();
  const rows: unknown = await client.$queryRaw(Prisma.sql`
    SELECT p."organizationId"::text AS "organizationId"
      FROM "User" u
      JOIN "Employee" e ON e."personId" = u."personId"
      JOIN "EmploymentAssignment" a ON a."employeeId" = e."id"
       AND a."status" IN ('PLANNED', 'ACTIVE')
      JOIN "Position" p ON p."id" = a."positionId"
     WHERE u."id" = ${userId}::uuid
    UNION
    SELECT ra."organizationId"::text AS "organizationId"
      FROM "RoleAssignment" ra
      JOIN "Role" r ON r."id" = ra."roleId"
     WHERE ra."userId" = ${userId}::uuid
       AND ra."revokedAt" IS NULL
       AND r."archivedAt" IS NULL
       AND ra."startsAt" <= ${now}::timestamptz
       AND (ra."expiresAt" IS NULL OR ra."expiresAt" > ${now}::timestamptz)
       AND ra."scopeType" <> 'SYSTEM'
       AND ra."organizationId" IS NOT NULL
    ORDER BY 1`);
  return Array.isArray(rows)
    ? rows
        .map((row) => (row as { organizationId?: unknown }).organizationId)
        .filter(
          (value): value is string =>
            typeof value === 'string' && UUID.test(value),
        )
    : [];
}
