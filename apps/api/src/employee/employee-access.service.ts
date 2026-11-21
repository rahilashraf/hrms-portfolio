import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { lifecycleError } from './employee-lifecycle-support.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../database/prisma.service.js';

type Client = Prisma.TransactionClient | PrismaService;
type AuditContext = {
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
};

@Injectable()
export class EmployeeAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /** Whether the user holds the permission at SYSTEM scope. */
  isSystem(
    userId: string,
    permission = 'employee.manage',
    client: Client = this.prisma,
  ) {
    return this.authorization.can(
      userId,
      permission,
      { type: 'SYSTEM' },
      new Date(),
      client,
    );
  }

  /** The employee record of the user (their own), if any. */
  async ownEmployeeId(userId: string, client: Client = this.prisma) {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: { person: { select: { employee: { select: { id: true } } } } },
    });
    return user?.person?.employee?.id ?? null;
  }

  /**
   * Batch 5A (K12): no lifecycle change on one's own employee record. Only a SYSTEM
   * employee.manage holder may, and that override is audited.
   */
  async assertNotSelfTarget(
    userId: string,
    employeeId: string,
    action: string,
    context: AuditContext,
    client: Client = this.prisma,
  ) {
    if ((await this.ownEmployeeId(userId, client)) !== employeeId) return;
    if (await this.isSystem(userId, 'employee.manage', client)) {
      await this.audit?.write(
        {
          action: 'LIFECYCLE_SELF_TARGET_OVERRIDE',
          actorUserId: userId,
          entityType: 'Employee',
          entityId: employeeId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          correlationId: context.correlationId,
          metadata: { action, authority: 'SYSTEM' },
        },
        client as Prisma.TransactionClient,
      );
      return;
    }
    throw new ForbiddenException(
      lifecycleError(
        403,
        'LIFECYCLE_SELF_TARGET',
        'You cannot change your own employment.',
        { action },
      ),
    );
  }

  /**
   * Batch 5A (K10): an employee-wide lifecycle action (terminate, rehire into a current
   * employment, inactivate, reactivate, profile edits) needs employee.manage over the position
   * of EVERY affected assignment: each ACTIVE or PLANNED one, and each ENDED one still running on
   * or after the reference date. With none, one manageable non-cancelled assignment is enough.
   * A SYSTEM holder always may; when the assignment scopes alone would not cover the action the
   * authority is reported as SYSTEM (callers record it in their audit). An employee the caller
   * cannot see at all is 404; visible but not fully covered is 403 LIFECYCLE_SCOPE_INCOMPLETE.
   */
  async authorizeEmployeeWide(
    userId: string,
    employeeId: string,
    options: { referenceDate: Date; extraPositionIds?: string[] },
    client: Client = this.prisma,
  ): Promise<{ authority: 'ASSIGNMENTS' | 'SYSTEM' }> {
    const system = await this.isSystem(userId, 'employee.manage', client);
    if (
      !system &&
      !(await this.canEmployee(userId, employeeId, 'employee.read', client))
    ) {
      throw new NotFoundException('Employee not found.');
    }
    const assignments = await client.employmentAssignment.findMany({
      where: { employeeId, status: { not: 'CANCELLED' } },
      select: { positionId: true, status: true, endDate: true },
    });
    const affected = assignments.filter(
      (a) =>
        a.status === 'ACTIVE' ||
        a.status === 'PLANNED' ||
        (a.endDate !== null &&
          a.endDate.getTime() >= options.referenceDate.getTime()),
    );
    const positions = [
      ...new Set([
        ...affected.map((a) => a.positionId),
        ...(options.extraPositionIds ?? []),
      ]),
    ];
    let covered: boolean;
    if (positions.length > 0) {
      covered = true;
      for (const positionId of positions) {
        if (
          !(await this.canPosition(
            userId,
            positionId,
            'employee.manage',
            client,
          ))
        ) {
          covered = false;
          break;
        }
      }
    } else {
      covered = false;
      for (const a of assignments) {
        if (
          await this.canPosition(
            userId,
            a.positionId,
            'employee.manage',
            client,
          )
        ) {
          covered = true;
          break;
        }
      }
    }
    if (covered) return { authority: 'ASSIGNMENTS' };
    if (system) return { authority: 'SYSTEM' };
    throw new ForbiddenException(
      lifecycleError(
        403,
        'LIFECYCLE_SCOPE_INCOMPLETE',
        'This change affects employment you do not manage. An administrator of every affected organization, or a System administrator, must make it.',
      ),
    );
  }

  /**
   * Batch 5A (K5): who may attach an existing employee to a position (a new assignment, a
   * rehire, an employee record for an existing person). employee.manage on the position is
   * always required (checked by the caller), and in addition one of:
   *  (a) the caller can already see the employee (employee.read through an existing assignment);
   *  (b) the caller holds employee.manage for the whole organization of the position and
   *      confirms the employee number found through the audited attach lookup;
   *  (c) SYSTEM employee.manage (reported as SYSTEM).
   * Unit, department and team managers can only use (a). Anything else answers 404 (the
   * employee's existence is not revealed).
   */
  async authorizeAttach(
    userId: string,
    employee: { id: string; employeeNumber: string },
    positionId: string,
    confirmedEmployeeNumber: string | undefined,
    client: Client = this.prisma,
  ): Promise<{ authority: 'VISIBLE' | 'ORGANIZATION' | 'SYSTEM' }> {
    if (await this.canEmployee(userId, employee.id, 'employee.read', client)) {
      return { authority: 'VISIBLE' };
    }
    const position = await client.position.findUnique({
      where: { id: positionId },
      select: { organizationId: true },
    });
    if (
      position &&
      confirmedEmployeeNumber !== undefined &&
      confirmedEmployeeNumber.trim() === employee.employeeNumber &&
      (await this.authorization.canAccess(
        userId,
        'employee.manage',
        { type: 'ORGANIZATION', id: position.organizationId },
        client,
      ))
    ) {
      return { authority: 'ORGANIZATION' };
    }
    if (await this.isSystem(userId, 'employee.manage', client)) {
      return { authority: 'SYSTEM' };
    }
    throw new NotFoundException('Employee not found.');
  }

  async canEmployee(
    userId: string,
    employeeId: string,
    permission = 'employee.read',
    client: Client = this.prisma,
  ): Promise<boolean> {
    if (
      await this.authorization.can(
        userId,
        permission,
        { type: 'SYSTEM' },
        new Date(),
        client,
      )
    ) {
      return Boolean(
        await client.employee.findUnique({
          where: { id: employeeId },
          select: { id: true },
        }),
      );
    }
    const employee = await client.employee.findUnique({
      where: { id: employeeId },
      include: {
        assignments: {
          where: { status: { not: 'CANCELLED' } },
          select: { positionId: true },
        },
      },
    });
    if (!employee || employee.assignments.length === 0) return false;
    for (const assignment of employee.assignments) {
      const scope = await this.targets.scopeForPosition(
        assignment.positionId,
        undefined,
        client,
      );
      if (await this.authorization.canAccess(userId, permission, scope, client))
        return true;
    }
    return false;
  }

  async assertEmployee(
    userId: string,
    employeeId: string,
    permission = 'employee.read',
    client: Client = this.prisma,
  ) {
    const allowed = await this.canEmployee(
      userId,
      employeeId,
      permission,
      client,
    );
    if (!allowed)
      throw new ForbiddenException(
        'Employee is not visible in the requested scope.',
      );
  }

  async assertPosition(
    userId: string,
    positionId: string,
    permission = 'employee.manage',
    client: Client = this.prisma,
  ) {
    const scope = await this.targets.scopeForPosition(
      positionId,
      undefined,
      client,
    );
    await this.authorization.assertAccess(userId, permission, scope, client);
  }

  async canPosition(
    userId: string,
    positionId: string,
    permission = 'employee.read',
    client: Client = this.prisma,
  ) {
    const scope = await this.targets.scopeForPosition(
      positionId,
      undefined,
      client,
    );
    return this.authorization.canAccess(userId, permission, scope, client);
  }
}
