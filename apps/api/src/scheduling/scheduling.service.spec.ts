import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthorizationScope } from '../authorization/authorization.types.js';
import { SchedulingDomainService } from './scheduling-domain.service.js';
import { SchedulingService } from './scheduling.service.js';
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

const context = { actorUserId: 'actor', correlationId: 'corr' };

function scheduleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'schedule-1',
    scopeType: 'DEPARTMENT',
    organizationId: 'org-1',
    organizationalUnitId: null,
    departmentId: 'dept-1',
    teamId: null,
    name: 'Week 41',
    periodStart: new Date('2026-10-05T00:00:00.000Z'),
    periodEnd: new Date('2026-10-11T00:00:00.000Z'),
    type: 'STANDARD',
    status: 'DRAFT',
    publishedAt: null,
    publishedByUserId: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

function shiftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shift-1',
    scheduleId: 'schedule-1',
    employmentAssignmentId: 'assignment-1',
    workLocationId: null,
    workDate: new Date('2026-10-06T00:00:00.000Z'),
    startsAt: new Date('2026-10-06T13:00:00.000Z'),
    endsAt: new Date('2026-10-06T21:00:00.000Z'),
    timezone: 'America/Toronto',
    status: 'ACTIVE',
    sourceType: 'MANUAL',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeService(
  grants: Array<{ permission: string; scope: { type: string; id?: string } }>,
) {
  const tx: any = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    organization: {
      findUnique: vi.fn().mockResolvedValue({ id: 'org-1', archivedAt: null }),
    },
    organizationalUnit: { findUnique: vi.fn() },
    department: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'dept-1',
        organizationId: 'org-1',
        archivedAt: null,
      }),
    },
    team: { findUnique: vi.fn() },
    schedule: {
      findUnique: vi.fn().mockResolvedValue(scheduleRow()),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }) => scheduleRow(data)),
      update: vi.fn(async ({ data }) => scheduleRow(data)),
      delete: vi.fn(),
    },
    scheduledShift: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(shiftRow()),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }) => shiftRow(data)),
      update: vi.fn(async ({ data }) => shiftRow(data)),
      delete: vi.fn(),
    },
    employmentAssignment: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'assignment-1',
        employeeId: 'employee-1',
        status: 'ACTIVE',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: null,
        positionId: 'position-1',
        position: { organizationId: 'org-1' },
      }),
    },
    workLocation: { findUnique: vi.fn() },
    scheduledShiftRevision: {
      findFirst: vi.fn().mockResolvedValue({ revisionNumber: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }) => ({
        id: 'revision-new',
        changedAt: new Date('2026-10-02T00:00:00.000Z'),
        ...data,
      })),
      createMany: vi.fn(async ({ data }) => ({ count: data.length })),
    },
    schedulePolicy: { findMany: vi.fn().mockResolvedValue([]) },
    timeEntry: { findMany: vi.fn().mockResolvedValue([]) },
    attendanceSignIn: { findMany: vi.fn().mockResolvedValue([]) },
    scheduleConflictOverride: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }) => ({ id: 'override-1', ...data })),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) };
  const resolveTarget = vi.fn(async (scope: AuthorizationScope) => ({
    type: scope.type,
    organizationId: scope.organizationId,
    departmentId: scope.type === 'DEPARTMENT' ? scope.id : null,
    teamId: scope.type === 'TEAM' ? scope.id : null,
    unitPathIds: [],
  }));
  const authorization: any = {
    effectiveGrants: vi.fn().mockResolvedValue(grants),
    resolveTarget,
    assertCan: vi.fn(async (_user, permission, scope: AuthorizationScope) => {
      const allowed = grants.some(
        (grant) =>
          grant.permission === permission &&
          (grant.scope.type === 'SYSTEM' || grant.scope.id === scope.id),
      );
      if (!allowed) throw new ForbiddenException();
    }),
  };
  const targets: any = {
    resolvePosition: vi.fn().mockResolvedValue({
      type: 'DEPARTMENT',
      organizationId: 'org-1',
      departmentId: 'dept-1',
      teamId: null,
      unitPathIds: [],
    }),
  };
  const audit: any = { write: vi.fn().mockResolvedValue({}) };
  const service = new SchedulingService(
    prisma,
    new SchedulingDomainService(),
    authorization,
    targets,
    audit,
    undefined,
    allFeaturesEnabled,
  );
  return { service, tx, prisma, authorization, targets, audit };
}

const manageDept = [
  {
    permission: 'schedule.manage',
    scope: { type: 'DEPARTMENT', id: 'dept-1' },
  },
];
const readDept = [
  { permission: 'schedule.read', scope: { type: 'DEPARTMENT', id: 'dept-1' } },
];

const shiftInput = {
  employmentAssignmentId: 'assignment-1',
  workDate: '2026-10-06',
  startsAt: '2026-10-06T09:00:00-04:00',
  endsAt: '2026-10-06T17:00:00-04:00',
  timezone: 'America/Toronto',
};

