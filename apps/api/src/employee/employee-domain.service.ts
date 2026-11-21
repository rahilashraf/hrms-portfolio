import {
  deriveAssignmentStatus,
  lockEmployeeLifecycle,
  lockPositions,
} from './employee-lifecycle-support.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { domainError, localDateOf } from '../common/domain-support.js';
import { isIanaTimezone } from '../common/timezone.js';
import { PrismaService } from '../database/prisma.service.js';

type Client = Prisma.TransactionClient;
type DateRange = { startDate: Date; endDate: Date | null };
type ManagerValidationAssignment = {
  id?: string;
  employeeId: string;
  startDate: Date;
  endDate?: Date | null;
  status?: string;
  managerAssignmentId?: string | null;
};

export interface EmployeeCreateInput {
  personId: string;
  employeeNumber?: string | null;
  hireDate: Date;
  status?: 'ACTIVE' | 'INACTIVE' | 'TERMINATED';
  terminationDate?: Date | null;
}

export interface PersonCreateInput {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
}

export interface AssignmentCreateInput {
  employeeId: string;
  positionId: string;
  employmentType: 'FULL_TIME' | 'PART_TIME' | 'CASUAL' | 'CONTRACT';
  status?: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
  startDate: Date;
  endDate?: Date | null;
  isPrimary?: boolean;
  managerAssignmentId?: string | null;
}

export interface DomainAuditContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

/** Who asked for a PLANNED → ACTIVE transition: a person (API) or the recurring worker. */
export type AssignmentActivationSource = 'MANUAL' | 'AUTOMATIC';

export interface AssignmentActivationResult {
  /** ACTIVATED: this call made the transition; ALREADY_ACTIVE: an earlier one did (no-op). */
  outcome: 'ACTIVATED' | 'ALREADY_ACTIVE';
  assignment: {
    id: string;
    employeeId: string;
    positionId: string;
    status: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
    startDate: Date;
    endDate: Date | null;
  };
  /** The business date (assignment timezone) the transition was evaluated on. */
  activatedOn: string;
  timezone: string;
}

