import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../database/prisma.service.js';
import { EmployeeDomainService } from './employee-domain.service.js';
import { EmployeeAccessService } from './employee-access.service.js';
import { assertCompensationFitsAssignment } from '../compensation/compensation-assignment.guard.js';
import { localDateOf } from '../common/domain-support.js';
import { resolveAssignmentTimezone } from './employee-domain.service.js';
import { EmployeeLifecycleService } from './employee-lifecycle.service.js';
import {
  profileAuditChanges,
  REQUIRED_PROFILE_FIELDS,
} from './employee-profile-audit.js';
import {
  assertManagerVisible,
  deriveAssignmentStatus,
  lifecycleError,
  lockEmployeeLifecycle,
  lockEmployeeTimeForLifecycle,
  lockPositions,
  optionalStrictDay,
  strictDay as lifecycleStrictDay,
} from './employee-lifecycle-support.js';
import type {
  CreateAssignmentDto,
  CreateEmployeeDto,
  CorrectAssignmentDto,
  EmployeeDirectoryQueryDto,
  EmployeeOptionQueryDto,
  EndAssignmentDto,
  ManagerAssignmentOptionQueryDto,
  PositionOptionQueryDto,
  UpdateEmployeeDto,
} from './employee.dto.js';

export interface EmployeeRequestContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}
const day = (value?: string | null) =>
  value ? new Date(`${value}T00:00:00.000Z`) : null;
const dateOnly = (value?: Date | string | null) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
};
const strictDay = (value: string, label: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new BadRequestException(`${label} must be a YYYY-MM-DD date.`);
  const parsed = day(value);
  if (!parsed || Number.isNaN(parsed.getTime()) || dateOnly(parsed) !== value)
    throw new BadRequestException(`${label} must be a valid date.`);
  return parsed;
};
const auditInput = (
  action: string,
  id: string,
  context: EmployeeRequestContext,
  metadata?: Prisma.InputJsonValue,
) => ({
  action,
  actorUserId: context.actorUserId,
  entityType: 'Employee',
  entityId: id,
  ipAddress: context.ipAddress,
  userAgent: context.userAgent,
  correlationId: context.correlationId,
  ...(metadata === undefined ? {} : { metadata }),
});

