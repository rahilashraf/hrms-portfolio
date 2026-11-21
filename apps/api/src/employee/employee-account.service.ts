import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { isEmail } from 'class-validator';
import { AccountTokenType, Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountEmailService } from '../auth/account-email.service.js';
import {
  AccountTokenService,
  type IssuedAccountToken,
} from '../auth/account-token.service.js';
import {
  INVITATION_TOKEN_LIFETIME_MS,
  PASSWORD_RESET_TOKEN_LIFETIME_MS,
} from '../auth/auth.service.js';
import {
  AuthorizationService,
  LIVE_ORGANIZATION_GRANT,
} from '../authorization/authorization.service.js';
import { scopeContainsTarget } from '../authorization/authorization.policy.js';
import type { ScopeRef } from '../authorization/authorization.types.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { domainError } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { normalizeEmail } from '../users/users.service.js';
import type { EmployeeRequestContext } from './employee.service.js';
import { EmployeeAccountAlertService } from './employee-account-alerts.service.js';
import {
  ACCOUNT_ACTION_CLASS,
  ACCOUNT_ACTIONS,
  REPEATED_REFUSAL_WINDOW_MS,
  accountOutsideScope,
  assignmentBusinessDate,
  assignmentQualifies,
  classifyRefusalRisk,
  type AccountAction,
  type AccountActionClass,
  type AccountRefusalCategory,
  type AccountScopeReason,
} from './employee-account-policy.js';

export const EMPLOYEE_ACCOUNT_PERMISSION = 'employee.account.manage';

/**
 * What the Login Access section shows. INVITATION_EXPIRED: invited, but no usable invitation
 * link exists any more (it expired, was superseded, or its email could not be delivered).
 */
export type EmployeeAccountStatus =
  | 'NOT_INVITED'
  | 'INVITED'
  | 'INVITATION_EXPIRED'
  | 'ACTIVE'
  | 'LOCKED'
  | 'DISABLED'
  | 'ARCHIVED';

type Tx = Prisma.TransactionClient;

interface LockedAccount {
  employee: {
    id: string;
    status: string;
    archivedAt: Date | null;
    personId: string;
    person: { personalEmail: string | null };
  };
  user: {
    id: string;
    email: string;
    status: string;
    passwordHash: string | null;
    archivedAt: Date | null;
    lastLoginAt: Date | null;
    mustChangePassword: boolean;
    lockedUntil: Date | null;
  } | null;
  /** Employee organizations the action is authorized in (email routing preference). */
  organizationIds: string[];
  /**
   * Where the action's audit entry is visible: the organizations whose authority it used, or
   * none (the System view) for a System-scope actor.
   */
  auditOrganizationIds: string[];
  /** M1: the policy facts the capability flags of a read are derived from. */
  policy: PolicyFacts;
}

/** M1: one non-cancelled employment assignment of the target, as the policy sees it. */
interface AssignmentFact {
  organizationId: string;
  status: string;
  endDate: Date | null;
  /** The actor holds employee.account.manage over the assignment's position. */
  inScope: boolean;
  /** The assignment's business date now (its own time zone). */
  businessDate: Date;
}

interface PolicyFacts {
  system: boolean;
  assignments: AssignmentFact[];
  /** Organizations of in-scope assignments: where the actor may read the login. */
  readOrganizationIds: string[];
  /** Every live grant of the target is inside the actor's employee.account.manage scope. */
  covered: boolean;
  /** The target holds a live SYSTEM-scope grant or the System Owner role. */
  targetSystemPrivileged: boolean;
  /**
   * The target is employed (ACTIVE / PLANNED) or holds a live grant in an organization outside
   * the actor's authority over them.
   */
  crossOrganization: boolean;
}

/** M1: what a refused attempt records (never shown to the client). */
interface RefusalDetails {
  category: AccountRefusalCategory;
  action: AccountAction;
  employeeId: string;
  subjectType: 'User' | 'Employee';
  subjectId: string;
  auditOrganizationIds: string[];
  alertOrganizationId: string | null;
  targetSystemPrivileged: boolean;
  crossOrganization: boolean;
}

/**
 * A refused account action. The response is exactly what the client receives (the earlier
 * messages for permission, self and System Owner refusals; ACCOUNT_OUTSIDE_SCOPE for M1); the
 * details, present for mutations, are audited after the transaction has rolled back.
 */
class AccountActionRefused extends ForbiddenException {
  constructor(
    response: string | object,
    readonly details: RefusalDetails | null,
  ) {
    super(response);
  }
}

export type AccountCapability = {
  allowed: boolean;
  /** Set when the login's state allows the action but the M1 policy refuses it. */
  reason: AccountScopeReason | null;
};

const conflict = (code: string, message: string) =>
  new ConflictException(domainError(409, code, message));

const unique = (values: readonly string[]) => [...new Set(values)].sort();

/**
 * Employee login access: administrator-controlled invitations linked to the employee's existing
 * Person (never a new Person or Employee), and disabling / re-enabling that login. Reuses the
 * account infrastructure: single-use hashed invitation tokens (AccountTokenService), the
 * acceptance flow in which the employee chooses their own password (AuthService.acceptInvitation)
 * and the account email boundary. Never grants a role or permission, never touches kiosk PINs,
 * employment records or compensation.
 *
 * Authorization: employee.account.manage in the scope of one of the employee's assignments
 * (or system-wide). An actor never manages their own login, and only a System Owner may manage a
 * System Owner's. Every change is audited without email addresses.
 *
 * Security remediation M1 (cross-organization isolation), for an actor without SYSTEM-scope
 * authority:
 * - PROTECTIVE actions (disable, sign out, cancel an invitation) need an in-scope assignment that
 *   is ACTIVE, PLANNED, or ENDED no more than 90 days ago (the assignment's business date);
 *   RESTORATIVE actions (invite, resend, enable, unlock, password reset, require a password
 *   change) need an ACTIVE or PLANNED one;
 * - and every live grant of the login (whatever its status: a disabled or invited login's grants
 *   come back with it) must lie inside the actor's employee.account.manage scope; a SYSTEM-scope
 *   grant needs a SYSTEM-scope actor.
 * Refusals are 403 ACCOUNT_OUTSIDE_SCOPE with a safe reason, audited
 * (EMPLOYEE_ACCOUNT_ACTION_REFUSED) in the organizations the actor already has authority in, and
 * high-risk ones alert SYSTEM-scope security administrators. Reads are unchanged and carry
 * per-action capability flags.
 *
 * Locking: Employee, then User (FOR UPDATE), then the grants are read. A grant insert takes the
 * User row's FOR KEY SHARE lock through its foreign key, so it and an account action serialize:
 * whichever commits first is seen by the other.
 */
