import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  AuthorizationService,
  getUnitPath,
} from '../authorization/authorization.service.js';
import type {
  AuthorizationScope,
  AuthorizationTarget,
} from '../authorization/authorization.types.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { LeavePolicy, LeaveType } from '../generated/prisma/client.js';
import { LeaveAccessService } from './leave-access.service.js';
import {
  addDays,
  advisoryLock,
  currentDates,
  formatDate,
  jsonValue,
  leaveError,
  parseDateOnly,
  positionTargets,
  requireActor,
  type LeaveClient,
  type LeaveRequestContext,
} from './leave-common.js';
import {
  employmentTypeSetsConflict,
  leavePolicySettingProblems,
  periodsOverlap,
  resolveLeavePolicy,
} from './leave-policy.js';
import type {
  CreateLeavePolicyDto,
  CreateLeaveTypeDto,
  EndLeavePolicyDto,
  LeavePolicyListQueryDto,
  LeavePolicySettingsDto,
  LeaveTypeListQueryDto,
  ResolveLeavePolicyQueryDto,
  UpdateLeavePolicyDto,
  UpdateLeaveTypeDto,
} from './leave.dto.js';

type Tx = Prisma.TransactionClient;
const MANAGE = 'leave.manage_policy' as const;
const CONFIG_READERS = [
  'leave.manage_policy',
  'leave.read',
  'leave.approve',
] as const;

const SETTING_FIELDS = [
  'name',
  'employmentTypes',
  'eligible',
  'waitingPeriodDays',
  'leaveYearStartMonth',
  'leaveYearStartDay',
  'amountSource',
  'standardWorkdayMinutes',
  'standardWorkdays',
  'excludeHolidays',
  'allowPartialDay',
  'accrualMethod',
  'annualGrantMinutes',
  'accrualFrequency',
  'accrualMinutesPerPeriod',
  'accrualAnchorDate',
  'prorateFirstYear',
  'maxBalanceMinutes',
  'negativeBalanceLimitMinutes',
  'carryoverMode',
  'carryoverMaxMinutes',
  'carryoverExpiryDays',
  'employeeMayCancelApprovedFuture',
] as const satisfies readonly (keyof LeavePolicySettingsDto)[];

/**
 * Phase 8 — leave types (organization catalog) and effective-dated leave policies.
 *
 * Policies follow the SchedulePolicy lifecycle: a policy that has not taken effect may be
 * edited or deleted; once in effect it can only be ended (never into days already past), so
 * policy history is preserved. Ambiguous policies — same leave type, exact scope target,
 * overlapping period and overlapping employment-type sets — are rejected under a per-scope
 * advisory lock instead of being merged.
 */
