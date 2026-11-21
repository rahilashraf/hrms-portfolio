import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { domainError, jsonValue } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PasswordHasherService } from '../security/password-hasher.service.js';
import { grantOrganizations } from '../time/organization-visibility.js';
import type { TimeRequestContext } from '../time/time.service.js';
import {
  normalizeEmployeeNumber,
  PIN_LOCK_MINUTES,
  PIN_MAX_FAILED_ATTEMPTS,
  PIN_PATTERN,
  randomPin,
  weakPin,
} from './kiosk-secrets.js';

const PERMISSION = 'time.credential.manage';

/** The single answer to any failed identification: never which part was wrong, or why. */
export const IDENTIFICATION_FAILED = {
  statusCode: 401,
  error: 'Unauthorized',
  code: 'KIOSK_IDENTIFICATION_FAILED',
  message: 'Employee number or PIN not recognized.',
} as const;

/**
 * Phase 9.5 — employees' kiosk credentials. A PIN is a separate attendance secret (never the
 * account password), stored only as an argon2id hash and never returned; an administrator can
 * issue or reset one (shown once) or revoke it, and an employee with an HRMS account can change
 * their own. Failed attempts lock the credential temporarily, atomically, without revealing it.
 * Future badge credentials (QR/NFC) are further types of the same model.
 */