@Injectable()
export class EmployeeAccountService {
  private readonly logger = new Logger(EmployeeAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly audit: AuditService,
    private readonly tokens: AccountTokenService,
    private readonly emails: AccountEmailService,
    @Optional() private readonly alerts?: EmployeeAccountAlertService,
  ) {}

  /** The instant whose business date places the 90-day protective window (a test seam). */
  protected businessNow(): Date {
    return new Date();
  }

  async account(employeeId: string, context: EmployeeRequestContext) {
    const actor = this.requireActor(context);
    const state = await this.prisma.$transaction((tx) =>
      this.lockAccount(tx, actor, employeeId, null, { lock: false }),
    );
    return this.shape(state, actor);
  }

  async invite(
    employeeId: string,
    input: { email?: string },
    context: EmployeeRequestContext,
  ) {
    const actor = this.requireActor(context);
    // Never create an account an invitation cannot reach.
    await this.emails.assertAvailable();
    const prepared = await this.transact(context, async (tx) => {
      const state = await this.lockAccount(tx, actor, employeeId, 'invite');
      this.assertEmployeeActive(state);
      const user = state.user;
      if (user && user.archivedAt === null) {
        if (user.status === 'INVITED') {
          throw conflict(
            'EMPLOYEE_ACCOUNT_ALREADY_INVITED',
            'This employee is already invited; resend the invitation instead.',
          );
        }
        if (user.status === 'DISABLED') {
          throw conflict(
            'EMPLOYEE_ACCOUNT_DISABLED',
            'This employee has a disabled login; enable it instead.',
          );
        }
        throw conflict(
          'EMPLOYEE_ACCOUNT_ALREADY_ACTIVE',
          'This employee already has an active login.',
        );
      }
      if (user && user.passwordHash !== null) {
        throw conflict(
          'EMPLOYEE_ACCOUNT_ARCHIVED',
          'This employee has an archived login that cannot be re-invited here.',
        );
      }
      // The login's state decides first; the address is checked only for a real invitation.
      const email = this.parseEmail(
        input.email ?? state.employee.person.personalEmail,
      );
      await this.assertEmailFree(tx, email, user?.id);
      let userId: string;
      let revived = false;
      let revokedRoleAssignmentCount = 0;
      try {
        if (user) {
          // A cancelled (never activated) invitation: the same account is invited again.
          const updated = await tx.user.updateMany({
            where: { id: user.id, status: 'ARCHIVED', passwordHash: null },
            data: { status: 'INVITED', archivedAt: null, email },
          });
          if (updated.count !== 1) throw this.changedConcurrently();
          userId = user.id;
          revived = true;
          // Batch 5E (defence in depth): a withdrawn invitation never keeps live roles (cancel and
          // a failed first delivery revoke them), but earlier code could leave some behind. They
          // are revoked before the login is revived, so none can authorize after acceptance.
          revokedRoleAssignmentCount = (
            await this.revokeLiveGrants(tx, user.id, actor, new Date())
          ).count;
        } else {
          userId = (
            await tx.user.create({
              data: {
                personId: state.employee.personId,
                email,
                status: 'INVITED',
              },
              select: { id: true },
            })
          ).id;
        }
      } catch (error) {
        throw this.uniqueConflict(error);
      }
      await this.writeAudit(
        tx,
        'EMPLOYEE_ACCOUNT_INVITED',
        userId,
        context,
        {
          employeeId,
          revived,
          emailSource: input.email ? 'ENTERED' : 'PERSONAL_EMAIL',
          revokedRoleAssignmentCount,
        },
        state.auditOrganizationIds,
      );
      // Issued under the employee lock, so a concurrent resend or cancel is ordered after it.
      const issued = await this.issueInvitation(tx, userId);
      return {
        userId,
        email,
        organizationIds: state.organizationIds,
        auditOrganizationIds: state.auditOrganizationIds,
        issued,
      };
    });
    await this.deliverInvitation(prepared, employeeId, context, {
      // A first invitation whose email fails is undone, never left as an unusable account.
      undoOnFailure: true,
    });
    return this.account(employeeId, context);
  }

  async resend(
    employeeId: string,
    input: { email?: string },
    context: EmployeeRequestContext,
  ) {
    const actor = this.requireActor(context);
    await this.emails.assertAvailable();
    const prepared = await this.transact(context, async (tx) => {
      const state = await this.lockAccount(tx, actor, employeeId, 'resend');
      this.assertEmployeeActive(state);
      const user = state.user;
      if (!user || user.status !== 'INVITED' || user.archivedAt !== null) {
        throw conflict(
          'EMPLOYEE_ACCOUNT_NOT_INVITED',
          'Only a pending invitation can be resent.',
        );
      }
      let email = user.email;
      if (input.email !== undefined) {
        email = this.parseEmail(input.email);
        if (email !== user.email) {
          await this.assertEmailFree(tx, email, user.id);
          try {
            await tx.user.update({ where: { id: user.id }, data: { email } });
          } catch (error) {
            throw this.uniqueConflict(error);
          }
        }
      }
      await this.writeAudit(
        tx,
        'EMPLOYEE_ACCOUNT_INVITATION_RESENT',
        user.id,
        context,
        {
          employeeId,
          emailChanged: email !== user.email,
        },
        state.auditOrganizationIds,
      );
      const issued = await this.issueInvitation(tx, user.id);
      return {
        userId: user.id,
        email,
        organizationIds: state.organizationIds,
        auditOrganizationIds: state.auditOrganizationIds,
        issued,
      };
    });
    await this.deliverInvitation(prepared, employeeId, context, {
      undoOnFailure: false,
    });
    return this.account(employeeId, context);
  }