@Injectable()
export class LeaveConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly access: LeaveAccessService,
    private readonly audit: AuditService,
  ) {}

  // ─── Leave types ───────────────────────────────────────────────────────────

  async listTypes(userId: string, query: LeaveTypeListQueryDto) {
    const grants = await this.access.grants(userId);
    if (
      !(await this.access.grantedInOrganization(
        grants,
        [...CONFIG_READERS, 'leave.request'],
        query.organizationId,
      ))
    ) {
      throw new ForbiddenException(
        'Missing permission to read leave types of the organization.',
      );
    }
    await this.access.requireEnabled(query.organizationId);
    const rows = await this.prisma.leaveType.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
    const canManage = this.access.can(
      grants,
      MANAGE,
      this.access.organizationTarget(query.organizationId),
    );
    return {
      items: rows.map((row) => ({
        ...this.typeShape(row),
        actions: {
          canEdit: canManage && !row.archivedAt,
          canArchive: canManage && !row.archivedAt,
        },
      })),
    };
  }

  async createType(input: CreateLeaveTypeDto, context: LeaveRequestContext) {
    const actor = requireActor(context);
    // Normalized here too, so non-HTTP callers get the same canonical code as the DTO pipe.
    const code = input.code.trim().replace(/\s+/g, '-').toUpperCase();
    if (!/^[A-Z0-9_-]{2,64}$/.test(code)) {
      throw new BadRequestException(
        'code must be 2–64 letters, digits, "-" or "_".',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertManageOrganization(actor, input.organizationId, tx);
      const organization = await tx.organization.findUnique({
        where: { id: input.organizationId },
      });
      if (!organization || organization.archivedAt) {
        throw new NotFoundException('Organization not found');
      }
      try {
        const created = await tx.leaveType.create({
          data: {
            organizationId: input.organizationId,
            code,
            name: input.name.trim(),
            description: input.description?.trim() || null,
            classification: input.classification,
            tracksBalance: input.tracksBalance ?? true,
            displayUnit: input.displayUnit ?? 'DAYS',
          },
        });
        await this.writeAudit(
          tx,
          'LEAVE_TYPE_CREATED',
          'LeaveType',
          created.id,
          context,
          {
            leaveType: this.typeShape(created),
          },
        );
        return this.typeShape(created);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException(
            leaveError(
              409,
              'LEAVE_TYPE_CODE_TAKEN',
              'A leave type with this code already exists.',
            ),
          );
        }
        throw error;
      }
    });
  }

  /**
   * Classification and balance tracking are fixed at creation: changing them would silently
   * reinterpret existing balances and approved leave. Create a new type instead.
   */
  async updateType(
    typeId: string,
    input: UpdateLeaveTypeDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockType(typeId, tx);
      await this.assertManageOrganization(actor, current.organizationId, tx);
      if (current.archivedAt)
        throw new ConflictException('An archived leave type cannot be edited.');
      const updated = await tx.leaveType.update({
        where: { id: typeId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description.trim() || null }
            : {}),
          ...(input.displayUnit ? { displayUnit: input.displayUnit } : {}),
        },
      });
      await this.writeAudit(
        tx,
        'LEAVE_TYPE_UPDATED',
        'LeaveType',
        typeId,
        context,
        {
          before: this.typeShape(current),
          after: this.typeShape(updated),
        },
      );
      return this.typeShape(updated);
    });
  }

  /** Archiving stops new requests and entitlement posting; history and balances remain. */
  async archiveType(typeId: string, context: LeaveRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockType(typeId, tx);
      await this.assertManageOrganization(actor, current.organizationId, tx);
      if (current.archivedAt) return this.typeShape(current);
      const archived = await tx.leaveType.update({
        where: { id: typeId },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(
        tx,
        'LEAVE_TYPE_ARCHIVED',
        'LeaveType',
        typeId,
        context,
        {
          leaveType: this.typeShape(archived),
        },
      );
      return this.typeShape(archived);
    });
  }

  // ─── Policies ──────────────────────────────────────────────────────────────

  async listPolicies(userId: string, query: LeavePolicyListQueryDto) {
    const grants = await this.access.grants(userId);
    const rows = await this.prisma.leavePolicy.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {}),
      },
      include: { leaveType: true },
      orderBy: [
        { leaveTypeId: 'asc' },
        { scopeType: 'asc' },
        { effectiveFrom: 'desc' },
        { id: 'asc' },
      ],
      take: 500,
    });
    const targets = await this.policyTargets(rows, this.prisma);
    const latest = currentDates().latest;
    const items = rows.filter((row) => {
      const target = targets.get(row.id);
      return target && this.access.canAny(grants, CONFIG_READERS, target);
    });
    if (items.length > 0)
      await this.access.requireEnabled(query.organizationId);
    // Batch 6B (L7): who an assignment-scoped policy is for, by name — listed only to readers
    // of that assignment's leave (the filter above), so nothing beyond their scope.
    const assignmentIds = items
      .map((row) => row.employmentAssignmentId)
      .filter((id): id is string => id !== null);
    const assignments = new Map(
      (assignmentIds.length
        ? await this.prisma.employmentAssignment.findMany({
            where: { id: { in: assignmentIds } },
            select: {
              id: true,
              position: { select: { name: true } },
              employee: {
                select: {
                  employeeNumber: true,
                  person: {
                    select: {
                      firstName: true,
                      lastName: true,
                      preferredName: true,
                    },
                  },
                },
              },
            },
          })
        : []
      ).map((row) => [
        row.id,
        {
          employeeName:
            [
              row.employee.person.preferredName ??
                row.employee.person.firstName,
              row.employee.person.lastName,
            ]
              .filter(Boolean)
              .join(' ') || row.employee.employeeNumber,
          employeeNumber: row.employee.employeeNumber,
          positionName: row.position.name,
        },
      ]),
    );
    return {
      items: items
        .filter((row) => {
          const target = targets.get(row.id);
          return target && this.access.canAny(grants, CONFIG_READERS, target);
        })
        .map((row) => {
          const canManage = this.access.can(
            grants,
            MANAGE,
            targets.get(row.id)!,
          );
          const started = row.effectiveFrom <= latest;
          return {
            ...this.policyShape(row),
            leaveType: this.typeShape(row.leaveType),
            assignment: row.employmentAssignmentId
              ? (assignments.get(row.employmentAssignmentId) ?? null)
              : null,
            actions: {
              canEdit: canManage && !started,
              canDelete: canManage && !started,
              canEnd:
                canManage &&
                started &&
                (row.effectiveTo === null ||
                  row.effectiveTo >= currentDates().earliest),
            },
          };
        }),
    };
  }

  async getPolicy(userId: string, policyId: string) {
    const policy = await this.prisma.leavePolicy.findUnique({
      where: { id: policyId },
      include: { leaveType: true },
    });
    if (!policy) throw new NotFoundException('Leave policy not found');
    const target = (await this.policyTargets([policy], this.prisma)).get(
      policy.id,
    );
    const grants = await this.access.grants(userId);
    if (!target || !this.access.canAny(grants, CONFIG_READERS, target)) {
      throw new NotFoundException('Leave policy not found');
    }
    await this.access.requireEnabled(policy.organizationId);
    return {
      ...this.policyShape(policy),
      leaveType: this.typeShape(policy.leaveType),
    };
  }

  async resolvePolicy(userId: string, query: ResolveLeavePolicyQueryDto) {
    const { assignment, target } = await this.access.assignmentContext(
      query.employmentAssignmentId,
    );
    const grants = await this.access.grants(userId);
    if (!this.access.canAny(grants, [...CONFIG_READERS], target)) {
      throw new ForbiddenException(
        'Missing permission to read leave policy for the assignment.',
      );
    }
    await this.access.requireEnabled(target.organizationId);
    const date = parseDateOnly(query.date, 'date');
    const policy = await this.resolveFor(
      {
        employmentAssignmentId: assignment.id,
        employmentType: assignment.employmentType,
        target,
      },
      query.leaveTypeId,
      date,
      this.prisma,
    );
    return {
      date: query.date,
      policy: policy ? this.policyShape(policy) : null,
      eligible: !!policy?.eligible,
    };
  }

  async createPolicy(
    input: CreateLeavePolicyDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    const period = this.parsePeriod(
      input.effectiveFrom,
      input.effectiveTo ?? null,
    );
    const scope = this.scopeColumns(input);
    const settings = this.mergedSettings(null, input);
    return this.prisma.$transaction(async (tx) => {
      await this.assertLeaveType(input.leaveTypeId, input.organizationId, tx);
      const target = await this.assertScope(actor, scope, tx);
      void target;
      await this.lockScope(input.leaveTypeId, scope, tx);
      await this.assertNoAmbiguity(
        input.leaveTypeId,
        scope,
        period,
        settings.employmentTypes,
        null,
        tx,
      );
      const created = await tx.leavePolicy.create({
        data: {
          leaveTypeId: input.leaveTypeId,
          ...scope,
          ...period,
          ...settings,
        },
      });
      await this.writeAudit(
        tx,
        'LEAVE_POLICY_CREATED',
        'LeavePolicy',
        created.id,
        context,
        {
          policy: this.policyShape(created),
        },
      );
      return this.policyShape(created);
    });
  }

  async updatePolicy(
    policyId: string,
    input: UpdateLeavePolicyDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockPolicy(actor, policyId, tx);
      this.assertNotStarted(current);
      const period = this.parsePeriod(
        input.effectiveFrom ?? formatDate(current.effectiveFrom),
        input.effectiveTo === undefined
          ? current.effectiveTo && formatDate(current.effectiveTo)
          : input.effectiveTo,
      );
      if (period.effectiveFrom <= currentDates().latest) {
        throw new BadRequestException(
          'An edited policy must still start in the future.',
        );
      }
      const settings = this.mergedSettings(current, input);
      await this.assertNoAmbiguity(
        current.leaveTypeId,
        current,
        period,
        settings.employmentTypes,
        current.id,
        tx,
      );
      const updated = await tx.leavePolicy.update({
        where: { id: policyId },
        data: { ...period, ...settings },
      });
      await this.writeAudit(
        tx,
        'LEAVE_POLICY_UPDATED',
        'LeavePolicy',
        policyId,
        context,
        {
          before: this.policyShape(current),
          after: this.policyShape(updated),
        },
      );
      return this.policyShape(updated);
    });
  }

  async endPolicy(
    policyId: string,
    input: EndLeavePolicyDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    const effectiveTo = parseDateOnly(input.effectiveTo, 'effectiveTo');
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockPolicy(actor, policyId, tx);
      if (effectiveTo < current.effectiveFrom) {
        throw new BadRequestException(
          'effectiveTo must be on or after effectiveFrom.',
        );
      }
      if (current.effectiveTo && effectiveTo >= current.effectiveTo) {
        throw new BadRequestException(
          'Ending a policy may only move its end earlier.',
        );
      }
      if (effectiveTo < addDays(currentDates().earliest, -1)) {
        throw new BadRequestException(
          'A policy cannot be ended before yesterday.',
        );
      }
      const updated = await tx.leavePolicy.update({
        where: { id: policyId },
        data: { effectiveTo },
      });
      await this.writeAudit(
        tx,
        'LEAVE_POLICY_ENDED',
        'LeavePolicy',
        policyId,
        context,
        {
          before: this.policyShape(current),
          after: this.policyShape(updated),
        },
      );
      return this.policyShape(updated);
    });
  }

  async deletePolicy(policyId: string, context: LeaveRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockPolicy(actor, policyId, tx);
      this.assertNotStarted(current);
      await tx.leavePolicy.delete({ where: { id: policyId } });
      await this.writeAudit(
        tx,
        'LEAVE_POLICY_DELETED',
        'LeavePolicy',
        policyId,
        context,
        {
          policy: this.policyShape(current),
        },
      );
      return { id: policyId, deleted: true };
    });
  }

  // ─── Resolution (shared with requests and entitlement jobs) ────────────────

  /** All policies of one leave type in an organization (resolution is in memory). */
  policiesOf(leaveTypeId: string, client: LeaveClient) {
    return client.leavePolicy.findMany({ where: { leaveTypeId } });
  }

  async resolveFor(
    subject: Parameters<typeof resolveLeavePolicy>[1],
    leaveTypeId: string,
    date: Date,
    client: LeaveClient,
  ) {
    return resolveLeavePolicy(
      await this.policiesOf(leaveTypeId, client),
      subject,
      date,
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private scopeColumns(input: CreateLeavePolicyDto) {
    const set = [
      ['ORGANIZATIONAL_UNIT', input.organizationalUnitId],
      ['DEPARTMENT', input.departmentId],
      ['TEAM', input.teamId],
      ['EMPLOYMENT_ASSIGNMENT', input.employmentAssignmentId],
    ].filter(([, id]) => id);
    const expected = input.scopeType === 'ORGANIZATION' ? 0 : 1;
    if (
      set.length !== expected ||
      (expected === 1 && set[0]![0] !== input.scopeType)
    ) {
      throw new BadRequestException(
        'The policy scope must name exactly the target of its scopeType (none for ORGANIZATION).',
      );
    }
    return {
      organizationId: input.organizationId,
      scopeType: input.scopeType,
      organizationalUnitId: input.organizationalUnitId ?? null,
      departmentId: input.departmentId ?? null,
      teamId: input.teamId ?? null,
      employmentAssignmentId: input.employmentAssignmentId ?? null,
    };
  }

  private mergedSettings(
    current: LeavePolicy | null,
    input: LeavePolicySettingsDto,
  ) {
    const base = {
      name: current?.name ?? null,
      employmentTypes: current?.employmentTypes ?? [],
      eligible: current?.eligible ?? true,
      waitingPeriodDays: current?.waitingPeriodDays ?? 0,
      leaveYearStartMonth: current?.leaveYearStartMonth ?? 1,
      leaveYearStartDay: current?.leaveYearStartDay ?? 1,
      amountSource: current?.amountSource ?? 'SCHEDULE_THEN_STANDARD',
      standardWorkdayMinutes: current?.standardWorkdayMinutes ?? 480,
      standardWorkdays: current?.standardWorkdays ?? [
        'MONDAY',
        'TUESDAY',
        'WEDNESDAY',
        'THURSDAY',
        'FRIDAY',
      ],
      excludeHolidays: current?.excludeHolidays ?? true,
      allowPartialDay: current?.allowPartialDay ?? true,
      accrualMethod: current?.accrualMethod ?? 'NONE',
      annualGrantMinutes: current?.annualGrantMinutes ?? null,
      accrualFrequency: current?.accrualFrequency ?? null,
      accrualMinutesPerPeriod: current?.accrualMinutesPerPeriod ?? null,
      accrualAnchorDate: current?.accrualAnchorDate ?? null,
      prorateFirstYear: current?.prorateFirstYear ?? false,
      maxBalanceMinutes: current?.maxBalanceMinutes ?? null,
      negativeBalanceLimitMinutes: current?.negativeBalanceLimitMinutes ?? 0,
      carryoverMode: current?.carryoverMode ?? 'UNLIMITED',
      carryoverMaxMinutes: current?.carryoverMaxMinutes ?? null,
      carryoverExpiryDays: current?.carryoverExpiryDays ?? null,
      employeeMayCancelApprovedFuture:
        current?.employeeMayCancelApprovedFuture ?? true,
    };
    const merged: Record<string, unknown> = { ...base };
    for (const field of SETTING_FIELDS) {
      const value = input[field];
      if (value === undefined) continue;
      merged[field] =
        field === 'accrualAnchorDate' && typeof value === 'string'
          ? parseDateOnly(value, 'accrualAnchorDate')
          : field === 'name' && typeof value === 'string'
            ? value.trim()
            : value;
    }
    const settings = merged as typeof base;
    const problems = leavePolicySettingProblems(settings);
    if (problems.length > 0) {
      throw new BadRequestException(
        leaveError(400, 'LEAVE_POLICY_INVALID', problems.join(' '), {
          problems,
        }),
      );
    }
    return settings;
  }

  private parsePeriod(from: string, to: string | null) {
    const effectiveFrom = parseDateOnly(from, 'effectiveFrom');
    const effectiveTo = to ? parseDateOnly(to, 'effectiveTo') : null;
    if (effectiveTo && effectiveTo < effectiveFrom) {
      throw new BadRequestException(
        'effectiveTo must be on or after effectiveFrom.',
      );
    }
    return { effectiveFrom, effectiveTo };
  }

  private assertNotStarted(policy: { effectiveFrom: Date }) {
    if (policy.effectiveFrom <= currentDates().latest) {
      throw new ConflictException(
        leaveError(
          409,
          'LEAVE_POLICY_IN_EFFECT',
          'The policy is in effect; it can only be ended. Create a new policy to change settings.',
        ),
      );
    }
  }

  private async assertLeaveType(
    leaveTypeId: string,
    organizationId: string,
    tx: Tx,
  ) {
    const type = await tx.leaveType.findUnique({ where: { id: leaveTypeId } });
    if (!type || type.organizationId !== organizationId) {
      throw new NotFoundException('Leave type not found in the organization');
    }
    if (type.archivedAt) {
      throw new BadRequestException(
        'Policies cannot be created for an archived leave type.',
      );
    }
  }

  /** Validates the scope target belongs to the organization and the actor may manage it. */
  private async assertScope(
    actor: string,
    scope: ReturnType<LeaveConfigService['scopeColumns']>,
    tx: Tx,
  ): Promise<AuthorizationTarget> {
    let target: AuthorizationTarget;
    if (scope.scopeType === 'EMPLOYMENT_ASSIGNMENT') {
      const context = await this.access.assignmentContext(
        scope.employmentAssignmentId!,
        tx,
      );
      if (context.assignment.position.organizationId !== scope.organizationId) {
        throw new BadRequestException(
          'The assignment does not belong to the policy organization.',
        );
      }
      target = context.target;
    } else {
      try {
        target = await this.authorization.resolveTarget(
          this.authorizationScope(scope),
          tx,
        );
      } catch (error) {
        if (error instanceof NotFoundException) {
          throw new NotFoundException('Leave policy scope target not found');
        }
        throw error;
      }
      if (target.organizationId !== scope.organizationId) {
        throw new BadRequestException(
          'The policy scope target must belong to its organization.',
        );
      }
    }
    const grants = await this.access.grants(actor, tx);
    if (!this.access.can(grants, MANAGE, target)) {
      throw new ForbiddenException(
        'Missing permission leave.manage_policy for the policy scope.',
      );
    }
    await this.access.requireEnabled(scope.organizationId, tx);
    return target;
  }

  private async lockScope(
    leaveTypeId: string,
    scope: Pick<
      LeavePolicy,
      | 'scopeType'
      | 'organizationId'
      | 'organizationalUnitId'
      | 'departmentId'
      | 'teamId'
      | 'employmentAssignmentId'
    >,
    tx: Tx,
  ) {
    const targetId =
      scope.employmentAssignmentId ??
      scope.teamId ??
      scope.departmentId ??
      scope.organizationalUnitId ??
      scope.organizationId;
    await advisoryLock(
      tx,
      `leave-policy:${leaveTypeId}:${scope.scopeType}:${targetId}`,
    );
  }

  /** The caller holds the scope lock, so the check and the write cannot race. */
  private async assertNoAmbiguity(
    leaveTypeId: string,
    scope: Pick<
      LeavePolicy,
      | 'scopeType'
      | 'organizationId'
      | 'organizationalUnitId'
      | 'departmentId'
      | 'teamId'
      | 'employmentAssignmentId'
    >,
    period: { effectiveFrom: Date; effectiveTo: Date | null },
    employmentTypes: LeavePolicy['employmentTypes'],
    excludeId: string | null,
    tx: Tx,
  ) {
    const siblings = await tx.leavePolicy.findMany({
      where: {
        leaveTypeId,
        scopeType: scope.scopeType,
        organizationId: scope.organizationId,
        organizationalUnitId: scope.organizationalUnitId,
        departmentId: scope.departmentId,
        teamId: scope.teamId,
        employmentAssignmentId: scope.employmentAssignmentId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    const conflict = siblings.find(
      (sibling) =>
        periodsOverlap(sibling, period) &&
        employmentTypeSetsConflict(sibling.employmentTypes, employmentTypes),
    );
    if (conflict) {
      throw new ConflictException(
        leaveError(
          409,
          'LEAVE_POLICY_AMBIGUOUS',
          'Another policy of this leave type and scope overlaps this period for the same employment types; end it or narrow the employment types.',
          { conflictingPolicyId: conflict.id },
        ),
      );
    }
  }

  private async lockPolicy(actor: string, policyId: string, tx: Tx) {
    const found = await tx.leavePolicy.findUnique({ where: { id: policyId } });
    if (!found) throw new NotFoundException('Leave policy not found');
    const target = (await this.policyTargets([found], tx)).get(found.id);
    const grants = await this.access.grants(actor, tx);
    if (!target || !this.access.canAny(grants, CONFIG_READERS, target)) {
      throw new NotFoundException('Leave policy not found');
    }
    if (!this.access.can(grants, MANAGE, target)) {
      throw new ForbiddenException(
        'Missing permission leave.manage_policy for the policy scope.',
      );
    }
    await this.access.requireEnabled(found.organizationId, tx);
    await this.lockScope(found.leaveTypeId, found, tx);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "LeavePolicy" WHERE "id" = ${policyId}::uuid FOR UPDATE`,
    );
    const policy = await tx.leavePolicy.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundException('Leave policy not found');
    return policy;
  }

  private async lockType(typeId: string, tx: Tx) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "LeaveType" WHERE "id" = ${typeId}::uuid FOR UPDATE`,
    );
    const type = await tx.leaveType.findUnique({ where: { id: typeId } });
    if (!type) throw new NotFoundException('Leave type not found');
    return type;
  }

  private async assertManageOrganization(
    actor: string,
    organizationId: string,
    tx: Tx,
  ) {
    const grants = await this.access.grants(actor, tx);
    if (
      !this.access.can(
        grants,
        MANAGE,
        this.access.organizationTarget(organizationId),
      )
    ) {
      throw new ForbiddenException(
        'Missing permission leave.manage_policy for the organization.',
      );
    }
    await this.access.requireEnabled(organizationId, tx);
  }

  /** Authorization targets of policy scopes; an assignment scope uses its position. */
  /**
   * The authorization target of each policy's scope, batched (one query per kind) with the
   * same semantics as AuthorizationService.resolveTarget / the assignment's position target.
   * A scope that no longer resolves maps to null.
   */
  private async policyTargets(policies: LeavePolicy[], client: LeaveClient) {
    const result = new Map<string, AuthorizationTarget | null>();
    if (policies.length === 0) return result;
    const ids = (pick: (p: LeavePolicy) => string | null) => [
      ...new Set(policies.map(pick).filter((id): id is string => !!id)),
    ];
    const [units, departments, teams, assignments] = await Promise.all([
      client.organizationalUnit.findMany({
        where: { organizationId: { in: ids((p) => p.organizationId) } },
        select: { id: true, organizationId: true, parentUnitId: true },
      }),
      client.department.findMany({
        where: { id: { in: ids((p) => p.departmentId) } },
      }),
      client.team.findMany({ where: { id: { in: ids((p) => p.teamId) } } }),
      client.employmentAssignment.findMany({
        where: { id: { in: ids((p) => p.employmentAssignmentId) } },
        select: {
          id: true,
          position: {
            select: {
              id: true,
              organizationId: true,
              organizationalUnitId: true,
              departmentId: true,
              teamId: true,
            },
          },
        },
      }),
    ]);
    // Team placement may name a department outside this batch.
    const teamDepartments = await client.department.findMany({
      where: {
        id: {
          in: teams
            .map((t) => t.departmentId)
            .filter((id): id is string => !!id),
        },
      },
    });
    const departmentById = new Map(
      [...departments, ...teamDepartments].map((d) => [d.id, d]),
    );
    const unitPath = (organizationId: string, unitId: string) =>
      getUnitPath(
        units.filter((u) => u.organizationId === organizationId),
        unitId,
      );
    const positionTarget = await positionTargets(
      client,
      assignments.map((a) => a.position),
    );
    for (const policy of policies) {
      let target: AuthorizationTarget | null = null;
      switch (policy.scopeType) {
        case 'ORGANIZATION':
          target = {
            type: 'ORGANIZATION',
            organizationId: policy.organizationId,
          };
          break;
        case 'ORGANIZATIONAL_UNIT': {
          const unit = units.find((u) => u.id === policy.organizationalUnitId);
          if (unit && unit.organizationId === policy.organizationId) {
            target = {
              type: 'ORGANIZATIONAL_UNIT',
              organizationId: unit.organizationId,
              unitPathIds: unitPath(unit.organizationId, unit.id),
            };
          }
          break;
        }
        case 'DEPARTMENT': {
          const department = departmentById.get(policy.departmentId!);
          if (
            department &&
            department.organizationId === policy.organizationId
          ) {
            target = {
              type: 'DEPARTMENT',
              organizationId: department.organizationId,
              departmentId: department.id,
              unitPathIds: department.organizationalUnitId
                ? unitPath(
                    department.organizationId,
                    department.organizationalUnitId,
                  )
                : [],
            };
          }
          break;
        }
        case 'TEAM': {
          const team = teams.find((t) => t.id === policy.teamId);
          if (!team || team.organizationId !== policy.organizationId) break;
          let unitId = team.organizationalUnitId ?? null;
          if (team.departmentId) {
            const department = departmentById.get(team.departmentId);
            if (
              !department ||
              department.organizationId !== team.organizationId
            )
              break;
            unitId = department.organizationalUnitId ?? null;
          }
          target = {
            type: 'TEAM',
            organizationId: team.organizationId,
            teamId: team.id,
            departmentId: team.departmentId ?? null,
            unitPathIds: unitId ? unitPath(team.organizationId, unitId) : [],
          };
          break;
        }
        case 'EMPLOYMENT_ASSIGNMENT': {
          const assignment = assignments.find(
            (a) => a.id === policy.employmentAssignmentId,
          );
          target = assignment
            ? (positionTarget.get(assignment.position.id) ?? null)
            : null;
          break;
        }
      }
      result.set(policy.id, target);
    }
    return result;
  }

  private authorizationScope(
    scope: Pick<
      LeavePolicy,
      | 'scopeType'
      | 'organizationId'
      | 'organizationalUnitId'
      | 'departmentId'
      | 'teamId'
    >,
  ): AuthorizationScope {
    const organizationId = scope.organizationId;
    switch (scope.scopeType) {
      case 'ORGANIZATIONAL_UNIT':
        return {
          type: 'ORGANIZATIONAL_UNIT',
          id: scope.organizationalUnitId!,
          organizationId,
        };
      case 'DEPARTMENT':
        return { type: 'DEPARTMENT', id: scope.departmentId!, organizationId };
      case 'TEAM':
        return { type: 'TEAM', id: scope.teamId!, organizationId };
      default:
        return { type: 'ORGANIZATION', id: organizationId, organizationId };
    }
  }

  typeShape(row: LeaveType) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      code: row.code,
      name: row.name,
      description: row.description,
      classification: row.classification,
      tracksBalance: row.tracksBalance,
      displayUnit: row.displayUnit,
      archivedAt: row.archivedAt?.toISOString() ?? null,
    };
  }

  policyShape(row: LeavePolicy) {
    return {
      id: row.id,
      leaveTypeId: row.leaveTypeId,
      organizationId: row.organizationId,
      scopeType: row.scopeType,
      organizationalUnitId: row.organizationalUnitId,
      departmentId: row.departmentId,
      teamId: row.teamId,
      employmentAssignmentId: row.employmentAssignmentId,
      employmentTypes: row.employmentTypes,
      name: row.name,
      effectiveFrom: formatDate(row.effectiveFrom),
      effectiveTo: row.effectiveTo && formatDate(row.effectiveTo),
      eligible: row.eligible,
      waitingPeriodDays: row.waitingPeriodDays,
      leaveYearStartMonth: row.leaveYearStartMonth,
      leaveYearStartDay: row.leaveYearStartDay,
      amountSource: row.amountSource,
      standardWorkdayMinutes: row.standardWorkdayMinutes,
      standardWorkdays: row.standardWorkdays,
      excludeHolidays: row.excludeHolidays,
      allowPartialDay: row.allowPartialDay,
      accrualMethod: row.accrualMethod,
      annualGrantMinutes: row.annualGrantMinutes,
      accrualFrequency: row.accrualFrequency,
      accrualMinutesPerPeriod: row.accrualMinutesPerPeriod,
      accrualAnchorDate:
        row.accrualAnchorDate && formatDate(row.accrualAnchorDate),
      prorateFirstYear: row.prorateFirstYear,
      maxBalanceMinutes: row.maxBalanceMinutes,
      negativeBalanceLimitMinutes: row.negativeBalanceLimitMinutes,
      carryoverMode: row.carryoverMode,
      carryoverMaxMinutes: row.carryoverMaxMinutes,
      carryoverExpiryDays: row.carryoverExpiryDays,
      employeeMayCancelApprovedFuture: row.employeeMayCancelApprovedFuture,
    };
  }

  private writeAudit(
    tx: Tx,
    action: string,
    entityType: string,
    entityId: string,
    context: LeaveRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType,
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue(metadata),
      },
      tx,
    );
  }
}
