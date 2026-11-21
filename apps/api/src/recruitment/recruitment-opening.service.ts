import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { requireActor } from '../common/domain-support.js';
import {
  formatRateAmount,
  parseCurrency,
  parseRateAmount,
} from '../compensation/compensation-domain.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  CompensationPayBasis,
  EmploymentType,
  JobOpening,
  JobOpeningStatus,
  Prisma,
} from '../generated/prisma/client.js';
import {
  RecruitmentAccessService,
  type OpeningAccess,
} from './recruitment-access.service.js';
import {
  conflict,
  isoDate,
  isUniqueViolation,
  lockOpening,
  optionalDate,
  personDisplayName,
  RecruitmentClock,
  recruitmentToday,
  writeRecruitmentAudit,
  type RecruitmentClient,
  type RecruitmentRequestContext,
} from './recruitment-common.js';
import {
  canMoveOpening,
  invalid,
  openingAfterCountChange,
  parseRecruitmentCode,
  parseText,
} from './recruitment-domain.js';
import { RecruitmentStageService } from './recruitment-stage.service.js';

export interface OpeningInput {
  organizationId: string;
  code: string;
  title: string;
  description?: string | null;
  positionId?: string | null;
  organizationalUnitId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  workLocationId?: string | null;
  hiringManagerEmployeeId?: string | null;
  recruiterUserId?: string | null;
  employmentType: EmploymentType;
  openingCount?: number;
  expectedStartDate?: string | null;
  postedOn?: string | null;
  closesOn?: string | null;
  compensation?: {
    payBasis: CompensationPayBasis;
    min?: string | null;
    max?: string | null;
    currency: string;
  } | null;
}

export type OpeningUpdate = Partial<
  Omit<OpeningInput, 'organizationId' | 'code'>
>;

export const OPENING_INCLUDE = {
  position: { select: { id: true, name: true, code: true } },
  organizationalUnit: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
  workLocation: { select: { id: true, name: true } },
  hiringManager: {
    select: {
      id: true,
      person: {
        select: { firstName: true, lastName: true, preferredName: true },
      },
    },
  },
  organization: { select: { id: true, name: true, timezone: true } },
} as const;

type OpeningRow = Prisma.JobOpeningGetPayload<{
  include: typeof OPENING_INCLUDE;
}>;

export function openingShape(row: OpeningRow, access?: OpeningAccess) {
  return {
    id: row.id,
    organization: { id: row.organization.id, name: row.organization.name },
    code: row.code,
    title: row.title,
    description: row.description,
    status: row.status,
    statusReason: row.statusReason,
    employmentType: row.employmentType,
    openingCount: row.openingCount,
    hiredCount: row.hiredCount,
    position: row.position,
    organizationalUnit: row.organizationalUnit,
    department: row.department,
    team: row.team,
    workLocation: row.workLocation,
    hiringManager: row.hiringManager
      ? {
          id: row.hiringManager.id,
          displayName: personDisplayName(row.hiringManager.person),
        }
      : null,
    recruiterUserId: row.recruiterUserId,
    expectedStartDate: isoDate(row.expectedStartDate),
    postedOn: isoDate(row.postedOn),
    closesOn: isoDate(row.closesOn),
    compensation:
      row.compensationPayBasis && row.compensationCurrency
        ? {
            payBasis: row.compensationPayBasis,
            min: row.compensationMin
              ? formatRateAmount(row.compensationMin)
              : null,
            max: row.compensationMax
              ? formatRateAmount(row.compensationMax)
              : null,
            currency: row.compensationCurrency,
          }
        : null,
    openedAt: row.openedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(access
      ? {
          actions: {
            canManage: access.canManage,
            canApproveOffers: access.canApproveOffers,
            canHire: access.canHire,
            isHiringManager: access.isHiringManager,
          },
        }
      : {}),
  };
}

const TRANSITION_ACTIONS: Record<
  'open' | 'hold' | 'resume' | 'close' | 'cancel',
  { to: JobOpeningStatus; action: string }