  async cancel(employeeId: string, context: EmployeeRequestContext) {
    const actor = this.requireActor(context);
    await this.transact(context, async (tx) => {
      const state = await this.lockAccount(tx, actor, employeeId, 'cancel');
      const user = state.user;
      if (!user || user.status !== 'INVITED' || user.archivedAt !== null) {
        throw conflict(
          'EMPLOYEE_ACCOUNT_NOT_INVITED',
          'Only a pending invitation can be cancelled.',
        );
      }
      const now = new Date();
      await this.tokens.invalidateOutstanding(
        tx,
        user.id,
        AccountTokenType.INVITATION,
        now,
      );
      const archived = await tx.user.updateMany({
        where: { id: user.id, status: 'INVITED', passwordHash: null },
        data: { status: 'ARCHIVED', archivedAt: now },
      });
      if (archived.count !== 1) throw this.changedConcurrently();
      // Roles prepared for the invitation must not come back if it is ever re-sent.
      const revoked = await this.revokeLiveGrants(tx, user.id, actor, now);
      await this.writeAudit(
        tx,
        'EMPLOYEE_ACCOUNT_INVITATION_CANCELLED',
        user.id,
        context,
        {
          employeeId,
          revokedRoleAssignmentCount: revoked.count,
        },
        state.auditOrganizationIds,
      );
    });
    return this.account(employeeId, context);
  }

