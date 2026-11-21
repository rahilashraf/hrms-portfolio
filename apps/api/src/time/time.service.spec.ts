import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../database/prisma.service.js';
import { SystemClock, TimeService } from './time.service.js';
import { TimeDomainService } from './time-domain.service.js';
import type { FeatureGateService } from '../features/feature-gate.service.js';

/** Phase 18: every module enabled (these unit tests mock no feature tables). */
const allFeaturesEnabled = {
  isEnabled: async () => true,
  require: async () => undefined,
  requireAll: async () => undefined,
  isEnabledForPosition: async () => true,
  requireForPosition: async () => undefined,
  requireForEmployee: async () => undefined,
  disabledOrganizations: async () => new Set<string>(),
  disabledAmong: async () => new Set<string>(),
} as unknown as FeatureGateService;

const fixedNow = new Date('2026-10-03T02:00:00.000Z');

function position(id: string, timezone = 'America/Toronto') {
  return {
    id,
    organizationId: 'org-1',
    jobTitleId: 'job-title-1',
    organizationalUnitId: null,
    departmentId: null,
    teamId: null,
    workLocationId: 'work-location-1',
    name: `Position ${id}`,
    code: id.toUpperCase(),
    description: null,
    sortOrder: 0,
    archivedAt: null,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    jobTitle: { id: 'job-title-1', name: 'Counsellor', code: 'COUNSELLOR' },
    organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
    organizationalUnit: null,
    department: null,
    team: null,
    workLocation: {
      id: 'work-location-1',
      name: 'Main Lodge',
      code: 'LODGE',
      physicalSiteId: 'physical-site-1',
      timezone,
    },
  };
}

function assignment(
  id: string,
  employeeId = 'employee-1',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    employeeId,
    positionId: `${id}-position`,
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    startDate: new Date('2026-10-01T00:00:00.000Z'),
    endDate: null,
    isPrimary: false,
    managerAssignmentId: null,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    position: position(`${id}-position`),
    ...overrides,
  };
}