@Injectable()
export class AttendanceCredentialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasherService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** Phase 18: the ATTENDANCE module gate (kiosk PINs belong to Time & attendance). */
  readonly features: FeatureGateService;

  /** Refused when Time & attendance is disabled in every organization the employee works in. */
  private requireAttendanceForEmployee(employeeId: string) {
    return this.features.requireForEmployee(employeeId, 'ATTENDANCE');
  }

  /** Whether the employee has a PIN, for administrators (no secret, ever). */
  async status(userId: string, employeeId: string) {
    await this.assertEmployeeVisible(userId, employeeId, this.prisma);
    await this.assertManage(userId, employeeId);
    const credential = await this.activePin(employeeId, this.prisma);
    return {
      employeeId,
      hasPin: credential !== null,
      issuedAt: credential?.issuedAt.toISOString() ?? null,
      lastUsedAt: credential?.lastUsedAt?.toISOString() ?? null,
      locked: credential?.lockedUntil
        ? credential.lockedUntil.getTime() > Date.now()
        : false,
    };
  }

  /**
   * Issues (or resets to) a random PIN, revoking any current one; the PIN is returned once.
   * Batch 4B (D4): one PIN works in every organization of the employee, so issuing one needs
   * time.credential.manage over every organization it works in (see assertManageEverywhere).
   * Issuing is also how an administrator re-enables a PIN another administrator revoked.
   */
  async issuePin(
    userId: string,
    employeeId: string,
    context: TimeRequestContext,
  ) {
    // Batch 4F (D4, D9): authorize before the expensive hash and the row lock; the same
    // checks run again under the lock below, so a concurrent permission change still counts.
    await this.prisma.$transaction(async (tx) => {
      await this.assertEmployeeVisible(userId, employeeId, tx);
      await this.assertManageEverywhere(
        tx,
        userId,
        employeeId,
        'ATTENDANCE_PIN_ISSUE',
      );
    });
    const pin = randomPin();
    const secretHash = await this.hasher.hashPassword(pin);
    const reset = await this.prisma.$transaction(async (tx) => {
      await this.lockEmployee(tx, employeeId);
      const authority = await this.assertManageEverywhere(
        tx,
        userId,
        employeeId,
        'ATTENDANCE_PIN_ISSUE',
      );
      const revoked = await this.revokeActive(
        tx,
        employeeId,
        userId,
        'Reset by an administrator',
      );
      const credential = await tx.attendanceCredential.create({
        data: { employeeId, type: 'PIN', secretHash, issuedByUserId: userId },
      });
      await this.writeAudit(
        tx,
        revoked ? 'ATTENDANCE_PIN_RESET' : 'ATTENDANCE_PIN_ISSUED',
        credential.id,
        context,
        { employeeId, ...authority },
      );
      return revoked;
    });
    return { employeeId, pin, reset: reset !== null };
  }

  async revokePin(
    userId: string,
    employeeId: string,
    reason: string,
    context: TimeRequestContext,
  ) {
    const trimmed = reason.trim();
    if (!trimmed) throw new BadRequestException('reason is required.');
    return this.prisma.$transaction(async (tx) => {
      // Batch 4F (D4, D9): an employee of no organization the caller can see is answered 404,
      // before any row lock is taken.
      await this.assertEmployeeVisible(userId, employeeId, tx);
      await this.lockEmployee(tx, employeeId);
      const authority = await this.assertManageEverywhere(
        tx,
        userId,
        employeeId,
        'ATTENDANCE_PIN_REVOKE',
      );
      const revoked = await this.revokeActive(tx, employeeId, userId, trimmed);
      if (revoked) {
        await this.writeAudit(tx, 'ATTENDANCE_PIN_REVOKED', revoked, context, {
          employeeId,
          // Phase 19: the reason stays on the credential; never in the audit log.
          withReason: true,
          ...authority,
        });
      }
      return { employeeId, hasPin: false };
    });
  }

  /**
   * An employee sets their own PIN through their authenticated HRMS account. Replacing an
   * existing PIN needs the current one (counted against the same lockout).
   */
  async changeOwnPin(
    userId: string,
    input: { currentPin?: string; newPin: string },
    context: TimeRequestContext,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        person: {
          select: { employee: { select: { id: true, archivedAt: true } } },
        },
      },
    });
    const employee = user?.person?.employee;
    if (!employee || employee.archivedAt) {
      throw new ForbiddenException('Authenticated user is not an employee.');
    }
    await this.requireAttendanceForEmployee(employee.id);
    if (!PIN_PATTERN.test(input.newPin) || weakPin(input.newPin)) {
      throw new BadRequestException(
        domainError(
          400,
          'ATTENDANCE_PIN_WEAK',
          'Choose 6 digits that are not all the same or a straight run.',
        ),
      );
    }
    const current = await this.activePin(employee.id, this.prisma);
    if (current) {
      // The lockout also covers this path, so the current PIN cannot be guessed here.
      if (current.lockedUntil && current.lockedUntil.getTime() > Date.now()) {
        throw new ForbiddenException(
          domainError(
            403,
            'ATTENDANCE_PIN_LOCKED',
            'Too many incorrect PINs. Try again later.',
          ),
        );
      }
      if (
        !input.currentPin ||
        !(await this.verifyAgainst(current, input.currentPin, context))
      ) {
        throw new ForbiddenException(
          domainError(
            403,
            'ATTENDANCE_PIN_INCORRECT',
            'The current PIN is incorrect.',
          ),
        );
      }
    }
    const secretHash = await this.hasher.hashPassword(input.newPin);
    await this.prisma.$transaction(async (tx) => {
      await this.lockEmployee(tx, employee.id);
      // Re-checked under the employee lock: an administrator's concurrent revoke or reset wins.
      const latest = await tx.attendanceCredential.findFirst({
        where: { employeeId: employee.id, type: 'PIN' },
        orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
      });
      // Batch 4B (D4): a PIN an administrator revoked stays revoked until an administrator
      // authorized for every organization of the employee issues a new one.
      if (
        latest?.status === 'REVOKED' &&
        latest.revokedByUserId !== null &&
        latest.revokedByUserId !== userId
      ) {
        throw new ForbiddenException(
          domainError(
            403,
            'ATTENDANCE_PIN_ADMIN_REVOKED',
            'Your PIN was revoked by an administrator. Ask an administrator to issue a new one.',
          ),
        );
      }
      if (
        (latest?.status === 'ACTIVE' ? latest.id : null) !==
        (current?.id ?? null)
      ) {
        throw new ConflictException(
          domainError(
            409,
            'ATTENDANCE_PIN_CHANGED',
            'Your PIN changed in the meantime. Try again.',
          ),
        );
      }
      await this.revokeActive(
        tx,
        employee.id,
        userId,
        'Changed by the employee',
      );
      const credential = await tx.attendanceCredential.create({
        data: {
          employeeId: employee.id,
          type: 'PIN',
          secretHash,
          issuedByUserId: userId,
        },
      });
      await this.writeAudit(
        tx,
        'ATTENDANCE_PIN_CHANGED',
        credential.id,
        context,
        {
          employeeId: employee.id,
        },
      );
    });
    return { hasPin: true };
  }

  /** Whether the signed-in employee has a PIN (self-service). */
  async ownStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { person: { select: { employee: { select: { id: true } } } } },
    });
    const employeeId = user?.person?.employee?.id;
    if (!employeeId)
      throw new ForbiddenException('Authenticated user is not an employee.');
    await this.requireAttendanceForEmployee(employeeId);
    return { hasPin: (await this.activePin(employeeId, this.prisma)) !== null };
  }

  /**
   * Kiosk identification: the employee for an employee number and PIN, or null for any failure
   * (unknown number, not working in the kiosk's organization, no PIN, wrong PIN, locked,
   * inactive). Every path costs one argon2 verify. Only a kiosk of an organization the employee
   * works in counts failures against the PIN, so another organization's kiosk cannot lock it.
   */
  async verifyPin(
    employeeNumber: string,
    pin: string,
    organizationId: string,
    context: TimeRequestContext,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { employeeNumber: normalizeEmployeeNumber(employeeNumber) },
      select: {
        id: true,
        status: true,
        archivedAt: true,
        terminationDate: true,
      },
    });
    // Batch 5A: employment ends on its dates, whatever the stored status says (an assignment
    // or termination past its date may not be processed yet). One day of margin keeps every
    // time zone's "today"; the clock actions themselves re-check the dates in the assignment's
    // own time zone.
    const now = new Date();
    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    );
    const inOrganization =
      employee &&
      (employee.terminationDate === null ||
        employee.terminationDate.getTime() >= cutoff.getTime())
        ? (await this.prisma.employmentAssignment.count({
            where: {
              employeeId: employee.id,
              status: { in: ['ACTIVE', 'PLANNED'] },
              OR: [{ endDate: null }, { endDate: { gte: cutoff } }],
              position: { organizationId },
            },
          })) > 0
        : false;
    const credential =
      employee && inOrganization
        ? await this.activePin(employee.id, this.prisma)
        : null;
    if (
      !employee ||
      !inOrganization ||
      !credential ||
      !PIN_PATTERN.test(pin) ||
      (credential.lockedUntil && credential.lockedUntil.getTime() > Date.now())
    ) {
      await this.hasher.verifyDummyPassword(pin);
      return null;
    }
    if (!(await this.verifyAgainst(credential, pin, context))) return null;
    if (employee.status !== 'ACTIVE' || employee.archivedAt) return null;
    return { employeeId: employee.id, credentialId: credential.id };
  }

  /** Whether the credential is still the employee's active one (re-checked before acting). */
  async stillActive(credentialId: string) {
    const credential = await this.prisma.attendanceCredential.findUnique({
      where: { id: credentialId },
      select: { status: true },
    });
    return credential?.status === 'ACTIVE';
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Verifies, counting failures atomically and locking after too many; resets on success. */
  private async verifyAgainst(
    credential: { id: string; employeeId: string; secretHash: string | null },
    pin: string,
    context: TimeRequestContext,
  ) {
    const valid =
      credential.secretHash !== null &&
      PIN_PATTERN.test(pin) &&
      (await this.hasher.verifyPassword(credential.secretHash, pin));
    if (valid) {
      // Never while locked: a guess checked before a concurrent lock must not lift it.
      const now = new Date();
      const { count } = await this.prisma.attendanceCredential.updateMany({
        where: {
          id: credential.id,
          status: 'ACTIVE',
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
        data: { failedAttempts: 0, lockedUntil: null, lastUsedAt: now },
      });
      return count === 1;
    }
    const rows = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`
      UPDATE "AttendanceCredential"
      SET "failedAttempts" = CASE WHEN "failedAttempts" + 1 >= ${PIN_MAX_FAILED_ATTEMPTS} THEN 0 ELSE "failedAttempts" + 1 END,
          "lockedUntil" = CASE WHEN "failedAttempts" + 1 >= ${PIN_MAX_FAILED_ATTEMPTS}
            THEN now() + make_interval(mins => ${PIN_LOCK_MINUTES}) ELSE "lockedUntil" END,
          "updatedAt" = now()
      WHERE "id" = ${credential.id}::uuid AND "status" = 'ACTIVE'
      RETURNING ("lockedUntil" IS NOT NULL AND "lockedUntil" > now() AND "failedAttempts" = 0) AS "locked"`;
    if (rows[0]?.locked) {
      await this.writeAudit(
        this.prisma,
        'ATTENDANCE_PIN_LOCKED',
        credential.id,
        context,
        {
          employeeId: credential.employeeId,
          lockMinutes: PIN_LOCK_MINUTES,
        },
      );
    }
    return false;
  }

  private activePin(
    employeeId: string,
    client: PrismaService | Prisma.TransactionClient,
  ) {
    return client.attendanceCredential.findFirst({
      where: { employeeId, type: 'PIN', status: 'ACTIVE' },
    });
  }

  /** Serializes credential changes of one employee (one ACTIVE PIN is also unique in the DB). */
  private async lockEmployee(tx: Prisma.TransactionClient, employeeId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Employee" WHERE "id" = ${employeeId}::uuid FOR NO KEY UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Employee not found.');
  }

  private async revokeActive(
    tx: Prisma.TransactionClient,
    employeeId: string,
    userId: string,
    reason: string,
  ) {
    const current = await this.activePin(employeeId, tx);
    if (!current) return null;
    await tx.attendanceCredential.update({
      where: { id: current.id },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedByUserId: userId,
        revokedReason: reason,
      },
    });
    return current.id;
  }

  /**
   * Batch 4B (D4): resetting or revoking a PIN changes it in every organization where it works,
   * so the actor needs time.credential.manage in EVERY such organization: over at least one of
   * the employee's assignments in each (the assignments that make the PIN work there: ACTIVE or
   * PLANNED; with none, every non-cancelled one). Within one organization this is the rule it
   * always was (any of the employee's assignments there). A System-scope holder is
   * the narrow recovery path for an employee no single administrator covers; that authority is
   * recorded in the audit. Never on one's own PIN (that is self-service), unless System scope.
   */
  private async assertManageEverywhere(
    tx: Prisma.TransactionClient,
    userId: string,
    employeeId: string,
    action: string,
  ): Promise<{
    authority: 'ASSIGNMENTS' | 'SYSTEM';
    organizationIds: string[];
  }> {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: {
        person: { select: { user: { select: { id: true } } } },
        assignments: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            status: true,
            positionId: true,
            position: { select: { organizationId: true } },
          },
        },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    const working = employee.assignments.filter(
      (assignment) =>
        assignment.status === 'ACTIVE' || assignment.status === 'PLANNED',
    );
    const affected = working.length > 0 ? working : employee.assignments;
    const organizationIds = [
      ...new Set(affected.map((a) => a.position.organizationId)),
    ].sort();
    const system = await this.authorization.canAccess(
      userId,
      PERMISSION,
      { type: 'SYSTEM' },
      tx,
    );
    const ownPin = employee.person.user?.id === userId;
    if (ownPin && !system) {
      throw new ForbiddenException(
        domainError(
          403,
          'ATTENDANCE_PIN_SELF_TARGET',
          'Change your own PIN in My Time instead.',
          { action },
        ),
      );
    }
    if (system) {
      await this.requireAttendanceForEmployee(employeeId);
      return { authority: 'SYSTEM', organizationIds };
    }
    const managed = new Set<string>();
    for (const assignment of affected) {
      if (managed.has(assignment.position.organizationId)) continue;
      const scope = await this.targets.scopeForPosition(
        assignment.positionId,
        undefined,
        tx,
      );
      if (await this.authorization.canAccess(userId, PERMISSION, scope, tx)) {
        managed.add(assignment.position.organizationId);
      }
    }
    const anyAccess = managed.size > 0;
    const covered = anyAccess && organizationIds.every((id) => managed.has(id));
    if (!anyAccess) {
      throw new ForbiddenException(
        'Missing permission time.credential.manage for the employee.',
      );
    }
    if (!covered) {
      throw new ForbiddenException(
        domainError(
          403,
          'ATTENDANCE_PIN_SHARED_SCOPE',
          'This PIN is also used in an organization you do not manage. An administrator of every organization the employee works in, or a System administrator, must change it.',
          { action },
        ),
      );
    }
    await this.requireAttendanceForEmployee(employeeId);
    return { authority: 'ASSIGNMENTS', organizationIds };
  }

  /**
   * Batch 4F (D4): an employee none of whose (non-cancelled) assignments is in an organization
   * where the caller holds time.credential.manage is answered 404, exactly like a missing
   * employee. Within such an organization the existing 403 rules (scope, shared PIN) apply.
   */
  private async assertEmployeeVisible(
    userId: string,
    employeeId: string,
    client: PrismaService | Prisma.TransactionClient,
  ) {
    // One's own PIN is visible to oneself (the self-service rules answer 403).
    const own = await client.user.findUnique({
      where: { id: userId },
      select: { person: { select: { employee: { select: { id: true } } } } },
    });
    if (own?.person?.employee?.id === employeeId) return;
    const assignments = await client.employmentAssignment.findMany({
      where: { employeeId, status: { not: 'CANCELLED' } },
      select: { position: { select: { organizationId: true } } },
    });
    const visible = await grantOrganizations(
      this.authorization,
      userId,
      [PERMISSION],
      client,
    );
    // A System-scope holder sees every employee (their existence is not secret to them).
    if (visible === 'ALL') return;
    if (
      !visible ||
      !assignments.some((a) => visible.includes(a.position.organizationId))
    ) {
      throw new NotFoundException('Employee not found.');
    }
  }

  /** time.credential.manage on any non-cancelled assignment position of the employee (reads). */
  private async assertManage(userId: string, employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        assignments: {
          where: { status: { not: 'CANCELLED' } },
          select: { positionId: true },
        },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    for (const assignment of employee.assignments) {
      const scope = await this.targets.scopeForPosition(assignment.positionId);
      if (await this.authorization.canAccess(userId, PERMISSION, scope)) {
        await this.requireAttendanceForEmployee(employeeId);
        return;
      }
    }
    throw new ForbiddenException(
      'Missing permission time.credential.manage for the employee.',
    );
  }

  private writeAudit(
    client: PrismaService | Prisma.TransactionClient,
    action: string,
    entityId: string,
    context: TimeRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'AttendanceCredential',
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue(
          context.capture
            ? { ...metadata, capture: context.capture }
            : metadata,
        ),
      },
      client,
    );
  }
}