@Injectable()
export class EmployeeDomainService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a Person (Phase 13: hire conversion creates the person a candidate becomes in the
   * caller's transaction). Audited without personal details.
   */
  async createPerson(
    input: PersonCreateInput,
    context: DomainAuditContext = {},
    existingClient?: Client,
  ) {
    const operation = async (tx: Client) => {
      const person = await tx.person.create({
        data: {
          firstName: input.firstName ?? null,
          middleName: input.middleName ?? null,
          lastName: input.lastName ?? null,
          preferredName: input.preferredName ?? null,
          personalEmail: input.personalEmail ?? null,
          phone: input.phone ?? null,
        },
      });
      await this.writeAudit(
        tx,
        'PERSON_CREATED',
        'Person',
        person.id,
        context,
        {},
      );
      return person;
    };
    return existingClient
      ? operation(existingClient)
      : this.prisma.$transaction(operation);
  }

  async createEmployee(
    input: EmployeeCreateInput,
    context: DomainAuditContext = {},
    existingClient?: Client,
  ) {
    this.assertDateRange(input.hireDate, input.terminationDate ?? null);
    if (input.status === 'TERMINATED' && !input.terminationDate) {
      throw new BadRequestException(
        'A terminated employee must have a termination date.',
      );
    }
    const operation = async (tx: Client) => {
      const person = await tx.person.findUnique({
        where: { id: input.personId },
      });
      if (!person) throw new NotFoundException('Person not found.');
      const existing = await tx.employee.findUnique({
        where: { personId: input.personId },
      });
      if (existing)
        throw new ConflictException('Person is already an employee.');
      const employeeNumber =
        normalizeEmployeeNumber(input.employeeNumber) ??
        (await this.nextEmployeeNumber(tx));
      if (
        input.employeeNumber !== undefined &&
        input.employeeNumber !== null &&
        (await tx.employee.findUnique({ where: { employeeNumber } }))
      ) {
        throw new ConflictException('Employee number is already in use.');
      }
      let employee;
      try {
        employee = await tx.employee.create({
          data: {
            personId: input.personId,
            employeeNumber,
            hireDate: input.hireDate,
            terminationDate: input.terminationDate ?? null,
            status: input.status ?? 'ACTIVE',
          },
        });
      } catch (error) {
        if (isUniqueConstraint(error, 'employeeNumber')) {
          throw new ConflictException('Employee number is already in use.');
        }
        if (isUniqueConstraint(error, 'personId')) {
          throw new ConflictException('Person is already an employee.');
        }
        throw error;
      }
      await this.writeAudit(
        tx,
        'EMPLOYEE_CREATED',
        'Employee',
        employee.id,
        context,
        {
          after: employee,
        },
      );
      return employee;
    };
    return existingClient
      ? operation(existingClient)
      : this.prisma.$transaction(operation);
  }

  async createAssignment(
    input: AssignmentCreateInput,
    context: DomainAuditContext = {},
    existingClient?: Client,
  ) {
    this.assertDateRange(input.startDate, input.endDate ?? null);
    const operation = async (tx: Client) => {
      // Batch 5A: every assignment, whichever module creates it (Core HR, rehire, recruitment
      // conversion), is created under the employee's lifecycle lock (re-entrant for callers that
      // already hold it), for an ACTIVE employee without a scheduled termination.
      await lockEmployeeLifecycle(tx, input.employeeId);
      // Batch 5B: and the position's lock (the one position archive and transfer take).
      await lockPositions(tx, [input.positionId]);
      const employee = await tx.employee.findUnique({
        where: { id: input.employeeId },
      });
      if (!employee) throw new NotFoundException('Employee not found.');
      if (employee.status !== 'ACTIVE') {
        throw new ConflictException(
          domainError(
            409,
            'EMPLOYEE_NOT_ACTIVE',
            employee.status === 'TERMINATED'
              ? 'The employee is terminated; rehire them into the new assignment instead.'
              : 'The employee is inactive; reactivate them first.',
          ),
        );
      }
      const scheduled = await tx.employeeTermination.findFirst({
        where: { employeeId: input.employeeId, status: 'SCHEDULED' },
        select: { id: true, terminationDate: true },
      });
      if (scheduled) {
        throw new ConflictException(
          domainError(
            409,
            'TERMINATION_SCHEDULED',
            `A termination is scheduled for ${dateOnly(scheduled.terminationDate)}; cancel or reschedule it first.`,
            { terminationId: scheduled.id },
          ),
        );
      }
      const position = await tx.position.findUnique({
        where: { id: input.positionId },
        include: {
          workLocation: { select: { timezone: true } },
          organization: { select: { timezone: true } },
        },
      });
      if (!position || position.archivedAt) {
        throw new BadRequestException('Position is not available.');
      }
      const manager = input.managerAssignmentId
        ? await tx.employmentAssignment.findUnique({
            where: { id: input.managerAssignmentId },
            select: {
              id: true,
              employeeId: true,
              positionId: true,
              status: true,
              startDate: true,
              endDate: true,
              managerAssignmentId: true,
            },
          })
        : null;
      if (input.managerAssignmentId && !manager) {
        throw new NotFoundException('Manager assignment not found.');
      }
      if (manager) {
        await this.validateManagerRelationship(tx, input, manager);
        await this.assertManagerSameOrganization(
          tx,
          input.positionId,
          manager.positionId,
        );
      }
      // R5 (Batch 5A): without an explicit status the dates decide (PLANNED, ACTIVE or ENDED).
      const status =
        input.status ??
        deriveAssignmentStatus(
          input.startDate,
          input.endDate ?? null,
          localDateOf(new Date(), resolveAssignmentTimezone(position)),
        );
      const range = {
        startDate: input.startDate,
        endDate: input.endDate ?? null,
      };
      if (this.occupiesPosition(status)) {
        await this.assertNoPositionOverlap(tx, input.positionId, range);
      }
      if (input.isPrimary) {
        await this.assertNoPrimaryOverlap(tx, input.employeeId, range);
      }
      const assignment = await tx.employmentAssignment.create({
        data: {
          employeeId: input.employeeId,
          positionId: input.positionId,
          employmentType: input.employmentType,
          status,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          isPrimary: input.isPrimary ?? false,
          managerAssignmentId: input.managerAssignmentId ?? null,
        },
      });
      await this.writeAudit(
        tx,
        'EMPLOYMENT_ASSIGNMENT_CREATED',
        'EmploymentAssignment',
        assignment.id,
        context,
        { after: assignment },
      );
      return assignment;
    };
    return existingClient
      ? operation(existingClient)
      : this.prisma.$transaction(operation);
  }

  static isEffectiveOn(
    assignment: {
      status: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
      startDate: Date;
      endDate: Date | null;
    },
    date: Date,
  ): boolean {
    return (
      assignment.status !== 'CANCELLED' &&
      assignment.startDate.getTime() <= date.getTime() &&
      (assignment.endDate === null ||
        date.getTime() <= assignment.endDate.getTime())
    );
  }

  /**
   * Batch 5B (K7): a new or changed manager link must point to an assignment in the same
   * organization as the subordinate's position (409 MANAGER_ORGANIZATION_MISMATCH). Existing
   * cross-organization links are left alone (only reported), so this runs only where a link is
   * created or changed, never when an assignment carrying an old link is corrected.
   */
  async assertManagerSameOrganization(
    tx: Client,
    subordinatePositionId: string,
    managerPositionId: string,
  ) {
    const [subordinate, manager] = await Promise.all([
      tx.position.findUnique({
        where: { id: subordinatePositionId },
        select: { organizationId: true },
      }),
      tx.position.findUnique({
        where: { id: managerPositionId },
        select: { organizationId: true },
      }),
    ]);
    if (
      !subordinate ||
      !manager ||
      subordinate.organizationId !== manager.organizationId
    ) {
      throw new ConflictException(
        domainError(
          409,
          'MANAGER_ORGANIZATION_MISMATCH',
          'A manager must hold an assignment in the same organization as the position they manage.',
        ),
      );
    }
  }

  async validateManagerRelationship(
    tx: Client,
    subordinate: ManagerValidationAssignment,
    manager: ManagerValidationAssignment,
  ) {
    if (
      manager.status === 'CANCELLED' ||
      !rangesOverlap(
        {
          startDate: subordinate.startDate,
          endDate: subordinate.endDate ?? null,
        },
        { startDate: manager.startDate, endDate: manager.endDate ?? null },
      )
    ) {
      throw new BadRequestException(
        'Manager assignment must be active for at least part of the subordinate assignment.',
      );
    }
    if (manager.employeeId === subordinate.employeeId) {
      throw new BadRequestException('An employee cannot be their own manager.');
    }
    await this.assertNoManagerCycle(
      tx,
      subordinate.id,
      manager.managerAssignmentId ?? null,
    );
  }

  private async nextEmployeeNumber(tx: Client): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ value: bigint }>>(
      Prisma.sql`SELECT nextval('employee_number_seq') AS value`,
    );
    const value = rows[0]?.value;
    if (value === undefined)
      throw new Error('Employee number sequence returned no value.');
    return `EMP-${value.toString().padStart(6, '0')}`;
  }

  private async assertNoPositionOverlap(
    tx: Client,
    positionId: string,
    range: DateRange,
  ) {
    const assignments = await tx.employmentAssignment.findMany({
      where: {
        positionId,
        status: { not: 'CANCELLED' },
        startDate: {
          lte: range.endDate ?? new Date('9999-12-31T00:00:00.000Z'),
        },
      },
      select: { startDate: true, endDate: true },
    });
    if (assignments.some((assignment) => rangesOverlap(range, assignment))) {
      throw new ConflictException(
        'Position is occupied during the requested dates.',
      );
    }
  }

  private async assertNoPrimaryOverlap(
    tx: Client,
    employeeId: string,
    range: DateRange,
  ) {
    const assignments = await tx.employmentAssignment.findMany({
      where: {
        employeeId,
        isPrimary: true,
        status: { not: 'CANCELLED' },
        startDate: {
          lte: range.endDate ?? new Date('9999-12-31T00:00:00.000Z'),
        },
      },
      select: { startDate: true, endDate: true },
    });
    if (assignments.some((assignment) => rangesOverlap(range, assignment))) {
      throw new ConflictException('Primary assignments may not overlap.');
    }
  }

  private async assertNoManagerCycle(
    tx: Client,
    subordinateAssignmentId: string | undefined,
    managerAssignmentId: string | null,
  ) {
    const seen = new Set<string>();
    let cursor = managerAssignmentId;
    while (cursor) {
      if (
        (subordinateAssignmentId && cursor === subordinateAssignmentId) ||
        seen.has(cursor)
      ) {
        throw new BadRequestException(
          'Manager relationship would create a cycle.',
        );
      }
      seen.add(cursor);
      const next = await tx.employmentAssignment.findUnique({
        where: { id: cursor },
        select: { managerAssignmentId: true },
      });
      cursor = next?.managerAssignmentId ?? null;
    }
  }

  private occupiesPosition(status: string) {
    return status !== 'CANCELLED';
  }

  private assertDateRange(startDate: Date, endDate: Date | null) {
    if (endDate && startDate.getTime() > endDate.getTime()) {
      throw new BadRequestException('End date must be on or after start date.');
    }
  }

  /**
   * The PLANNED → ACTIVE lifecycle transition, shared by the API and the recurring worker.
   * Only the status changes: the assignment keeps its id, dates, position, manager, primary flag
   * and everything that references it (compensation, time, payroll history).
   *
   * Rules, evaluated on the business date of the assignment (its work location's timezone, then
   * its organization's — the same resolution as at creation):
   *  - the employee is ACTIVE (not archived), the assignment is PLANNED;
   *  - its start date has arrived and, when it has an end date, that date has not passed
   *    (an expired PLANNED assignment is never activated; correct or cancel it instead).
   *
   * Concurrency: the assignment row is locked first (FOR NO KEY UPDATE) and the update is guarded
   * on status = PLANNED, so concurrent or repeated attempts activate it exactly once and write
   * exactly one EMPLOYMENT_ASSIGNMENT_ACTIVATED audit entry; later attempts see ALREADY_ACTIVE.
   * Callers authorize first (the API checks employee.manage on the position's scope).
   */
  async activateAssignment(
    assignmentId: string,
    options: {
      source: AssignmentActivationSource;
      context?: DomainAuditContext;
      /** When given, the assignment must belong to this employee (API path parameter). */
      employeeId?: string;
      now?: Date;
    },
    existingClient?: Client,
  ): Promise<AssignmentActivationResult> {
    const operation = async (
      tx: Client,
    ): Promise<AssignmentActivationResult> => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "EmploymentAssignment" WHERE "id" = ${assignmentId}::uuid FOR NO KEY UPDATE`,
      );
      const assignment = await tx.employmentAssignment.findUnique({
        where: { id: assignmentId },
        include: {
          employee: { select: { id: true, status: true, archivedAt: true } },
          position: {
            select: {
              organizationId: true,
              archivedAt: true,
              workLocation: { select: { timezone: true } },
              organization: { select: { timezone: true, archivedAt: true } },
            },
          },
        },
      });
      if (
        !assignment ||
        (options.employeeId !== undefined &&
          assignment.employeeId !== options.employeeId)
      ) {
        throw new NotFoundException('Assignment not found.');
      }
      const timezone = resolveAssignmentTimezone(assignment.position);
      const today = localDateOf(options.now ?? new Date(), timezone);
      const activatedOn = dateOnly(today);
      const shape = (
        status: AssignmentActivationResult['assignment']['status'],
      ) => ({
        id: assignment.id,
        employeeId: assignment.employeeId,
        positionId: assignment.positionId,
        status,
        startDate: assignment.startDate,
        endDate: assignment.endDate,
      });
      if (assignment.status === 'ACTIVE') {
        return {
          outcome: 'ALREADY_ACTIVE',
          assignment: shape('ACTIVE'),
          activatedOn,
          timezone,
        };
      }
      if (assignment.status !== 'PLANNED') {
        throw new ConflictException(
          domainError(
            409,
            'EMPLOYMENT_ASSIGNMENT_NOT_PLANNED',
            `Only a planned assignment can be activated; this one is ${assignment.status.toLowerCase()}.`,
            { status: assignment.status },
          ),
        );
      }
      if (
        assignment.employee.status !== 'ACTIVE' ||
        assignment.employee.archivedAt !== null
      ) {
        throw new ConflictException(
          domainError(
            409,
            'EMPLOYEE_NOT_ACTIVE',
            'The employee is not active; their assignments cannot be activated.',
          ),
        );
      }
      // Batch 5B (D17): no employment starts in an archived position or organization (archive
      // refuses live assignments; this covers rows older than that guard).
      if (
        assignment.position.archivedAt !== null ||
        assignment.position.organization.archivedAt !== null
      ) {
        throw new ConflictException(
          domainError(
            409,
            'POSITION_ARCHIVED',
            "The assignment's position (or its organization) is archived; it cannot be activated.",
          ),
        );
      }
      if (assignment.startDate.getTime() > today.getTime()) {
        throw new ConflictException(
          domainError(
            409,
            'EMPLOYMENT_ASSIGNMENT_NOT_STARTED',
            `The assignment starts on ${dateOnly(assignment.startDate)}; it can be activated from that date (${timezone}).`,
            {
              startDate: dateOnly(assignment.startDate),
              today: activatedOn,
              timezone,
            },
          ),
        );
      }
      if (
        assignment.endDate &&
        assignment.endDate.getTime() < today.getTime()
      ) {
        throw new ConflictException(
          domainError(
            409,
            'EMPLOYMENT_ASSIGNMENT_EXPIRED',
            `The assignment ended on ${dateOnly(assignment.endDate)} without being activated; correct or cancel it instead.`,
            {
              endDate: dateOnly(assignment.endDate),
              today: activatedOn,
              timezone,
            },
          ),
        );
      }
      const updated = await tx.employmentAssignment.updateMany({
        where: { id: assignment.id, status: 'PLANNED' },
        data: { status: 'ACTIVE' },
      });
      if (updated.count !== 1) {
        // Unreachable under the row lock; never report a transition that did not happen.
        throw new ConflictException(
          domainError(
            409,
            'EMPLOYMENT_ASSIGNMENT_NOT_PLANNED',
            'The assignment changed concurrently; reload and try again.',
          ),
        );
      }
      await this.writeAudit(
        tx,
        'EMPLOYMENT_ASSIGNMENT_ACTIVATED',
        'EmploymentAssignment',
        assignment.id,
        options.context ?? {},
        {
          employeeId: assignment.employeeId,
          positionId: assignment.positionId,
          organizationId: assignment.position.organizationId,
          source: options.source,
          activatedOn,
          timezone,
          before: { status: 'PLANNED' },
          after: { status: 'ACTIVE' },
          startDate: dateOnly(assignment.startDate),
          endDate: assignment.endDate ? dateOnly(assignment.endDate) : null,
        },
      );
      return {
        outcome: 'ACTIVATED',
        assignment: shape('ACTIVE'),
        activatedOn,
        timezone,
      };
    };
    return existingClient
      ? operation(existingClient)
      : this.prisma.$transaction(operation);
  }

  private async writeAudit(
    tx: Client,
    action: string,
    entityType: string,
    entityId: string,
    context: DomainAuditContext,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.write(
      {
        action,
        entityType,
        entityId,
        actorUserId: context.actorUserId ?? null,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
      },
      tx,
    );
  }
}

function rangesOverlap(left: DateRange, right: DateRange): boolean {
  return (
    (left.endDate === null ||
      right.startDate.getTime() <= left.endDate.getTime()) &&
    (right.endDate === null ||
      left.startDate.getTime() <= right.endDate.getTime())
  );
}

function normalizeEmployeeNumber(value: string | null | undefined) {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException('Employee number is required when provided.');
  }
  if (trimmed.length > 50) {
    throw new BadRequestException(
      'Employee number must be 50 characters or fewer.',
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed)) {
    throw new BadRequestException(
      'Employee number may contain letters, numbers, dots, underscores, slashes, and hyphens.',
    );
  }
  return trimmed;
}

export function defaultAssignmentStatus(
  startDate: Date,
  timezone: string,
  now = new Date(),
): 'PLANNED' | 'ACTIVE' {
  return dateOnly(startDate) > dateOnly(localDateOf(now, timezone))
    ? 'PLANNED'
    : 'ACTIVE';
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function resolveAssignmentTimezone(position: {
  workLocation?: { timezone: string | null } | null;
  organization?: { timezone: string | null } | null;
}) {
  for (const candidate of [
    position.workLocation?.timezone,
    position.organization?.timezone,
  ]) {
    if (candidate && isIanaTimezone(candidate)) return candidate.trim();
  }
  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'EMPLOYEE_ASSIGNMENT_TIMEZONE_UNRESOLVED',
    message:
      'The assignment position has no timezone: set a WorkLocation timezone or an organization timezone.',
  });
}

function isUniqueConstraint(error: unknown, field: string) {
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === 'string') return target.includes(field);
  return target === undefined;
}