function makeHarness() {
  const domain = new TimeDomainService();
  const employee = {
    id: 'employee-1',
    personId: 'person-1',
    employeeNumber: 'EMP-000001',
    status: 'ACTIVE',
    hireDate: new Date('2026-10-01T00:00:00.000Z'),
    terminationDate: null,
    archivedAt: null,
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
  const assignments = [
    assignment('assignment-1'),
    assignment('assignment-2'),
    assignment('other-assignment', 'employee-2'),
    assignment('inactive-assignment', 'employee-1', { status: 'ENDED' }),
  ];
  const entries: any[] = [];
  const coverages: any[] = [];
  const breakEntries: any[] = [];
  const exceptions: any[] = [];
  const correctionRequests: any[] = [];
  const adjustments: any[] = [];
  const punches: any[] = [];
  const timePeriods: any[] = [];
  const timesheets: any[] = [];
  const timesheetSegments: any[] = [];
  const timesheetEvents: any[] = [];
  const audits: any[] = [];
  const policies = new Map<string, any>([
    [
      'assignment-1',
      {
        inheritanceMode: 'INHERIT',
        config: { clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true } },
      },
    ],
    [
      'assignment-2',
      {
        inheritanceMode: 'INHERIT',
        config: { clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true } },
      },
    ],
  ]);
  const policyRows: any[] = [];
  let failNextEntryCreateWithUnique = false;
  let now = fixedNow;

  const attachTimesheet = (row: any) => ({
    ...row,
    timePeriod: timePeriods.find((period) => period.id === row.timePeriodId),
    employee: {
      ...employee,
      id: row.employeeId,
      person: {
        id: row.employeeId === 'employee-2' ? 'person-2' : 'person-1',
        user:
          row.employeeId === 'employee-2' ? { id: 'user-2' } : { id: 'user-1' },
      },
    },
    segments: timesheetSegments
      .filter((segment) => segment.timesheetId === row.id)
      .map((segment) => ({
        ...segment,
        employmentAssignment: assignments.find(
          (assignment) => assignment.id === segment.employmentAssignmentId,
        ),
      })),
    events: timesheetEvents.filter((event) => event.timesheetId === row.id),
  });

  const dateMatches = (value: Date, filter: any) =>
    (!filter?.gte || value.getTime() >= filter.gte.getTime()) &&
    (!filter?.lte || value.getTime() <= filter.lte.getTime());

  const tx: any = {
    // Batch 4A: the employee advisory lock and FOR UPDATE / FOR SHARE row locks (no-ops here:
    // one fake client, no concurrency).
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    user: {
      // Batch 4E-1 (G2): actor names for management responses.
      findMany: vi.fn(async ({ where }: any) =>
        (where.id.in as string[])
          .filter((id) => id === 'user-1')
          .map((id) => ({
            id,
            person: {
              firstName: 'Ada',
              middleName: null,
              lastName: null,
              preferredName: null,
            },
          })),
      ),
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === 'user-1'
          ? { id: 'user-1', person: { id: 'person-1', employee } }
          : where.id === 'user-2'
            ? {
                id: 'user-2',
                person: {
                  id: 'person-2',
                  employee: {
                    ...employee,
                    id: 'employee-2',
                    personId: 'person-2',
                    employeeNumber: 'EMP-000002',
                  },
                },
              }
            : null,
      ),
    },
    // Batch 4F: organization visibility and history markers read a position's organization.
    position: {
      findUnique: vi.fn(async () => ({ organizationId: 'org-1' })),
      findMany: vi.fn(async () => [
        { id: 'position-1', organizationId: 'org-1' },
      ]),
    },
    employmentAssignment: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          assignments.find((item) => item.id === where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        assignments.filter(
          (item) =>
            item.employeeId === where.employeeId &&
            (!where.status || item.status === where.status),
        ),
      ),
    },
    timeEntry: {
      findFirst: vi.fn(async ({ where }: any) => {
        const entry = entries.find(
          (item) =>
            (!where.id || item.id === where.id) &&
            (!where.employeeId || item.employeeId === where.employeeId) &&
            (!where.status || item.status === where.status) &&
            (where.archivedAt === undefined ||
              item.archivedAt === where.archivedAt) &&
            (!where.workDate || dateMatches(item.workDate, where.workDate)),
        );
        if (!entry) return null;
        if (
          where.clockInAt?.lt &&
          !(entry.clockInAt.getTime() < where.clockInAt.lt.getTime())
        ) {
          return null;
        }
        if (
          where.clockOutAt?.gt &&
          !(entry.clockOutAt?.getTime() > where.clockOutAt.gt.getTime())
        ) {
          return null;
        }
        // Batch 4A overlap check: closed after the start, or still open.
        if (
          Array.isArray(where.OR) &&
          where.OR.some((branch: any) => branch.clockOutAt?.gt) &&
          !where.OR.some(
            (branch: any) =>
              (branch.clockOutAt === null && !entry.clockOutAt) ||
              (branch.clockOutAt?.gt &&
                entry.clockOutAt?.getTime() > branch.clockOutAt.gt.getTime()),
          )
        ) {
          return null;
        }
        if (where.id?.not && entry.id === where.id.not) return null;
        return {
          ...entry,
          employmentAssignment: assignments.find(
            (item) => item.id === entry.employmentAssignmentId,
          ),
        };
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const entry = entries.find((item) => item.id === where.id);
        if (!entry) return null;
        if (where.select) {
          return Object.fromEntries(
            Object.keys(where.select).map((key) => [key, entry[key]]),
          );
        }
        return {
          ...entry,
          breaks: breakEntries.filter(
            (item) => item.timeEntryId === entry.id && item.removedAt === null,
          ),
          employmentAssignment: assignments.find(
            (item) => item.id === entry.employmentAssignmentId,
          ),
        };
      }),
      findMany: vi.fn(async ({ where }: any) =>
        entries
          .filter(
            (item) =>
              (!where.employeeId || item.employeeId === where.employeeId) &&
              (!where.employmentAssignmentId?.in ||
                where.employmentAssignmentId.in.includes(
                  item.employmentAssignmentId,
                )) &&
              (!where.status || item.status === where.status) &&
              (where.archivedAt === undefined ||
                item.archivedAt === where.archivedAt) &&
              (!where.workDate || dateMatches(item.workDate, where.workDate)),
          )
          .map((entry) => ({
            ...entry,
            employee: {
              ...employee,
              id: entry.employeeId,
              employeeNumber:
                entry.employeeId === 'employee-2' ? 'EMP-000002' : 'EMP-000001',
              person: {
                firstName: entry.employeeId === 'employee-2' ? 'Grace' : 'Ada',
                middleName: null,
                lastName:
                  entry.employeeId === 'employee-2' ? 'Hopper' : 'Lovelace',
                preferredName:
                  entry.employeeId === 'employee-2' ? 'Grace' : 'Ada',
              },
            },
            breaks: breakEntries.filter(
              (item) =>
                item.timeEntryId === entry.id &&
                (item.removedAt === null || item.removedAt === undefined),
            ),
            exceptions: exceptions.filter(
              (item) => item.timeEntryId === entry.id,
            ),
            correctionRequests: correctionRequests
              .filter((item) => item.timeEntryId === entry.id)
              .map((item) => ({
                ...item,
                adjustment:
                  adjustments.find(
                    (adjustment) => adjustment.correctionRequestId === item.id,
                  ) ?? null,
              })),
            employmentAssignment: assignments.find(
              (item) => item.id === entry.employmentAssignmentId,
            ),
          })),
      ),
      create: vi.fn(async ({ data }: any) => {
        if (failNextEntryCreateWithUnique) {
          failNextEntryCreateWithUnique = false;
          throw { code: 'P2002' };
        }
        const row = {
          id: `entry-${entries.length + 1}`,
          clockOutAt: null,
          archivedAt: null,
          updatedAt: fixedNow,
          createdAt: fixedNow,
          ...data,
        };
        entries.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = entries.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      // Batch 4A: closing an entry is conditional on it still being open.
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = entries.filter(
          (item) =>
            item.id === where.id &&
            (!where.status || item.status === where.status) &&
            (where.archivedAt === undefined ||
              item.archivedAt === where.archivedAt),
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
    },
    timePunch: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `punch-${punches.length + 1}`,
          createdAt: fixedNow,
          ...data,
        };
        punches.push(row);
        return row;
      }),
      // Batch 4A: anything recorded at or after a proposed clock-out.
      findFirst: vi.fn(
        async ({ where }: any) =>
          punches.find(
            (item) =>
              item.timeEntryId === where.timeEntryId &&
              (!where.occurredAt?.gte ||
                item.occurredAt.getTime() >= where.occurredAt.gte.getTime()),
          ) ?? null,
      ),
    },
    // Batch 4A: the linked user of an employee (self-target checks).
    employee: {
      findUnique: vi.fn(async ({ where }: any) => ({
        id: where.id,
        person: {
          user: { id: where.id === 'employee-2' ? 'user-2' : 'user-1' },
        },
      })),
    },
    // Batch 4A: no finalized payroll has claimed anything here (reopen finds no retro work).
    payrollSourceClaim: { findMany: vi.fn(async () => []) },
    payrollRetroRequirement: { createMany: vi.fn(async () => ({ count: 0 })) },
    // Batch 4A: the organization timezone (the period-end rule).
    organization: {
      findUnique: vi.fn(async () => ({ timezone: 'America/Toronto' })),
    },
    breakEntry: {
      findFirst: vi.fn(async ({ where }: any) => {
        return (
          breakEntries.find(
            (item) =>
              item.timeEntryId === where.timeEntryId &&
              (!Array.isArray(where.OR) ||
                where.OR.some(
                  (branch: any) =>
                    (branch.startAt?.gte &&
                      item.startAt.getTime() >= branch.startAt.gte.getTime()) ||
                    (branch.endAt?.gt &&
                      item.endAt?.getTime() > branch.endAt.gt.getTime()),
                )) &&
              (where.endAt === undefined || item.endAt === where.endAt) &&
              (where.removedAt === undefined ||
                item.removedAt === where.removedAt) &&
              (!where.id?.not || item.id !== where.id.not) &&
              (!where.startAt?.lt ||
                item.startAt.getTime() < where.startAt.lt.getTime()) &&
              (!where.endAt?.gt ||
                item.endAt?.getTime() > where.endAt.gt.getTime()),
          ) ?? null
        );
      }),
      findUnique: vi.fn(
        async ({ where }: any) =>
          breakEntries.find((item) => item.id === where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        if (
          breakEntries.some(
            (item) =>
              item.timeEntryId === data.timeEntryId && item.endAt === null,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: `break-${breakEntries.length + 1}`,
          endAt: null,
          removedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        breakEntries.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = breakEntries.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    attendanceException: {
      findMany: vi.fn(async ({ where }: any) =>
        exceptions
          .filter(
            (item) =>
              (!where.employeeId || item.employeeId === where.employeeId) &&
              (!where.status || item.status === where.status) &&
              (!where.type || item.type === where.type) &&
              (!where.severity || item.severity === where.severity) &&
              (!where.workflowImpact ||
                item.workflowImpact === where.workflowImpact),
          )
          .map((item) => ({
            ...item,
            employee: {
              employeeNumber:
                item.employeeId === 'employee-2' ? 'EMP-000002' : 'EMP-000001',
              person: {
                firstName: item.employeeId === 'employee-2' ? 'Grace' : 'Ada',
                middleName: null,
                lastName:
                  item.employeeId === 'employee-2' ? 'Hopper' : 'Lovelace',
                preferredName:
                  item.employeeId === 'employee-2' ? 'Grace' : 'Ada',
              },
            },
            employmentAssignment:
              assignments.find(
                (assignment) => assignment.id === item.employmentAssignmentId,
              ) ?? null,
            timeEntry: entries.find((entry) => entry.id === item.timeEntryId)
              ? {
                  ...entries.find((entry) => entry.id === item.timeEntryId),
                  employmentAssignment: assignments.find(
                    (assignment) =>
                      assignment.id ===
                      entries.find((entry) => entry.id === item.timeEntryId)
                        ?.employmentAssignmentId,
                  ),
                }
              : null,
          })),
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          exceptions.find((item) => {
            if (where.employeeId && item.employeeId !== where.employeeId) {
              return false;
            }
            if (where.timeEntryId && item.timeEntryId !== where.timeEntryId) {
              return false;
            }
            if (where.type && item.type !== where.type) return false;
            if (where.status && item.status !== where.status) return false;
            if (
              where.workflowImpact &&
              item.workflowImpact !== where.workflowImpact
            ) {
              return false;
            }
            if (where.timeEntry?.workDate) {
              const entry = entries.find(
                (entryItem) => entryItem.id === item.timeEntryId,
              );
              return entry
                ? dateMatches(entry.workDate, where.timeEntry.workDate)
                : false;
            }
            return true;
          }) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        const exception = exceptions.find((item) => item.id === where.id);
        if (!exception) return null;
        const entry = entries.find((item) => item.id === exception.timeEntryId);
        return {
          ...exception,
          timeEntry: entry
            ? {
                ...entry,
                employmentAssignment: assignments.find(
                  (item) => item.id === entry.employmentAssignmentId,
                ),
              }
            : null,
        };
      }),
      create: vi.fn(async ({ data }: any) => {
        if (
          data.status === 'OPEN' &&
          exceptions.some(
            (item) =>
              item.timeEntryId === data.timeEntryId &&
              item.type === data.type &&
              item.status === 'OPEN',
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: `exception-${exceptions.length + 1}`,
          resolutionMethod: null,
          resolvedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        exceptions.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = exceptions.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of exceptions) {
          if (
            (!where.timeEntryId || row.timeEntryId === where.timeEntryId) &&
            (!where.status || row.status === where.status) &&
            (!where.type || row.type === where.type)
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    timeCorrectionRequest: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          correctionRequests.find((item) => {
            if (where.employeeId && item.employeeId !== where.employeeId) {
              return false;
            }
            if (where.status && item.status !== where.status) return false;
            if (!where.OR) return true;
            return where.OR.some((condition: any) => {
              if (condition.timeEntry?.workDate) {
                const entry = entries.find(
                  (entryItem) => entryItem.id === item.timeEntryId,
                );
                return entry
                  ? dateMatches(entry.workDate, condition.timeEntry.workDate)
                  : false;
              }
              if (condition.timeEntryId === null) {
                return item.timeEntryId === null;
              }
              return false;
            });
          }) ?? null,
      ),
      findMany: vi.fn(async ({ where, include }: any) =>
        correctionRequests
          .filter(
            (item) =>
              (!where.employeeId || item.employeeId === where.employeeId) &&
              (!where.status || item.status === where.status),
          )
          .map((item) => ({
            ...item,
            ...(include?.employee
              ? {
                  employee: {
                    employeeNumber:
                      item.employeeId === 'employee-2'
                        ? 'EMP-000002'
                        : 'EMP-000001',
                    person: {
                      firstName:
                        item.employeeId === 'employee-2' ? 'Grace' : 'Ada',
                      middleName: null,
                      lastName:
                        item.employeeId === 'employee-2'
                          ? 'Hopper'
                          : 'Lovelace',
                      preferredName:
                        item.employeeId === 'employee-2' ? 'Grace' : 'Ada',
                    },
                  },
                }
              : {}),
            ...(include?.timeEntry
              ? {
                  timeEntry: entries.find(
                    (entry) => entry.id === item.timeEntryId,
                  )
                    ? {
                        ...entries.find(
                          (entry) => entry.id === item.timeEntryId,
                        ),
                        employmentAssignment: assignments.find(
                          (assignment) =>
                            assignment.id ===
                            entries.find(
                              (entry) => entry.id === item.timeEntryId,
                            )?.employmentAssignmentId,
                        ),
                      }
                    : null,
                }
              : {}),
            ...(include?.employmentAssignment
              ? {
                  employmentAssignment:
                    assignments.find(
                      (assignment) =>
                        assignment.id === item.employmentAssignmentId,
                    ) ?? null,
                }
              : {}),
            ...(include?.targetEmploymentAssignment
              ? {
                  targetEmploymentAssignment:
                    assignments.find(
                      (assignment) =>
                        assignment.id === item.targetEmploymentAssignmentId,
                    ) ?? null,
                }
              : {}),
            ...(include?.breakEntry
              ? {
                  breakEntry:
                    breakEntries.find(
                      (entry) => entry.id === item.breakEntryId,
                    ) ?? null,
                }
              : {}),
            ...(include?.adjustment
              ? {
                  adjustment:
                    adjustments.find(
                      (adjustment) =>
                        adjustment.correctionRequestId === item.id,
                    ) ?? null,
                }
              : {}),
          })),
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = correctionRequests.find((item) => item.id === where.id);
        if (!row) return null;
        return {
          ...row,
          adjustment:
            adjustments.find((item) => item.correctionRequestId === row.id) ??
            null,
        };
      }),
      create: vi.fn(async ({ data }: any) => {
        if (
          data.status === 'PENDING' &&
          correctionRequests.some(
            (item) =>
              item.status === 'PENDING' &&
              item.employeeId === data.employeeId &&
              item.type === data.type &&
              item.timeEntryId === data.timeEntryId &&
              item.breakEntryId === data.breakEntryId &&
              item.employmentAssignmentId === data.employmentAssignmentId &&
              item.targetEmploymentAssignmentId ===
                data.targetEmploymentAssignmentId,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: `correction-${correctionRequests.length + 1}`,
          reviewerUserId: null,
          reviewerNote: null,
          reviewedAt: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
          requestedAt: now,
          ...data,
        };
        correctionRequests.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data, include }: any) => {
        const row = correctionRequests.find((item) => item.id === where.id);
        Object.assign(row, data);
        return include?.adjustment
          ? {
              ...row,
              adjustment:
                adjustments.find(
                  (item) => item.correctionRequestId === row.id,
                ) ?? null,
            }
          : row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of correctionRequests) {
          if (where.id && row.id !== where.id) continue;
          if (where.status && row.status !== where.status) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
    },
    timeAdjustment: {
      create: vi.fn(async ({ data }: any) => {
        if (
          data.correctionRequestId &&
          adjustments.some(
            (item) => item.correctionRequestId === data.correctionRequestId,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: `adjustment-${adjustments.length + 1}`,
          createdAt: now,
          ...data,
        };
        adjustments.push(row);
        return row;
      }),
    },
    timeAttendancePolicy: {
      findFirst: vi.fn(async ({ where }: any) => {
        const scoped = policyRows
          .filter((row) => policyMatches(row, where))
          .sort(
            (a, b) =>
              b.effectiveFrom.getTime() - a.effectiveFrom.getTime() ||
              b.createdAt.getTime() - a.createdAt.getTime(),
          )[0];
        if (scoped) {
          return {
            inheritanceMode: scoped.inheritanceMode,
            config: scoped.config,
          };
        }
        if (where.scopeType !== 'EMPLOYMENT_ASSIGNMENT') return null;
        return policies.get(where.employmentAssignmentId) ?? null;
      }),
    },
    timePeriod: {
      // Batch 4C: the overlap check (a period of the organization sharing a date).
      findFirst: vi.fn(
        async ({ where }: any) =>
          timePeriods.find(
            (period) =>
              period.organizationId === where.organizationId &&
              period.startDate.getTime() <= where.startDate.lte.getTime() &&
              period.endDate.getTime() >= where.endDate.gte.getTime(),
          ) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id)
          return timePeriods.find((period) => period.id === where.id) ?? null;
        const key = where.organizationId_startDate_endDate;
        return (
          timePeriods.find(
            (period) =>
              period.organizationId === key.organizationId &&
              period.startDate.getTime() === key.startDate.getTime() &&
              period.endDate.getTime() === key.endDate.getTime(),
          ) ?? null
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        const existing = timePeriods.find(
          (period) =>
            period.organizationId === data.organizationId &&
            period.startDate.getTime() === data.startDate.getTime() &&
            period.endDate.getTime() === data.endDate.getTime(),
        );
        if (existing) throw { code: 'P2002' };
        const row = {
          id: `period-${timePeriods.length + 1}`,
          status: 'UPCOMING',
          cadence: 'CUSTOM',
          metadata: null,
          openedAt: null,
          closedAt: null,
          lockedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        timePeriods.push(row);
        return row;
      }),
      upsert: vi.fn(async ({ where, create }: any) => {
        const key = where.organizationId_startDate_endDate;
        const existing = timePeriods.find(
          (period) =>
            period.organizationId === key.organizationId &&
            period.startDate.getTime() === key.startDate.getTime() &&
            period.endDate.getTime() === key.endDate.getTime(),
        );
        if (existing) return existing;
        const row = {
          id: `period-${timePeriods.length + 1}`,
          status: 'UPCOMING',
          cadence: 'CUSTOM',
          metadata: null,
          openedAt: null,
          closedAt: null,
          lockedAt: null,
          createdAt: now,
          updatedAt: now,
          ...create,
        };
        timePeriods.push(row);
        return row;
      }),
    },
    timesheet: {
      // The finalized-time lookup: the employee's APPROVED/LOCKED timesheet (or one with an
      // approved segment of the assignment) whose period covers the work date.
      findFirst: vi.fn(async ({ where }: any) => {
        const row = timesheets.find((item) => {
          if (item.employeeId !== where.employeeId) return false;
          const period = timePeriods.find(
            (periodItem) => periodItem.id === item.timePeriodId,
          );
          if (
            !period ||
            period.startDate.getTime() >
              where.timePeriod.startDate.lte.getTime() ||
            period.endDate.getTime() < where.timePeriod.endDate.gte.getTime()
          ) {
            return false;
          }
          const segmentClause = where.OR?.[1]?.segments?.some;
          return (
            ['APPROVED', 'LOCKED'].includes(item.status) ||
            (segmentClause !== undefined &&
              timesheetSegments.some(
                (segment) =>
                  segment.timesheetId === item.id &&
                  segment.employmentAssignmentId ===
                    segmentClause.employmentAssignmentId &&
                  segment.status === 'APPROVED',
              ))
          );
        });
        return row ? { id: row.id, status: row.status } : null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = timesheets.find((item) => item.id === where.id);
        return row ? attachTimesheet(row) : null;
      }),
      findMany: vi.fn(async ({ where }: any = {}) =>
        timesheets
          .filter((item) => {
            if (where?.employeeId && item.employeeId !== where.employeeId) {
              return false;
            }
            if (where?.status?.in && !where.status.in.includes(item.status)) {
              return false;
            }
            if (
              where?.status &&
              typeof where.status === 'string' &&
              item.status !== where.status
            ) {
              return false;
            }
            if (where?.timePeriod) {
              const period = timePeriods.find(
                (periodItem) => periodItem.id === item.timePeriodId,
              );
              if (!period) return false;
              if (
                where.timePeriod.startDate?.lte &&
                period.startDate.getTime() >
                  where.timePeriod.startDate.lte.getTime()
              ) {
                return false;
              }
              if (
                where.timePeriod.endDate?.gte &&
                period.endDate.getTime() <
                  where.timePeriod.endDate.gte.getTime()
              ) {
                return false;
              }
            }
            return true;
          })
          .map((item) =>
            where?.select ? { id: item.id } : attachTimesheet(item),
          ),
      ),
      upsert: vi.fn(async ({ where, create }: any) => {
        const key = where.employeeId_timePeriodId;
        const existing = timesheets.find(
          (item) =>
            item.employeeId === key.employeeId &&
            item.timePeriodId === key.timePeriodId,
        );
        if (existing) return existing;
        const row = {
          id: `timesheet-${timesheets.length + 1}`,
          submittedByUserId: null,
          submittedAt: null,
          approvedByUserId: null,
          approvedAt: null,
          lockedByUserId: null,
          lockedAt: null,
          reopenedByUserId: null,
          reopenedAt: null,
          reviewerNote: null,
          version: 1,
          totals: null,
          createdAt: now,
          updatedAt: now,
          ...create,
        };
        timesheets.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = timesheets.find((item) => item.id === where.id);
        Object.assign(row, {
          ...data,
          version:
            typeof data.version === 'object' && data.version.increment
              ? row.version + data.version.increment
              : (data.version ?? row.version),
          updatedAt: now,
        });
        return attachTimesheet(row);
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of timesheets) {
          if (where.id && row.id !== where.id) continue;
          if (where.status && row.status !== where.status) continue;
          Object.assign(row, {
            ...data,
            version:
              typeof data.version === 'object' && data.version.increment
                ? row.version + data.version.increment
                : (data.version ?? row.version),
            updatedAt: now,
          });
          count += 1;
        }
        return { count };
      }),
    },
    timesheetSegment: {
      findUnique: vi.fn(async ({ where }: any) => {
        const segment = timesheetSegments.find((item) => item.id === where.id);
        if (!segment) return null;
        return {
          ...segment,
          employmentAssignment: assignments.find(
            (item) => item.id === segment.employmentAssignmentId,
          ),
          timesheet: attachTimesheet(
            timesheets.find((item) => item.id === segment.timesheetId),
          ),
        };
      }),
      findMany: vi.fn(async ({ where }: any) =>
        timesheetSegments.filter(
          (segment) =>
            !where.timesheetId || segment.timesheetId === where.timesheetId,
        ),
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `timesheet-segment-${timesheetSegments.length + 1}`,
          reviewedByUserId: null,
          reviewedAt: null,
          reviewerNote: null,
          approvedWorkedMinutes: 0,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        timesheetSegments.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = timesheetSegments.find((item) => item.id === where.id);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of timesheetSegments) {
          if (where.id?.in && !where.id.in.includes(row.id)) continue;
          if (typeof where.id === 'string' && row.id !== where.id) continue;
          if (where.timesheetId && row.timesheetId !== where.timesheetId)
            continue;
          if (where.status?.in && !where.status.in.includes(row.status))
            continue;
          if (where.status?.not && row.status === where.status.not) continue;
          Object.assign(row, data, { updatedAt: now });
          count += 1;
        }
        return { count };
      }),
    },
    timesheetEvent: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `timesheet-event-${timesheetEvents.length + 1}`,
          occurredAt: now,
          ...data,
        };
        timesheetEvents.push(row);
        return row;
      }),
    },
    organizationalUnit: { findMany: vi.fn(async () => []) },
    timeEntryAssignmentCoverage: {
      findMany: vi.fn(async ({ where }: any) =>
        coverages
          .filter(
            (row) =>
              (!where.timeEntryId || row.timeEntryId === where.timeEntryId) &&
              (!where.employeeId || row.employeeId === where.employeeId) &&
              (where.removedAt === undefined ||
                row.removedAt === where.removedAt),
          )
          .map((row) => {
            const entry = entries.find((item) => item.id === row.timeEntryId);
            const withAssignment = (id: string) =>
              assignments.find((item) => item.id === id);
            return {
              ...row,
              employmentAssignment: withAssignment(row.employmentAssignmentId),
              timeEntry: entry && {
                ...entry,
                breaks: (entry.breaks ?? []).filter(
                  (item: any) => !item.removedAt,
                ),
                employmentAssignment: withAssignment(
                  entry.employmentAssignmentId,
                ),
              },
            };
          })
          .filter(
            (row) =>
              !where.timeEntry ||
              (row.timeEntry &&
                (!where.timeEntry.status ||
                  row.timeEntry.status === where.timeEntry.status) &&
                dateMatches(row.timeEntry.workDate, where.timeEntry.workDate)),
          ),
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `coverage-${coverages.length + 1}`,
          createdAt: new Date(),
          removedAt: null,
          ...data,
        };
        coverages.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of coverages) {
          if (
            row.timeEntryId === where.timeEntryId &&
            row.removedAt === null &&
            where.employmentAssignmentId.in.includes(row.employmentAssignmentId)
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const canAccess = vi.fn(async () => true);
  const authorization = {
    canAccess,
    assertCan: vi.fn(async () => undefined),
    // Batch 4B: management lists pre-filter by the reader's organizations (System scope here).
    effectiveGrants: vi.fn(async () =>
      [
        'time.view',
        'time.correct',
        'time.approve',
        'time.timesheet.approve',
        'time.timesheet.manage',
      ].map((permission) => ({ permission, scope: { type: 'SYSTEM' } })),
    ),
  } as unknown as AuthorizationService;
  const targets = {
    scopeForPosition: vi.fn(async () => ({
      type: 'ORGANIZATION',
      id: 'org-1',
    })),
  } as unknown as PositionAuthorizationTargetResolver;
  const audit = {
    write: vi.fn(async (input: unknown) => {
      audits.push(input);
      return input;
    }),
  } as unknown as AuditService;
  const clock = { now: vi.fn(() => now) } as unknown as SystemClock;

  const service = new TimeService(
    prisma,
    domain,
    authorization,
    targets,
    audit,
    clock,
    undefined,
    undefined,
    allFeaturesEnabled,
  );

  return {
    service,
    tx,
    employee,
    assignments,
    entries,
    breakEntries,
    exceptions,
    correctionRequests,
    adjustments,
    punches,
    timePeriods,
    timesheets,
    timesheetSegments,
    timesheetEvents,
    audits,
    policies,
    policyRows,
    canAccess,
    setNow: (value: Date) => {
      now = value;
    },
    failNextEntryCreateWithUnique: () => {
      failNextEntryCreateWithUnique = true;
    },
  };
}

function policyMatches(row: any, where: any): boolean {
  if (row.archivedAt !== null && row.archivedAt !== undefined) return false;
  if (row.scopeType !== where.scopeType) return false;
  for (const key of [
    'organizationId',
    'organizationalUnitId',
    'departmentId',
    'teamId',
    'employmentAssignmentId',
  ]) {
    if (where[key] !== undefined && row[key] !== where[key]) return false;
  }
  if (
    where.effectiveFrom?.lte &&
    row.effectiveFrom.getTime() > where.effectiveFrom.lte.getTime()
  ) {
    return false;
  }
  const effectiveTo = row.effectiveTo ?? null;
  if (
    where.OR &&
    effectiveTo &&
    effectiveTo.getTime() < where.OR[1].effectiveTo.gte.getTime()
  ) {
    return false;
  }
  return true;
}

describe('TimeService', () => {
  it('returns OFF_CLOCK status with eligible assignments and actions', async () => {
    const { service } = makeHarness();

    await expect(service.status('user-1')).resolves.toMatchObject({
      state: 'OFF_CLOCK',
      availableActions: ['CLOCK_IN'],
      eligibleAssignments: [{ id: 'assignment-1' }, { id: 'assignment-2' }],
    });
  });

  it('returns readable status without actions when live clocking is disabled', async () => {
    const { service, policies } = makeHarness();
    policies.clear();

    await expect(service.status('user-1')).resolves.toMatchObject({
      state: 'OFF_CLOCK',
      availableActions: [],
      eligibleAssignments: [],
    });
  });

  it('honors scoped policy inheritance and effective dating independently by section', async () => {
    const { service, assignments, policies, policyRows } = makeHarness();
    policies.clear();
    Object.assign(assignments[0].position as any, {
      teamId: 'team-1',
      team: { id: 'team-1', name: 'Cabin Team', code: 'CABIN' },
    });
    policyRows.push(
      {
        scopeType: 'ORGANIZATION',
        organizationId: 'org-1',
        inheritanceMode: 'INHERIT',
        effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-09-30T00:00:00.000Z'),
        createdAt: fixedNow,
        config: { clock: { mode: 'DISABLED' } },
      },
      {
        scopeType: 'ORGANIZATION',
        organizationId: 'org-1',
        inheritanceMode: 'INHERIT',
        effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
        effectiveTo: null,
        createdAt: fixedNow,
        config: {
          clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
          breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30 },
        },
      },
      {
        scopeType: 'ORGANIZATION',
        organizationId: 'org-1',
        inheritanceMode: 'INHERIT',
        effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
        effectiveTo: null,
        createdAt: fixedNow,
        config: { clock: { mode: 'DISABLED' } },
      },
      {
        scopeType: 'TEAM',
        organizationId: 'org-1',
        teamId: 'team-1',
        inheritanceMode: 'INHERIT',
        effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
        effectiveTo: null,
        createdAt: fixedNow,
        config: {
          breaks: {
            mode: 'MANUAL_PUNCH',
            paidUnpaidClassification: true,
            defaultPayType: 'UNPAID',
          },
        },
      },
    );

    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await expect(
      service.startBreak('user-1', { actorUserId: 'user-1' }),
    ).resolves.toMatchObject({ state: 'ON_BREAK' });

    await service.endBreak('user-1', { actorUserId: 'user-1' });
    await service.clockOut('user-1', { actorUserId: 'user-1' });
    await service.clockIn('user-1', 'assignment-2', { actorUserId: 'user-1' });
    await expect(
      service.startBreak('user-1', { actorUserId: 'user-1' }),
    ).rejects.toThrow('Manual break punching is not enabled');
  });

  it('clocks in with server time, timezone-derived workDate, punch, and audit', async () => {
    const { service, entries, punches, audits } = makeHarness();

    const result = await service.clockIn('user-1', 'assignment-1', {
      actorUserId: 'user-1',
    });

    expect(result).toMatchObject({
      state: 'CLOCKED_IN',
      currentTimeEntry: {
        employmentAssignmentId: 'assignment-1',
        clockedInAt: fixedNow.toISOString(),
        timezone: 'America/Toronto',
        workDate: '2026-10-02',
      },
      availableActions: ['CLOCK_OUT', 'SWITCH_ASSIGNMENT'],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].clockInAt).toBe(fixedNow);
    expect(punches).toHaveLength(1);
    expect(punches[0]).toMatchObject({
      type: 'CLOCK_IN',
      occurredAt: fixedNow,
      employmentAssignmentId: 'assignment-1',
    });
    expect(audits).toHaveLength(1);
  });

  it('rejects another employee assignment, inactive assignment, and disabled policy', async () => {
    const { service, policies } = makeHarness();

    await expect(
      service.clockIn('user-1', 'other-assignment', { actorUserId: 'user-1' }),
    ).rejects.toThrow('Assignment does not belong');
    await expect(
      service.clockIn('user-1', 'inactive-assignment', {
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow('Assignment is not active');

    policies.delete('assignment-1');
    await expect(
      service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('makes duplicate clock-in to the same assignment idempotent', async () => {
    const { service, entries, punches, audits } = makeHarness();

    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });

    expect(entries).toHaveLength(1);
    expect(punches).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('rejects clock-in to a different assignment while already clocked in', async () => {
    const { service } = makeHarness();

    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await expect(
      service.clockIn('user-1', 'assignment-2', { actorUserId: 'user-1' }),
    ).rejects.toThrow(ConflictException);
  });

  it('translates a duplicate clock-in database race into current status', async () => {
    const { service, entries, failNextEntryCreateWithUnique } = makeHarness();
    entries.push({
      id: 'entry-existing',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      clockInAt: fixedNow,
      clockOutAt: null,
      timezone: 'America/Toronto',
      workDate: new Date('2026-10-02T00:00:00.000Z'),
      status: 'OPEN',
      source: 'LIVE_CLOCK',
      archivedAt: null,
    });
    failNextEntryCreateWithUnique();

    await expect(
      service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' }),
    ).resolves.toMatchObject({
      state: 'CLOCKED_IN',
      currentTimeEntry: { id: 'entry-existing' },
    });
  });

  it('clocks out with the same timestamp on punch and entry', async () => {
    const { service, entries, punches, audits } = makeHarness();
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });

    const result = await service.clockOut('user-1', { actorUserId: 'user-1' });

    expect(result).toMatchObject({ state: 'OFF_CLOCK' });
    expect(entries[0]).toMatchObject({
      status: 'CLOSED',
      clockOutAt: fixedNow,
    });
    expect(punches[1]).toMatchObject({
      type: 'CLOCK_OUT',
      occurredAt: fixedNow,
      timeEntryId: entries[0].id,
    });
    expect(audits).toHaveLength(2);
  });

  it('allows clock-out even after policy is disabled or assignment becomes inactive', async () => {
    const { service, entries, policies, assignments } = makeHarness();
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    policies.clear();
    assignments[0].status = 'ENDED';

    await expect(
      service.clockOut('user-1', { actorUserId: 'user-1' }),
    ).resolves.toMatchObject({ state: 'OFF_CLOCK' });
    expect(entries[0].status).toBe('CLOSED');
  });

  it('makes duplicate clock-out while off-clock idempotent', async () => {
    const { service, punches, audits } = makeHarness();

    await expect(
      service.clockOut('user-1', { actorUserId: 'user-1' }),
    ).resolves.toMatchObject({ state: 'OFF_CLOCK' });

    expect(punches).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('starts a manual break with a BreakEntry, BREAK_START punch, and ON_BREAK status', async () => {
    const { service, policies, breakEntries, punches, audits } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: {
          mode: 'MANUAL_PUNCH',
          paidUnpaidClassification: true,
          defaultPayType: 'PAID',
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });

    const result = await service.startBreak('user-1', {
      actorUserId: 'user-1',
    });

    expect(result).toMatchObject({
      state: 'ON_BREAK',
      currentBreakEntry: { id: 'break-1', payType: 'PAID' },
      breakStartedAt: fixedNow.toISOString(),
      availableActions: ['END_BREAK', 'CLOCK_OUT'],
    });
    expect(breakEntries).toHaveLength(1);
    expect(breakEntries[0]).toMatchObject({
      timeEntryId: 'entry-1',
      startAt: fixedNow,
      endAt: null,
      payType: 'PAID',
    });
    expect(punches.at(-1)).toMatchObject({
      type: 'BREAK_START',
      occurredAt: fixedNow,
      timeEntryId: 'entry-1',
    });
    expect(audits.at(-1)).toMatchObject({ action: 'TIME_BREAK_STARTED' });
  });

  it('rejects break start while off-clock or when policy is NONE/AUTO_DEDUCT', async () => {
    const { service, policies } = makeHarness();

    await expect(
      service.startBreak('user-1', { actorUserId: 'user-1' }),
    ).rejects.toThrow('Employee is not clocked in');

    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await expect(
      service.startBreak('user-1', { actorUserId: 'user-1' }),
    ).rejects.toThrow('Manual break punching is not enabled');

    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: { mode: 'AUTO_DEDUCT' },
      },
    });
    await expect(
      service.startBreak('user-1', { actorUserId: 'user-1' }),
    ).rejects.toThrow('Manual break punching is not enabled');
  });

  it('makes duplicate break start retry-safe', async () => {
    const { service, policies, breakEntries, punches, audits } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: { mode: 'MANUAL_PUNCH' },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await service.startBreak('user-1', { actorUserId: 'user-1' });
    await service.startBreak('user-1', { actorUserId: 'user-1' });

    expect(breakEntries).toHaveLength(1);
    expect(
      punches.filter((punch) => punch.type === 'BREAK_START'),
    ).toHaveLength(1);
    expect(
      audits.filter((audit) => audit.action === 'TIME_BREAK_STARTED'),
    ).toHaveLength(1);
  });

  it('ends a break with a BREAK_END punch and idempotent retry', async () => {
    const { service, policies, breakEntries, punches, audits, setNow } =
      makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: { mode: 'MANUAL_PUNCH' },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await service.startBreak('user-1', { actorUserId: 'user-1' });
    const endAt = new Date('2026-10-03T02:15:00.000Z');
    setNow(endAt);

    await expect(
      service.endBreak('user-1', { actorUserId: 'user-1' }),
    ).resolves.toMatchObject({
      state: 'CLOCKED_IN',
      currentBreakEntry: null,
      availableActions: ['START_BREAK', 'CLOCK_OUT', 'SWITCH_ASSIGNMENT'],
    });
    await service.endBreak('user-1', { actorUserId: 'user-1' });

    expect(breakEntries[0]).toMatchObject({ endAt });
    expect(punches.filter((punch) => punch.type === 'BREAK_END')).toHaveLength(
      1,
    );
    expect(
      audits.filter((audit) => audit.action === 'TIME_BREAK_ENDED'),
    ).toHaveLength(1);
  });

  it('clocks out while on break by closing the break and time entry at one timestamp', async () => {
    const {
      service,
      policies,
      entries,
      breakEntries,
      punches,
      audits,
      setNow,
    } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: { mode: 'MANUAL_PUNCH' },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await service.startBreak('user-1', { actorUserId: 'user-1' });
    const transition = new Date('2026-10-03T02:20:00.000Z');
    setNow(transition);

    await expect(
      service.clockOut('user-1', { actorUserId: 'user-1' }),
    ).resolves.toMatchObject({ state: 'OFF_CLOCK' });
    await service.clockOut('user-1', { actorUserId: 'user-1' });

    expect(breakEntries[0]).toMatchObject({ endAt: transition });
    expect(entries[0]).toMatchObject({
      status: 'CLOSED',
      clockOutAt: transition,
    });
    expect(punches.map((punch) => punch.type)).toEqual([
      'CLOCK_IN',
      'BREAK_START',
      'BREAK_END',
      'CLOCK_OUT',
    ]);
    expect(audits.at(-1)).toMatchObject({
      action: 'TIME_CLOCKED_OUT_ON_BREAK',
    });
  });

  it('rejects assignment switching while on break', async () => {
    const { service, policies } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: { mode: 'MANUAL_PUNCH' },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await service.startBreak('user-1', { actorUserId: 'user-1' });

    await expect(
      service.switchAssignment('user-1', 'assignment-2', {
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow('End the current break');
  });

  it('switches assignments atomically at one transition instant', async () => {
    const { service, entries, punches, audits } = makeHarness();
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });

    const result = await service.switchAssignment('user-1', 'assignment-2', {
      actorUserId: 'user-1',
    });

    expect(result).toMatchObject({
      state: 'CLOCKED_IN',
      currentTimeEntry: { employmentAssignmentId: 'assignment-2' },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      status: 'CLOSED',
      clockOutAt: fixedNow,
    });
    expect(entries[1]).toMatchObject({
      status: 'OPEN',
      clockInAt: fixedNow,
      employmentAssignmentId: 'assignment-2',
    });
    expect(punches.map((punch) => punch.type)).toEqual([
      'CLOCK_IN',
      'CLOCK_OUT',
      'CLOCK_IN',
    ]);
    expect(audits).toHaveLength(2);
  });

  it('makes repeated switch to the current assignment idempotent', async () => {
    const { service, entries, punches, audits } = makeHarness();
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await service.switchAssignment('user-1', 'assignment-1', {
      actorUserId: 'user-1',
    });

    expect(entries).toHaveLength(1);
    expect(punches).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('rejects invalid switch targets and disabled switching policy', async () => {
    const { service, policies } = makeHarness();
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });

    await expect(
      service.switchAssignment('user-1', 'other-assignment', {
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow('Assignment does not belong');
    await expect(
      service.switchAssignment('user-1', 'inactive-assignment', {
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow('Assignment is not active');

    policies.set('assignment-2', {
      inheritanceMode: 'INHERIT',
      config: { clock: { mode: 'LIVE_CLOCK', assignmentSwitching: false } },
    });
    await expect(
      service.switchAssignment('user-1', 'assignment-2', {
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow('Assignment switching is not enabled');
  });

  it('detects stale open entries once and surfaces the active exception in status', async () => {
    const { service, policies, exceptions, audits, setNow } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        missedPunch: {
          enabled: true,
          maxOpenDurationMinutes: 60,
          detectionGraceMinutes: 15,
          employeeResolutionEnabled: true,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T03:14:00.000Z'));
    await expect(service.scanOpenTimeEntriesForExceptions()).resolves.toEqual({
      scanned: 1,
      detected: 0,
      autoResolved: 0,
      escalated: 0,
      failed: [],
      skippedOrganizations: [],
    });
    setNow(new Date('2026-10-03T03:16:00.000Z'));

    await expect(service.scanOpenTimeEntriesForExceptions()).resolves.toEqual({
      scanned: 1,
      detected: 1,
      autoResolved: 0,
      escalated: 0,
      failed: [],
      skippedOrganizations: [],
    });
    await expect(service.scanOpenTimeEntriesForExceptions()).resolves.toEqual({
      scanned: 1,
      detected: 0,
      autoResolved: 0,
      escalated: 0,
      failed: [],
      skippedOrganizations: [],
    });

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      type: 'MISSING_CLOCK_OUT',
      severity: 'ACTION_REQUIRED',
      workflowImpact: 'SUBMISSION_BLOCKING',
      status: 'OPEN',
    });
    expect(
      audits.filter((audit) => audit.action === 'TIME_EXCEPTION_DETECTED'),
    ).toHaveLength(1);
    await expect(service.status('user-1')).resolves.toMatchObject({
      activeExceptions: [{ id: 'exception-1', type: 'MISSING_CLOCK_OUT' }],
      availableActions: expect.arrayContaining([
        'CLOCK_OUT',
        'RESOLVE_MISSED_CLOCK_OUT',
      ]),
    });
  });

  it('does not detect missed punches when policy is disabled', async () => {
    const { service, exceptions, setNow } = makeHarness();
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T12:00:00.000Z'));

    await expect(service.scanOpenTimeEntriesForExceptions()).resolves.toEqual({
      scanned: 1,
      detected: 0,
      autoResolved: 0,
      escalated: 0,
      failed: [],
      skippedOrganizations: [],
    });
    expect(exceptions).toHaveLength(0);
  });

  it('auto-resolves stale entries only from a trusted expected end', async () => {
    const { service, policies, entries, punches, exceptions, audits, setNow } =
      makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        missedPunch: {
          enabled: true,
          maxOpenDurationMinutes: 60,
          allowAutoCloseFromExpectedEnd: true,
          expectedEndLocalTime: '22:30',
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T05:00:00.000Z'));

    await expect(service.scanOpenTimeEntriesForExceptions()).resolves.toEqual({
      scanned: 1,
      detected: 1,
      autoResolved: 1,
      escalated: 0,
      failed: [],
      skippedOrganizations: [],
    });
    await expect(service.scanOpenTimeEntriesForExceptions()).resolves.toEqual({
      scanned: 0,
      detected: 0,
      autoResolved: 0,
      escalated: 0,
      failed: [],
      skippedOrganizations: [],
    });

    expect(entries[0]).toMatchObject({
      status: 'CLOSED',
      clockOutAt: new Date('2026-10-03T02:30:00.000Z'),
    });
    expect(punches.at(-1)).toMatchObject({
      type: 'CLOCK_OUT',
      source: 'SYSTEM',
      occurredAt: new Date('2026-10-03T02:30:00.000Z'),
    });
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      type: 'AUTO_CLOSED_CLOCK_OUT',
      status: 'RESOLVED',
      resolutionMethod: 'SYSTEM_AUTO_RESOLUTION',
    });
    expect(
      audits.filter(
        (audit) => audit.action === 'TIME_EXCEPTION_SYSTEM_AUTO_RESOLVED',
      ),
    ).toHaveLength(1);
  });

  it('uses stale detection without auto-closing when no trusted expected end exists', async () => {
    const { service, policies, entries, exceptions, setNow } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        missedPunch: {
          enabled: true,
          maxOpenDurationMinutes: 60,
          allowAutoCloseFromExpectedEnd: true,
          employeeResolutionEnabled: false,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T05:00:00.000Z'));

    await expect(service.scanOpenTimeEntriesForExceptions()).resolves.toEqual({
      scanned: 1,
      detected: 1,
      autoResolved: 0,
      escalated: 1,
      failed: [],
      skippedOrganizations: [],
    });

    expect(entries[0]).toMatchObject({ status: 'OPEN', clockOutAt: null });
    expect(exceptions[0]).toMatchObject({
      type: 'MISSING_CLOCK_OUT',
      status: 'OPEN',
      workflowImpact: 'SUBMISSION_BLOCKING',
    });
  });

  it('lets the employee self-resolve a missed clock-out in the entry timezone', async () => {
    const { service, policies, entries, punches, exceptions, setNow } =
      makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        missedPunch: {
          enabled: true,
          maxOpenDurationMinutes: 60,
          employeeResolutionEnabled: true,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T05:00:00.000Z'));
    await service.scanOpenTimeEntriesForExceptions();

    await expect(
      service.resolveMissedClockOut(
        'user-1',
        'exception-1',
        '2026-10-02T22:30',
        { actorUserId: 'user-1' },
      ),
    ).resolves.toMatchObject({ state: 'OFF_CLOCK', activeExceptions: [] });

    expect(entries[0]).toMatchObject({
      status: 'CLOSED',
      clockOutAt: new Date('2026-10-03T02:30:00.000Z'),
    });
    expect(punches.at(-1)).toMatchObject({
      type: 'CLOCK_OUT',
      source: 'SYSTEM',
      occurredAt: new Date('2026-10-03T02:30:00.000Z'),
    });
    expect(exceptions[0]).toMatchObject({
      status: 'RESOLVED',
      resolutionMethod: 'EMPLOYEE_RESOLUTION',
    });
    await expect(
      service.resolveMissedClockOut(
        'user-1',
        'exception-1',
        '2026-10-02T22:15',
        { actorUserId: 'user-1' },
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects invalid or cross-employee missed clock-out resolution', async () => {
    const { service, policies, setNow } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        missedPunch: {
          enabled: true,
          maxOpenDurationMinutes: 60,
          employeeResolutionEnabled: true,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T05:00:00.000Z'));
    await service.scanOpenTimeEntriesForExceptions();

    await expect(
      service.resolveMissedClockOut(
        'user-2',
        'exception-1',
        '2026-10-02T22:00',
        { actorUserId: 'user-2' },
      ),
    ).rejects.toThrow('Attendance exception not found');
    await expect(
      service.resolveMissedClockOut(
        'user-1',
        'exception-1',
        '2026-10-02T21:59',
        { actorUserId: 'user-1' },
      ),
    ).rejects.toThrow('clockOutAt must be after');
  });

  it('records an open-break auto-close exception during configured clock-out', async () => {
    const { service, policies, exceptions, audits } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: {
          mode: 'MANUAL_PUNCH',
          openBreakAutoCloseExceptionEnabled: true,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await service.startBreak('user-1', { actorUserId: 'user-1' });

    await service.clockOut('user-1', { actorUserId: 'user-1' });
    await service.clockOut('user-1', { actorUserId: 'user-1' });

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      type: 'OPEN_BREAK_AUTO_CLOSED',
      status: 'RESOLVED',
      workflowImpact: 'NON_BLOCKING',
    });
    expect(
      audits.filter((audit) => audit.action === 'TIME_EXCEPTION_RECORDED'),
    ).toHaveLength(1);
  });

  it('creates a late-arrival exception only after the grace boundary', async () => {
    const { service, policies, exceptions, audits } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        attendanceInterpretation: {
          mode: 'BASIC',
          lateArrivalEnabled: true,
          expectedStartLocalTime: '21:54',
          lateGraceMinutes: 5,
        },
      },
    });

    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await service.recalculateAttendanceInterpretationForEntry('entry-1', {
      actorUserId: 'system',
    });

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      type: 'LATE_ARRIVAL',
      severity: 'REVIEW',
      workflowImpact: 'NON_BLOCKING',
      status: 'OPEN',
      metadata: expect.objectContaining({
        varianceMinutes: 6,
        graceMinutes: 5,
        expectedAt: '2026-10-03T01:54:00.000Z',
        actualAt: fixedNow.toISOString(),
      }),
    });
    expect(
      audits.filter(
        (audit) => audit.action === 'TIME_INTERPRETATION_EXCEPTION_CREATED',
      ),
    ).toHaveLength(1);
  });

  it('does not create late-arrival interpretation within or exactly at grace', async () => {
    const { service, policies, exceptions } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        attendanceInterpretation: {
          mode: 'BASIC',
          lateArrivalEnabled: true,
          expectedStartLocalTime: '21:55',
          lateGraceMinutes: 5,
        },
      },
    });

    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });

    expect(exceptions).toHaveLength(0);
  });

  it('does not judge punctuality when expected time is absent or disabled', async () => {
    const { service, policies, exceptions } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        attendanceInterpretation: {
          mode: 'BASIC',
          lateArrivalEnabled: true,
        },
      },
    });

    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    expect(exceptions).toHaveLength(0);

    policies.set('assignment-2', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        attendanceInterpretation: {
          mode: 'BASIC',
          lateArrivalEnabled: false,
          expectedStartLocalTime: '21:00',
        },
      },
    });
  });

  it('creates early-departure only after clock-out and respects grace', async () => {
    const { service, policies, exceptions, setNow } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        attendanceInterpretation: {
          mode: 'BASIC',
          earlyDepartureEnabled: true,
          expectedStartLocalTime: '22:00',
          expectedEndLocalTime: '00:00',
          earlyDepartureGraceMinutes: 5,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    await service.recalculateAttendanceInterpretationForEntry('entry-1');
    expect(exceptions).toHaveLength(0);

    setNow(new Date('2026-10-03T03:50:00.000Z'));
    await service.clockOut('user-1', { actorUserId: 'user-1' });

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      type: 'EARLY_DEPARTURE',
      status: 'OPEN',
      metadata: expect.objectContaining({
        varianceMinutes: 10,
        expectedAt: '2026-10-03T04:00:00.000Z',
        actualAt: '2026-10-03T03:50:00.000Z',
      }),
    });
  });

  it('handles overnight expected windows for late and early interpretation', async () => {
    const { service, policies, exceptions, setNow } = makeHarness();
    setNow(new Date('2026-10-03T02:10:00.000Z'));
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        attendanceInterpretation: {
          mode: 'BASIC',
          lateArrivalEnabled: true,
          earlyDepartureEnabled: true,
          expectedStartLocalTime: '22:00',
          expectedEndLocalTime: '06:00',
          lateGraceMinutes: 5,
          earlyDepartureGraceMinutes: 5,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T09:30:00.000Z'));
    await service.clockOut('user-1', { actorUserId: 'user-1' });

    expect(
      exceptions
        .map((exception) => exception.type)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(['EARLY_DEPARTURE', 'LATE_ARRIVAL']);
    expect(
      exceptions.find((exception) => exception.type === 'LATE_ARRIVAL'),
    ).toMatchObject({
      metadata: expect.objectContaining({
        varianceMinutes: 10,
        expectedAt: '2026-10-03T02:00:00.000Z',
      }),
    });
    expect(
      exceptions.find((exception) => exception.type === 'EARLY_DEPARTURE'),
    ).toMatchObject({
      metadata: expect.objectContaining({
        varianceMinutes: 30,
        expectedAt: '2026-10-03T10:00:00.000Z',
      }),
    });
  });

  it('recalculates interpretation after direct corrections and avoids duplicates', async () => {
    const { service, policies, exceptions, audits, setNow } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        attendanceInterpretation: {
          mode: 'BASIC',
          lateArrivalEnabled: true,
          earlyDepartureEnabled: true,
          expectedStartLocalTime: '21:54',
          expectedEndLocalTime: '23:00',
          lateGraceMinutes: 5,
          earlyDepartureGraceMinutes: 5,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T02:30:00.000Z'));
    await service.clockOut('user-1', { actorUserId: 'user-1' });
    expect(exceptions.map((exception) => exception.type)).toEqual([
      'LATE_ARRIVAL',
      'EARLY_DEPARTURE',
    ]);

    // Batch 4A: corrections and submissions happen after the period, never ahead of now.
    setNow(new Date('2026-10-10T12:00:00.000Z'));
    await service.correctEntry(
      'user-2',
      'entry-1',
      {
        type: 'CHANGE_CLOCK_IN',
        reason: 'Actual start was on time',
        clockInAt: '2026-10-02T21:54',
      },
      { actorUserId: 'user-2' },
    );
    await service.correctEntry(
      'user-2',
      'entry-1',
      {
        type: 'CHANGE_CLOCK_OUT',
        reason: 'Actual end was after expected end',
        clockOutAt: '2026-10-02T23:05',
      },
      { actorUserId: 'user-2' },
    );
    await service.recalculateAttendanceInterpretationForEntry('entry-1');

    expect(exceptions).toHaveLength(2);
    expect(exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'LATE_ARRIVAL',
          status: 'RESOLVED',
        }),
        expect.objectContaining({
          type: 'EARLY_DEPARTURE',
          status: 'RESOLVED',
        }),
      ]),
    );
    expect(
      audits.filter(
        (audit) => audit.action === 'TIME_INTERPRETATION_EXCEPTION_CREATED',
      ),
    ).toHaveLength(2);
    expect(
      audits.filter(
        (audit) => audit.action === 'TIME_INTERPRETATION_EXCEPTION_RESOLVED',
      ),
    ).toHaveLength(2);
  });

  it('creates a pending employee clock-out correction request when approval is required', async () => {
    const { service, policies, correctionRequests, adjustments, setNow } =
      makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        correction: {
          employeeRequestsEnabled: true,
          approvalMode: 'ALWAYS_REQUIRE_APPROVAL',
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T04:00:00.000Z'));
    await service.clockOut('user-1', { actorUserId: 'user-1' });

    // Batch 4A: corrections and submissions happen after the period, never ahead of now.
    setNow(new Date('2026-10-10T12:00:00.000Z'));
    await expect(
      service.requestCorrection(
        'user-1',
        {
          type: 'CHANGE_CLOCK_OUT',
          timeEntryId: 'entry-1',
          clockOutAt: '2026-10-03T00:30',
          reason: 'Forgot cleanup time',
        },
        { actorUserId: 'user-1' },
      ),
    ).resolves.toMatchObject({
      id: 'correction-1',
      status: 'PENDING',
      type: 'CHANGE_CLOCK_OUT',
      adjustmentId: null,
    });
    expect(correctionRequests).toHaveLength(1);
    expect(adjustments).toHaveLength(0);

    await expect(
      service.requestCorrection(
        'user-1',
        {
          type: 'CHANGE_CLOCK_OUT',
          timeEntryId: 'entry-1',
          clockOutAt: '2026-10-03T00:45',
          reason: 'Duplicate',
        },
        { actorUserId: 'user-1' },
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('auto-approves narrow safe clock corrections when policy allows', async () => {
    const { service, policies, entries, punches, adjustments, setNow } =
      makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        correction: {
          employeeRequestsEnabled: true,
          approvalMode: 'AUTO_APPROVE_SAFE',
          autoApprovalToleranceMinutes: 30,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T04:00:00.000Z'));
    await service.clockOut('user-1', { actorUserId: 'user-1' });

    // Batch 4A: corrections and submissions happen after the period, never ahead of now.
    setNow(new Date('2026-10-10T12:00:00.000Z'));
    await expect(
      service.requestCorrection(
        'user-1',
        {
          type: 'CHANGE_CLOCK_OUT',
          timeEntryId: 'entry-1',
          clockOutAt: '2026-10-03T00:15',
          reason: 'Rounded to actual end',
        },
        { actorUserId: 'user-1' },
      ),
    ).resolves.toMatchObject({
      status: 'APPROVED',
      adjustmentId: 'adjustment-1',
    });

    expect(entries[0].clockOutAt).toEqual(new Date('2026-10-03T04:15:00.000Z'));
    expect(adjustments[0]).toMatchObject({
      type: 'CHANGE_CLOCK_OUT',
      source: 'EMPLOYEE_AUTO_APPROVED',
      timeEntryId: 'entry-1',
    });
    expect(punches.map((punch) => punch.type)).toEqual([
      'CLOCK_IN',
      'CLOCK_OUT',
    ]);
  });

  it('keeps assignment changes and missing entries pending by default', async () => {
    const { service, policies, setNow } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        correction: {
          employeeRequestsEnabled: true,
          approvalMode: 'AUTO_APPROVE_SAFE',
          autoApprovalToleranceMinutes: 999,
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T04:00:00.000Z'));
    await service.clockOut('user-1', { actorUserId: 'user-1' });

    // Batch 4A: corrections and submissions happen after the period, never ahead of now.
    setNow(new Date('2026-10-10T12:00:00.000Z'));
    await expect(
      service.requestCorrection(
        'user-1',
        {
          type: 'CHANGE_ASSIGNMENT',
          timeEntryId: 'entry-1',
          targetEmploymentAssignmentId: 'assignment-2',
          reason: 'Worked the second assignment',
        },
        { actorUserId: 'user-1' },
      ),
    ).resolves.toMatchObject({ status: 'PENDING' });

    await expect(
      service.requestCorrection(
        'user-1',
        {
          type: 'ADD_MISSING_TIME_ENTRY',
          employmentAssignmentId: 'assignment-1',
          startAt: '2026-10-03T08:00',
          endAt: '2026-10-03T09:00',
          reason: 'Forgot to clock a meeting',
        },
        { actorUserId: 'user-1' },
      ),
    ).resolves.toMatchObject({
      status: 'PENDING',
      type: 'ADD_MISSING_TIME_ENTRY',
    });
  });

  it('approves a missing clock-out correction once and resolves the exception', async () => {
    const {
      service,
      policies,
      entries,
      exceptions,
      adjustments,
      audits,
      setNow,
    } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        missedPunch: {
          enabled: true,
          maxOpenDurationMinutes: 60,
          employeeResolutionEnabled: true,
        },
        correction: {
          employeeRequestsEnabled: true,
          approvalMode: 'ALWAYS_REQUIRE_APPROVAL',
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T05:00:00.000Z'));
    await service.scanOpenTimeEntriesForExceptions();
    await service.requestCorrection(
      'user-1',
      {
        type: 'ADD_MISSING_CLOCK_OUT',
        timeEntryId: 'entry-1',
        clockOutAt: '2026-10-02T23:00',
        reason: 'Forgot to clock out',
      },
      { actorUserId: 'user-1' },
    );

    await expect(
      service.approveCorrection('user-2', 'correction-1', 'Looks right', {
        actorUserId: 'user-2',
      }),
    ).resolves.toMatchObject({
      status: 'APPROVED',
      adjustmentId: 'adjustment-1',
    });
    await expect(
      service.approveCorrection('user-2', 'correction-1', 'Retry', {
        actorUserId: 'user-2',
      }),
    ).resolves.toMatchObject({ status: 'APPROVED' });

    expect(entries[0]).toMatchObject({
      status: 'CLOSED',
      clockOutAt: new Date('2026-10-03T03:00:00.000Z'),
    });
    expect(exceptions[0]).toMatchObject({
      status: 'RESOLVED',
      resolutionMethod: 'EMPLOYEE_RESOLUTION',
    });
    expect(adjustments).toHaveLength(1);
    expect(
      audits.filter((audit) => audit.action === 'TIME_CORRECTION_APPROVED'),
    ).toHaveLength(1);
  });

  it('rejects self approval and manager rejection leaves attendance unchanged', async () => {
    const { service, policies, entries, setNow } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        correction: {
          employeeRequestsEnabled: true,
          approvalMode: 'ALWAYS_REQUIRE_APPROVAL',
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T04:00:00.000Z'));
    await service.clockOut('user-1', { actorUserId: 'user-1' });
    // Batch 4A: corrections and submissions happen after the period, never ahead of now.
    setNow(new Date('2026-10-10T12:00:00.000Z'));
    await service.requestCorrection(
      'user-1',
      {
        type: 'CHANGE_CLOCK_OUT',
        timeEntryId: 'entry-1',
        clockOutAt: '2026-10-03T00:30',
        reason: 'Cleanup',
      },
      { actorUserId: 'user-1' },
    );

    await expect(
      service.approveCorrection('user-1', 'correction-1', undefined, {
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.rejectCorrection('user-2', 'correction-1', 'No evidence', {
        actorUserId: 'user-2',
      }),
    ).resolves.toMatchObject({ status: 'REJECTED' });
    expect(entries[0].clockOutAt).toEqual(new Date('2026-10-03T04:00:00.000Z'));
  });

  it('allows requestor cancellation for pending corrections only', async () => {
    const { service, policies, setNow } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        correction: {
          employeeRequestsEnabled: true,
          approvalMode: 'ALWAYS_REQUIRE_APPROVAL',
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T04:00:00.000Z'));
    await service.clockOut('user-1', { actorUserId: 'user-1' });
    // Batch 4A: corrections and submissions happen after the period, never ahead of now.
    setNow(new Date('2026-10-10T12:00:00.000Z'));
    await service.requestCorrection(
      'user-1',
      {
        type: 'CHANGE_CLOCK_OUT',
        timeEntryId: 'entry-1',
        clockOutAt: '2026-10-03T00:30',
        reason: 'Cleanup',
      },
      { actorUserId: 'user-1' },
    );

    await expect(
      service.cancelCorrection('user-1', 'correction-1', {
        actorUserId: 'user-1',
      }),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
    await expect(
      service.cancelCorrection('user-1', 'correction-1', {
        actorUserId: 'user-1',
      }),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('applies direct corrections and break additions without mutating raw punches', async () => {
    const {
      service,
      policies,
      entries,
      breakEntries,
      punches,
      adjustments,
      setNow,
    } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: {
          mode: 'MANUAL_PUNCH',
          paidUnpaidClassification: true,
          defaultPayType: 'UNPAID',
        },
      },
    });
    await service.clockIn('user-1', 'assignment-1', { actorUserId: 'user-1' });
    setNow(new Date('2026-10-03T04:00:00.000Z'));
    await service.clockOut('user-1', { actorUserId: 'user-1' });

    await expect(
      service.correctEntry(
        'user-2',
        'entry-1',
        {
          type: 'ADD_BREAK',
          reason: 'Lunch was missed',
          breakStartAt: '2026-10-02T23:00',
          breakEndAt: '2026-10-02T23:15',
        },
        { actorUserId: 'user-2' },
      ),
    ).resolves.toMatchObject({
      type: 'ADD_BREAK',
      source: 'MANAGER_DIRECT',
    });

    expect(breakEntries[0]).toMatchObject({
      startAt: new Date('2026-10-03T03:00:00.000Z'),
      endAt: new Date('2026-10-03T03:15:00.000Z'),
      payType: 'UNPAID',
    });
    expect(punches.map((punch) => punch.type)).toEqual([
      'CLOCK_IN',
      'CLOCK_OUT',
    ]);
    expect(adjustments).toHaveLength(1);
    expect(entries[0].clockOutAt).toEqual(new Date('2026-10-03T04:00:00.000Z'));
  });

  it('returns employee attendance history with backend-derived totals', async () => {
    const { service, entries, breakEntries, exceptions, correctionRequests } =
      makeHarness();
    entries.push({
      id: 'entry-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      clockInAt: new Date('2026-10-03T01:00:00.000Z'),
      clockOutAt: new Date('2026-10-03T05:00:00.000Z'),
      timezone: 'America/Toronto',
      workDate: new Date('2026-10-02T00:00:00.000Z'),
      status: 'CLOSED',
      source: 'LIVE_CLOCK',
      archivedAt: null,
    });
    breakEntries.push({
      id: 'break-1',
      timeEntryId: 'entry-1',
      startAt: new Date('2026-10-03T03:00:00.000Z'),
      endAt: new Date('2026-10-03T03:30:00.000Z'),
      payType: 'UNPAID',
      removedAt: null,
    });
    exceptions.push({
      id: 'exception-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      timeEntryId: 'entry-1',
      type: 'LATE_ARRIVAL',
      severity: 'REVIEW',
      workflowImpact: 'NON_BLOCKING',
      status: 'OPEN',
      detectedAt: fixedNow,
      resolvedAt: null,
      reason: 'Late',
      metadata: {},
    });
    correctionRequests.push({
      id: 'correction-1',
      employeeId: 'employee-1',
      requestorUserId: 'user-1',
      reviewerUserId: null,
      timeEntryId: 'entry-1',
      breakEntryId: null,
      employmentAssignmentId: 'assignment-1',
      targetEmploymentAssignmentId: null,
      type: 'CHANGE_CLOCK_OUT',
      status: 'PENDING',
      reason: 'Forgot cleanup',
      reviewerNote: null,
      requestedValues: {},
      currentValues: {},
      requestedAt: fixedNow,
      reviewedAt: null,
      cancelledAt: null,
    });

    await expect(service.selfEntries('user-1')).resolves.toMatchObject({
      items: [
        {
          id: 'entry-1',
          employeeName: 'Ada',
          workDate: '2026-10-02',
          timezone: 'America/Toronto',
          grossMinutes: 240,
          unpaidBreakMinutes: 30,
          netWorkedMinutes: 210,
          exceptions: [{ id: 'exception-1', type: 'LATE_ARRIVAL' }],
          corrections: [{ id: 'correction-1', status: 'PENDING' }],
        },
      ],
      nextAfterId: null,
    });
  });

  it('scopes management current attendance with time.view', async () => {
    const { service, entries, canAccess } = makeHarness();
    entries.push(
      {
        id: 'entry-1',
        employeeId: 'employee-1',
        employmentAssignmentId: 'assignment-1',
        clockInAt: fixedNow,
        clockOutAt: null,
        timezone: 'America/Toronto',
        workDate: new Date('2026-10-02T00:00:00.000Z'),
        status: 'OPEN',
        source: 'LIVE_CLOCK',
        archivedAt: null,
      },
      {
        id: 'entry-2',
        employeeId: 'employee-1',
        employmentAssignmentId: 'assignment-2',
        clockInAt: fixedNow,
        clockOutAt: null,
        timezone: 'America/Toronto',
        workDate: new Date('2026-10-02T00:00:00.000Z'),
        status: 'OPEN',
        source: 'LIVE_CLOCK',
        archivedAt: null,
      },
    );
    canAccess.mockImplementation(async (...args: unknown[]) => {
      const scope = args[2] as { id?: string };
      return scope.id === 'org-1';
    });

    await expect(service.managementCurrent('manager-1')).resolves.toMatchObject(
      {
        items: [{ id: 'entry-1' }, { id: 'entry-2' }],
      },
    );

    canAccess.mockResolvedValue(false);
    await expect(service.managementCurrent('manager-1')).resolves.toEqual({
      items: [],
      nextAfterId: null,
    });
  });

  it('returns correction and timesheet approval queues through action permissions', async () => {
    const {
      service,
      entries,
      correctionRequests,
      timePeriods,
      timesheets,
      timesheetSegments,
      canAccess,
    } = makeHarness();
    entries.push({
      id: 'entry-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      clockInAt: fixedNow,
      clockOutAt: new Date('2026-10-03T04:00:00.000Z'),
      timezone: 'America/Toronto',
      workDate: new Date('2026-10-02T00:00:00.000Z'),
      status: 'CLOSED',
      source: 'LIVE_CLOCK',
      archivedAt: null,
    });
    correctionRequests.push({
      id: 'correction-1',
      employeeId: 'employee-1',
      requestorUserId: 'user-1',
      reviewerUserId: null,
      timeEntryId: 'entry-1',
      breakEntryId: null,
      employmentAssignmentId: 'assignment-1',
      targetEmploymentAssignmentId: null,
      type: 'CHANGE_CLOCK_OUT',
      status: 'PENDING',
      reason: 'Forgot cleanup',
      reviewerNote: null,
      requestedValues: {},
      currentValues: {},
      requestedAt: fixedNow,
      reviewedAt: null,
      cancelledAt: null,
    });
    timePeriods.push({
      id: 'period-1',
      organizationId: 'org-1',
      startDate: new Date('2026-10-02T00:00:00.000Z'),
      endDate: new Date('2026-10-08T00:00:00.000Z'),
      status: 'OPEN',
      cadence: 'WEEKLY',
      metadata: null,
      openedAt: fixedNow,
      closedAt: null,
      lockedAt: null,
    });
    timesheets.push({
      id: 'timesheet-1',
      employeeId: 'employee-1',
      timePeriodId: 'period-1',
      status: 'SUBMITTED',
      submittedByUserId: 'user-1',
      submittedAt: fixedNow,
      approvedByUserId: null,
      approvedAt: null,
      lockedByUserId: null,
      lockedAt: null,
      reopenedByUserId: null,
      reopenedAt: null,
      reviewerNote: null,
      version: 1,
      totals: {},
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    timesheetSegments.push({
      id: 'segment-1',
      timesheetId: 'timesheet-1',
      employmentAssignmentId: 'assignment-1',
      status: 'PENDING',
      reviewedByUserId: null,
      reviewedAt: null,
      reviewerNote: null,
      grossMinutes: 180,
      paidBreakMinutes: 0,
      unpaidBreakMinutes: 0,
      policyDeductionMinutes: 0,
      netWorkedMinutes: 180,
      approvedWorkedMinutes: 0,
      calculatedAt: fixedNow,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    canAccess.mockImplementation(async (...args: unknown[]) => {
      const permission = args[1];
      return (
        permission === 'time.approve' || permission === 'time.timesheet.approve'
      );
    });

    await expect(
      service.managementCorrections('manager-1', { status: 'PENDING' }),
    ).resolves.toMatchObject({
      items: [
        {
          id: 'correction-1',
          employeeName: 'Ada',
          status: 'PENDING',
          // Batch 4E-1 (G2): the requestor's name; no reviewer yet.
          actors: { 'user-1': 'Ada' },
        },
      ],
    });
    await expect(
      service.managementTimesheets('manager-1', { segmentStatus: 'PENDING' }),
    ).resolves.toMatchObject({
      items: [{ id: 'timesheet-1', segments: [{ id: 'segment-1' }] }],
    });
  });

  it('generates date-only periods and materializes assignment-segment totals', async () => {
    const {
      service,
      policies,
      entries,
      breakEntries,
      timePeriods,
      timesheetSegments,
      audits,
    } = makeHarness();
    await expect(
      service.generateTimePeriods(
        'user-2',
        {
          organizationId: 'org-1',
          cadence: 'WEEKLY',
          startDate: '2026-10-02',
          count: 2,
        },
        { actorUserId: 'user-2' },
      ),
    ).resolves.toMatchObject({
      periods: [
        { startDate: '2026-10-02', endDate: '2026-10-08' },
        { startDate: '2026-10-09', endDate: '2026-10-15' },
      ],
    });
    await service.generateTimePeriods(
      'user-2',
      {
        organizationId: 'org-1',
        cadence: 'WEEKLY',
        startDate: '2026-10-02',
        count: 2,
      },
      { actorUserId: 'user-2' },
    );
    expect(timePeriods).toHaveLength(2);
    expect(
      audits.filter((audit) => audit.action === 'TIME_PERIODS_GENERATED'),
    ).toHaveLength(1);
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30 },
      },
    });
    entries.push({
      id: 'entry-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      clockInAt: new Date('2026-10-03T01:00:00.000Z'),
      clockOutAt: new Date('2026-10-03T05:00:00.000Z'),
      timezone: 'America/Toronto',
      workDate: new Date('2026-10-02T00:00:00.000Z'),
      status: 'CLOSED',
      source: 'LIVE_CLOCK',
      archivedAt: null,
    });
    breakEntries.push(
      {
        id: 'break-paid',
        timeEntryId: 'entry-1',
        startAt: new Date('2026-10-03T02:00:00.000Z'),
        endAt: new Date('2026-10-03T02:15:00.000Z'),
        payType: 'PAID',
        removedAt: null,
      },
      {
        id: 'break-unpaid',
        timeEntryId: 'entry-1',
        startAt: new Date('2026-10-03T03:00:00.000Z'),
        endAt: new Date('2026-10-03T03:30:00.000Z'),
        payType: 'UNPAID',
        removedAt: null,
      },
    );

    await expect(
      service.materializeTimesheetForEmployeePeriod(
        'employee-1',
        timePeriods[0].id,
      ),
    ).resolves.toMatchObject({
      status: 'OPEN',
      totals: {
        // Batch 4D (D-G): the recorded 30-minute unpaid break counts toward the 30-minute
        // automatic deduction, which is applied once per day, so nothing more is deducted.
        grossMinutes: 240,
        paidBreakMinutes: 15,
        unpaidBreakMinutes: 30,
        policyDeductionMinutes: 0,
        netWorkedMinutes: 210,
      },
      segments: [
        {
          employmentAssignmentId: 'assignment-1',
          grossMinutes: 240,
          paidBreakMinutes: 15,
          unpaidBreakMinutes: 30,
          policyDeductionMinutes: 0,
          netWorkedMinutes: 210,
        },
      ],
    });
    expect(timesheetSegments).toHaveLength(1);
  });

  it('blocks submission for open entries, blocking exceptions, and pending corrections only', async () => {
    const {
      setNow,
      service,
      entries,
      exceptions,
      correctionRequests,
      timePeriods,
      timesheets,
    } = makeHarness();
    timePeriods.push({
      id: 'period-1',
      organizationId: 'org-1',
      startDate: new Date('2026-10-02T00:00:00.000Z'),
      endDate: new Date('2026-10-08T00:00:00.000Z'),
      status: 'OPEN',
      cadence: 'WEEKLY',
      metadata: null,
      openedAt: fixedNow,
      closedAt: null,
      lockedAt: null,
    });
    entries.push({
      id: 'entry-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      clockInAt: new Date('2026-10-03T01:00:00.000Z'),
      clockOutAt: null,
      timezone: 'America/Toronto',
      workDate: new Date('2026-10-02T00:00:00.000Z'),
      status: 'OPEN',
      source: 'LIVE_CLOCK',
      archivedAt: null,
    });
    const sheet = await service.materializeTimesheetForEmployeePeriod(
      'employee-1',
      'period-1',
    );

    // Batch 4A: corrections and submissions happen after the period, never ahead of now.
    setNow(new Date('2026-10-10T12:00:00.000Z'));
    await expect(
      service.submitTimesheet('user-1', sheet.id, { actorUserId: 'user-1' }),
    ).rejects.toThrow('TimeEntry is open');

    entries[0].status = 'CLOSED';
    entries[0].clockOutAt = new Date('2026-10-03T05:00:00.000Z');
    exceptions.push({
      id: 'exception-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      timeEntryId: 'entry-1',
      type: 'LATE_ARRIVAL',
      severity: 'REVIEW',
      workflowImpact: 'NON_BLOCKING',
      status: 'OPEN',
      detectedAt: fixedNow,
    });
    await expect(
      service.submitTimesheet('user-1', sheet.id, { actorUserId: 'user-1' }),
    ).resolves.toMatchObject({ status: 'SUBMITTED' });

    exceptions[0].workflowImpact = 'SUBMISSION_BLOCKING';
    timesheets[0].status = 'OPEN';
    await expect(
      service.submitTimesheet('user-1', sheet.id, {
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow('blocking exceptions');

    exceptions[0].status = 'RESOLVED';
    timesheets[0].status = 'OPEN';
    correctionRequests.push({
      id: 'correction-1',
      employeeId: 'employee-1',
      requestorUserId: 'user-1',
      reviewerUserId: null,
      timeEntryId: null,
      breakEntryId: null,
      employmentAssignmentId: 'assignment-1',
      targetEmploymentAssignmentId: null,
      type: 'ADD_MISSING_TIME_ENTRY',
      status: 'PENDING',
      reason: 'pending',
      reviewerNote: null,
      requestedValues: {
        startAt: '2026-10-02T12:00',
        endAt: '2026-10-02T13:00',
      },
      currentValues: {},
      requestedAt: fixedNow,
      reviewedAt: null,
      cancelledAt: null,
    });
    await expect(
      service.submitTimesheet('user-1', sheet.id, {
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow('pending correction');
  });

  it('approves segments, locks stable snapshots, and reopens with history', async () => {
    const {
      setNow,
      service,
      policies,
      entries,
      timePeriods,
      timesheetSegments,
      timesheetEvents,
      audits,
    } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        timesheet: { mode: 'REVIEW_REQUIRED', autoLockOnApproval: true },
      },
    });
    timePeriods.push({
      id: 'period-1',
      organizationId: 'org-1',
      startDate: new Date('2026-10-02T00:00:00.000Z'),
      endDate: new Date('2026-10-08T00:00:00.000Z'),
      status: 'OPEN',
      cadence: 'WEEKLY',
      metadata: null,
      openedAt: fixedNow,
      closedAt: null,
      lockedAt: null,
    });
    entries.push({
      id: 'entry-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      clockInAt: new Date('2026-10-03T01:00:00.000Z'),
      clockOutAt: new Date('2026-10-03T05:00:00.000Z'),
      timezone: 'America/Toronto',
      workDate: new Date('2026-10-02T00:00:00.000Z'),
      status: 'CLOSED',
      source: 'LIVE_CLOCK',
      archivedAt: null,
    });
    const sheet = await service.materializeTimesheetForEmployeePeriod(
      'employee-1',
      'period-1',
    );
    // Batch 4A: corrections and submissions happen after the period, never ahead of now.
    setNow(new Date('2026-10-10T12:00:00.000Z'));
    await service.submitTimesheet('user-1', sheet.id, {
      actorUserId: 'user-1',
    });

    await expect(
      service.approveTimesheetSegment(
        'user-1',
        timesheetSegments[0].id,
        undefined,
        { actorUserId: 'user-1' },
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.approveTimesheetSegment(
        'user-2',
        timesheetSegments[0].id,
        'Approved',
        { actorUserId: 'user-2' },
      ),
    ).resolves.toMatchObject({
      status: 'LOCKED',
      lockedByUserId: 'user-2',
      totals: { approvedWorkedMinutes: 240 },
    });
    await expect(
      service.approveTimesheetSegment(
        'user-2',
        timesheetSegments[0].id,
        'Retry',
        { actorUserId: 'user-2' },
      ),
    ).resolves.toMatchObject({ status: 'LOCKED' });

    entries[0].clockOutAt = new Date('2026-10-03T06:00:00.000Z');
    await expect(
      service.approvedPayrollTimeOutputs(sheet.id),
    ).resolves.toMatchObject({
      status: 'LOCKED',
      workDateOutputs: [
        {
          employeeId: 'employee-1',
          employmentAssignmentId: 'assignment-1',
          timePeriodId: 'period-1',
          workDate: '2026-10-02',
          approvedWorkedMinutes: 240,
          grossMinutes: 240,
          paidBreakMinutes: 0,
          unpaidBreakMinutes: 0,
          policyDeductionMinutes: 0,
          finalizationStatus: 'LOCKED',
          timesheetSegmentId: 'timesheet-segment-1',
          timesheetVersion: 1,
        },
      ],
      segments: [{ approvedWorkedMinutes: 240, netWorkedMinutes: 240 }],
    });

    await expect(
      service.reopenTimesheet('user-2', sheet.id, 'Need another look', {
        actorUserId: 'user-2',
      }),
    ).resolves.toMatchObject({
      status: 'OPEN',
      version: 2,
      segments: [
        { status: 'PENDING', approvedWorkedMinutes: 0, netWorkedMinutes: 300 },
      ],
    });
    expect(timesheetEvents.map((event) => event.type)).toEqual([
      'SUBMITTED',
      'SEGMENT_APPROVED',
      // Batch 4C: the timesheet-level approval is its own event.
      'APPROVED',
      'LOCKED',
      'REOPENED',
    ]);
    expect(
      audits.filter((audit) => audit.action === 'TIMESHEET_SEGMENT_APPROVED'),
    ).toHaveLength(1);
    expect(
      audits.filter((audit) => audit.action === 'TIMESHEET_LOCKED'),
    ).toHaveLength(1);
  });

  it('refreshes mutable timesheets after approved corrections', async () => {
    const {
      service,
      policies,
      entries,
      timePeriods,
      timesheetSegments,
      setNow,
    } = makeHarness();
    policies.set('assignment-1', {
      inheritanceMode: 'INHERIT',
      config: {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        correction: {
          employeeRequestsEnabled: true,
          approvalMode: 'ALWAYS_REQUIRE_APPROVAL',
        },
      },
    });
    timePeriods.push({
      id: 'period-1',
      organizationId: 'org-1',
      startDate: new Date('2026-10-02T00:00:00.000Z'),
      endDate: new Date('2026-10-08T00:00:00.000Z'),
      status: 'OPEN',
      cadence: 'WEEKLY',
      metadata: null,
      openedAt: fixedNow,
      closedAt: null,
      lockedAt: null,
    });
    entries.push({
      id: 'entry-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      clockInAt: new Date('2026-10-03T01:00:00.000Z'),
      clockOutAt: new Date('2026-10-03T05:00:00.000Z'),
      timezone: 'America/Toronto',
      workDate: new Date('2026-10-02T00:00:00.000Z'),
      status: 'CLOSED',
      source: 'LIVE_CLOCK',
      archivedAt: null,
    });
    const sheet = await service.materializeTimesheetForEmployeePeriod(
      'employee-1',
      'period-1',
    );
    // Batch 4A: corrections and submissions happen after the period, never ahead of now.
    setNow(new Date('2026-10-10T12:00:00.000Z'));
    await service.submitTimesheet('user-1', sheet.id, {
      actorUserId: 'user-1',
    });

    setNow(new Date('2026-10-03T06:00:00.000Z'));
    await service.requestCorrection(
      'user-1',
      {
        type: 'CHANGE_CLOCK_OUT',
        timeEntryId: 'entry-1',
        clockOutAt: '2026-10-03T02:00',
        reason: 'Worked longer',
      },
      { actorUserId: 'user-1' },
    );
    await service.approveCorrection('user-2', 'correction-1', 'ok', {
      actorUserId: 'user-2',
    });

    expect(timesheetSegments[0]).toMatchObject({
      netWorkedMinutes: 300,
      status: 'PENDING',
      approvedWorkedMinutes: 0,
    });
  });

  it('hides actions when authorization does not allow time.clock', async () => {
    const { service, canAccess } = makeHarness();
    canAccess.mockResolvedValue(false);

    await expect(service.status('user-1')).resolves.toMatchObject({
      state: 'OFF_CLOCK',
      availableActions: [],
      eligibleAssignments: [],
    });
  });
});
