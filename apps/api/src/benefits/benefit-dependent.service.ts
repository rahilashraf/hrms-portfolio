import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  parseDateOnly,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  BenefitDependent,
  BenefitDependentRelationship,
  Prisma,
} from '../generated/prisma/client.js';
import {
  BenefitsAccessService,
  permissionRequired,
} from './benefits-access.service.js';
import {
  BenefitsClock,
  benefitsToday,
  lockEmployee,
  writeBenefitsAudit,
  type BenefitsRequestContext,
} from './benefits-common.js';
import { dependentEligibleOn, isoDate } from './benefits-domain.js';

export const BENEFIT_RELATIONSHIPS: readonly BenefitDependentRelationship[] = [
  'SPOUSE',
  'CHILD',
  'OTHER',
];

export interface DependentInput {
  firstName: string;
  lastName: string;
  relationship: BenefitDependentRelationship;
  dateOfBirth?: string | null;
  relationshipStartDate?: string | null;
  relationshipEndDate?: string | null;
}

const name = (value: string | undefined, field: string) => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.length > 100) {
    throw new BadRequestException(
      `${field} is required (at most 100 characters).`,
    );
  }
  return trimmed;
};
const optionalDate = (value: string | null | undefined, field: string) =>
  value === undefined
    ? undefined
    : value === null
      ? null
      : parseDateOnly(value, field);

/**
 * Phase 11 Batch 11.5 — an employee's dependents, kept only for benefits: names, relationship,
 * birth date (children) and relationship dates. Nothing else (no SIN, address or health data),
 * and never a Person or user. Read with benefit.read, maintained with benefit.manage on any of
 * the employee's assignments (never one's own), and read-only through self-service. A dependent
 * referenced by an election is never deleted: it is archived once no coverage remains, and its
 * relationship never changes once it has been covered. Audit metadata never carries names or
 * birth dates.
 */