@Injectable()
export class EmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly domain: EmployeeDomainService,
    private readonly access: EmployeeAccessService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly audit: AuditService,
    private readonly lifecycle: EmployeeLifecycleService,
  ) {}

  async create(input: CreateEmployeeDto, context: EmployeeRequestContext) {
    const actor = this.requireActor(context);
    if (input.personId && input.person)
      throw new BadRequestException('Provide personId or person, not both.');
    if (!input.personId && !input.person)
      throw new BadRequestException('A personId or new person is required.');
    const employeeNumber = this.normalizeEmployeeNumber(input.employeeNumber);
    const hireDate = lifecycleStrictDay(input.hireDate, 'Hire date');
    const initialStartDate = optionalStrictDay(
      input.initialStartDate,
      'Initial start date',
    );
    const initialEndDate = optionalStrictDay(
      input.initialEndDate,
      'Initial end date',
    );
    if (input.initialPositionId)
      await this.access.assertPosition(actor, input.initialPositionId);
    else
      await this.authorization.assertAccess(actor, 'employee.manage', {
        type: 'SYSTEM',
      });
    if (input.personId && input.initialPositionId) {
      // K5: an existing person (perhaps known to another organization) becomes an employee only
      // through organization-wide or System authority, never a unit or team manager's.
      const position = await this.prisma.position.findUnique({
        where: { id: input.initialPositionId },
        select: { organizationId: true },
      });
      const allowed =
        (position &&
          (await this.authorization.canAccess(actor, 'employee.manage', {
            type: 'ORGANIZATION',
            id: position.organizationId,
          }))) ||
        (await this.authorization.can(
          actor,
          'employee.manage',
          { type: 'SYSTEM' },
          new Date(),
        ));
      if (!allowed) throw new NotFoundException('Person not found.');
    }
    return this.prisma.$transaction(async (tx) => {
      const person = input.personId
        ? await tx.person.findUnique({ where: { id: input.personId } })
        : await tx.person.create({
            data: {
              firstName: input.person?.firstName,
              middleName: input.person?.middleName,
              lastName: input.person?.lastName,
              preferredName: input.person?.preferredName,
              personalEmail: input.person?.personalEmail,
              phone: input.person?.phone,
            },
          });
      if (!person) throw new NotFoundException('Person not found.');
      if (await tx.employee.findUnique({ where: { personId: person.id } }))
        throw new ConflictException('Person is already an employee.');
      if (
        employeeNumber &&
        (await tx.employee.findUnique({ where: { employeeNumber } }))
      )
        throw new ConflictException('Employee number is already in use.');
      const createdEmployeeNumber =
        employeeNumber ?? (await this.nextEmployeeNumber(tx));
      let employee;
      try {
        employee = await tx.employee.create({
          data: {
            personId: person.id,
            employeeNumber: createdEmployeeNumber,
            hireDate,
          },
        });
      } catch (error) {
        if (this.isUniqueConstraint(error, 'employeeNumber'))
          throw new ConflictException('Employee number is already in use.');
        if (this.isUniqueConstraint(error, 'personId'))
          throw new ConflictException('Person is already an employee.');
        throw error;
      }
      await this.audit.write(
        auditInput('EMPLOYEE_CREATED', employee.id, context),
        tx,
      );
      if (input.initialPositionId) {
        if (!input.initialEmploymentType || !input.initialStartDate)
          throw new BadRequestException(
            'Initial assignment details are required.',
          );
        if (input.initialManagerAssignmentId)
          await assertManagerVisible(
            tx,
            this.access,
            actor,
            input.initialManagerAssignmentId,
          );
        await this.domain.createAssignment(
          {
            employeeId: employee.id,
            positionId: input.initialPositionId,
            employmentType: input.initialEmploymentType,
            startDate: initialStartDate!,
            endDate: initialEndDate,
            isPrimary: input.initialPrimary,
            managerAssignmentId: input.initialManagerAssignmentId,
          },
          context,
          tx,
        );
      }
      return this.safeEmployee(
        await tx.employee.findUniqueOrThrow({
          where: { id: employee.id },
          include: { person: true },
        }),
      );
    });
  }

  async update(
    id: string,
    input: UpdateEmployeeDto,
    context: EmployeeRequestContext,
  ) {
    const actor = this.requireActor(context);
    // R4-A.2: `null` clears an optional field and an omitted field is unchanged; the legal names
    // can be corrected but never cleared.
    // Blank text (only spaces) would clear the name just as null would.
    const clearedRequired = REQUIRED_PROFILE_FIELDS.filter((field) => {
      const value: unknown = input[field];
      return (
        value === null || (typeof value === 'string' && value.trim() === '')
      );
    });
    if (clearedRequired.length > 0)
      throw new BadRequestException(
        lifecycleError(
          400,
          'PROFILE_REQUIRED_FIELD',
          'The legal first and last name cannot be cleared.',
          { fields: clearedRequired },
        ),
      );
    return this.prisma.$transaction(async (tx) => {
      // K10: profile data is employee-wide — employee.manage over every current assignment, or
      // SYSTEM.
      await lockEmployeeLifecycle(tx, id);
      const authority = await this.access.authorizeEmployeeWide(
        actor,
        id,
        { referenceDate: localDateOf(new Date(), 'UTC') },
        tx,
      );
      const employee = await tx.employee.findUnique({
        where: { id },
        include: { person: true },
      });
      if (!employee) throw new NotFoundException('Employee not found');
      const updated = await tx.person.update({
        where: { id: employee.personId },
        data: {
          firstName: input.firstName,
          middleName: input.middleName,
          lastName: input.lastName,
          preferredName: input.preferredName,
          personalEmail: input.personalEmail,
          phone: input.phone,
        },
      });
      // R4-A.2: what changed, with values before and after (contact details masked); see
      // employee-profile-audit.ts.
      await this.audit.write(
        auditInput('EMPLOYEE_UPDATED', id, context, {
          ...profileAuditChanges(employee.person, input),
          authority: authority.authority,
        }),
        tx,
      );
      return this.safeEmployee({ ...employee, person: updated });
    });
  }

  async directory(query: EmployeeDirectoryQueryDto, userId: string) {
    const limit = query.limit ?? 50;
    const systemRead = await this.authorization.can(userId, 'employee.read', {
      type: 'SYSTEM',
    });
    const filteredPosition: Prisma.PositionWhereInput | null =
      query.organizationId || query.jobTitleId
        ? {
            ...(query.organizationId
              ? { organizationId: query.organizationId }
              : {}),
            ...(query.jobTitleId ? { jobTitleId: query.jobTitleId } : {}),
          }
        : null;
    const assignmentFilter: Prisma.EmployeeWhereInput = filteredPosition
      ? {
          assignments: {
            some: { status: { not: 'CANCELLED' }, position: filteredPosition },
          },
        }
      : !systemRead
        ? { assignments: { some: { status: { not: 'CANCELLED' } } } }
        : {};
    // Phase 19: the page is filled batch by batch and the scan stops as soon as one more
    // visible employee proves there is a next page (it used to read the whole table on every
    // call, and its cursor pointed past the end). Position checks are memoized per request.
    const memo = new Map<string, Promise<boolean>>();
    const canRead = (positionId: string) => {
      let hit = memo.get(positionId);
      if (!hit) {
        hit = this.access.canPosition(userId, positionId, 'employee.read');
        memo.set(positionId, hit);
      }
      return hit;
    };
    const visible = [];
    let cursor = query.afterId;
    let exhausted = false;
    let more = false;
    let lastIncluded: string | null = null;
    while (!exhausted && !more) {
      const batch = await this.prisma.employee.findMany({
        where: {
          archivedAt: null,
          ...(query.status ? { status: query.status } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
          ...(query.search
            ? {
                OR: [
                  {
                    employeeNumber: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  },
                  {
                    person: {
                      firstName: {
                        contains: query.search,
                        mode: 'insensitive',
                      },
                    },
                  },
                  {
                    person: {
                      lastName: { contains: query.search, mode: 'insensitive' },
                    },
                  },
                  {
                    person: {
                      preferredName: {
                        contains: query.search,
                        mode: 'insensitive',
                      },
                    },
                  },
                ],
              }
            : {}),
          ...assignmentFilter,
        },
        include: {
          person: true,
          assignments: {
            where: { status: { not: 'CANCELLED' } },
            include: {
              position: {
                include: {
                  jobTitle: true,
                  organization: true,
                  organizationalUnit: true,
                  department: true,
                  team: true,
                  workLocation: true,
                },
              },
            },
            orderBy: { startDate: 'desc' },
          },
        },
        orderBy: { id: 'asc' },
        take: Math.max(limit, 50),
      });
      if (!batch.length) {
        exhausted = true;
        break;
      }
      for (const row of batch) {
        const assignments: any[] = [];
        for (const assignment of row.assignments) {
          if (await canRead(assignment.positionId)) {
            assignments.push(
              await this.assignmentShape(assignment, userId, canRead),
            );
          }
        }
        assignments.sort(
          (a, b) =>
            Number(b.isPrimary) - Number(a.isPrimary) ||
            a.startDate.localeCompare(b.startDate) * -1 ||
            a.id.localeCompare(b.id),
        );
        if (assignments.length || systemRead) {
          if (visible.length >= limit) {
            more = true;
            break;
          }
          visible.push({
            id: row.id,
            employeeNumber: row.employeeNumber,
            status: row.status,
            // Batch 5C: an ACTIVE employee with a date has a scheduled termination (no reason).
            terminationDate: row.terminationDate
              ? dateOnly(row.terminationDate)
              : null,
            person: this.personShape(row.person),
            displayAssignment: assignments[0] ?? null,
          });
        }
        lastIncluded = row.id;
      }
      cursor = batch[batch.length - 1]!.id;
      exhausted = batch.length < Math.max(limit, 50);
    }
    return { items: visible, nextAfterId: more ? lastIncluded : null };
  }

  /**
   * The signed-in user's own employee record, read-only (My Profile). Resolved only from the
   * caller's account (user → person → employee), never from a client-supplied id, so it can
   * never return another employee. Needs no permission. The manager is reduced to name and
   * position; cancelled assignments are omitted.
   */
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        person: {
          select: { employee: { select: { id: true, archivedAt: true } } },
        },
      },
    });
    const employee = user?.person.employee;
    if (!employee || employee.archivedAt)
      throw new NotFoundException(
        'No employee record is linked to your account.',
      );
    const row = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employee.id },
      include: {
        person: true,
        assignments: {
          where: { status: { not: 'CANCELLED' } },
          include: {
            position: {
              include: {
                jobTitle: true,
                organization: true,
                organizationalUnit: true,
                department: true,
                team: true,
                workLocation: true,
              },
            },
            manager: {
              include: {
                employee: { include: { person: true } },
                position: true,
              },
            },
          },
          orderBy: { startDate: 'asc' },
        },
      },
    });
    const today = day(dateOnly(new Date()))!;
    const shaped: Array<{ source: any; value: any }> = [];
    for (const assignment of row.assignments) {
      const value = await this.assignmentShape(
        assignment,
        userId,
        async () => true,
      );
      shaped.push({
        source: assignment,
        value: {
          ...value,
          manager: value.manager
            ? {
                displayName: value.manager.displayName,
                positionName: value.manager.positionName,
              }
            : null,
        },
      });
    }
    const values = (predicate: (a: any) => boolean) =>
      shaped.filter((item) => predicate(item.source)).map((item) => item.value);
    return {
      id: row.id,
      employeeNumber: row.employeeNumber,
      status: row.status,
      hireDate: dateOnly(row.hireDate),
      terminationDate: dateOnly(row.terminationDate),
      person: this.personShape(row.person, true),
      assignments: {
        current: values((a) => EmployeeDomainService.isEffectiveOn(a, today)),
        upcoming: values((a) => a.startDate > today),
        historical: values((a) => a.endDate !== null && a.endDate < today),
      },
    };
  }

  async profile(id: string, userId: string) {
    const row = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        person: true,
        assignments: {
          include: {
            position: {
              include: {
                jobTitle: true,
                organization: true,
                organizationalUnit: true,
                department: true,
                team: true,
                workLocation: true,
              },
            },
            manager: {
              include: {
                employee: { include: { person: true } },
                position: true,
              },
            },
          },
          orderBy: { startDate: 'asc' },
        },
      },
    });
    if (!row) throw new NotFoundException('Employee not found');
    const visible = [];
    let employeeVisible = false;
    const systemRead = await this.authorization.can(userId, 'employee.read', {
      type: 'SYSTEM',
    });
    for (const assignment of row.assignments) {
      const readable = await this.access.canPosition(
        userId,
        assignment.positionId,
        'employee.read',
      );
      if (readable && assignment.status !== 'CANCELLED') employeeVisible = true;
      if (readable) visible.push(assignment);
    }
    if (!employeeVisible && !systemRead)
      throw new NotFoundException('Employee not found');
    const today = day(dateOnly(new Date()))!;
    const shaped: any[] = [];
    for (const assignment of visible) {
      const value = await this.assignmentShape(assignment, userId);
      shaped.push({ source: assignment, value });
    }
    const values = (predicate: (a: any) => boolean) =>
      shaped.filter((item) => predicate(item.source)).map((item) => item.value);
    return {
      id: row.id,
      employeeNumber: row.employeeNumber,
      status: row.status,
      hireDate: dateOnly(row.hireDate),
      terminationDate: dateOnly(row.terminationDate),
      person: this.personShape(row.person, true),
      assignments: {
        current: values(
          (a) =>
            a.status !== 'CANCELLED' &&
            EmployeeDomainService.isEffectiveOn(a, today),
        ),
        upcoming: values(
          (a) => a.status !== 'CANCELLED' && a.startDate > today,
        ),
        historical: values(
          (a) =>
            a.status !== 'CANCELLED' && a.endDate !== null && a.endDate < today,
        ),
        cancelled: values((a) => a.status === 'CANCELLED'),
      },
    };
  }

  async peopleOptions(query: EmployeeOptionQueryDto, userId: string) {
    await this.authorization.assertAccess(userId, 'employee.manage', {
      type: 'SYSTEM',
    });
    const limit = this.optionLimit(query.limit);
    const rows: any[] = [];
    let cursor = query.afterId;
    let exhausted = false;
    let lastExamined: string | null = null;
    while (rows.length < limit && !exhausted) {
      const batch = await this.prisma.person.findMany({
        where: {
          archivedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
          ...(query.search
            ? {
                OR: [
                  {
                    firstName: { contains: query.search, mode: 'insensitive' },
                  },
                  {
                    middleName: { contains: query.search, mode: 'insensitive' },
                  },
                  { lastName: { contains: query.search, mode: 'insensitive' } },
                  {
                    preferredName: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  },
                  {
                    personalEmail: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          firstName: true,
          middleName: true,
          lastName: true,
          preferredName: true,
          personalEmail: true,
          employee: { select: { id: true } },
          user: { select: { id: true } },
        },
        orderBy: { id: 'asc' },
        take: this.sourceBatchSize(limit),
      });
      if (!batch.length) {
        exhausted = true;
        break;
      }
      let reachedLimit = false;
      for (const person of batch) {
        lastExamined = person.id;
        rows.push({
          id: person.id,
          firstName: person.firstName ?? null,
          middleName: person.middleName ?? null,
          lastName: person.lastName ?? null,
          preferredName: person.preferredName ?? null,
          personalEmail: person.personalEmail ?? null,
          hasEmployee: Boolean(person.employee),
          hasUser: Boolean(person.user),
        });
        if (rows.length >= limit) {
          reachedLimit = true;
          break;
        }
      }
      cursor = lastExamined ?? cursor;
      exhausted = reachedLimit
        ? false
        : batch.length < this.sourceBatchSize(limit);
    }
    return {
      items: rows,
      nextAfterId: !exhausted && lastExamined ? lastExamined : null,
    };
  }

  async positionOptions(query: PositionOptionQueryDto, userId: string) {
    const limit = this.optionLimit(query.limit);
    const grants = await this.authorization.effectiveGrants(userId);
    const items: any[] = [];
    let cursor = query.afterId;
    let exhausted = false;
    let lastExamined: string | null = null;
    while (items.length < limit && !exhausted) {
      const batch = await this.prisma.position.findMany({
        where: {
          archivedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
          ...(query.organizationId
            ? { organizationId: query.organizationId }
            : {}),
          ...(query.search
            ? {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' } },
                  { code: { contains: query.search, mode: 'insensitive' } },
                  {
                    jobTitle: {
                      name: { contains: query.search, mode: 'insensitive' },
                    },
                  },
                  {
                    jobTitle: {
                      code: { contains: query.search, mode: 'insensitive' },
                    },
                  },
                  {
                    organization: {
                      name: { contains: query.search, mode: 'insensitive' },
                    },
                  },
                  {
                    organization: {
                      code: { contains: query.search, mode: 'insensitive' },
                    },
                  },
                ],
              }
            : {}),
        },
        include: {
          jobTitle: true,
          organization: true,
          organizationalUnit: true,
          department: true,
          team: true,
          workLocation: true,
        },
        orderBy: { id: 'asc' },
        take: this.sourceBatchSize(limit),
      });
      if (!batch.length) {
        exhausted = true;
        break;
      }
      let reachedLimit = false;
      for (const position of batch) {
        lastExamined = position.id;
        const target = await this.targets.resolvePosition(position.id);
        if (!permissionIsGranted(grants, 'employee.manage', target)) continue;
        items.push(this.positionOptionShape(position));
        if (items.length >= limit) {
          reachedLimit = true;
          break;
        }
      }
      cursor = lastExamined ?? cursor;
      exhausted = reachedLimit
        ? false
        : batch.length < this.sourceBatchSize(limit);
    }
    return {
      items,
      nextAfterId: !exhausted && lastExamined ? lastExamined : null,
    };
  }

  /**
   * The assignment a manager is being chosen for: an existing one, or (Batch 5C) a new one
   * described by its position and dates. Either way the caller needs employee.manage on the
   * position, and managers come from that position's organization over overlapping dates.
   */
  private async managerOptionSubject(
    query: ManagerAssignmentOptionQueryDto,
    userId: string,
  ): Promise<{
    id: string | null;
    excludeEmployeeId: string | null;
    startDate: Date;
    endDate: Date | null;
    position: { organizationId: string };
  }> {
    if (query.subordinateAssignmentId) {
      const subordinate = await this.prisma.employmentAssignment.findUnique({
        where: { id: query.subordinateAssignmentId },
        include: { position: { select: { organizationId: true } } },
      });
      if (!subordinate) throw new NotFoundException('Assignment not found');
      await this.access.assertPosition(
        userId,
        subordinate.positionId,
        'employee.manage',
      );
      return {
        id: subordinate.id,
        excludeEmployeeId: null,
        startDate: subordinate.startDate,
        endDate: subordinate.endDate,
        position: subordinate.position,
      };
    }
    const position = await this.prisma.position.findUnique({
      where: { id: query.positionId! },
      select: { id: true, organizationId: true },
    });
    if (!position) throw new NotFoundException('Position not found');
    await this.access.assertPosition(userId, position.id, 'employee.manage');
    const startDate = strictDay(query.startDate!, 'startDate');
    const endDate = query.endDate ? strictDay(query.endDate, 'endDate') : null;
    if (endDate && endDate.getTime() < startDate.getTime())
      throw new BadRequestException('endDate must be on or after startDate.');
    return {
      id: null,
      excludeEmployeeId: query.employeeId ?? null,
      startDate,
      endDate,
      position,
    };
  }

  async managerAssignmentOptions(
    query: ManagerAssignmentOptionQueryDto,
    userId: string,
  ) {
    const subordinate = await this.managerOptionSubject(query, userId);
    const limit = this.optionLimit(query.limit);
    const readGrants = await this.authorization.effectiveGrants(userId);
    const items: any[] = [];
    let cursor = query.afterId;
    let exhausted = false;
    let lastExamined: string | null = null;
    while (items.length < limit && !exhausted) {
      const batch = await this.prisma.employmentAssignment.findMany({
        where: {
          id: {
            ...(cursor ? { gt: cursor } : {}),
            ...(subordinate.id ? { not: subordinate.id } : {}),
          },
          ...(subordinate.excludeEmployeeId
            ? { employeeId: { not: subordinate.excludeEmployeeId } }
            : {}),
          status: { not: 'CANCELLED' },
          // Batch 5B (K7): managers come from the subordinate's own organization.
          position: { organizationId: subordinate.position.organizationId },
          startDate: {
            lte: subordinate.endDate ?? new Date('9999-12-31T00:00:00.000Z'),
          },
          OR: [{ endDate: null }, { endDate: { gte: subordinate.startDate } }],
          ...(query.search
            ? {
                AND: [
                  {
                    OR: [
                      {
                        employee: {
                          employeeNumber: {
                            contains: query.search,
                            mode: 'insensitive',
                          },
                        },
                      },
                      {
                        employee: {
                          person: {
                            firstName: {
                              contains: query.search,
                              mode: 'insensitive',
                            },
                          },
                        },
                      },
                      {
                        employee: {
                          person: {
                            lastName: {
                              contains: query.search,
                              mode: 'insensitive',
                            },
                          },
                        },
                      },
                      {
                        employee: {
                          person: {
                            preferredName: {
                              contains: query.search,
                              mode: 'insensitive',
                            },
                          },
                        },
                      },
                      {
                        position: {
                          name: { contains: query.search, mode: 'insensitive' },
                        },
                      },
                      {
                        position: {
                          code: { contains: query.search, mode: 'insensitive' },
                        },
                      },
                      {
                        position: {
                          jobTitle: {
                            name: {
                              contains: query.search,
                              mode: 'insensitive',
                            },
                          },
                        },
                      },
                    ],
                  },
                ],
              }
            : {}),
        },
        include: {
          employee: { include: { person: true } },
          position: { include: { jobTitle: true, organization: true } },
        },
        orderBy: { id: 'asc' },
        take: this.sourceBatchSize(limit),
      });
      if (!batch.length) {
        exhausted = true;
        break;
      }
      let reachedLimit = false;
      for (const assignment of batch) {
        lastExamined = assignment.id;
        const target = await this.targets.resolvePosition(
          assignment.positionId,
        );
        if (!permissionIsGranted(readGrants, 'employee.read', target)) continue;
        items.push({
          assignmentId: assignment.id,
          employeeId: assignment.employeeId,
          employeeNumber: assignment.employee.employeeNumber,
          displayName: this.displayName(assignment.employee.person),
          position: {
            id: assignment.position.id,
            name: assignment.position.name,
            code: assignment.position.code,
          },
          jobTitle: {
            id: assignment.position.jobTitle.id,
            name: assignment.position.jobTitle.name,
            code: assignment.position.jobTitle.code,
          },
          organization: {
            id: assignment.position.organization.id,
            name: assignment.position.organization.name,
            code: assignment.position.organization.code,
          },
          startDate: dateOnly(assignment.startDate),
          endDate: dateOnly(assignment.endDate),
          status: assignment.status,
        });
        if (items.length >= limit) {
          reachedLimit = true;
          break;
        }
      }
      cursor = lastExamined ?? cursor;
      exhausted = reachedLimit
        ? false
        : batch.length < this.sourceBatchSize(limit);
    }
    return {
      items,
      nextAfterId: !exhausted && lastExamined ? lastExamined : null,
    };
  }

  /**
   * Batch 5A: a new assignment for an existing employee. Its status is derived from its dates in
   * the position's time zone (R5: a different requested status is 400 ASSIGNMENT_STATUS_DERIVED).
   * The employee must be ACTIVE and have no scheduled termination; attaching an employee the
   * caller cannot already see needs organization-wide authority and the confirmed employee number
   * (K5); one's own record needs SYSTEM authority (K12).
   */
  async createAssignment(
    employeeId: string,
    input: CreateAssignmentDto,
    context: EmployeeRequestContext,
    now = new Date(),
  ) {
    const actor = this.requireActor(context);
    const startDate = lifecycleStrictDay(input.startDate, 'Start date');
    const endDate = optionalStrictDay(input.endDate, 'End date');
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      await this.access.assertPosition(
        actor,
        input.positionId,
        'employee.manage',
        tx,
      );
      const employee = await tx.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, employeeNumber: true, status: true },
      });
      if (!employee) throw new NotFoundException('Employee not found');
      const attach = await this.access.authorizeAttach(
        actor,
        employee,
        input.positionId,
        input.attachEmployeeNumber,
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'CREATE_ASSIGNMENT',
        context,
        tx,
      );
      if (employee.status !== 'ACTIVE') {
        throw new ConflictException(
          lifecycleError(
            409,
            'EMPLOYEE_NOT_ACTIVE',
            employee.status === 'TERMINATED'
              ? 'The employee is terminated; rehire them into the new assignment instead.'
              : 'The employee is inactive; reactivate them first.',
          ),
        );
      }
      await this.assertNoScheduledTermination(tx, employeeId);
      const position = await tx.position.findUnique({
        where: { id: input.positionId },
        include: {
          workLocation: { select: { timezone: true } },
          organization: { select: { timezone: true } },
        },
      });
      if (!position || position.archivedAt)
        throw new BadRequestException('Position is not available.');
      const derived = deriveAssignmentStatus(
        startDate,
        endDate,
        localDateOf(now, resolveAssignmentTimezone(position)),
      );
      if (input.status !== undefined && input.status !== derived) {
        throw new BadRequestException(
          lifecycleError(
            400,
            'ASSIGNMENT_STATUS_DERIVED',
            `An assignment's status follows from its dates; these dates make it ${derived}.`,
            { requested: input.status, derived },
          ),
        );
      }
      await lockPositions(tx, [input.positionId]);
      // Batch 5B: an explicit manager needs the visibility set-manager requires.
      if (input.managerAssignmentId)
        await assertManagerVisible(
          tx,
          this.access,
          actor,
          input.managerAssignmentId,
        );
      const assignment = await this.domain.createAssignment(
        {
          employeeId,
          positionId: input.positionId,
          employmentType: input.employmentType,
          status: derived,
          startDate,
          endDate,
          isPrimary: input.isPrimary,
          managerAssignmentId: input.managerAssignmentId,
        },
        context,
        tx,
      );
      if (attach.authority !== 'VISIBLE') {
        await this.audit.write(
          {
            ...auditInput('EMPLOYEE_ATTACHED', employeeId, context, {
              employmentAssignmentId: assignment.id,
              positionId: input.positionId,
              organizationId: position.organizationId,
              authority: attach.authority,
            }),
          },
          tx,
        );
      }
      return assignment;
    });
  }

  /**
   * Corrects an assignment's employment type and dates. The stored status must stay compatible
   * with the new dates (an ACTIVE assignment may become overdue, a PLANNED one due; an ENDED one
   * cannot reopen and an ACTIVE one cannot move into the future), no finalized or recorded time may
   * fall outside the new dates, and with a scheduled termination the end stays on or before it.
   */
  async correctAssignment(
    employeeId: string,
    assignmentId: string,
    input: CorrectAssignmentDto,
    context: EmployeeRequestContext,
    now = new Date(),
  ) {
    const actor = this.requireActor(context);
    const startDate = lifecycleStrictDay(input.startDate, 'Start date');
    const endDate = optionalStrictDay(input.endDate, 'End date');
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const old = await tx.employmentAssignment.findFirst({
        where: { id: assignmentId, employeeId },
        include: {
          position: {
            include: {
              workLocation: { select: { timezone: true } },
              organization: { select: { timezone: true } },
            },
          },
        },
      });
      if (!old) throw new NotFoundException('Assignment not found');
      await this.access.assertPosition(
        actor,
        old.positionId,
        'employee.manage',
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'CORRECT_ASSIGNMENT',
        context,
        tx,
      );
      if (old.status === 'CANCELLED')
        throw new ConflictException(
          lifecycleError(
            409,
            'ASSIGNMENT_NOT_OPEN',
            'A cancelled assignment cannot be corrected.',
          ),
        );
      await lockPositions(tx, [old.positionId]);
      await lockEmployeeTimeForLifecycle(tx, employeeId);
      const derived = deriveAssignmentStatus(
        startDate,
        endDate,
        localDateOf(now, this.timezoneOf(old.position)),
      );
      const compatible =
        derived === old.status ||
        (old.status === 'ACTIVE' && derived === 'ENDED') ||
        (old.status === 'PLANNED' && derived === 'ACTIVE');
      if (!compatible) {
        throw new ConflictException(
          lifecycleError(
            409,
            'ASSIGNMENT_STATUS_CONFLICT',
            `These dates would make a ${old.status} assignment ${derived}; that change is not a correction.`,
            { status: old.status, derived },
          ),
        );
      }
      await this.assertWithinScheduledTermination(tx, old, endDate);
      await this.lifecycle.assertNoFinalizedBlockers(tx, old, {
        start: startDate,
        end: endDate,
      });
      await this.validateAssignment(tx, {
        ...old,
        employmentType: input.employmentType,
        startDate,
        endDate,
      });
      await assertCompensationFitsAssignment(tx, assignmentId, {
        status: old.status,
        startDate,
        endDate,
      });
      const updated = await tx.employmentAssignment.update({
        where: { id: assignmentId },
        data: { employmentType: input.employmentType, startDate, endDate },
      });
      await this.audit.write(
        {
          ...auditInput(
            'EMPLOYMENT_ASSIGNMENT_UPDATED',
            assignmentId,
            context,
            {
              employeeId,
              before: {
                employmentType: old.employmentType,
                startDate: dateOnly(old.startDate),
                endDate: dateOnly(old.endDate),
              },
              after: {
                employmentType: input.employmentType,
                startDate: dateOnly(startDate),
                endDate: dateOnly(endDate),
              },
            },
          ),
          entityType: 'EmploymentAssignment',
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Sets the last day of an ACTIVE or PLANNED assignment. A date still to come keeps the status
   * (the assignment ends once the date has passed in its time zone: the end job, or the manual
   * apply); a date already past ends it now.
   */
  async endAssignment(
    employeeId: string,
    assignmentId: string,
    input: EndAssignmentDto,
    context: EmployeeRequestContext,
    now = new Date(),
  ) {
    const end = lifecycleStrictDay(input.endDate, 'End date');
    return this.assignmentMutation(
      employeeId,
      assignmentId,
      context,
      'END_ASSIGNMENT',
      async (tx, a) => {
        if (a.status !== 'ACTIVE' && a.status !== 'PLANNED')
          throw new ConflictException(
            lifecycleError(
              409,
              'ASSIGNMENT_NOT_OPEN',
              'Only an active or planned assignment can be ended.',
            ),
          );
        if (end < a.startDate)
          throw new BadRequestException('End date precedes start date.');
        await this.assertWithinScheduledTermination(tx, a, end);
        await this.lifecycle.assertNoFinalizedBlockers(tx, a, {
          start: a.startDate,
          end,
        });
        const today = localDateOf(now, this.timezoneOf(a.position));
        const endsNow = a.status === 'ACTIVE' && end < today;
        const status = endsNow ? 'ENDED' : a.status;
        await assertCompensationFitsAssignment(tx, assignmentId, {
          status,
          startDate: a.startDate,
          endDate: end,
        });
        const updated = await tx.employmentAssignment.update({
          where: { id: assignmentId },
          data: { endDate: end, status },
        });
        return {
          result: updated,
          before: { status: a.status, endDate: dateOnly(a.endDate) },
          after: { status, endDate: dateOnly(end) },
        };
      },
      'EMPLOYMENT_ASSIGNMENT_ENDED',
    );
  }
  async cancelAssignment(
    employeeId: string,
    assignmentId: string,
    context: EmployeeRequestContext,
    now = new Date(),
  ) {
    return this.assignmentMutation(
      employeeId,
      assignmentId,
      context,
      'CANCEL_ASSIGNMENT',
      async (tx, a) => {
        // A planned assignment whose start is still to come in its own time zone.
        const today = localDateOf(now, this.timezoneOf(a.position));
        if (a.status !== 'PLANNED' || a.startDate <= today)
          throw new BadRequestException(
            'Only future planned assignments may be cancelled.',
          );
        if (await this.inScheduledTermination(tx, a.id))
          throw new ConflictException(
            lifecycleError(
              409,
              'ASSIGNMENT_IN_SCHEDULED_TERMINATION',
              'This assignment is part of a scheduled termination; cancel or reschedule the termination first.',
            ),
          );
        await this.lifecycle.assertNoFinalizedBlockers(tx, a, null);
        await assertCompensationFitsAssignment(tx, assignmentId, {
          status: 'CANCELLED',
          startDate: a.startDate,
          endDate: a.endDate,
        });
        const updated = await tx.employmentAssignment.update({
          where: { id: assignmentId },
          data: { status: 'CANCELLED' },
        });
        return {
          result: updated,
          before: { status: a.status },
          after: { status: 'CANCELLED' },
        };
      },
      'EMPLOYMENT_ASSIGNMENT_CANCELLED',
    );
  }
  /**
   * PLANNED → ACTIVE once the start date has arrived (the same transition the recurring worker
   * makes). Requires employee.manage in the assignment position's scope, so another
   * organization's assignment is refused; the domain rules, lock and audit are shared.
   */
  async activateAssignment(
    employeeId: string,
    assignmentId: string,
    context: EmployeeRequestContext,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const assignment = await tx.employmentAssignment.findFirst({
        where: { id: assignmentId, employeeId },
        select: { id: true, positionId: true },
      });
      if (!assignment) throw new NotFoundException('Assignment not found');
      await this.access.assertPosition(
        actor,
        assignment.positionId,
        'employee.manage',
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'ACTIVATE_ASSIGNMENT',
        context,
        tx,
      );
      const result = await this.domain.activateAssignment(
        assignmentId,
        { source: 'MANUAL', context, employeeId },
        tx,
      );
      return {
        outcome: result.outcome,
        activatedOn: result.activatedOn,
        timezone: result.timezone,
        assignment: {
          ...result.assignment,
          startDate: dateOnly(result.assignment.startDate),
          endDate: dateOnly(result.assignment.endDate),
        },
      };
    });
  }
  async setPrimary(
    employeeId: string,
    assignmentId: string,
    isPrimary: boolean,
    context: EmployeeRequestContext,
  ) {
    return this.assignmentMutation(
      employeeId,
      assignmentId,
      context,
      'SET_PRIMARY_ASSIGNMENT',
      async (tx, a) => {
        if (isPrimary)
          await this.validatePrimary(
            tx,
            employeeId,
            a.startDate,
            a.endDate,
            assignmentId,
          );
        const updated = await tx.employmentAssignment.update({
          where: { id: assignmentId },
          data: { isPrimary },
        });
        return {
          result: updated,
          before: { isPrimary: a.isPrimary },
          after: { isPrimary },
        };
      },
      'EMPLOYMENT_ASSIGNMENT_PRIMARY_CHANGED',
    );
  }
  async setManager(
    employeeId: string,
    assignmentId: string,
    managerId: string | undefined,
    context: EmployeeRequestContext,
  ) {
    return this.assignmentMutation(
      employeeId,
      assignmentId,
      context,
      'SET_ASSIGNMENT_MANAGER',
      async (tx, a) => {
        if (managerId) {
          const manager = await tx.employmentAssignment.findUnique({
            where: { id: managerId },
            select: {
              id: true,
              employeeId: true,
              positionId: true,
              status: true,
              startDate: true,
              endDate: true,
              managerAssignmentId: true,
            },
          });
          if (!manager)
            throw new NotFoundException('Manager assignment not found');
          await this.access.assertPosition(
            context.actorUserId!,
            manager.positionId,
            'employee.read',
            tx,
          );
          await this.domain.validateManagerRelationship(tx, a, manager);
          if (managerId !== a.managerAssignmentId)
            await this.domain.assertManagerSameOrganization(
              tx,
              a.positionId,
              manager.positionId,
            );
        }
        const updated = await tx.employmentAssignment.update({
          where: { id: assignmentId },
          data: { managerAssignmentId: managerId ?? null },
        });
        return {
          result: updated,
          before: { managerAssignmentId: a.managerAssignmentId },
          after: { managerAssignmentId: managerId ?? null },
        };
      },
      'EMPLOYMENT_ASSIGNMENT_MANAGER_CHANGED',
    );
  }

  /**
   * K5: finds an employee by exact employee number for attaching them to a position of an
   * organization the caller manages organization-wide. Minimal fields; every lookup is audited.
   */
  async attachLookup(
    organizationId: string,
    employeeNumber: string,
    context: EmployeeRequestContext,
  ) {
    const actor = this.requireActor(context);
    const allowed =
      (await this.authorization.canAccess(actor, 'employee.manage', {
        type: 'ORGANIZATION',
        id: organizationId,
      })) ||
      (await this.authorization.can(
        actor,
        'employee.manage',
        { type: 'SYSTEM' },
        new Date(),
      ));
    if (!allowed)
      throw new ForbiddenException(
        'Attaching existing employees needs organization-wide employee management.',
      );
    const number = employeeNumber.trim();
    const employee = number
      ? await this.prisma.employee.findUnique({
          where: { employeeNumber: number },
          select: {
            id: true,
            employeeNumber: true,
            status: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        })
      : null;
    await this.audit.write({
      ...auditInput('EMPLOYEE_ATTACH_LOOKUP', organizationId, context, {
        employeeNumber: number,
        found: Boolean(employee),
        employeeId: employee?.id ?? null,
      }),
      entityType: 'Organization',
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    return {
      id: employee.id,
      employeeNumber: employee.employeeNumber,
      status: employee.status,
      displayName:
        [
          employee.person.preferredName ?? employee.person.firstName,
          employee.person.lastName,
        ]
          .filter(Boolean)
          .join(' ') || null,
    };
  }

  private async assignmentMutation(
    employeeId: string,
    assignmentId: string,
    context: EmployeeRequestContext,
    lifecycleAction: string,
    mutate: (
      tx: Prisma.TransactionClient,
      a: any,
    ) => Promise<{
      result: any;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>,
    action: string,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const a = await tx.employmentAssignment.findFirst({
        where: { id: assignmentId, employeeId },
        include: {
          position: {
            include: {
              workLocation: { select: { timezone: true } },
              organization: { select: { timezone: true } },
            },
          },
        },
      });
      if (!a) throw new NotFoundException('Assignment not found');
      await this.access.assertPosition(
        actor,
        a.positionId,
        'employee.manage',
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        lifecycleAction,
        context,
        tx,
      );
      await lockPositions(tx, [a.positionId]);
      // Before any finalized-records check: time capture serializes on the same lock.
      await lockEmployeeTimeForLifecycle(tx, employeeId);
      const change = await mutate(tx, a);
      await this.audit.write(
        {
          ...auditInput(action, assignmentId, context, {
            employeeId,
            before: change.before,
            after: change.after,
          } as Prisma.InputJsonValue),
          entityType: 'EmploymentAssignment',
        },
        tx,
      );
      return change.result;
    });
  }

  private timezoneOf(position: {
    workLocation?: { timezone: string | null } | null;
    organization?: { timezone: string | null } | null;
  }) {
    try {
      return resolveAssignmentTimezone(position);
    } catch {
      return 'UTC';
    }
  }

  private async assertNoScheduledTermination(
    tx: Prisma.TransactionClient,
    employeeId: string,
  ) {
    const scheduled = await tx.employeeTermination.findFirst({
      where: { employeeId, status: 'SCHEDULED' },
      select: { id: true, terminationDate: true },
    });
    if (scheduled)
      throw new ConflictException(
        lifecycleError(
          409,
          'TERMINATION_SCHEDULED',
          `A termination is scheduled for ${dateOnly(scheduled.terminationDate)}; cancel or reschedule it first.`,
          { terminationId: scheduled.id },
        ),
      );
  }

  private async inScheduledTermination(
    tx: Prisma.TransactionClient,
    assignmentId: string,
  ) {
    return (
      (await tx.employeeTerminationAssignment.count({
        where: {
          employmentAssignmentId: assignmentId,
          appliedAt: null,
          termination: { status: 'SCHEDULED' },
        },
      })) > 0
    );
  }

  /** With a termination scheduled, an open assignment's end stays on or before its date. */
  private async assertWithinScheduledTermination(
    tx: Prisma.TransactionClient,
    a: { employeeId: string; status: string },
    endDate: Date | null,
  ) {
    if (a.status !== 'ACTIVE' && a.status !== 'PLANNED') return;
    const scheduled = await tx.employeeTermination.findFirst({
      where: { employeeId: a.employeeId, status: 'SCHEDULED' },
      select: { id: true, terminationDate: true },
    });
    if (
      scheduled &&
      (endDate === null ||
        endDate.getTime() > scheduled.terminationDate.getTime())
    )
      throw new ConflictException(
        lifecycleError(
          409,
          'TERMINATION_SCHEDULED',
          `A termination is scheduled for ${dateOnly(scheduled.terminationDate)}; the assignment must end on or before it.`,
          { terminationId: scheduled.id },
        ),
      );
  }
  private async validateAssignment(tx: Prisma.TransactionClient, a: any) {
    if (a.endDate && a.startDate > a.endDate)
      throw new BadRequestException('End date must be on or after start date.');
    const overlaps = await tx.employmentAssignment.findMany({
      where: {
        id: { not: a.id },
        positionId: a.positionId,
        status: { not: 'CANCELLED' },
      },
      select: { startDate: true, endDate: true },
    });
    if (overlaps.some((x) => this.overlap(a, x)))
      throw new ConflictException(
        'Position is occupied during the requested dates.',
      );
    if (a.isPrimary)
      await this.validatePrimary(
        tx,
        a.employeeId,
        a.startDate,
        a.endDate,
        a.id,
      );
    if (a.managerAssignmentId) {
      const m = await tx.employmentAssignment.findUnique({
        where: { id: a.managerAssignmentId },
        select: {
          id: true,
          employeeId: true,
          status: true,
          startDate: true,
          endDate: true,
          managerAssignmentId: true,
        },
      });
      if (!m) throw new NotFoundException('Manager assignment not found');
      await this.domain.validateManagerRelationship(tx, a, m);
    }
  }
  private async validatePrimary(
    tx: Prisma.TransactionClient,
    employeeId: string,
    startDate: Date,
    endDate: Date | null,
    exclude: string,
  ) {
    const rows = await tx.employmentAssignment.findMany({
      where: {
        employeeId,
        isPrimary: true,
        id: { not: exclude },
        status: { not: 'CANCELLED' },
      },
      select: { startDate: true, endDate: true },
    });
    if (rows.some((x) => this.overlap({ startDate, endDate }, x)))
      throw new ConflictException('Primary assignments may not overlap.');
  }
  private overlap(a: any, b: any) {
    return (
      a.startDate <= (b.endDate ?? new Date('9999-12-31')) &&
      b.startDate <= (a.endDate ?? new Date('9999-12-31'))
    );
  }
  private requireActor(context: EmployeeRequestContext) {
    if (!context.actorUserId) throw new ForbiddenException();
    return context.actorUserId;
  }
  private normalizeEmployeeNumber(value: string | undefined) {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (!trimmed)
      throw new BadRequestException(
        'Employee number is required when provided.',
      );
    if (trimmed.length > 50)
      throw new BadRequestException(
        'Employee number must be 50 characters or fewer.',
      );
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed))
      throw new BadRequestException(
        'Employee number may contain letters, numbers, dots, underscores, slashes, and hyphens.',
      );
    return trimmed;
  }
  private isUniqueConstraint(error: unknown, field: string) {
    if ((error as { code?: unknown }).code !== 'P2002') return false;
    const target = (error as { meta?: { target?: unknown } }).meta?.target;
    if (Array.isArray(target)) return target.includes(field);
    if (typeof target === 'string') return target.includes(field);
    return target === undefined;
  }
  private async nextEmployeeNumber(tx: Prisma.TransactionClient) {
    const seq = await tx.$queryRaw<Array<{ value: bigint }>>(
      Prisma.sql`SELECT nextval('employee_number_seq') AS value`,
    );
    return `EMP-${seq[0]!.value.toString().padStart(6, '0')}`;
  }
  private optionLimit(limit?: number) {
    return Math.min(Math.max(limit ?? 25, 1), 100);
  }
  private sourceBatchSize(limit: number) {
    return Math.max(limit * 2, 50);
  }
  private personShape(p: any, includeContact = false) {
    return {
      firstName: p?.firstName ?? null,
      middleName: p?.middleName ?? null,
      lastName: p?.lastName ?? null,
      preferredName: p?.preferredName ?? null,
      ...(includeContact
        ? { personalEmail: p?.personalEmail ?? null, phone: p?.phone ?? null }
        : {}),
    };
  }
  private async assignmentShape(
    a: any,
    userId: string,
    canRead?: (positionId: string) => Promise<boolean>,
  ) {
    const position = a.position ?? {};
    const manager =
      a.manager &&
      (await (canRead
        ? canRead(a.manager.positionId)
        : this.access.canPosition(
            userId,
            a.manager.positionId,
            'employee.read',
          )))
        ? a.manager
        : null;
    const placement = position.team
      ? {
          type: 'TEAM',
          id: position.team.id,
          name: position.team.name,
          code: position.team.code,
        }
      : position.department
        ? {
            type: 'DEPARTMENT',
            id: position.department.id,
            name: position.department.name,
            code: position.department.code,
          }
        : position.organizationalUnit
          ? {
              type: 'ORGANIZATIONAL_UNIT',
              id: position.organizationalUnit.id,
              name: position.organizationalUnit.name,
              code: position.organizationalUnit.code,
            }
          : null;
    return {
      id: a.id,
      employmentType: a.employmentType,
      status: a.status,
      startDate: dateOnly(a.startDate),
      endDate: dateOnly(a.endDate),
      isPrimary: a.isPrimary,
      position: {
        id: position.id ?? a.positionId,
        name: position.name ?? '',
        code: position.code ?? '',
      },
      jobTitle: {
        id: position.jobTitle?.id ?? position.jobTitleId,
        name: position.jobTitle?.name ?? '',
        code: position.jobTitle?.code ?? '',
      },
      organization: {
        id: position.organization?.id ?? position.organizationId,
        name: position.organization?.name ?? '',
        code: position.organization?.code ?? '',
      },
      placement,
      workLocation: position.workLocation
        ? {
            id: position.workLocation.id,
            name: position.workLocation.name,
            code: position.workLocation.code,
          }
        : null,
      // Batch 5B (K7): links are kept, but the profile says when they no longer hold.
      managerWarnings: manager ? this.managerWarnings(manager, position) : [],
      manager: manager
        ? {
            assignmentId: manager.id,
            employeeId: manager.employeeId,
            employeeNumber: manager.employee.employeeNumber,
            displayName: this.displayName(manager.employee.person),
            positionName: manager.position.name,
          }
        : null,
    };
  }
  private managerWarnings(
    manager: {
      status: string;
      endDate: Date | null;
      position?: { organizationId: string } | null;
    },
    position: { organizationId?: string },
  ) {
    const warnings: Array<
      'MANAGER_ASSIGNMENT_ENDED' | 'MANAGER_ORGANIZATION_MISMATCH'
    > = [];
    const today = day(dateOnly(new Date()))!;
    if (
      manager.status === 'ENDED' ||
      manager.status === 'CANCELLED' ||
      (manager.endDate != null && manager.endDate.getTime() < today.getTime())
    )
      warnings.push('MANAGER_ASSIGNMENT_ENDED');
    if (
      manager.position &&
      position.organizationId &&
      manager.position.organizationId !== position.organizationId
    )
      warnings.push('MANAGER_ORGANIZATION_MISMATCH');
    return warnings;
  }

  private positionOptionShape(position: any) {
    const placement = position.team
      ? {
          type: 'TEAM',
          id: position.team.id,
          name: position.team.name,
          code: position.team.code,
        }
      : position.department
        ? {
            type: 'DEPARTMENT',
            id: position.department.id,
            name: position.department.name,
            code: position.department.code,
          }
        : position.organizationalUnit
          ? {
              type: 'ORGANIZATIONAL_UNIT',
              id: position.organizationalUnit.id,
              name: position.organizationalUnit.name,
              code: position.organizationalUnit.code,
            }
          : null;
    return {
      id: position.id,
      name: position.name,
      code: position.code,
      jobTitle: {
        id: position.jobTitle.id,
        name: position.jobTitle.name,
        code: position.jobTitle.code,
      },
      organization: {
        id: position.organization.id,
        name: position.organization.name,
        code: position.organization.code,
      },
      placement,
      workLocation: position.workLocation
        ? {
            id: position.workLocation.id,
            name: position.workLocation.name,
            code: position.workLocation.code,
          }
        : null,
    };
  }
  private displayName(p: any) {
    return (
      p?.preferredName ||
      [p?.firstName, p?.lastName].filter(Boolean).join(' ') ||
      'Unnamed employee'
    );
  }
  private safeEmployee(e: any) {
    return {
      id: e.id,
      employeeNumber: e.employeeNumber,
      status: e.status,
      person: this.personShape(e.person),
    };
  }
}