  async disable(
    employeeId: string,
    input: { reason?: string },
    context: EmployeeRequestContext,
  ) {
    const actor = this.requireActor(context);
    await this.transact(context, async (tx) => {
      const state = await this.lockAccount(tx, actor, employeeId, 'disable');
      const user = state.user;
      if (
        !user ||
        user.archivedAt !== null ||
        !['ACTIVE', 'LOCKED'].includes(user.status)
      ) {
        throw conflict(
          user?.status === 'INVITED'
            ? 'EMPLOYEE_ACCOUNT_INVITED'
            : 'EMPLOYEE_ACCOUNT_NOT_ACTIVE',
          user?.status === 'INVITED'
            ? 'This employee has not activated their login yet; cancel the invitation instead.'
            : 'Only an active login can be disabled.',
        );
      }
      const now = new Date();
      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          status: { in: ['ACTIVE', 'LOCKED'] },
          archivedAt: null,
        },
        data: { status: 'DISABLED' },
      });
      if (updated.count !== 1) throw this.changedConcurrently();
      // Signed-in sessions end now (every request checks its session and an ACTIVE user);
      // outstanding reset and verification links stop working.
      const sessions = await tx.authSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'access_disabled' },
      });
      await tx.accountToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });
      await this.writeAudit(
        tx,
        'EMPLOYEE_ACCOUNT_DISABLED',
        user.id,
        context,
        {
          employeeId,
          revokedSessionCount: sessions.count,
          ...(input.reason?.trim()
            ? { reason: input.reason.trim().slice(0, 500) }
            : {}),
        },
        state.auditOrganizationIds,
      );
    });
    return this.account(employeeId, context);
  }

  async enable(employeeId: string, context: EmployeeRequestContext) {
    const actor = this.requireActor(context);
    await this.transact(context, async (tx) => {
      const state = await this.lockAccount(tx, actor, employeeId, 'enable');
      this.assertEmployeeActive(state);
      const user = state.user;
      if (!user || user.status !== 'DISABLED' || user.archivedAt !== null) {
        throw conflict(
          'EMPLOYEE_ACCOUNT_NOT_DISABLED',
          'Only a disabled login can be enabled.',
        );
      }
      // A login that never had a password returns to a pending invitation, never to ACTIVE.
      const restored = user.passwordHash === null ? 'INVITED' : 'ACTIVE';
      const updated = await tx.user.updateMany({
        where: { id: user.id, status: 'DISABLED', archivedAt: null },
        data: {
          status: restored,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      if (updated.count !== 1) throw this.changedConcurrently();
      await this.writeAudit(
        tx,
        'EMPLOYEE_ACCOUNT_ENABLED',
        user.id,
        context,
        {
          employeeId,
          restoredStatus: restored,
        },
        state.auditOrganizationIds,
      );
    });
    return this.account(employeeId, context);
  }

  // ─── Batch 2: account security actions ──────────────────────────────────

  /**
   * Requires the employee to choose a new password before using anything else (enforced on
   * every request). With `signOut` (the default) their sessions also end now, so they meet the
   * requirement at their next sign-in; without it, the open sessions are confined to the
   * password change at their next request.
   */
  async requirePasswordChange(
    employeeId: string,
    input: { signOut?: boolean },
    context: EmployeeRequestContext,
  ) {
    const actor = this.requireActor(context);
    const signOut = input.signOut ?? true;
    await this.transact(context, async (tx) => {
      const state = await this.lockAccount(
        tx,
        actor,
        employeeId,
        'requirePasswordChange',
      );
      const user = this.passwordLogin(state);
      const now = new Date();
      const updated = await tx.user.updateMany({
        where: { id: user.id, status: 'ACTIVE', archivedAt: null },
        data: { mustChangePassword: true },
      });
      if (updated.count !== 1) throw this.changedConcurrently();
      const revoked = signOut
        ? await tx.authSession.updateMany({
            where: { userId: user.id, revokedAt: null, expiresAt: { gt: now } },
            data: { revokedAt: now, revokedReason: 'password_change_required' },
          })
        : { count: 0 };
      await this.writeAudit(
        tx,
        'EMPLOYEE_ACCOUNT_PASSWORD_CHANGE_REQUIRED',
        user.id,
        context,
        { employeeId, signedOut: signOut, revokedSessionCount: revoked.count },
        state.auditOrganizationIds,
      );
    });
    return this.account(employeeId, context);
  }

  /** Ends every session of the employee's login now (they sign in again). */
  async signOut(employeeId: string, context: EmployeeRequestContext) {
    const actor = this.requireActor(context);
    await this.transact(context, async (tx) => {
      const state = await this.lockAccount(tx, actor, employeeId, 'signOut');
      const user = state.user;
      if (
        !user ||
        user.archivedAt !== null ||
        !['ACTIVE', 'LOCKED'].includes(user.status)
      ) {
        throw conflict(
          'EMPLOYEE_ACCOUNT_NOT_ACTIVE',
          'Only an active login has sessions to end.',
        );
      }
      const now = new Date();
      const revoked = await tx.authSession.updateMany({
        where: { userId: user.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now, revokedReason: 'admin_revoked' },
      });
      await this.writeAudit(
        tx,
        'EMPLOYEE_ACCOUNT_SESSIONS_REVOKED',
        user.id,
        context,
        {
          employeeId,
          revokedSessionCount: revoked.count,
        },
        state.auditOrganizationIds,
      );
    });
    return this.account(employeeId, context);
  }

  /**
   * Emails the employee a password reset link (the employee chooses the password; nobody else
   * ever sets or sees it). Sent at once so the administrator learns whether delivery failed;
   * on failure the link is withdrawn.
   */
  async sendPasswordReset(employeeId: string, context: EmployeeRequestContext) {
    const actor = this.requireActor(context);
    await this.emails.assertAvailable();
    const prepared = await this.transact(context, async (tx) => {
      const state = await this.lockAccount(
        tx,
        actor,
        employeeId,
        'sendPasswordReset',
      );
      this.assertEmployeeActive(state);
      const user = this.passwordLogin(state);
      const issued = await this.tokens.issueWithin(
        tx,
        user.id,
        AccountTokenType.PASSWORD_RESET,
        PASSWORD_RESET_TOKEN_LIFETIME_MS,
      );
      return {
        user,
        issued,
        organizationIds: state.organizationIds,
        auditOrganizationIds: state.auditOrganizationIds,
      };
    });
    try {
      await this.emails.sendPasswordReset({
        email: prepared.user.email,
        token: prepared.issued.token,
        expiresAt: prepared.issued.expiresAt,
        userId: prepared.user.id,
        organizationIds: prepared.organizationIds,
      });
    } catch (error) {
      await this.tokens.withdraw(prepared.issued.id);
      await this.writeAudit(
        this.prisma,
        'EMPLOYEE_ACCOUNT_PASSWORD_RESET_FAILED',
        prepared.user.id,
        context,
        { employeeId },
        prepared.auditOrganizationIds,
      );
      throw error;
    }
    await this.writeAudit(
      this.prisma,
      'EMPLOYEE_ACCOUNT_PASSWORD_RESET_SENT',
      prepared.user.id,
      context,
      { employeeId },
      prepared.auditOrganizationIds,
    );
    return this.account(employeeId, context);
  }

  /** Lifts the temporary lock that repeated wrong passwords started. */
  async unlock(employeeId: string, context: EmployeeRequestContext) {
    const actor = this.requireActor(context);
    await this.transact(context, async (tx) => {
      const state = await this.lockAccount(tx, actor, employeeId, 'unlock');
      const user = state.user;
      const now = new Date();
      if (
        !user ||
        user.archivedAt !== null ||
        !user.lockedUntil ||
        user.lockedUntil <= now
      ) {
        throw conflict(
          'EMPLOYEE_ACCOUNT_NOT_LOCKED',
          'This login is not locked.',
        );
      }
      const updated = await tx.user.updateMany({
        where: { id: user.id, lockedUntil: { gt: now } },
        data: { lockedUntil: null, failedLoginAttempts: 0 },
      });
      if (updated.count !== 1) throw this.changedConcurrently();
      await this.writeAudit(
        tx,
        'EMPLOYEE_ACCOUNT_UNLOCKED',
        user.id,
        context,
        {
          employeeId,
        },
        state.auditOrganizationIds,
      );
    });
    return this.account(employeeId, context);
  }

  /** The employee's active login with a password, or 409. */
  private passwordLogin(state: LockedAccount) {
    const user = state.user;
    if (
      !user ||
      user.archivedAt !== null ||
      user.status !== 'ACTIVE' ||
      user.passwordHash === null
    ) {
      throw conflict(
        'EMPLOYEE_ACCOUNT_NOT_ACTIVE',
        'Only an active login with a password supports this action.',
      );
    }
    return user;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** A fresh single-use invitation token, superseding the login's earlier invitation links. */
  private issueInvitation(tx: Tx, userId: string) {
    return this.tokens.issueWithin(
      tx,
      userId,
      AccountTokenType.INVITATION,
      INVITATION_TOKEN_LIFETIME_MS,
    );
  }

  /**
   * Emails an invitation token issued in the locked transaction. On a delivery failure the
   * token is withdrawn and the failure audited; a first invitation is also returned to "not
   * invited" so nothing unusable is left behind — but only while it is still the relevant
   * attempt. Another administrator may have resent (or cancelled) meanwhile, which supersedes
   * this token; the newer invitation is then left intact.
   */
  private async deliverInvitation(
    prepared: {
      userId: string;
      email: string;
      organizationIds: string[];
      auditOrganizationIds: string[];
      issued: IssuedAccountToken;
    },
    employeeId: string,
    context: EmployeeRequestContext,
    options: { undoOnFailure: boolean },
  ) {
    const { issued } = prepared;
    try {
      await this.emails.sendInvitation({
        email: prepared.email,
        token: issued.token,
        expiresAt: issued.expiresAt,
        userId: prepared.userId,
        organizationIds: prepared.organizationIds,
      });
    } catch (error) {
      await this.prisma.$transaction(async (tx) => {
        // Same lock order as every account change: a concurrent resend or cancel either
        // committed already (and superseded this token) or waits and sees the outcome.
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId}::uuid FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${prepared.userId}::uuid FOR UPDATE`,
        );
        const now = new Date();
        // Still unused means no later issue, cancel or disable has superseded this attempt.
        const withdrawn = await tx.accountToken.updateMany({
          where: { id: issued.id, usedAt: null },
          data: { usedAt: now },
        });
        const superseded = withdrawn.count === 0;
        const newerUsable = await tx.accountToken.count({
          where: {
            userId: prepared.userId,
            type: AccountTokenType.INVITATION,
            id: { not: issued.id },
            usedAt: null,
            expiresAt: { gt: now },
          },
        });
        let undone = false;
        let revokedRoleAssignmentCount = 0;
        if (options.undoOnFailure && !superseded && newerUsable === 0) {
          const archived = await tx.user.updateMany({
            where: {
              id: prepared.userId,
              status: 'INVITED',
              passwordHash: null,
              archivedAt: null,
            },
            data: { status: 'ARCHIVED', archivedAt: now },
          });
          undone = archived.count === 1;
          // Batch 5E: withdrawn like a cancellation — roles given to the invited login while
          // the email was being sent must not come back if the invitation is ever reissued.
          if (undone)
            revokedRoleAssignmentCount = (
              await this.revokeLiveGrants(
                tx,
                prepared.userId,
                this.requireActor(context),
                now,
              )
            ).count;
        }
        await this.writeAudit(
          tx,
          'EMPLOYEE_ACCOUNT_INVITATION_FAILED',
          prepared.userId,
          context,
          { employeeId, undone, superseded, revokedRoleAssignmentCount },
          prepared.auditOrganizationIds,
        );
      });
      throw error;
    }
  }

  /**
   * Batch 5E: revokes every live grant of a login inside the caller's transaction, which already
   * holds the employee and login row locks. The grants are locked in id order first — the order
   * every revocation path uses (lifecycle revocation, the Roles API, role archiving) — then
   * revoked conditionally, so a concurrent revocation never deadlocks with this one and each
   * grant is revoked once. Used by cancellation, a failed first delivery and reissue.
   */
  private async revokeLiveGrants(
    tx: Tx,
    userId: string,
    actor: string,
    now: Date,
  ) {
    const live = (
      await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "RoleAssignment" WHERE "userId" = ${userId}::uuid AND "revokedAt" IS NULL ORDER BY "id" FOR UPDATE`,
      )
    ).map((row) => row.id);
    return tx.roleAssignment.updateMany({
      where: { id: { in: live }, revokedAt: null },
      data: { revokedAt: now, revokedByUserId: actor },
    });
  }

  /**
   * Runs a login-access mutation in one transaction. An M1 refusal rolls the transaction back,
   * is then audited (and, when high-risk, alerted) on its own, and reaches the client unchanged.
   */
  private async transact<T>(
    context: EmployeeRequestContext,
    run: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(run);
    } catch (error) {
      if (error instanceof AccountActionRefused && error.details)
        await this.recordRefusal(error.details, context);
      throw error;
    }
  }

  /**
   * Authorizes the actor and loads (and, for mutations, row-locks) the employee and its login:
   * Employee, then User, then the login's grants are read (see the class comment). `action` is
   * the mutation being authorized (M1 policy); null for a read.
   */
  private async lockAccount(
    tx: Tx,
    actor: string,
    employeeId: string,
    action: AccountAction | null,
    options: { lock: boolean } = { lock: true },
  ): Promise<LockedAccount> {
    if (options.lock) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId}::uuid FOR UPDATE`,
      );
    }
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        status: true,
        archivedAt: true,
        personId: true,
        person: {
          select: {
            personalEmail: true,
            user: {
              select: {
                id: true,
                email: true,
                status: true,
                passwordHash: true,
                archivedAt: true,
                lastLoginAt: true,
                mustChangePassword: true,
                lockedUntil: true,
              },
            },
          },
        },
        assignments: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            positionId: true,
            status: true,
            endDate: true,
            position: {
              select: {
                organizationId: true,
                organization: { select: { timezone: true } },
                workLocation: { select: { timezone: true } },
              },
            },
          },
        },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    const authority = await this.authorizedAssignments(
      tx,
      actor,
      employee.assignments,
    );
    const user = employee.person.user;
    const subject = user
      ? { subjectType: 'User' as const, subjectId: user.id }
      : { subjectType: 'Employee' as const, subjectId: employee.id };
    const refuse = async (
      response: string | object,
      category: AccountRefusalCategory,
      risk: { targetSystemPrivileged: boolean; crossOrganization: boolean },
      auditOrganizationIds: string[],
      audited = true,
    ): Promise<never> => {
      throw new AccountActionRefused(
        response,
        action && audited
          ? {
              category,
              action,
              employeeId,
              ...subject,
              auditOrganizationIds,
              alertOrganizationId: await this.alertOrganization(
                tx,
                actor,
                authority.readOrganizationIds,
                employee.assignments,
              ),
              ...risk,
            }
          : null,
      );
    };
    if (authority.readOrganizationIds.length === 0 && !authority.system) {
      // Audited (and classified as cross-organization) only for an account administrator
      // elsewhere reaching for someone they have no authority over; an ordinary user's refused
      // request is the plain permission refusal it always was, and writes nothing.
      const administrator =
        action !== null &&
        (await this.authorization.can(
          actor,
          EMPLOYEE_ACCOUNT_PERMISSION,
          undefined,
          new Date(),
          tx,
        ));
      await refuse(
        'Missing permission employee.account.manage for this employee.',
        'NO_ACCOUNT_AUTHORITY',
        { targetSystemPrivileged: false, crossOrganization: administrator },
        [],
        administrator,
      );
    }
    const readAudit = authority.system ? [] : authority.readOrganizationIds;
    if (options.lock && user) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${user.id}::uuid FOR UPDATE`,
      );
    }
    let targetSystemOwner = false;
    if (user) {
      if (user.id === actor) {
        await refuse(
          'You cannot manage your own login access.',
          'SELF_MANAGEMENT',
          { targetSystemPrivileged: false, crossOrganization: false },
          readAudit,
        );
      }
      targetSystemOwner = await this.holdsSystemOwner(tx, user.id);
      if (targetSystemOwner && !(await this.holdsSystemOwner(tx, actor))) {
        await refuse(
          "Only a System Owner can manage a System Owner's login access.",
          'SYSTEM_OWNER_PROTECTED',
          { targetSystemPrivileged: true, crossOrganization: false },
          readAudit,
        );
      }
    }
    // Read after the User row lock: a concurrent grant insert has either committed (and is seen
    // here) or waits for this transaction (it needs the row's key-share lock).
    const policy = await this.policyFacts(
      tx,
      actor,
      user?.id ?? null,
      authority,
      employee.assignments,
      targetSystemOwner,
    );
    let organizationIds = authority.readOrganizationIds;
    if (action) {
      const decision = this.decide(ACCOUNT_ACTION_CLASS[action], policy);
      if (!decision.allowed) {
        await refuse(
          accountOutsideScope(decision.reason!).getResponse(),
          decision.reason!,
          {
            targetSystemPrivileged: policy.targetSystemPrivileged,
            crossOrganization: policy.crossOrganization,
          },
          readAudit,
        );
      }
      organizationIds = decision.organizationIds;
    }
    return {
      employee: {
        id: employee.id,
        status: employee.status,
        archivedAt: employee.archivedAt,
        personId: employee.personId,
        person: { personalEmail: employee.person.personalEmail },
      },
      user,
      organizationIds,
      auditOrganizationIds: authority.system ? [] : organizationIds,
      policy,
    };
  }

  /** Which of the employee's assignments the actor holds the permission over (or SYSTEM). */
  private async authorizedAssignments(
    tx: Tx,
    actor: string,
    assignments: ReadonlyArray<{
      positionId: string;
      status: string;
      endDate: Date | null;
      position: {
        organizationId: string;
        organization: { timezone: string | null } | null;
        workLocation: { timezone: string | null } | null;
      };
    }>,
  ) {
    const system = await this.authorization.can(
      actor,
      EMPLOYEE_ACCOUNT_PERMISSION,
      { type: 'SYSTEM' },
      new Date(),
      tx,
    );
    const now = this.businessNow();
    const byPosition = new Map<string, boolean>();
    const facts: AssignmentFact[] = [];
    for (const assignment of assignments) {
      let inScope = system || byPosition.get(assignment.positionId);
      if (inScope === undefined) {
        const scope = await this.targets.scopeForPosition(
          assignment.positionId,
          undefined,
          tx,
        );
        inScope = await this.authorization.canAccess(
          actor,
          EMPLOYEE_ACCOUNT_PERMISSION,
          scope,
          tx,
        );
        byPosition.set(assignment.positionId, inScope);
      }
      facts.push({
        organizationId: assignment.position.organizationId,
        status: assignment.status,
        endDate: assignment.endDate,
        inScope,
        businessDate: assignmentBusinessDate(assignment.position, now),
      });
    }
    return {
      system,
      assignments: facts,
      readOrganizationIds: unique(
        facts.filter((a) => a.inScope).map((a) => a.organizationId),
      ),
    };
  }

  /**
   * M1: grant coverage and the risk facts. The target's live grants are read whatever the login's
   * status (AuthorizationService.effectiveGrants returns none for a login that is not ACTIVE, but
   * a disabled or invited login's grants come back with it): not revoked, not expired, role and
   * organizations not archived, holding an active permission. A grant whose start lies ahead is
   * included: it becomes live without anyone acting again.
   */
  private async policyFacts(
    tx: Tx,
    actor: string,
    targetUserId: string | null,
    authority: {
      system: boolean;
      assignments: AssignmentFact[];
      readOrganizationIds: string[];
    },
    assignments: ReadonlyArray<{
      status: string;
      position: { organizationId: string };
    }>,
    targetSystemOwner: boolean,
  ): Promise<PolicyFacts> {
    const now = new Date();
    const grants = targetUserId
      ? await tx.roleAssignment.findMany({
          where: {
            userId: targetUserId,
            revokedAt: null,
            startsAt: { lte: now },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            AND: [
              {
                OR: LIVE_ORGANIZATION_GRANT.OR,
              },
            ],
            role: {
              ...LIVE_ORGANIZATION_GRANT.role,
              permissions: { some: { permission: { isActive: true } } },
            },
          },
          select: {
            scopeType: true,
            organizationId: true,
            organizationalUnitId: true,
            departmentId: true,
            teamId: true,
          },
        })
      : [];
    const targetSystemPrivileged =
      targetSystemOwner || grants.some((grant) => grant.scopeType === 'SYSTEM');
    const covered =
      authority.system ||
      (grants.length === 0
        ? true
        : await this.coversGrants(tx, actor, grants, now));
    const read = new Set(authority.readOrganizationIds);
    const crossOrganization =
      !authority.system &&
      (assignments.some(
        (a) =>
          (a.status === 'ACTIVE' || a.status === 'PLANNED') &&
          !read.has(a.position.organizationId),
      ) ||
        grants.some(
          (grant) =>
            grant.organizationId !== null && !read.has(grant.organizationId),
        ));
    return {
      system: authority.system,
      assignments: authority.assignments,
      readOrganizationIds: authority.readOrganizationIds,
      covered,
      targetSystemPrivileged,
      crossOrganization,
    };
  }

  /** Every grant scope lies inside one of the actor's employee.account.manage scopes. */
  private async coversGrants(
    tx: Tx,
    actor: string,
    grants: ReadonlyArray<{
      scopeType: string;
      organizationId: string | null;
      organizationalUnitId: string | null;
      departmentId: string | null;
      teamId: string | null;
    }>,
    now: Date,
  ): Promise<boolean> {
    const actorScopes: ScopeRef[] = (
      await this.authorization.effectiveGrants(actor, now, tx)
    )
      .filter((grant) => grant.permission === EMPLOYEE_ACCOUNT_PERMISSION)
      .map((grant) => grant.scope);
    if (actorScopes.some((scope) => scope.type === 'SYSTEM')) return true;
    const seen = new Set<string>();
    for (const grant of grants) {
      if (grant.scopeType === 'SYSTEM') return false;
      const id =
        grant.scopeType === 'ORGANIZATION'
          ? grant.organizationId
          : grant.scopeType === 'ORGANIZATIONAL_UNIT'
            ? grant.organizationalUnitId
            : grant.scopeType === 'DEPARTMENT'
              ? grant.departmentId
              : grant.teamId;
      if (!id) return false;
      const key = `${grant.scopeType}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let target;
      try {
        target = await this.authorization.resolveTarget(
          {
            type: grant.scopeType as
              'ORGANIZATION' | 'ORGANIZATIONAL_UNIT' | 'DEPARTMENT' | 'TEAM',
            id,
          },
          tx,
        );
      } catch {
        // A scope that no longer resolves cannot be shown to be covered.
        return false;
      }
      if (!actorScopes.some((scope) => scopeContainsTarget(scope, target)))
        return false;
    }
    return true;
  }

  /** M1: whether an action class is authorized, why not, and in which organizations. */
  private decide(
    actionClass: AccountActionClass,
    policy: PolicyFacts,
  ): {
    allowed: boolean;
    reason: AccountScopeReason | null;
    organizationIds: string[];
  } {
    if (policy.system)
      return {
        allowed: true,
        reason: null,
        organizationIds: policy.readOrganizationIds,
      };
    const inScope = policy.assignments.filter((a) => a.inScope);
    const organizationIds = unique(
      inScope
        .filter((a) => assignmentQualifies(actionClass, a, a.businessDate))
        .map((a) => a.organizationId),
    );
    if (organizationIds.length === 0) {
      const reason: AccountScopeReason =
        actionClass === 'PROTECTIVE' &&
        inScope.some((a) => a.status === 'ENDED')
          ? 'PROTECTIVE_WINDOW_ENDED'
          : 'NO_CURRENT_ASSIGNMENT';
      return { allowed: false, reason, organizationIds };
    }
    if (!policy.covered)
      return {
        allowed: false,
        reason: 'ACCESS_OUTSIDE_SCOPE',
        organizationIds,
      };
    return { allowed: true, reason: null, organizationIds };
  }

  /**
   * The organization an alert is filed under: one where the actor already has authority over the
   * target, else one where the actor administers logins, else the target's; null when none.
   */
  private async alertOrganization(
    tx: Tx,
    actor: string,
    readOrganizationIds: readonly string[],
    assignments: ReadonlyArray<{ position: { organizationId: string } }>,
  ): Promise<string | null> {
    if (readOrganizationIds.length > 0) return readOrganizationIds[0]!;
    const own = await tx.roleAssignment.findFirst({
      where: {
        userId: actor,
        revokedAt: null,
        startsAt: { lte: new Date() },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        organizationId: { not: null },
        organization: { archivedAt: null },
        role: {
          archivedAt: null,
          permissions: {
            some: { permission: { key: EMPLOYEE_ACCOUNT_PERMISSION } },
          },
        },
      },
      orderBy: { organizationId: 'asc' },
      select: { organizationId: true },
    });
    if (own?.organizationId) return own.organizationId;
    return unique(assignments.map((a) => a.position.organizationId))[0] ?? null;
  }

  /**
   * M1: audits a refused mutation (EMPLOYEE_ACCOUNT_ACTION_REFUSED, visible where the actor
   * already has authority over the person), classifies it, and alerts security administrators
   * when it is high-risk. Runs after the refused transaction rolled back; never throws, so the
   * refusal is what the client receives whatever happens here.
   */
  private async recordRefusal(
    details: RefusalDetails,
    context: EmployeeRequestContext,
  ) {
    try {
      const actor = this.requireActor(context);
      const actionClass = ACCOUNT_ACTION_CLASS[details.action];
      const at = new Date();
      const prior =
        actionClass === 'RESTORATIVE'
          ? await this.priorRestorativeRefusals(actor, at)
          : 0;
      const risk = classifyRefusalRisk({
        actionClass,
        targetSystemPrivileged: details.targetSystemPrivileged,
        crossOrganization: details.crossOrganization,
        priorRestorativeRefusals: prior,
      });
      const entry = {
        employeeId: details.employeeId,
        // Not `action` / `reason`: the audit viewer shows only these code-valued keys.
        refusedAction: details.action,
        actionClass,
        refusalReason: details.category,
        attemptId: randomUUID(),
      };
      const security = {
        ...entry,
        highRisk: risk !== null,
        riskCategory: risk,
      };
      if (details.auditOrganizationIds.length > 0) {
        // The organizations' copies carry no risk classification (it would tell the actor's
        // organization that the person is privileged or employed elsewhere) …
        await this.writeAudit(
          this.prisma,
          'EMPLOYEE_ACCOUNT_ACTION_REFUSED',
          details.subjectId,
          context,
          entry,
          details.auditOrganizationIds,
          details.subjectType,
        );
      }
      // … the System view's copy does (one per attempt: always when there is no organization
      // copy, otherwise only for a high-risk attempt).
      if (details.auditOrganizationIds.length === 0 || risk !== null) {
        await this.writeAudit(
          this.prisma,
          'EMPLOYEE_ACCOUNT_ACTION_REFUSED',
          details.subjectId,
          context,
          security,
          [],
          details.subjectType,
        );
      }
      if (risk && this.alerts && details.alertOrganizationId) {
        await this.alerts.refused({
          risk,
          action: details.action,
          actorUserId: actor,
          subjectType: details.subjectType,
          subjectId: details.subjectId,
          organizationId: details.alertOrganizationId,
          at,
        });
      }
    } catch (error) {
      this.logger.error(
        `Refused account action could not be audited: ${(error as Error).message}`,
      );
    }
  }

  /** Refused restorative attempts by the actor in the last 24 hours (one per attempt). */
  private async priorRestorativeRefusals(actor: string, at: Date) {
    const since = new Date(at.getTime() - REPEATED_REFUSAL_WINDOW_MS);
    const [{ count }] = await this.prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT count(DISTINCT COALESCE("metadata"->>'attemptId', "id"::text)) AS count
        FROM "AuditLog"
        WHERE "actorUserId" = ${actor}::uuid
          AND "action" = 'EMPLOYEE_ACCOUNT_ACTION_REFUSED'
          AND "occurredAt" > ${since}
          AND "metadata"->>'actionClass' = 'RESTORATIVE'`,
    );
    return Number(count);
  }

  private async holdsSystemOwner(tx: Tx, userId: string) {
    return (
      (await tx.roleAssignment.count({
        where: { userId, revokedAt: null, role: { isSystemOwner: true } },
      })) > 0
    );
  }

  private assertEmployeeActive(state: LockedAccount) {
    if (
      state.employee.status !== 'ACTIVE' ||
      state.employee.archivedAt !== null
    ) {
      throw conflict(
        'EMPLOYEE_NOT_ACTIVE',
        'Only an active employee can be given login access.',
      );
    }
  }

  private parseEmail(value: string | null | undefined) {
    const email = value ? normalizeEmail(value) : '';
    if (!email) {
      throw new BadRequestException(
        domainError(
          400,
          'EMPLOYEE_ACCOUNT_EMAIL_REQUIRED',
          'Enter the email address the invitation is sent to (the employee has no personal email).',
        ),
      );
    }
    if (!isEmail(email) || email.length > 254) {
      throw new BadRequestException(
        domainError(
          400,
          'EMPLOYEE_ACCOUNT_EMAIL_INVALID',
          'Enter a valid email address.',
        ),
      );
    }
    return email;
  }

  private async assertEmailFree(tx: Tx, email: string, exceptUserId?: string) {
    const owner = await tx.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (owner && owner.id !== exceptUserId) {
      throw conflict(
        'EMPLOYEE_ACCOUNT_EMAIL_IN_USE',
        'This email address already belongs to another login.',
      );
    }
  }

  private uniqueConflict(error: unknown) {
    if ((error as { code?: unknown }).code === 'P2002') {
      return conflict(
        'EMPLOYEE_ACCOUNT_EMAIL_IN_USE',
        'This email address or person already has a login.',
      );
    }
    return error;
  }

  private changedConcurrently() {
    return conflict(
      'EMPLOYEE_ACCOUNT_CHANGED',
      'The login changed meanwhile; reload and try again.',
    );
  }

  private async shape(state: LockedAccount, actor: string) {
    const user = state.user;
    let status: EmployeeAccountStatus = 'NOT_INVITED';
    let invitationExpiresAt: Date | null = null;
    if (user) {
      if (user.archivedAt !== null || user.status === 'ARCHIVED') {
        status = user.passwordHash === null ? 'NOT_INVITED' : 'ARCHIVED';
      } else if (user.status === 'INVITED') {
        const pending = await this.prisma.accountToken.findFirst({
          where: {
            userId: user.id,
            type: AccountTokenType.INVITATION,
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: { expiresAt: 'desc' },
          select: { expiresAt: true },
        });
        status = pending ? 'INVITED' : 'INVITATION_EXPIRED';
        invitationExpiresAt = pending?.expiresAt ?? null;
      } else {
        status = user.status as EmployeeAccountStatus;
      }
    }
    const employeeActive =
      state.employee.status === 'ACTIVE' && state.employee.archivedAt === null;
    const invited = status === 'INVITED' || status === 'INVITATION_EXPIRED';
    const now = new Date();
    const notSelf = user?.id !== actor;
    const signedIn = status === 'ACTIVE' || status === 'LOCKED';
    const lockedUntil =
      signedIn && user?.lockedUntil && user.lockedUntil > now
        ? user.lockedUntil
        : null;
    const activeSessionCount =
      user && signedIn
        ? await this.prisma.authSession.count({
            where: { userId: user.id, revokedAt: null, expiresAt: { gt: now } },
          })
        : 0;
    return {
      employeeId: state.employee.id,
      status,
      /** The login's address; for an employee without one, where an invitation would go. */
      email:
        user && status !== 'NOT_INVITED'
          ? user.email
          : (state.employee.person.personalEmail ?? null),
      invitationExpiresAt: invitationExpiresAt?.toISOString() ?? null,
      lastLoginAt: user?.lastLoginAt?.toISOString() ?? null,
      // Batch 2: security state, without addresses or devices.
      mustChangePassword: Boolean(user?.mustChangePassword) && signedIn,
      lockedUntil: lockedUntil?.toISOString() ?? null,
      activeSessionCount,
      ...this.capabilities(state.policy, {
        invite: status === 'NOT_INVITED' && employeeActive,
        resend: invited && employeeActive,
        cancel: invited,
        disable:
          (status === 'ACTIVE' || status === 'LOCKED') && user?.id !== actor,
        enable: status === 'DISABLED' && employeeActive,
        requirePasswordChange:
          status === 'ACTIVE' && !user?.mustChangePassword && notSelf,
        sendPasswordReset: status === 'ACTIVE' && employeeActive && notSelf,
        signOut: signedIn && activeSessionCount > 0 && notSelf,
        unlock: lockedUntil !== null && notSelf,
      }),
    };
  }

  /**
   * The action flags of a read. `actions` (unchanged contract): the action is available now.
   * M1 `capabilities`: the same answer with a reason when the login's state allows the action but
   * the policy refuses it (no reason when the state alone rules it out). Presentation hints only:
   * every mutation re-checks the policy in its own transaction.
   */
  private capabilities(
    policy: PolicyFacts,
    applicable: Record<AccountAction, boolean>,
  ) {
    const decisions = {
      PROTECTIVE: this.decide('PROTECTIVE', policy),
      RESTORATIVE: this.decide('RESTORATIVE', policy),
    };
    const capabilities = {} as Record<AccountAction, AccountCapability>;
    const actions = {} as Record<AccountAction, boolean>;
    for (const action of ACCOUNT_ACTIONS) {
      const decision = decisions[ACCOUNT_ACTION_CLASS[action]];
      capabilities[action] = applicable[action]
        ? { allowed: decision.allowed, reason: decision.reason }
        : { allowed: false, reason: null };
      actions[action] = capabilities[action].allowed;
    }
    return { actions, capabilities };
  }

  /**
   * Batch 2: an administrator's action on a login is visible only in the organizations whose
   * authority it used (the employee's organizations where the actor holds the permission), never
   * in another organization merely because it shares the employee. A System-scope action has no
   * organization: it appears in the System view only (an empty list).
   */
  private writeAudit(
    tx: Tx | PrismaService,
    action: string,
    userId: string,
    context: EmployeeRequestContext,
    metadata: Record<string, unknown>,
    auditOrganizationIds: readonly string[],
    entityType: 'User' | 'Employee' = 'User',
  ) {
    return this.audit.writeForOrganizations(
      {
        action,
        actorUserId: context.actorUserId,
        entityType,
        entityId: userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
      },
      auditOrganizationIds,
      tx,
    );
  }

  private requireActor(context: EmployeeRequestContext) {
    if (!context.actorUserId) throw new ForbiddenException();
    return context.actorUserId;
  }
}