> = {
  open: { to: 'OPEN', action: 'JOB_OPENING_OPENED' },
  hold: { to: 'ON_HOLD', action: 'JOB_OPENING_PUT_ON_HOLD' },
  resume: { to: 'OPEN', action: 'JOB_OPENING_RESUMED' },
  close: { to: 'CLOSED', action: 'JOB_OPENING_CLOSED' },
  cancel: { to: 'CANCELLED', action: 'JOB_OPENING_CANCELLED' },
};

/** Phase 19: most openings one list request returns. */
export const OPENING_LIST_LIMIT = 500;

/**
 * Phase 13 — job openings / requisitions. An opening's placement is its authorization target
 * (recruitment.manage there creates and changes it). Field changes and status changes are kept
 * as JobOpeningEvents; closed and cancelled openings are frozen; the hire count is maintained
 * only by hire conversion.
 */
@Injectable()
export class RecruitmentOpeningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RecruitmentAccessService,
    private readonly audit: AuditService,
    private readonly clock: RecruitmentClock,
    private readonly stages: RecruitmentStageService,
  ) {}

  async list(
    userId: string,
    organizationId: string,
    filters: { status?: JobOpeningStatus; search?: string } = {},
  ) {
    const { items } = await this.access.visibleOpenings(userId, organizationId);
    const search = filters.search?.trim().toLowerCase();
    const ids = items
      .filter(
        ({ opening }) => !filters.status || opening.status === filters.status,
      )
      .filter(
        ({ opening }) =>
          !search ||
          opening.title.toLowerCase().includes(search) ||
          opening.code.toLowerCase().includes(search),
      )
      .map(({ opening }) => opening.id);
    const accessById = new Map(
      items.map(({ opening, access }) => [opening.id, access]),
    );
    const all = await this.prisma.jobOpening.findMany({
      where: { id: { in: ids } },
      include: OPENING_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      // Phase 19: a hard safety cap (newest first); `truncated` tells the UI.
      take: OPENING_LIST_LIMIT + 1,
    });
    const rows = all.slice(0, OPENING_LIST_LIMIT);
    const counts = await this.prisma.recruitmentApplication.groupBy({
      by: ['openingId', 'status'],
      where: { openingId: { in: rows.map((row) => row.id) } },
      _count: { _all: true },
    });
    return {
      items: rows.map((row) => ({
        ...openingShape(row, accessById.get(row.id)),
        applications: Object.fromEntries(
          counts
            .filter((count) => count.openingId === row.id)
            .map((count) => [count.status, count._count._all]),
        ),
      })),
      truncated: all.length > OPENING_LIST_LIMIT,
    };
  }

  async detail(userId: string, openingId: string) {
    const { access } = await this.access.requireOpening(
      userId,
      openingId,
      'read',
    );
    const row = await this.prisma.jobOpening.findUniqueOrThrow({
      where: { id: openingId },
      include: OPENING_INCLUDE,
    });
    const events = access.canRead
      ? await this.prisma.jobOpeningEvent.findMany({
          where: { openingId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    return {
      ...openingShape(row, access),
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        changedFields: event.changedFields,
        reason: event.reason,
        actorUserId: event.actorUserId,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  async create(input: OpeningInput, context: RecruitmentRequestContext) {
    const actor = requireActor(context);
    // Batch 7A (Q4/D4): some recruitment.manage reach into the organization before its
    // records are validated, so placement and hiring-manager ids cannot be probed.
    await this.access.requireAnyInOrganization(
      actor,
      'recruitment.manage',
      input.organizationId,
    );
    const code = parseRecruitmentCode(input.code, 'requisition code');
    const values = await this.values(
      this.prisma,
      input.organizationId,
      input,
      null,
    );
    const target = await this.access.openingTarget(this.prisma, {
      id: 'new',
      organizationId: input.organizationId,
      ...values.placement,
      hiringManagerEmployeeId: null,
    });
    const grants = await this.access.grants(actor);
    if (!this.access.can(grants, 'recruitment.manage', target)) {
      throw new ForbiddenException(
        'Missing permission recruitment.manage for the opening placement.',
      );
    }
    await this.access.requireEnabled(input.organizationId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (
          await tx.jobOpening.findUnique({
            where: {
              organizationId_code: {
                organizationId: input.organizationId,
                code,
              },
            },
            select: { id: true },
          })
        ) {
          throw conflict(
            'RECRUITMENT_OPENING_EXISTS',
            `An opening with requisition code ${code} already exists.`,
          );
        }
        await this.stages.ensureDefaults(tx, input.organizationId, actor);
        const row = await tx.jobOpening.create({
          data: {
            ...(values.data as Omit<
              Prisma.JobOpeningUncheckedCreateInput,
              'organizationId' | 'code' | 'employmentType'
            >),
            ...values.placement,
            organizationId: input.organizationId,
            code,
            employmentType: input.employmentType,
            openingCount: values.openingCount ?? 1,
            createdByUserId: actor,
          } as Prisma.JobOpeningUncheckedCreateInput,
          include: OPENING_INCLUDE,
        });
        await tx.jobOpeningEvent.create({
          data: {
            openingId: row.id,
            type: 'CREATED',
            toStatus: 'DRAFT',
            actorUserId: actor,
          },
        });
        await writeRecruitmentAudit(this.audit, tx, {
          action: 'JOB_OPENING_CREATED',
          entityType: 'JobOpening',
          entityId: row.id,
          context,
          metadata: {
            organizationId: row.organizationId,
            code,
            positionId: row.positionId,
          },
        });
        return openingShape(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          'RECRUITMENT_OPENING_EXISTS',
          `An opening with requisition code ${code} already exists.`,
        );
      }
      throw error;
    }
  }

  async update(
    openingId: string,
    input: OpeningUpdate,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await lockOpening(tx, openingId);
      const { opening, access } = await this.access.requireOpening(
        actor,
        openingId,
        'manage',
        tx,
      );
      if (opening.status === 'CLOSED' || opening.status === 'CANCELLED') {
        throw conflict(
          'RECRUITMENT_OPENING_FROZEN',
          'A closed or cancelled opening cannot be changed.',
        );
      }
      const values = await this.values(
        tx,
        opening.organizationId,
        input,
        opening,
      );
      const placementChanged = (
        ['organizationalUnitId', 'departmentId', 'teamId'] as const
      ).some((key) => values.placement[key] !== opening[key]);
      if (placementChanged) {
        const target = await this.access.openingTarget(tx, {
          ...opening,
          ...values.placement,
        });
        if (!this.access.can(access.grants, 'recruitment.manage', target)) {
          throw new ForbiddenException(
            'Missing permission recruitment.manage for the new placement.',
          );
        }
      }
      const data: Prisma.JobOpeningUncheckedUpdateInput = {
        ...(values.data as Prisma.JobOpeningUncheckedUpdateInput),
        ...values.placement,
        ...(input.employmentType
          ? { employmentType: input.employmentType }
          : {}),
      };
      let status: JobOpeningStatus = opening.status;
      if (values.openingCount !== undefined) {
        data.openingCount = values.openingCount;
        status = openingAfterCountChange(opening, values.openingCount);
        if (status !== opening.status) data.status = status;
      }
      const changed = Object.keys(input).filter(
        (key) => input[key as keyof OpeningUpdate] !== undefined,
      );
      const row = await tx.jobOpening.update({
        where: { id: openingId },
        data,
        include: OPENING_INCLUDE,
      });
      await tx.jobOpeningEvent.create({
        data: {
          openingId,
          type: status !== opening.status ? 'STATUS_CHANGED' : 'UPDATED',
          fromStatus: status !== opening.status ? opening.status : null,
          toStatus: status !== opening.status ? status : null,
          changedFields: changed,
          actorUserId: actor,
        },
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'JOB_OPENING_UPDATED',
        entityType: 'JobOpening',
        entityId: openingId,
        context,
        metadata: {
          organizationId: row.organizationId,
          fields: changed,
          status,
        },
      });
      return openingShape(row, access);
    });
  }

  async transition(
    openingId: string,
    action: keyof typeof TRANSITION_ACTIONS,
    reason: string | null | undefined,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const { to, action: auditAction } = TRANSITION_ACTIONS[action];
    return this.prisma.$transaction(async (tx) => {
      await lockOpening(tx, openingId);
      const { opening, access } = await this.access.requireOpening(
        actor,
        openingId,
        'manage',
        tx,
      );
      const valid =
        canMoveOpening(opening.status, to) &&
        (action !== 'resume' || opening.status === 'ON_HOLD') &&
        (action !== 'open' || opening.status === 'DRAFT');
      if (!valid) {
        throw conflict(
          'RECRUITMENT_OPENING_TRANSITION_INVALID',
          `An opening that is ${opening.status} cannot be ${action === 'hold' ? 'put on hold' : `${action}ed`}.`,
          { status: opening.status },
        );
      }
      if (action === 'cancel' && opening.hiredCount > 0) {
        throw conflict(
          'RECRUITMENT_OPENING_HAS_HIRES',
          'An opening with hires is closed, not cancelled.',
        );
      }
      const note = parseText(reason, 'reason', { max: 1000 });
      if ((action === 'cancel' || action === 'hold') && !note) {
        invalid('RECRUITMENT_REASON_REQUIRED', 'A reason is required.');
      }
      const now = this.clock.now();
      const today = recruitmentToday(
        now,
        (
          await tx.organization.findUnique({
            where: { id: opening.organizationId },
          })
        )?.timezone,
      );
      const row = await tx.jobOpening.update({
        where: { id: openingId },
        data: {
          status: to,
          statusReason: note,
          ...(action === 'open'
            ? { openedAt: now, postedOn: opening.postedOn ?? today }
            : {}),
          ...(to === 'CLOSED' || to === 'CANCELLED' ? { closedAt: now } : {}),
        },
        include: OPENING_INCLUDE,
      });
      if (action === 'open')
        await this.stages.ensureDefaults(tx, opening.organizationId, actor);
      await tx.jobOpeningEvent.create({
        data: {
          openingId,
          type: 'STATUS_CHANGED',
          fromStatus: opening.status,
          toStatus: to,
          reason: note,
          actorUserId: actor,
        },
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: auditAction,
        entityType: 'JobOpening',
        entityId: openingId,
        context,
        metadata: {
          organizationId: opening.organizationId,
          from: opening.status,
          to,
        },
      });
      return openingShape(row, access);
    });
  }

  /** Validated column values; placement follows the position when one anchors the opening. */
  private async values(
    client: RecruitmentClient,
    organizationId: string,
    input: OpeningUpdate,
    current: JobOpening | null,
  ) {
    const data: Record<string, unknown> = {};
    if (input.title !== undefined || !current)
      data.title = parseText(input.title, 'title', {
        required: true,
        max: 200,
      })!;
    if (input.description !== undefined)
      data.description = parseText(input.description, 'description');
    for (const key of ['expectedStartDate', 'postedOn', 'closesOn'] as const) {
      if (input[key] !== undefined) data[key] = optionalDate(input[key], key);
    }
    const postedOn =
      (data.postedOn as Date | null | undefined) ?? current?.postedOn ?? null;
    const closesOn =
      (data.closesOn as Date | null | undefined) ?? current?.closesOn ?? null;
    if (postedOn && closesOn && closesOn < postedOn) {
      invalid(
        'RECRUITMENT_OPENING_DATES_INVALID',
        'The closing date precedes the posting date.',
      );
    }
    if (input.compensation !== undefined) {
      if (input.compensation === null) {
        Object.assign(data, {
          compensationPayBasis: null,
          compensationMin: null,
          compensationMax: null,
          compensationCurrency: null,
        });
      } else {
        const min = input.compensation.min
          ? parseRateAmount(input.compensation.min, 'compensation.min').decimal
          : null;
        const max = input.compensation.max
          ? parseRateAmount(input.compensation.max, 'compensation.max').decimal
          : null;
        if (!min && !max) {
          invalid(
            'RECRUITMENT_COMPENSATION_INVALID',
            'Give a minimum, a maximum or both.',
          );
        }
        if (min && max && min.gt(max)) {
          invalid(
            'RECRUITMENT_COMPENSATION_INVALID',
            'The minimum exceeds the maximum.',
          );
        }
        Object.assign(data, {
          compensationPayBasis: input.compensation.payBasis,
          compensationMin: min,
          compensationMax: max,
          compensationCurrency: parseCurrency(input.compensation.currency),
        });
      }
    }
    if (input.hiringManagerEmployeeId !== undefined) {
      if (input.hiringManagerEmployeeId) {
        const inOrg = await client.employmentAssignment.count({
          where: {
            employeeId: input.hiringManagerEmployeeId,
            status: { not: 'CANCELLED' },
            position: { organizationId },
          },
        });
        if (!inOrg) {
          invalid(
            'RECRUITMENT_HIRING_MANAGER_INVALID',
            'The hiring manager is not an employee of the organization.',
          );
        }
      }
      data.hiringManagerEmployeeId = input.hiringManagerEmployeeId ?? null;
    }
    if (input.recruiterUserId !== undefined) {
      if (input.recruiterUserId) {
        const user = await client.user.findUnique({
          where: { id: input.recruiterUserId },
          select: { status: true },
        });
        if (!user || user.status !== 'ACTIVE') {
          invalid(
            'RECRUITMENT_RECRUITER_INVALID',
            'The recruiter is not an active user.',
          );
        }
      }
      data.recruiterUserId = input.recruiterUserId ?? null;
    }
    // Placement.
    const placement = {
      positionId: current?.positionId ?? null,
      organizationalUnitId: current?.organizationalUnitId ?? null,
      departmentId: current?.departmentId ?? null,
      teamId: current?.teamId ?? null,
      workLocationId: current?.workLocationId ?? null,
    };
    const placementKeys = [
      'positionId',
      'organizationalUnitId',
      'departmentId',
      'teamId',
      'workLocationId',
    ] as const;
    if (placementKeys.some((key) => input[key] !== undefined)) {
      for (const key of placementKeys) {
        if (input[key] !== undefined) placement[key] = input[key] ?? null;
      }
      if (placement.positionId) {
        const position = await client.position.findUnique({
          where: { id: placement.positionId },
        });
        if (
          !position ||
          position.organizationId !== organizationId ||
          position.archivedAt
        ) {
          invalid(
            'RECRUITMENT_POSITION_INVALID',
            'The position is not an active position of the organization.',
          );
        }
        placement.organizationalUnitId = position.organizationalUnitId;
        placement.departmentId = position.departmentId;
        placement.teamId = position.teamId;
        placement.workLocationId =
          input.workLocationId ?? position.workLocationId ?? null;
      }
      const checks: Array<[string | null, () => Promise<number>, string]> = [
        [
          placement.organizationalUnitId,
          () =>
            client.organizationalUnit.count({
              where: { id: placement.organizationalUnitId!, organizationId },
            }),
          'organizational unit',
        ],
        [
          placement.departmentId,
          () =>
            client.department.count({
              where: { id: placement.departmentId!, organizationId },
            }),
          'department',
        ],
        [
          placement.teamId,
          () =>
            client.team.count({
              where: { id: placement.teamId!, organizationId },
            }),
          'team',
        ],
        [
          placement.workLocationId,
          () =>
            client.workLocation.count({
              where: { id: placement.workLocationId!, organizationId },
            }),
          'work location',
        ],
      ];
      for (const [id, count, label] of checks) {
        if (id && (await count()) === 0) {
          invalid(
            'RECRUITMENT_PLACEMENT_INVALID',
            `The ${label} does not belong to the organization.`,
          );
        }
      }
    }
    let openingCount: number | undefined;
    if (input.openingCount !== undefined) {
      openingCount = input.openingCount;
      if (!current)
        openingAfterCountChange(
          { status: 'DRAFT', hiredCount: 0 },
          openingCount,
        );
    }
    return { data, placement, openingCount };
  }
}