@Injectable()
export class BenefitDependentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BenefitsAccessService,
    private readonly audit: AuditService,
    private readonly clock: BenefitsClock,
  ) {}

  /**
   * Batch 7C (C4): an employee's dependents as the reader may see them — those not covered
   * through any assignment, or covered (now or ever) through one the reader reads; birth dates
   * only for those who maintain dependents (benefit.manage on one of the employee's
   * assignments). Per-dependent `canManage` follows the write rule.
   */
  async list(userId: string, employeeId: string, includeArchived = false) {
    const { assignments, isSelf } = await this.access.employeeAccess(
      userId,
      employeeId,
    );
    const readable = new Set(
      assignments.filter((row) => row.canRead).map((row) => row.assignment.id),
    );
    const manageable = new Set(
      assignments
        .filter((row) => row.canManage)
        .map((row) => row.assignment.id),
    );
    const canManageAny = !isSelf && manageable.size > 0;
    const rows = await this.prisma.benefitDependent.findMany({
      where: { employeeId, ...(includeArchived ? {} : { archivedAt: null }) },
      include: {
        coverages: {
          where: { enrollment: { supersededAt: null } },
          select: {
            enrollment: {
              select: { employmentAssignmentId: true, coverageEnd: true },
            },
          },
        },
      },
      orderBy: [
        { archivedAt: 'asc' },
        { relationship: 'asc' },
        { firstName: 'asc' },
      ],
    });
    const today = await this.employeeToday(employeeId);
    const items = [];
    for (const row of rows) {
      const sponsors = row.coverages.map(
        (link) => link.enrollment.employmentAssignmentId,
      );
      if (sponsors.length > 0 && !sponsors.some((id) => readable.has(id))) {
        continue;
      }
      const liveSponsors = row.coverages
        .filter(
          (link) =>
            !link.enrollment.coverageEnd ||
            link.enrollment.coverageEnd >= today,
        )
        .map((link) => link.enrollment.employmentAssignmentId);
      items.push({
        ...this.shape(row, { dateOfBirth: canManageAny }),
        canManage:
          canManageAny && liveSponsors.every((id) => manageable.has(id)),
      });
    }
    return { items, canManage: canManageAny };
  }

  /** Self-service: one's own dependents, read-only. */
  async mine(userId: string) {
    const employeeId = await this.access.employeeIdOfUser(userId);
    if (!employeeId) {
      throw new ForbiddenException(
        domainError(
          403,
          'BENEFIT_NOT_AN_EMPLOYEE',
          'Your account is not linked to an employee.',
        ),
      );
    }
    await this.access.requireEnabledForEmployee(employeeId);
    return { items: await this.rows(employeeId, false) };
  }

  async create(
    employeeId: string,
    input: DependentInput,
    context: BenefitsRequestContext,
  ) {
    const manageable = await this.requireManage(context, employeeId);
    const data = this.parse(input, await this.employeeToday(employeeId));
    return this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      const dependent = await tx.benefitDependent.create({
        data: {
          employeeId,
          firstName: data.firstName,
          lastName: data.lastName,
          relationship: data.relationship,
          dateOfBirth: data.dateOfBirth ?? null,
          relationshipStartDate: data.relationshipStartDate ?? null,
          relationshipEndDate: data.relationshipEndDate ?? null,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_DEPENDENT_ADDED',
        entityType: 'BenefitDependent',
        entityId: dependent.id,
        context,
        metadata: {
          organizationId: manageable.organizationId,
          employeeId,
          relationship: dependent.relationship,
        },
      });
      return this.shape(dependent);
    });
  }

  async update(
    dependentId: string,
    input: Partial<DependentInput>,
    context: BenefitsRequestContext,
  ) {
    const existing = await this.dependentOrThrow(dependentId);
    const manageable = await this.requireManage(context, existing.employeeId);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, existing.employeeId);
      const sponsorOrganizationId = await this.requireCoverageScope(
        tx,
        dependentId,
        manageable,
      );
      const current = await tx.benefitDependent.findUniqueOrThrow({
        where: { id: dependentId },
      });
      if (current.archivedAt) {
        throw new ConflictException(
          domainError(409, 'BENEFIT_ARCHIVED', 'The dependent is archived.'),
        );
      }
      if (
        input.relationship !== undefined &&
        input.relationship !== current.relationship
      ) {
        const covered = await tx.benefitEnrollmentDependent.count({
          where: { dependentId },
        });
        if (covered > 0) {
          throw new ConflictException(
            domainError(
              409,
              'BENEFIT_DEPENDENT_RELATIONSHIP_FIXED',
              'A dependent who has been covered keeps their relationship; add a new dependent instead.',
            ),
          );
        }
      }
      const merged = this.parse(
        {
          firstName: input.firstName ?? current.firstName,
          lastName: input.lastName ?? current.lastName,
          relationship: input.relationship ?? current.relationship,
          dateOfBirth:
            input.dateOfBirth === undefined
              ? isoDate(current.dateOfBirth)
              : input.dateOfBirth,
          relationshipStartDate:
            input.relationshipStartDate === undefined
              ? isoDate(current.relationshipStartDate)
              : input.relationshipStartDate,
          relationshipEndDate:
            input.relationshipEndDate === undefined
              ? isoDate(current.relationshipEndDate)
              : input.relationshipEndDate,
        },
        await this.employeeToday(existing.employeeId),
      );
      await this.assertHistoryHolds(tx, dependentId, {
        ...current,
        ...merged,
        dateOfBirth: merged.dateOfBirth ?? null,
        relationshipStartDate: merged.relationshipStartDate ?? null,
        relationshipEndDate: merged.relationshipEndDate ?? null,
      });
      const data: Prisma.BenefitDependentUpdateInput = {
        firstName: merged.firstName,
        lastName: merged.lastName,
        relationship: merged.relationship,
        dateOfBirth: merged.dateOfBirth ?? null,
        relationshipStartDate: merged.relationshipStartDate ?? null,
        relationshipEndDate: merged.relationshipEndDate ?? null,
      };
      const updated = await tx.benefitDependent.update({
        where: { id: dependentId },
        data,
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_DEPENDENT_UPDATED',
        entityType: 'BenefitDependent',
        entityId: dependentId,
        context,
        // Which fields changed, never their (personal) values.
        metadata: {
          organizationId: sponsorOrganizationId ?? manageable.organizationId,
          employeeId: current.employeeId,
          changed: Object.keys(input)
            .filter(
              (key) => (input as Record<string, unknown>)[key] !== undefined,
            )
            .sort(),
        },
      });
      return this.shape(updated);
    });
  }

  /** Archives a dependent no current or future coverage includes. */
  async archive(dependentId: string, context: BenefitsRequestContext) {
    const existing = await this.dependentOrThrow(dependentId);
    const manageable = await this.requireManage(context, existing.employeeId);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, existing.employeeId);
      const sponsorOrganizationId = await this.requireCoverageScope(
        tx,
        dependentId,
        manageable,
      );
      const current = await tx.benefitDependent.findUniqueOrThrow({
        where: { id: dependentId },
      });
      if (current.archivedAt) return this.shape(current);
      const covered = await tx.benefitEnrollmentDependent.findMany({
        where: { dependentId, enrollment: { supersededAt: null } },
        include: {
          enrollment: {
            include: {
              employmentAssignment: {
                include: {
                  position: {
                    select: {
                      workLocation: { select: { timezone: true } },
                      organization: { select: { timezone: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      const live = covered.filter((row) => {
        const { today } = benefitsToday(
          this.clock.now(),
          row.enrollment.employmentAssignment.position.workLocation?.timezone,
          row.enrollment.employmentAssignment.position.organization.timezone,
        );
        return (
          !row.enrollment.coverageEnd || row.enrollment.coverageEnd >= today
        );
      });
      if (live.length > 0) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_DEPENDENT_COVERED',
            'The dependent is covered by current or future elections; change them first.',
            { enrollmentIds: live.map((row) => row.enrollmentId) },
          ),
        );
      }
      const updated = await tx.benefitDependent.update({
        where: { id: dependentId },
        data: { archivedAt: this.clock.now() },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_DEPENDENT_ARCHIVED',
        entityType: 'BenefitDependent',
        entityId: dependentId,
        context,
        metadata: {
          organizationId: sponsorOrganizationId ?? manageable.organizationId,
          employeeId: current.employeeId,
        },
      });
      return this.shape(updated);
    });
  }

  private async requireManage(
    context: BenefitsRequestContext,
    employeeId: string,
  ) {
    if (!context.actorUserId) throw new ForbiddenException();
    const { assignments, isSelf } = await this.access.employeeAccess(
      context.actorUserId,
      employeeId,
    );
    if (isSelf) {
      throw new ForbiddenException(
        domainError(
          403,
          'BENEFIT_SELF_MANAGEMENT',
          'You cannot change your own benefits.',
        ),
      );
    }
    if (!assignments.some((row) => row.canManage)) {
      throw permissionRequired(
        'Missing permission benefit.manage for the employee.',
      );
    }
    const manageable = assignments.filter((row) => row.canManage);
    return Object.assign(new Set(manageable.map((row) => row.assignment.id)), {
      // Batch 7C (B16): the organization the write is made through (audit tagging).
      organizationId: manageable[0]!.target.organizationId,
    });
  }

  /**
   * Batch 7C (C4): a covered dependent is changed only by someone who manages benefits through
   * every assignment sponsoring their current or future coverage — access through an unrelated
   * assignment (another team or organization) never reaches it.
   */
  private async requireCoverageScope(
    tx: Prisma.TransactionClient,
    dependentId: string,
    manageable: ReadonlySet<string>,
  ) {
    const links = await tx.benefitEnrollmentDependent.findMany({
      where: { dependentId, enrollment: { supersededAt: null } },
      select: {
        enrollment: {
          select: {
            employmentAssignmentId: true,
            coverageEnd: true,
            employmentAssignment: {
              select: {
                position: {
                  select: {
                    organizationId: true,
                    workLocation: { select: { timezone: true } },
                    organization: { select: { timezone: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const outside = links.filter(({ enrollment }) => {
      const { today } = benefitsToday(
        this.clock.now(),
        enrollment.employmentAssignment.position.workLocation?.timezone,
        enrollment.employmentAssignment.position.organization.timezone,
      );
      return (
        (!enrollment.coverageEnd || enrollment.coverageEnd >= today) &&
        !manageable.has(enrollment.employmentAssignmentId)
      );
    });
    if (outside.length > 0) {
      throw new ForbiddenException(
        domainError(
          403,
          'BENEFIT_PERMISSION_REQUIRED',
          'The dependent is covered through an assignment outside your benefits scope.',
        ),
      );
    }
    // Batch 7C (B16): the organization of the coverage the change concerns (audit tagging):
    // live coverage first, in a fixed order.
    const live = links
      .filter(({ enrollment }) => {
        const { today } = benefitsToday(
          this.clock.now(),
          enrollment.employmentAssignment.position.workLocation?.timezone,
          enrollment.employmentAssignment.position.organization.timezone,
        );
        return !enrollment.coverageEnd || enrollment.coverageEnd >= today;
      })
      .map(
        ({ enrollment }) =>
          enrollment.employmentAssignment.position.organizationId,
      )
      .sort();
    return live[0] ?? null;
  }

  /**
   * Batch 7C (C5): an edit never makes recorded coverage invalid — every election covering the
   * dependent must still have been valid on its coverage start (relationship dates, a child's
   * birth date and the plan's age limit).
   */
  private async assertHistoryHolds(
    tx: Prisma.TransactionClient,
    dependentId: string,
    dependent: Parameters<typeof dependentEligibleOn>[0],
  ) {
    const links = await tx.benefitEnrollmentDependent.findMany({
      where: { dependentId, enrollment: { supersededAt: null } },
      select: {
        enrollment: {
          select: {
            coverageStart: true,
            plan: { select: { dependentChildMaxAge: true } },
          },
        },
      },
    });
    const broken = links.filter(
      ({ enrollment }) =>
        !dependentEligibleOn(
          dependent,
          enrollment.coverageStart,
          enrollment.plan.dependentChildMaxAge,
        ),
    );
    if (broken.length > 0) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_DEPENDENT_HISTORY_CONFLICT',
          'This change would make recorded coverage invalid; correct the elections first.',
          {
            earliestCoverageStart: formatDate(
              broken
                .map(({ enrollment }) => enrollment.coverageStart)
                .sort((a, b) => a.getTime() - b.getTime())[0]!,
            ),
            elections: broken.length,
          },
        ),
      );
    }
  }

  /** Today in the employee's primary assignment's time zone (organization's otherwise). */
  private async employeeToday(employeeId: string) {
    const assignment = await this.prisma.employmentAssignment.findFirst({
      where: { employeeId },
      orderBy: [{ isPrimary: 'desc' }, { startDate: 'asc' }],
      select: {
        position: {
          select: {
            workLocation: { select: { timezone: true } },
            organization: { select: { timezone: true } },
          },
        },
      },
    });
    return benefitsToday(
      this.clock.now(),
      assignment?.position.workLocation?.timezone,
      assignment?.position.organization.timezone,
    ).today;
  }

  private async dependentOrThrow(dependentId: string) {
    const dependent = await this.prisma.benefitDependent.findUnique({
      where: { id: dependentId },
    });
    if (!dependent) throw new NotFoundException('Dependent not found.');
    return dependent;
  }

  /** `today`: the employee's local date (Batch 7C — a birth today east of UTC is accepted). */
  private parse(input: DependentInput, today: Date) {
    if (!BENEFIT_RELATIONSHIPS.includes(input.relationship)) {
      throw new BadRequestException(
        'relationship must be SPOUSE, CHILD or OTHER.',
      );
    }
    const dateOfBirth = optionalDate(input.dateOfBirth, 'dateOfBirth');
    const relationshipStartDate = optionalDate(
      input.relationshipStartDate,
      'relationshipStartDate',
    );
    const relationshipEndDate = optionalDate(
      input.relationshipEndDate,
      'relationshipEndDate',
    );
    if (input.relationship === 'CHILD' && !dateOfBirth) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_DEPENDENT_BIRTH_DATE_REQUIRED',
          'A child needs a date of birth.',
        ),
      );
    }
    if (dateOfBirth && dateOfBirth > today) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_DEPENDENT_BIRTH_DATE_INVALID',
          'dateOfBirth is in the future.',
        ),
      );
    }
    if (
      relationshipStartDate &&
      relationshipEndDate &&
      relationshipEndDate < relationshipStartDate
    ) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_DATE_RANGE_INVALID',
          'relationshipEndDate must not be before relationshipStartDate.',
        ),
      );
    }
    return {
      firstName: name(input.firstName, 'firstName'),
      lastName: name(input.lastName, 'lastName'),
      relationship: input.relationship,
      dateOfBirth,
      relationshipStartDate,
      relationshipEndDate,
    };
  }

  private async rows(employeeId: string, includeArchived: boolean) {
    const rows = await this.prisma.benefitDependent.findMany({
      where: { employeeId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [
        { archivedAt: 'asc' },
        { relationship: 'asc' },
        { firstName: 'asc' },
      ],
    });
    return rows.map((row) => this.shape(row));
  }

  /** Batch 7C (C4): `dateOfBirth: false` leaves the birth date out (null). */
  shape(dependent: BenefitDependent, show: { dateOfBirth?: boolean } = {}) {
    return {
      id: dependent.id,
      employeeId: dependent.employeeId,
      firstName: dependent.firstName,
      lastName: dependent.lastName,
      relationship: dependent.relationship,
      dateOfBirth:
        show.dateOfBirth === false ? null : isoDate(dependent.dateOfBirth),
      relationshipStartDate: isoDate(dependent.relationshipStartDate),
      relationshipEndDate: isoDate(dependent.relationshipEndDate),
      archived: dependent.archivedAt !== null,
    };
  }
}