describe('SchedulingService', () => {
  it('creates a DRAFT schedule authorized against its own scope and audits it', async () => {
    const setup = makeService(manageDept);
    const created = await setup.service.createSchedule(
      {
        scopeType: 'DEPARTMENT',
        organizationId: 'org-1',
        departmentId: 'dept-1',
        name: ' Week 41 ',
        periodStart: '2026-10-05',
        periodEnd: '2026-10-11',
        type: 'STANDARD',
      },
      context,
    );
    expect(setup.authorization.assertCan).toHaveBeenCalledWith(
      'actor',
      'schedule.manage',
      { type: 'DEPARTMENT', id: 'dept-1', organizationId: 'org-1' },
      setup.tx,
    );
    expect(setup.tx.schedule.create.mock.calls[0][0].data).toMatchObject({
      status: 'DRAFT',
      name: 'Week 41',
    });
    expect(setup.tx.schedule.create.mock.calls[0][0].data).not.toHaveProperty(
      'publishedAt',
    );
    expect(created).toMatchObject({ periodStart: '2026-10-05' });
    expect(setup.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SCHEDULE_CREATED',
        entityType: 'Schedule',
        actorUserId: 'actor',
      }),
      setup.tx,
    );
  });

  it('rejects an invalid scope before touching the database', async () => {
    const setup = makeService(manageDept);
    await expect(
      setup.service.createSchedule(
        {
          scopeType: 'TEAM',
          organizationId: 'org-1',
          departmentId: 'dept-1',
          name: 'x',
          periodStart: '2026-10-05',
          periodEnd: '2026-10-11',
          type: 'STANDARD',
        },
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(setup.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('hides schedules outside the read scope and forbids readers from managing', async () => {
    const hidden = makeService([]);
    await expect(
      hidden.service.getSchedule('actor', 'schedule-1'),
    ).rejects.toBeInstanceOf(NotFoundException);

    const reader = makeService(readDept);
    await expect(
      reader.service.getSchedule('actor', 'schedule-1'),
    ).resolves.toMatchObject({ id: 'schedule-1' });
    await expect(
      reader.service.updateSchedule('schedule-1', { name: 'x' }, context),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('locks the schedule row and rejects a period that would exclude shifts', async () => {
    const setup = makeService(manageDept);
    setup.tx.scheduledShift.count.mockResolvedValue(2);
    await expect(
      setup.service.updateSchedule(
        'schedule-1',
        { periodStart: '2026-10-08' },
        context,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(setup.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(setup.tx.scheduledShift.count).toHaveBeenCalledWith({
      where: {
        scheduleId: 'schedule-1',
        OR: [
          { workDate: { lt: new Date('2026-10-08T00:00:00.000Z') } },
          { workDate: { gt: new Date('2026-10-11T00:00:00.000Z') } },
        ],
      },
    });
    expect(setup.tx.schedule.update).not.toHaveBeenCalled();
    expect(setup.audit.write).not.toHaveBeenCalled();
  });

  it('rejects every Batch 2 mutation of a PUBLISHED schedule', async () => {
    const setup = makeService(manageDept);
    setup.tx.schedule.findUnique.mockResolvedValue(
      scheduleRow({
        status: 'PUBLISHED',
        publishedAt: new Date(),
        publishedByUserId: 'publisher',
      }),
    );
    const attempts = [
      () => setup.service.updateSchedule('schedule-1', { name: 'x' }, context),
      () => setup.service.deleteSchedule('schedule-1', context),
      () => setup.service.createShift('schedule-1', shiftInput, context),
      () =>
        setup.service.updateShift(
          'schedule-1',
          'shift-1',
          { timezone: 'UTC' },
          context,
        ),
      () => setup.service.deleteShift('schedule-1', 'shift-1', context),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(ConflictException);
    }
    expect(setup.tx.schedule.update).not.toHaveBeenCalled();
    expect(setup.tx.schedule.delete).not.toHaveBeenCalled();
    expect(setup.tx.scheduledShift.create).not.toHaveBeenCalled();
    expect(setup.tx.scheduledShift.update).not.toHaveBeenCalled();
    expect(setup.tx.scheduledShift.delete).not.toHaveBeenCalled();
    expect(setup.audit.write).not.toHaveBeenCalled();
  });

  it('refuses to delete a draft schedule that still has shifts', async () => {
    const setup = makeService(manageDept);
    setup.tx.scheduledShift.count.mockResolvedValue(3);
    await expect(
      setup.service.deleteSchedule('schedule-1', context),
    ).rejects.toThrow('still has 3 shift(s)');
    expect(setup.tx.schedule.delete).not.toHaveBeenCalled();
  });

  it('creates MANUAL ACTIVE shifts with a resolved timezone', async () => {
    const setup = makeService(manageDept);
    await setup.service.createShift('schedule-1', shiftInput, context);
    expect(setup.tx.scheduledShift.create).toHaveBeenCalledWith({
      data: {
        scheduleId: 'schedule-1',
        employmentAssignmentId: 'assignment-1',
        workLocationId: null,
        workDate: new Date('2026-10-06T00:00:00.000Z'),
        startsAt: new Date('2026-10-06T13:00:00.000Z'),
        endsAt: new Date('2026-10-06T21:00:00.000Z'),
        timezone: 'America/Toronto',
        status: 'ACTIVE',
        sourceType: 'MANUAL',
      },
    });
    expect(setup.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SCHEDULED_SHIFT_CREATED',
        entityType: 'ScheduledShift',
      }),
      setup.tx,
    );
  });

  it('forbids scheduling an assignment outside the actor scope', async () => {
    const setup = makeService(manageDept);
    setup.targets.resolvePosition.mockResolvedValue({
      type: 'DEPARTMENT',
      organizationId: 'org-1',
      departmentId: 'dept-2',
      teamId: null,
      unitPathIds: [],
    });
    await expect(
      setup.service.createShift('schedule-1', shiftInput, context),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(setup.tx.scheduledShift.create).not.toHaveBeenCalled();
  });

  it('reports a shift from another schedule as not found', async () => {
    const setup = makeService(manageDept);
    setup.tx.scheduledShift.findFirst.mockResolvedValue(null);
    await expect(
      setup.service.deleteShift('schedule-1', 'shift-1', context),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(setup.tx.scheduledShift.findFirst).toHaveBeenCalledWith({
      where: { id: 'shift-1', scheduleId: 'schedule-1' },
    });
  });

  it('only manages MANUAL shifts', async () => {
    const setup = makeService(manageDept);
    setup.tx.scheduledShift.findFirst.mockResolvedValue(
      shiftRow({ sourceType: 'PATTERN' }),
    );
    await expect(
      setup.service.deleteShift('schedule-1', 'shift-1', context),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('audits only the fields that changed on shift update', async () => {
    const setup = makeService(manageDept);
    await setup.service.updateShift(
      'schedule-1',
      'shift-1',
      { endsAt: '2026-10-06T18:00:00-04:00' },
      context,
    );
    expect(setup.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SCHEDULED_SHIFT_UPDATED',
        metadata: {
          scheduleId: 'schedule-1',
          changes: {
            endsAt: {
              from: '2026-10-06T21:00:00.000Z',
              to: '2026-10-06T22:00:00.000Z',
            },
          },
        },
      }),
      setup.tx,
    );
  });

  it('returns an empty list without scanning when the actor has no schedule grants', async () => {
    const setup = makeService([
      { permission: 'time.view', scope: { type: 'SYSTEM' } },
    ]);
    setup.authorization.effectiveGrants.mockResolvedValue([
      { permission: 'time.view', scope: { type: 'SYSTEM' } },
    ]);
    await expect(setup.service.listSchedules('actor')).resolves.toEqual({
      items: [],
      nextAfterId: null,
    });
    expect(setup.tx.schedule.findMany).not.toHaveBeenCalled();
  });

  describe('conflicts', () => {
    const deptTarget = (departmentId: string) => ({
      type: 'DEPARTMENT',
      organizationId: 'org-1',
      departmentId,
      teamId: null,
      unitPathIds: [],
    });
    const overlapping = (overrides: Record<string, unknown> = {}) => ({
      id: 'other-shift',
      scheduleId: 'schedule-2',
      employmentAssignmentId: 'assignment-2',
      workDate: new Date('2026-10-06T00:00:00.000Z'),
      startsAt: new Date('2026-10-06T16:00:00.000Z'),
      endsAt: new Date('2026-10-06T22:00:00.000Z'),
      status: 'ACTIVE',
      employmentAssignment: {
        employeeId: 'employee-1',
        positionId: 'position-2',
      },
      ...overrides,
    });
    const grant = (permission: string, id = 'dept-1') => ({
      permission,
      scope: { type: 'DEPARTMENT', id },
    });
    const fullDept1 = [
      grant('schedule.manage'),
      grant('schedule.override_conflict'),
    ];
    const fullBoth = [
      ...fullDept1,
      grant('schedule.manage', 'dept-2'),
      grant('schedule.override_conflict', 'dept-2'),
    ];

    function conflictSetup(
      grants: Array<{
        permission: string;
        scope: { type: string; id?: string };
      }>,
      existing: Array<Record<string, unknown>>,
    ) {
      const setup = makeService(grants);
      setup.tx.scheduledShift.findMany.mockResolvedValue(existing);
      setup.targets.resolvePosition.mockImplementation(
        async (positionId: string) =>
          deptTarget(positionId === 'position-2' ? 'dept-2' : 'dept-1'),
      );
      return setup;
    }

    async function caught(promise: Promise<unknown>) {
      return promise.then(
        () => {
          throw new Error('expected rejection');
        },
        (error: unknown) => error,
      );
    }

    it('locks the Employee after the Schedule and queries ACTIVE overlaps across every Schedule', async () => {
      const setup = conflictSetup(manageDept, []);
      await setup.service.createShift('schedule-1', shiftInput, context);
      const locks = setup.tx.$queryRaw.mock.calls.map(([sql]: any) =>
        sql.strings.join('?'),
      );
      expect(locks[0]).toContain('FROM "Schedule"');
      expect(locks[1]).toContain('FROM "Employee"');
      expect(locks[1]).toContain('FOR NO KEY UPDATE');
      expect(setup.tx.$queryRaw.mock.calls[1][0].values).toEqual([
        'employee-1',
      ]);
      const [{ where }] = setup.tx.scheduledShift.findMany.mock.calls.at(-1);
      expect(where).toEqual({
        status: 'ACTIVE',
        startsAt: { lt: new Date('2026-10-06T21:00:00.000Z') },
        endsAt: { gt: new Date('2026-10-06T13:00:00.000Z') },
        employmentAssignment: { employeeId: 'employee-1' },
      });
      expect(where).not.toHaveProperty('scheduleId');
    });

    it('rejects a same-assignment overlap with a structured, non-overrideable 409', async () => {
      const setup = conflictSetup(fullBoth, [
        overlapping({
          employmentAssignmentId: 'assignment-1',
          employmentAssignment: {
            employeeId: 'employee-1',
            positionId: 'position-1',
          },
        }),
      ]);
      const error: any = await caught(
        setup.service.createShift('schedule-1', shiftInput, context),
      );
      expect(error).toBeInstanceOf(ConflictException);
      const body = error.getResponse();
      expect(body).toMatchObject({
        statusCode: 409,
        code: 'SCHEDULE_CONFLICT_ERROR',
        conflicts: [
          {
            type: 'SAME_ASSIGNMENT_OVERLAP',
            severity: 'ERROR',
            overrideAllowed: false,
            conflictingShift: { id: 'other-shift' },
          },
        ],
      });

      // Even a fully privileged actor cannot override the hard error.
      const retry: any = await caught(
        setup.service.createShift(
          'schedule-1',
          {
            ...shiftInput,
            conflictOverrides: [
              {
                conflictType: 'SAME_ASSIGNMENT_OVERLAP',
                conflictKey: body.conflicts[0].key,
                reason: 'Please',
              },
            ],
          },
          context,
        ),
      );
      expect(retry.getResponse().code).toBe('SCHEDULE_CONFLICT_ERROR');
      expect(setup.tx.scheduledShift.create).not.toHaveBeenCalled();
      expect(setup.tx.scheduleConflictOverride.create).not.toHaveBeenCalled();
    });

    it('requires an explicit override for an employee-wide overlap and records an accepted one', async () => {
      const setup = conflictSetup(fullBoth, [overlapping()]);
      const error: any = await caught(
        setup.service.createShift('schedule-1', shiftInput, context),
      );
      const body = error.getResponse();
      expect(body).toMatchObject({
        code: 'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED',
        conflicts: [
          {
            type: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
            severity: 'WARNING',
            overrideAllowed: true,
            overridden: false,
            employeeId: 'employee-1',
          },
        ],
      });
      expect(setup.tx.scheduledShift.create).not.toHaveBeenCalled();

      await setup.service.createShift(
        'schedule-1',
        {
          ...shiftInput,
          conflictOverrides: [
            {
              conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
              conflictKey: body.conflicts[0].key,
              reason: '  Approved double booking  ',
            },
          ],
        },
        context,
      );
      expect(setup.tx.scheduleConflictOverride.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          conflictingShiftId: 'other-shift',
          conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
          conflictKey: body.conflicts[0].key,
          reason: 'Approved double booking',
          overriddenByUserId: 'actor',
        }),
      });
      expect(setup.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SCHEDULE_CONFLICT_OVERRIDDEN',
          entityType: 'ScheduledShift',
          metadata: expect.objectContaining({
            overrideId: 'override-1',
            conflictingShiftId: 'other-shift',
            reason: 'Approved double booking',
          }),
        }),
        setup.tx,
      );
    });

    it('requires schedule.override_conflict in addition to schedule.manage', async () => {
      const setup = conflictSetup(
        [
          grant('schedule.manage'),
          grant('schedule.manage', 'dept-2'),
          grant('schedule.override_conflict', 'dept-2'),
        ],
        [overlapping()],
      );
      const key = (
        (await caught(
          setup.service.createShift('schedule-1', shiftInput, context),
        )) as any
      ).getResponse().conflicts[0].key;
      await expect(
        setup.service.createShift(
          'schedule-1',
          {
            ...shiftInput,
            conflictOverrides: [
              {
                conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
                conflictKey: key,
                reason: 'Approved',
              },
            ],
          },
          context,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(setup.tx.scheduledShift.create).not.toHaveBeenCalled();
    });

    it.each([
      ['override only', [grant('schedule.override_conflict', 'dept-2')]],
      ['manage only', [grant('schedule.manage', 'dept-2')]],
      ['nothing', []],
    ])(
      'requires manage and override over the conflicting assignment scope (%s)',
      async (_label, conflictingGrants) => {
        const setup = conflictSetup(
          [...fullDept1, ...conflictingGrants],
          [overlapping()],
        );
        const key = (
          (await caught(
            setup.service.createShift('schedule-1', shiftInput, context),
          )) as any
        ).getResponse().conflicts[0].key;
        await expect(
          setup.service.createShift(
            'schedule-1',
            {
              ...shiftInput,
              conflictOverrides: [
                {
                  conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
                  conflictKey: key,
                  reason: 'Approved',
                },
              ],
            },
            context,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(setup.tx.scheduledShift.create).not.toHaveBeenCalled();
        expect(setup.audit.write).not.toHaveBeenCalled();
      },
    );

    it('rejects invented or mismatched conflict keys as stale', async () => {
      const setup = conflictSetup(fullBoth, [overlapping()]);
      const key = (
        (await caught(
          setup.service.createShift('schedule-1', shiftInput, context),
        )) as any
      ).getResponse().conflicts[0].key;
      for (const override of [
        {
          conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
          conflictKey: 'f'.repeat(64),
        },
        { conflictType: 'SAME_ASSIGNMENT_OVERLAP', conflictKey: key },
      ] as const) {
        const error: any = await caught(
          setup.service.createShift(
            'schedule-1',
            {
              ...shiftInput,
              conflictOverrides: [{ ...override, reason: 'Approved' }],
            },
            context,
          ),
        );
        expect(error.getResponse().code).toBe(
          'SCHEDULE_CONFLICT_OVERRIDE_STALE',
        );
      }
      expect(setup.tx.scheduledShift.create).not.toHaveBeenCalled();
    });

    it('rejects blank reasons and duplicate overrides', async () => {
      const setup = conflictSetup(fullBoth, []);
      const override = {
        conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP' as const,
        conflictKey: 'a'.repeat(64),
        reason: 'Approved',
      };
      await expect(
        setup.service.createShift(
          'schedule-1',
          {
            ...shiftInput,
            conflictOverrides: [{ ...override, reason: '   ' }],
          },
          context,
        ),
      ).rejects.toThrow('A reason is required');
      await expect(
        setup.service.createShift(
          'schedule-1',
          { ...shiftInput, conflictOverrides: [override, override] },
          context,
        ),
      ).rejects.toThrow('only once per request');
      expect(setup.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('honors a persisted override only for the same conflict state on update', async () => {
      const setup = conflictSetup(fullBoth, [overlapping()]);
      setup.tx.scheduleConflictOverride.findMany.mockResolvedValue([
        { id: 'override-9', conflictKey: 'placeholder' },
      ]);
      // The stored key does not match the recomputed state, so the warning is unresolved.
      const error: any = await caught(
        setup.service.updateShift(
          'schedule-1',
          'shift-1',
          { endsAt: '2026-10-06T18:00:00-04:00' },
          context,
        ),
      );
      expect(error.getResponse().code).toBe(
        'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED',
      );
      const [{ where }] =
        setup.tx.scheduleConflictOverride.findMany.mock.calls[0];
      expect(where.OR).toEqual([
        expect.objectContaining({
          scheduledShiftId: 'shift-1',
          conflictingShiftId: 'other-shift',
        }),
        expect.objectContaining({
          scheduledShiftId: 'other-shift',
          conflictingShiftId: 'shift-1',
        }),
      ]);

      setup.tx.scheduleConflictOverride.findMany.mockResolvedValue([
        { id: 'override-9', conflictKey: where.OR[0].conflictKey },
      ]);
      await setup.service.updateShift(
        'schedule-1',
        'shift-1',
        { endsAt: '2026-10-06T18:00:00-04:00' },
        context,
      );
      expect(setup.tx.scheduledShift.update).toHaveBeenCalled();
      expect(setup.tx.scheduleConflictOverride.create).not.toHaveBeenCalled();
    });

    it('does not record a resubmitted override for an already approved conflict state', async () => {
      const setup = conflictSetup(fullBoth, [overlapping()]);
      setup.tx.scheduleConflictOverride.findMany.mockImplementation(
        async ({ where }: any) => [
          { id: 'override-9', conflictKey: where.OR[0].conflictKey },
        ],
      );
      const preview = await setup.service.previewShiftConflicts(
        'actor',
        'schedule-1',
        'shift-1',
        { endsAt: '2026-10-06T18:00:00-04:00' },
      );
      expect(preview.conflicts[0]).toMatchObject({
        overridden: true,
        overrideId: 'override-9',
      });
      await setup.service.updateShift(
        'schedule-1',
        'shift-1',
        {
          endsAt: '2026-10-06T18:00:00-04:00',
          conflictOverrides: [
            {
              conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
              conflictKey: preview.conflicts[0]!.key,
              reason: 'Again',
            },
          ],
        },
        context,
      );
      expect(setup.tx.scheduledShift.update).toHaveBeenCalled();
      expect(setup.tx.scheduleConflictOverride.create).not.toHaveBeenCalled();
      expect(setup.audit.write).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SCHEDULE_CONFLICT_OVERRIDDEN' }),
        expect.anything(),
      );
    });

    it('rejects overrides on an update that changes nothing', async () => {
      const setup = conflictSetup(fullBoth, []);
      await expect(
        setup.service.updateShift(
          'schedule-1',
          'shift-1',
          {
            conflictOverrides: [
              {
                conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
                conflictKey: 'a'.repeat(64),
                reason: 'Approved',
              },
            ],
          },
          context,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('previews conflicts read-only and hides details of contexts the actor cannot see', async () => {
      const setup = conflictSetup(manageDept, [overlapping()]);
      const preview = await setup.service.previewShiftConflicts(
        'actor',
        'schedule-1',
        null,
        shiftInput,
      );
      expect(preview).toMatchObject({
        valid: false,
        overrideRequired: true,
        conflicts: [
          {
            type: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
            conflictingShift: {
              id: 'other-shift',
              scheduleId: null,
              employmentAssignmentId: null,
              startsAt: '2026-10-06T16:00:00.000Z',
            },
          },
        ],
      });
      expect(setup.prisma.$transaction).not.toHaveBeenCalled();
      expect(setup.tx.scheduledShift.create).not.toHaveBeenCalled();

      const visible = conflictSetup(fullBoth, [overlapping()]);
      const shown = await visible.service.previewShiftConflicts(
        'actor',
        'schedule-1',
        null,
        shiftInput,
      );
      expect(shown.conflicts[0]!.conflictingShift).toMatchObject({
        scheduleId: 'schedule-2',
        employmentAssignmentId: 'assignment-2',
      });
    });

    it("deletes a draft shift's own overrides with the shift", async () => {
      const setup = conflictSetup(manageDept, []);
      setup.tx.scheduleConflictOverride.deleteMany.mockResolvedValue({
        count: 2,
      });
      await setup.service.deleteShift('schedule-1', 'shift-1', context);
      expect(setup.tx.scheduleConflictOverride.deleteMany).toHaveBeenCalledWith(
        {
          where: { scheduledShiftId: 'shift-1' },
        },
      );
      expect(setup.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SCHEDULED_SHIFT_DELETED',
          metadata: expect.objectContaining({ removedConflictOverrides: 2 }),
        }),
        setup.tx,
      );
    });
  });

  describe('publication and published changes', () => {
    const publishDept = [
      ...manageDept,
      {
        permission: 'schedule.publish',
        scope: { type: 'DEPARTMENT', id: 'dept-1' },
      },
    ];
    const published = scheduleRow({
      status: 'PUBLISHED',
      publishedAt: new Date('2026-10-02T00:00:00.000Z'),
      publishedByUserId: 'publisher',
    });

    function publishedSetup(grants = publishDept) {
      const setup = makeService(grants);
      setup.tx.schedule.findUnique.mockResolvedValue(published);
      return setup;
    }

    it('publishes a DRAFT schedule with one baseline revision per shift', async () => {
      const setup = makeService(publishDept);
      setup.tx.scheduledShift.findMany
        .mockResolvedValueOnce([
          shiftRow(),
          shiftRow({
            id: 'shift-2',
            startsAt: new Date('2026-10-07T13:00:00.000Z'),
            endsAt: new Date('2026-10-07T21:00:00.000Z'),
            workDate: new Date('2026-10-07T00:00:00.000Z'),
          }),
        ])
        .mockResolvedValue([]);
      const result = await setup.service.publishSchedule('schedule-1', context);

      expect(setup.tx.$queryRaw.mock.calls[0][0].strings.join('?')).toContain(
        'FOR UPDATE',
      );
      const update = setup.tx.schedule.update.mock.calls[0][0];
      expect(update.data).toMatchObject({
        status: 'PUBLISHED',
        publishedByUserId: 'actor',
        publishedAt: expect.any(Date),
      });
      const baselines = setup.tx.scheduledShiftRevision.createMany.mock
        .calls[0][0].data as Array<Record<string, unknown>>;
      expect(baselines).toHaveLength(2);
      expect(baselines[0]).toMatchObject({
        scheduledShiftId: 'shift-1',
        revisionNumber: 1,
        revisionType: 'PUBLISHED_BASELINE',
        reason: null,
        changedByUserId: 'actor',
        changedAt: update.data.publishedAt,
        status: 'ACTIVE',
        sourceType: 'MANUAL',
        timezone: 'America/Toronto',
      });
      expect(result).toMatchObject({ status: 'PUBLISHED' });
      expect(setup.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SCHEDULE_PUBLISHED',
          metadata: expect.objectContaining({
            shiftCount: 2,
            baselineRevisionCount: 2,
          }),
        }),
        setup.tx,
      );
    });

    it('requires schedule.publish in addition to schedule.manage', async () => {
      const setup = makeService(manageDept);
      setup.tx.scheduledShift.findMany.mockResolvedValue([shiftRow()]);
      await expect(
        setup.service.publishSchedule('schedule-1', context),
      ).rejects.toThrow('schedule.publish');
      const publishOnly = makeService([
        ...readDept,
        {
          permission: 'schedule.publish',
          scope: { type: 'DEPARTMENT', id: 'dept-1' },
        },
      ]);
      await expect(
        publishOnly.service.publishSchedule('schedule-1', context),
      ).rejects.toThrow('schedule.manage');
      for (const { tx } of [setup, publishOnly]) {
        expect(tx.schedule.update).not.toHaveBeenCalled();
        expect(tx.scheduledShiftRevision.createMany).not.toHaveBeenCalled();
      }
    });

    it('rejects publishing an empty or already published schedule', async () => {
      const empty = makeService(publishDept);
      const error = await empty.service
        .publishSchedule('schedule-1', context)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'SCHEDULE_PUBLICATION_EMPTY',
      });
      const again = publishedSetup();
      await expect(
        again.service.publishSchedule('schedule-1', context),
      ).rejects.toThrow('Only DRAFT schedules can be published.');
      for (const { tx } of [empty, again]) {
        expect(tx.schedule.update).not.toHaveBeenCalled();
        expect(tx.scheduledShiftRevision.createMany).not.toHaveBeenCalled();
      }
    });

    it('reports every shift that is no longer valid instead of fixing it', async () => {
      const setup = makeService(publishDept);
      setup.tx.scheduledShift.findMany.mockResolvedValueOnce([
        shiftRow(),
        shiftRow({ id: 'shift-2', workLocationId: 'location-1' }),
        shiftRow({ id: 'shift-3', status: 'CANCELLED' }),
      ]);
      setup.tx.employmentAssignment.findUnique.mockResolvedValueOnce({
        id: 'assignment-1',
        employeeId: 'employee-1',
        status: 'ENDED',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: new Date('2026-10-01T00:00:00.000Z'),
        positionId: 'position-1',
        position: { organizationId: 'org-1' },
      });
      setup.tx.workLocation.findUnique.mockResolvedValue({
        id: 'location-1',
        organizationId: 'org-1',
        archivedAt: null,
        timezone: 'America/Vancouver',
      });
      const error = await setup.service
        .publishSchedule('schedule-1', context)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as {
        code: string;
        invalidShifts: Array<{ shiftId: string; message: string }>;
      };
      expect(body.code).toBe('SCHEDULE_PUBLICATION_INVALID');
      expect(body.invalidShifts.map((row) => row.shiftId)).toEqual([
        'shift-1',
        'shift-2',
        'shift-3',
      ]);
      expect(setup.tx.schedule.update).not.toHaveBeenCalled();
      expect(setup.tx.scheduledShift.update).not.toHaveBeenCalled();
    });

    it('requires a reason for every published change', async () => {
      const setup = publishedSetup();
      await expect(
        setup.service.correctShift(
          'schedule-1',
          'shift-1',
          { reason: '   ', endsAt: '2026-10-06T18:00:00-04:00' },
          context,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        setup.service.cancelShift(
          'schedule-1',
          'shift-1',
          { reason: '' },
          context,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        setup.service.addPublishedShift(
          'schedule-1',
          { ...shiftInput, reason: ' ' },
          context,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(setup.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts published changes only on PUBLISHED schedules with schedule.publish', async () => {
      const draft = makeService(publishDept);
      const managerOnly = publishedSetup(manageDept);
      for (const { service, tx } of [draft, managerOnly]) {
        await expect(
          service.correctShift(
            'schedule-1',
            'shift-1',
            { reason: 'Fix', endsAt: '2026-10-06T18:00:00-04:00' },
            context,
          ),
        ).rejects.toThrow();
        await expect(
          service.cancelShift(
            'schedule-1',
            'shift-1',
            { reason: 'x' },
            context,
          ),
        ).rejects.toThrow();
        await expect(
          service.addPublishedShift(
            'schedule-1',
            { ...shiftInput, reason: 'Cover' },
            context,
          ),
        ).rejects.toThrow();
        expect(tx.scheduledShift.update).not.toHaveBeenCalled();
        expect(tx.scheduledShift.create).not.toHaveBeenCalled();
        expect(tx.scheduledShiftRevision.create).not.toHaveBeenCalled();
      }
    });

    it('corrects a published shift and appends the next full-snapshot revision', async () => {
      const setup = publishedSetup();
      setup.tx.scheduledShiftRevision.findFirst.mockResolvedValue({
        revisionNumber: 2,
      });
      const result = await setup.service.correctShift(
        'schedule-1',
        'shift-1',
        { reason: ' Late finish ', endsAt: '2026-10-06T18:00:00-04:00' },
        context,
      );
      const locks = setup.tx.$queryRaw.mock.calls.map((call: any) =>
        call[0].strings.join('?'),
      );
      expect(locks[0]).toContain('"Schedule"');
      expect(locks[0]).toContain('FOR SHARE');
      expect(locks[1]).toContain('"ScheduledShift"');
      expect(locks[1]).toContain('FOR NO KEY UPDATE');
      expect(locks[2]).toContain('"Employee"');
      expect(setup.tx.scheduledShiftRevision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scheduledShiftId: 'shift-1',
          revisionNumber: 3,
          revisionType: 'CORRECTED',
          reason: 'Late finish',
          endsAt: new Date('2026-10-06T22:00:00.000Z'),
          startsAt: new Date('2026-10-06T13:00:00.000Z'),
          employmentAssignmentId: 'assignment-1',
          status: 'ACTIVE',
          changedByUserId: 'actor',
        }),
      });
      expect(result.revision).toMatchObject({
        revisionNumber: 3,
        revisionType: 'CORRECTED',
      });
      expect(setup.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SCHEDULED_SHIFT_CORRECTED',
          metadata: expect.objectContaining({
            reason: 'Late finish',
            revisionNumber: 3,
            changes: {
              endsAt: {
                from: '2026-10-06T21:00:00.000Z',
                to: '2026-10-06T22:00:00.000Z',
              },
            },
          }),
        }),
        setup.tx,
      );
    });

    it('rejects a no-op correction and a correction of a CANCELLED shift', async () => {
      const setup = publishedSetup();
      await expect(
        setup.service.correctShift(
          'schedule-1',
          'shift-1',
          { reason: 'Nothing' },
          context,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      setup.tx.scheduledShift.findFirst.mockResolvedValue(
        shiftRow({ status: 'CANCELLED' }),
      );
      await expect(
        setup.service.correctShift(
          'schedule-1',
          'shift-1',
          { reason: 'Restore', endsAt: '2026-10-06T18:00:00-04:00' },
          context,
        ),
      ).rejects.toThrow('CANCELLED shift is final');
      expect(setup.tx.scheduledShift.update).not.toHaveBeenCalled();
      expect(setup.tx.scheduledShiftRevision.create).not.toHaveBeenCalled();
    });

    it('refuses to extend history of a published shift without a baseline', async () => {
      const setup = publishedSetup();
      setup.tx.scheduledShiftRevision.findFirst.mockResolvedValue(null);
      await expect(
        setup.service.cancelShift(
          'schedule-1',
          'shift-1',
          { reason: 'Closed' },
          context,
        ),
      ).rejects.toThrow('no baseline revision');
      expect(setup.tx.scheduledShiftRevision.create).not.toHaveBeenCalled();
    });

    it('cancels once and treats a repeated cancellation as idempotent', async () => {
      const setup = publishedSetup();
      const first = await setup.service.cancelShift(
        'schedule-1',
        'shift-1',
        { reason: 'Store closed' },
        context,
      );
      expect(setup.tx.scheduledShift.update).toHaveBeenCalledWith({
        where: { id: 'shift-1' },
        data: { status: 'CANCELLED' },
      });
      expect(first.revision).toMatchObject({
        revisionType: 'CANCELLED',
        revisionNumber: 2,
        status: 'CANCELLED',
        reason: 'Store closed',
      });
      expect(setup.tx.scheduledShift.delete).not.toHaveBeenCalled();

      setup.tx.scheduledShift.findFirst.mockResolvedValue(
        shiftRow({ status: 'CANCELLED' }),
      );
      setup.tx.scheduledShiftRevision.findFirst.mockResolvedValue({
        ...shiftRow({ status: 'CANCELLED' }),
        id: 'revision-cancel',
        scheduledShiftId: 'shift-1',
        revisionNumber: 2,
        revisionType: 'CANCELLED',
        reason: 'Store closed',
        changedByUserId: 'actor',
        changedAt: new Date('2026-10-02T00:00:00.000Z'),
      });
      await setup.service.cancelShift(
        'schedule-1',
        'shift-1',
        { reason: 'Again' },
        context,
      );
      expect(setup.tx.scheduledShift.update).toHaveBeenCalledTimes(1);
      expect(setup.tx.scheduledShiftRevision.create).toHaveBeenCalledTimes(1);
      expect(
        setup.audit.write.mock.calls.filter(
          ([entry]: any) => entry.action === 'SCHEDULED_SHIFT_CANCELLED',
        ),
      ).toHaveLength(1);
    });

    it('adds a published shift with a reasoned baseline revision', async () => {
      const setup = publishedSetup();
      setup.tx.scheduledShiftRevision.findFirst.mockResolvedValue(null);
      const result = await setup.service.addPublishedShift(
        'schedule-1',
        { ...shiftInput, reason: 'Extra coverage' },
        context,
      );
      expect(
        setup.tx.scheduledShift.create.mock.calls[0][0].data,
      ).toMatchObject({ status: 'ACTIVE', sourceType: 'MANUAL' });
      expect(result.revision).toMatchObject({
        revisionNumber: 1,
        revisionType: 'PUBLISHED_BASELINE',
        reason: 'Extra coverage',
      });
      expect(setup.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SCHEDULED_SHIFT_ADDED' }),
        setup.tx,
      );
    });

    it('lists revisions in order for readers and hides them outside scope', async () => {
      const reader = makeService(readDept);
      await reader.service.listShiftRevisions('actor', 'schedule-1', 'shift-1');
      expect(
        reader.prisma.scheduledShiftRevision.findMany,
      ).toHaveBeenCalledWith({
        where: { scheduledShiftId: 'shift-1' },
        orderBy: { revisionNumber: 'asc' },
      });
      const outsider = makeService([
        {
          permission: 'schedule.read',
          scope: { type: 'DEPARTMENT', id: 'dept-2' },
        },
      ]);
      await expect(
        outsider.service.listShiftRevisions('actor', 'schedule-1', 'shift-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
