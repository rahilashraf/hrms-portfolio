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
import type { AuthorizationScope } from '../authorization/authorization.types.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import {
  addDays,
  advisoryLock,
  currentDates,
  domainError,
  formatDate,
  jsonValue,
  parseDateOnly,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import type {
  Prisma,
  TimeAttendancePolicy,
} from '../generated/prisma/client.js';
import type {
  CreateTimePolicyDto,
  InheritedPolicyQueryDto,
  EndTimePolicyDto,
  SupersedeTimePolicyDto,
  TimePolicyListQueryDto,
} from './time.dto.js';
import {
  AUTO_DEDUCT_DEFAULT_AFTER_MINUTES,
  ORGANIZATION_ONLY_POLICY_SECTIONS,
  validateTimePolicyConfig,
} from './time-policy.js';
import type { TimeRequestContext } from './time.service.js';
import { canSeeOrganization } from './organization-visibility.js';
import { policyScopeNames } from './time-policy-scope-names.js';

type Client = PrismaService | Prisma.TransactionClient;
const PERMISSION = 'time.manage_policy';
const MANAGE_ORGANIZATION_PERMISSIONS = [
  'time.view',
  'time.correct',
  PERMISSION,
  'time.device.manage',
  'time.credential.manage',
  // Batch 4E-1 (G4): attendance review (exceptions, corrections, timesheets).
  'time.approve',
  'time.timesheet.approve',
  'time.timesheet.manage',
] as const;

/**
 * Phase 9.5 — administration of TimeAttendancePolicy layers (including the attendance tracking
 * and capture modes). Policies are effective-dated records: never edited, never retroactive.
 * Changing a policy is ending the current layer and adding the next. A layer that has not yet
 * started anywhere may be archived. Each scope is managed with time.manage_policy on it.
 */
@Injectable()
export class TimePolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly audit: AuditService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** Phase 18: the ATTENDANCE module gate (SYSTEM layers are not organization-gated). */
  readonly features: FeatureGateService;

  /**
   * The organizations the user can administer attendance in through any Time permission (an
   * organization picker for managers who do not hold organization.read), with what they may do.
   * Unit, department and team grants count for their organization; the per-record endpoints
   * still check each action on its own scope.
   */
  async organizations(
    userId: string,
    options: { includeDisabledOrganizations?: boolean } = {},
  ) {
    const grants = (await this.authorization.effectiveGrants(userId)).filter(
      (g) =>
        (MANAGE_ORGANIZATION_PERMISSIONS as readonly string[]).includes(
          g.permission,
        ),
    );
    if (grants.length === 0) return { items: [] };
    const system = grants.some((g) => g.scope.type === 'SYSTEM');
    const ids = (type: string) => [
      ...new Set(
        grants
          .filter((g) => g.scope.type === type && g.scope.id)
          .map((g) => g.scope.id!),
      ),
    ];
    const [units, departments, teams] = await Promise.all([
      this.prisma.organizationalUnit.findMany({
        where: { id: { in: ids('ORGANIZATIONAL_UNIT') } },
        select: { id: true, organizationId: true },
      }),
      this.prisma.department.findMany({
        where: { id: { in: ids('DEPARTMENT') } },
        select: { id: true, organizationId: true },
      }),
      this.prisma.team.findMany({
        where: { id: { in: ids('TEAM') } },
        select: { id: true, organizationId: true },
      }),
    ]);
    const organizationOf = new Map<string, string>(
      [...units, ...departments, ...teams].map((row) => [
        row.id,
        row.organizationId,
      ]),
    );
    const scopedOrganization = (g: (typeof grants)[number]) =>
      g.scope.type === 'ORGANIZATION'
        ? g.scope.id
        : organizationOf.get(g.scope.id ?? '');
    // Phase 18: organizations with Time & attendance disabled are not offered, unless the
    // caller asks for history (Batch 4F, C10): then they are listed, read-only.
    const disabled = await this.features.disabledOrganizations('ATTENDANCE');
    const rows = await this.prisma.organization.findMany({
      where: {
        archivedAt: null,
        ...(options.includeDisabledOrganizations
          ? {}
          : { AND: [{ id: { notIn: [...disabled] } }] }),
        ...(system
          ? {}
          : {
              id: {
                in: [
                  ...new Set(
                    grants
                      .map(scopedOrganization)
                      .filter((id): id is string => !!id),
                  ),
                ],
              },
            }),
      },
      select: { id: true, name: true, code: true, timezone: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const locations = await this.prisma.workLocation.findMany({
      where: {
        organizationId: { in: rows.map((row) => row.id) },
        archivedAt: null,
      },
      select: { id: true, organizationId: true, name: true, timezone: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const sites = await this.prisma.physicalSite.findMany({
      where: {
        organizationId: { in: rows.map((row) => row.id) },
        archivedAt: null,
        workLocations: { some: { archivedAt: null } },
      },
      select: { id: true, organizationId: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      items: rows.map((organization) => {
        const anywhere = (permissions: readonly string[]) =>
          grants.some(
            (g) =>
              permissions.includes(g.permission) &&
              (g.scope.type === 'SYSTEM' ||
                scopedOrganization(g) === organization.id),
          );
        const atOrganization = (permission: string) =>
          grants.some(
            (g) =>
              g.permission === permission &&
              (g.scope.type === 'SYSTEM' ||
                (g.scope.type === 'ORGANIZATION' &&
                  g.scope.id === organization.id)),
          );
        // Batch 4F (C10): an organization with Time & attendance disabled is history only:
        // reading stays possible, every action is off (and still refused by the API).
        const attendanceEnabled = !disabled.has(organization.id);
        const act = (allowed: boolean) => attendanceEnabled && allowed;
        const canManageDevices = act(atOrganization('time.device.manage'));
        return {
          ...organization,
          attendanceEnabled,
          /** Kiosk locations (archived ones and ones without a timezone are not offered). */
          workLocations: canManageDevices
            ? locations
                .filter((l) => l.organizationId === organization.id)
                .map(({ id, name, timezone }) => ({ id, name, timezone }))
            : [],
          physicalSites: canManageDevices
            ? sites
                .filter((site) => site.organizationId === organization.id)
                .map(({ id, name }) => ({ id, name }))
            : [],
          actions: {
            canViewSignIns: anywhere(['time.view']),
            canCorrectSignIns: act(anywhere(['time.correct'])),
            canManageDevices,
            canManagePolicies: act(anywhere([PERMISSION])),
            canManagePins: act(anywhere(['time.credential.manage'])),
            // Batch 4E-1 (G4): what the manager review screens may offer here. Hints for the
            // interface only: every action is still authorized by the API per record.
            canViewAttendance: anywhere(['time.view']),
            canCorrectTime: act(anywhere(['time.correct'])),
            canReviewExceptions: act(anywhere(['time.approve'])),
            canReviewCorrections: act(anywhere(['time.approve'])),
            canApproveTimesheets: act(anywhere(['time.timesheet.approve'])),
            canManageTimesheets: act(anywhere(['time.timesheet.manage'])),
            // Period generation and timesheet creation need the permission on the organization.
            canManagePeriods: act(atOrganization('time.timesheet.manage')),
          },
        };
      }),
    };
  }

  async list(userId: string, query: TimePolicyListQueryDto) {
    if (
      !(await this.authorization.canAccess(userId, PERMISSION, {
        type: 'ORGANIZATION',
        id: query.organizationId,
      })) &&
      !(await this.hasAnyGrantInOrganization(userId, query.organizationId))
    ) {
      throw new ForbiddenException(
        'Missing permission time.manage_policy in the organization.',
      );
    }
    await this.features.require(query.organizationId, 'ATTENDANCE');
    const rows = await this.prisma.timeAttendancePolicy.findMany({
      where: {
        ...(query.includeArchived ? {} : { archivedAt: null }),
        OR: [
          { scopeType: 'SYSTEM' },
          { organizationId: query.organizationId },
          {
            scopeType: 'EMPLOYMENT_ASSIGNMENT',
            employmentAssignment: {
              position: { organizationId: query.organizationId },
            },
          },
        ],
      },
      orderBy: [{ scopeType: 'asc' }, { effectiveFrom: 'asc' }, { id: 'asc' }],
    });
    const { latest } = currentDates();
    // Batch 4E-2 (B2): each layer's scope by name (the ids stay as they were).
    const scopeNames = await policyScopeNames(this.prisma, rows);
    const items = [];
    for (const row of rows) {
      const canManage = await this.canManage(userId, row);
      items.push({
        ...this.shape(row),
        // An assignment layer is named (employee and position) only for a caller who manages
        // that position; anyone else in the organization sees the layer, not who it is for.
        scopeName:
          row.scopeType === 'EMPLOYMENT_ASSIGNMENT' && !canManage
            ? 'Employment assignment'
            : (scopeNames.get(row.id) ?? 'Unknown'),
        actions: {
          canEnd: canManage && !row.archivedAt,
          canArchive:
            canManage && !row.archivedAt && row.effectiveFrom > latest,
        },
      });
    }
    return { items };
  }

  /**
   * Batch 4E-2 review — the scope whose inherited values the editor shows, authorized exactly as
   * adding a layer there would be. A scope the caller may not manage answers 404, the same as a
   * missing one, so nothing about other organizations' structure is disclosed.
   */
  async inheritanceTarget(userId: string, query: InheritedPolicyQueryDto) {
    const notFound = () => new NotFoundException('Policy scope not found.');
    let target: Awaited<ReturnType<TimePolicyService['resolveTarget']>>;
    try {
      target = await this.resolveTarget(query, this.prisma);
      await this.assertManage(userId, target, this.prisma);
    } catch (error) {
      // Missing and not manageable look the same.
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw notFound();
      }
      throw error;
    }
    const organizationId = await this.organizationOfTarget(target, this.prisma);
    if (!organizationId || !target.id) {
      throw notFound();
    }
    return { scopeType: target.scopeType, id: target.id, organizationId };
  }

  async create(
    userId: string,
    input: CreateTimePolicyDto,
    context: TimeRequestContext,
  ) {
    const prepared = this.prepareLayer(input);
    return this.prisma.$transaction(async (tx) => {
      const created = await this.insertLayer(tx, userId, input, prepared);
      await this.writeAudit(tx, 'TIME_POLICY_CREATED', created.id, context, {
        policy: this.shape(created),
      });
      return this.shape(created);
    });
  }

  /**
   * Batch 4E-2 (B3) — replaces a layer from a date, atomically: the replacement is validated
   * first; then, in one transaction under the layer's row lock and the scope's lock, the layer
   * ends the day before and the replacement starts, through the same overlap check as any new
   * layer. `expectedUpdatedAt` is the layer as the administrator saw it: a layer changed since
   * (ended, superseded, archived) answers 409 TIME_POLICY_CHANGED, never a silent overwrite.
   * Never retroactive; the layer's past days, and everything recorded under them, are unchanged.
   */
  async supersede(
    userId: string,
    policyId: string,
    input: SupersedeTimePolicyDto,
    context: TimeRequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.locked(tx, userId, policyId);
      const target = this.targetOf(policy);
      await this.assertManage(userId, target, tx);
      // Validated before anything is written (the replacement keeps the layer's planned end).
      const scope: Record<string, string> = {
        scopeType: policy.scopeType,
        ...(policy.organizationId
          ? { organizationId: policy.organizationId }
          : {}),
        ...(policy.organizationalUnitId
          ? { organizationalUnitId: policy.organizationalUnitId }
          : {}),
        ...(policy.departmentId ? { departmentId: policy.departmentId } : {}),
        ...(policy.teamId ? { teamId: policy.teamId } : {}),
        ...(policy.employmentAssignmentId
          ? { employmentAssignmentId: policy.employmentAssignmentId }
          : {}),
      };
      const replacementInput = {
        ...scope,
        inheritanceMode: input.inheritanceMode ?? policy.inheritanceMode,
        effectiveFrom: input.effectiveFrom,
        ...(policy.effectiveTo
          ? { effectiveTo: formatDate(policy.effectiveTo) }
          : {}),
        config: input.config,
      } as CreateTimePolicyDto;
      if (policy.archivedAt) {
        throw new ConflictException(
          domainError(409, 'TIME_POLICY_CHANGED', 'This policy was archived.', {
            policyId: policy.id,
          }),
        );
      }
      if (policy.updatedAt.toISOString() !== input.expectedUpdatedAt) {
        throw new ConflictException(
          domainError(
            409,
            'TIME_POLICY_CHANGED',
            'This policy changed since you opened it. Review it and try again.',
            { policyId: policy.id },
          ),
        );
      }
      // Then the replacement's date against this layer, and the replacement itself: all
      // validated before anything is written.
      const replacementStart = parseDateOnly(
        input.effectiveFrom,
        'effectiveFrom',
      );
      if (replacementStart < currentDates().earliest) {
        throw new ConflictException(
          domainError(
            409,
            'TIME_POLICY_RETROACTIVE',
            'A time policy cannot start in the past.',
          ),
        );
      }
      if (replacementStart <= policy.effectiveFrom) {
        throw new ConflictException(
          domainError(
            409,
            'TIME_POLICY_SUPERSEDE_DATE',
            'The replacement must start after this policy starts. A policy that has not started can be archived instead.',
          ),
        );
      }
      if (policy.effectiveTo && replacementStart > policy.effectiveTo) {
        throw new ConflictException(
          domainError(
            409,
            'TIME_POLICY_SUPERSEDE_DATE',
            'This policy ends before that date; add a new policy instead.',
          ),
        );
      }
      const prepared = this.prepareLayer(replacementInput);
      await advisoryLock(
        tx,
        `time-policy:${policy.scopeType}:${target.id ?? 'system'}`,
      );
      const ended = await tx.timeAttendancePolicy.update({
        where: { id: policy.id },
        data: { effectiveTo: addDays(prepared.effectiveFrom, -1) },
      });
      const created = await this.insertLayer(
        tx,
        userId,
        replacementInput,
        prepared,
      );
      await this.writeAudit(tx, 'TIME_POLICY_SUPERSEDED', policy.id, context, {
        supersededBy: created.id,
        effectiveFrom: formatDate(prepared.effectiveFrom),
        effectiveTo: {
          before: policy.effectiveTo && formatDate(policy.effectiveTo),
          after: formatDate(ended.effectiveTo!),
        },
      });
      await this.writeAudit(tx, 'TIME_POLICY_CREATED', created.id, context, {
        policy: this.shape(created),
        supersedes: policy.id,
      });
      return { ended: this.shape(ended), created: this.shape(created) };
    });
  }

  /** Validates a new layer's config and dates (no database access, nothing written). */
  private prepareLayer(
    input: Pick<
      CreateTimePolicyDto,
      'scopeType' | 'effectiveFrom' | 'effectiveTo' | 'config'
    >,
  ) {
    const config = validateTimePolicyConfig(input.config);
    // Batch 4D (D-G): a new AUTO_DEDUCT layer without a threshold gets the 360-minute default,
    // written explicitly, so layers created before 4D (no threshold: 0) keep their meaning.
    const breaks = config.breaks as Record<string, unknown> | undefined;
    if (
      breaks?.mode === 'AUTO_DEDUCT' &&
      breaks.autoDeductAfterMinutes === undefined
    ) {
      breaks.autoDeductAfterMinutes = AUTO_DEDUCT_DEFAULT_AFTER_MINUTES;
    }
    if (
      input.scopeType !== 'SYSTEM' &&
      input.scopeType !== 'ORGANIZATION' &&
      ORGANIZATION_ONLY_POLICY_SECTIONS.some((section) => section in config)
    ) {
      throw new BadRequestException(
        domainError(
          400,
          'TIME_POLICY_SECTION_SCOPE',
          'Period automation (periods) is set on the organization (or system) policy only.',
        ),
      );
    }
    const effectiveFrom = parseDateOnly(input.effectiveFrom, 'effectiveFrom');
    const effectiveTo = input.effectiveTo
      ? parseDateOnly(input.effectiveTo, 'effectiveTo')
      : null;
    if (effectiveTo && effectiveTo < effectiveFrom) {
      throw new ConflictException(
        domainError(
          409,
          'TIME_POLICY_PERIOD_INVALID',
          'effectiveTo must be on or after effectiveFrom.',
        ),
      );
    }
    // Never retroactive: a new layer starts today (somewhere) at the earliest, so recorded
    // attendance is never reinterpreted under rules that did not apply to it.
    if (effectiveFrom < currentDates().earliest) {
      throw new ConflictException(
        domainError(
          409,
          'TIME_POLICY_RETROACTIVE',
          'A time policy cannot start in the past.',
        ),
      );
    }
    return { config, effectiveFrom, effectiveTo };
  }

  /** Inserts a prepared layer inside a transaction: target, authorization, scope lock, overlap. */
  private async insertLayer(
    tx: Prisma.TransactionClient,
    userId: string,
    input: CreateTimePolicyDto,
    prepared: {
      config: Record<string, unknown>;
      effectiveFrom: Date;
      effectiveTo: Date | null;
    },
  ) {
    const { config, effectiveFrom, effectiveTo } = prepared;
    const target = await this.resolveTarget(input, tx);
    await this.assertManage(userId, target, tx);
    await advisoryLock(tx, `time-policy:${target.scopeType}:${target.key}`);
    const overlapping = await tx.timeAttendancePolicy.findFirst({
      where: {
        ...target.where,
        archivedAt: null,
        effectiveFrom: effectiveTo ? { lte: effectiveTo } : undefined,
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFrom } }],
      },
      select: { id: true },
    });
    if (overlapping) {
      throw new ConflictException(
        domainError(
          409,
          'TIME_POLICY_OVERLAP',
          'Another policy of this scope is in effect then; end it first.',
          { conflictingPolicyId: overlapping.id },
        ),
      );
    }
    const created = await tx.timeAttendancePolicy.create({
      data: {
        ...target.data,
        scopeType: target.scopeType,
        inheritanceMode: input.inheritanceMode ?? 'INHERIT',
        effectiveFrom,
        effectiveTo,
        config: jsonValue(config),
      },
    });
    return created;
  }

  /** Ends a layer: sets or moves its end earlier, never into the past, never extends it. */
  async end(
    userId: string,
    policyId: string,
    input: EndTimePolicyDto,
    context: TimeRequestContext,
  ) {
    const effectiveTo = parseDateOnly(input.effectiveTo, 'effectiveTo');
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.locked(tx, userId, policyId);
      await this.assertManage(userId, this.targetOf(policy), tx);
      if (policy.archivedAt) {
        throw new ConflictException('An archived policy cannot be ended.');
      }
      if (effectiveTo < policy.effectiveFrom) {
        throw new ConflictException(
          domainError(
            409,
            'TIME_POLICY_PERIOD_INVALID',
            'effectiveTo must be on or after the policy start.',
          ),
        );
      }
      if (effectiveTo < addDays(currentDates().earliest, -1)) {
        throw new ConflictException(
          domainError(
            409,
            'TIME_POLICY_RETROACTIVE',
            'A time policy cannot be ended in the past.',
          ),
        );
      }
      if (policy.effectiveTo && effectiveTo >= policy.effectiveTo) {
        throw new ConflictException(
          domainError(
            409,
            'TIME_POLICY_END_NOT_EARLIER',
            'Ending only moves a policy end earlier.',
          ),
        );
      }
      const updated = await tx.timeAttendancePolicy.update({
        where: { id: policy.id },
        data: { effectiveTo },
      });
      await this.writeAudit(tx, 'TIME_POLICY_ENDED', policy.id, context, {
        effectiveTo: {
          before: policy.effectiveTo && formatDate(policy.effectiveTo),
          after: formatDate(effectiveTo),
        },
      });
      return this.shape(updated);
    });
  }

  /** Withdraws a layer that has not started anywhere yet. */
  async archive(userId: string, policyId: string, context: TimeRequestContext) {
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.locked(tx, userId, policyId);
      await this.assertManage(userId, this.targetOf(policy), tx);
      if (policy.archivedAt) return this.shape(policy);
      if (policy.effectiveFrom <= currentDates().latest) {
        throw new ConflictException(
          domainError(
            409,
            'TIME_POLICY_STARTED',
            'A policy that has started cannot be archived; end it instead.',
          ),
        );
      }
      const archived = await tx.timeAttendancePolicy.update({
        where: { id: policy.id },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(tx, 'TIME_POLICY_ARCHIVED', policy.id, context, {
        policy: this.shape(archived),
      });
      return this.shape(archived);
    });
  }

  shape(row: TimeAttendancePolicy) {
    return {
      id: row.id,
      scopeType: row.scopeType,
      organizationId: row.organizationId,
      organizationalUnitId: row.organizationalUnitId,
      departmentId: row.departmentId,
      teamId: row.teamId,
      employmentAssignmentId: row.employmentAssignmentId,
      inheritanceMode: row.inheritanceMode,
      effectiveFrom: formatDate(row.effectiveFrom),
      effectiveTo: row.effectiveTo && formatDate(row.effectiveTo),
      config: row.config,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      // Batch 4E-2: the version an administrator saw (supersede's expectedUpdatedAt).
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async locked(
    tx: Prisma.TransactionClient,
    userId: string,
    policyId: string,
  ) {
    // Batch 4F (D4, D9): a policy of an organization the caller cannot see is answered 404,
    // and permission is checked before the row lock (a layer never changes scope). Callers
    // check again on the locked row.
    const unlocked = await tx.timeAttendancePolicy.findUnique({
      where: { id: policyId },
    });
    if (!unlocked) throw new NotFoundException('Time policy not found.');
    const target = this.targetOf(unlocked);
    const organizationId = await this.organizationOfTarget(target, tx);
    if (
      organizationId &&
      !(await canSeeOrganization(
        this.authorization,
        userId,
        [organizationId],
        // Batch 4F (D4/Q2): time.view reads policy layers (effective policy view): 403.
        [PERMISSION, 'time.view'],
        tx,
      ))
    ) {
      throw new NotFoundException('Time policy not found.');
    }
    await this.assertManage(userId, target, tx);
    await tx.$queryRaw`SELECT "id" FROM "TimeAttendancePolicy" WHERE "id" = ${policyId}::uuid FOR UPDATE`;
    const policy = await tx.timeAttendancePolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) throw new NotFoundException('Time policy not found.');
    return policy;
  }

  private targetOf(policy: TimeAttendancePolicy) {
    const scopeType = policy.scopeType;
    const id =
      scopeType === 'ORGANIZATION'
        ? policy.organizationId
        : scopeType === 'ORGANIZATIONAL_UNIT'
          ? policy.organizationalUnitId
          : scopeType === 'DEPARTMENT'
            ? policy.departmentId
            : scopeType === 'TEAM'
              ? policy.teamId
              : scopeType === 'EMPLOYMENT_ASSIGNMENT'
                ? policy.employmentAssignmentId
                : null;
    return { scopeType, id };
  }

  /** The scope's columns (with its derived organization), validated to exist. */
  private async resolveTarget(
    input: Pick<
      CreateTimePolicyDto,
      | 'scopeType'
      | 'organizationId'
      | 'organizationalUnitId'
      | 'departmentId'
      | 'teamId'
      | 'employmentAssignmentId'
    >,
    client: Client,
  ) {
    const missing = (field: string) =>
      new ConflictException(
        domainError(
          409,
          'TIME_POLICY_SCOPE_INVALID',
          `${field} is required for this scope.`,
        ),
      );
    switch (input.scopeType) {
      case 'SYSTEM':
        return {
          scopeType: 'SYSTEM' as const,
          key: 'system',
          id: null,
          data: {},
          where: { scopeType: 'SYSTEM' as const },
        };
      case 'ORGANIZATION': {
        if (!input.organizationId) throw missing('organizationId');
        const organization = await client.organization.findUnique({
          where: { id: input.organizationId },
        });
        if (!organization)
          throw new NotFoundException('Organization not found.');
        return {
          scopeType: 'ORGANIZATION' as const,
          key: organization.id,
          id: organization.id,
          data: { organizationId: organization.id },
          where: {
            scopeType: 'ORGANIZATION' as const,
            organizationId: organization.id,
          },
        };
      }
      case 'ORGANIZATIONAL_UNIT': {
        if (!input.organizationalUnitId) throw missing('organizationalUnitId');
        const unit = await client.organizationalUnit.findUnique({
          where: { id: input.organizationalUnitId },
        });
        if (!unit)
          throw new NotFoundException('Organizational unit not found.');
        return {
          scopeType: 'ORGANIZATIONAL_UNIT' as const,
          key: unit.id,
          id: unit.id,
          data: {
            organizationId: unit.organizationId,
            organizationalUnitId: unit.id,
          },
          where: {
            scopeType: 'ORGANIZATIONAL_UNIT' as const,
            organizationalUnitId: unit.id,
          },
        };
      }
      case 'DEPARTMENT': {
        if (!input.departmentId) throw missing('departmentId');
        const department = await client.department.findUnique({
          where: { id: input.departmentId },
        });
        if (!department) throw new NotFoundException('Department not found.');
        return {
          scopeType: 'DEPARTMENT' as const,
          key: department.id,
          id: department.id,
          data: {
            organizationId: department.organizationId,
            departmentId: department.id,
          },
          where: {
            scopeType: 'DEPARTMENT' as const,
            departmentId: department.id,
          },
        };
      }
      case 'TEAM': {
        if (!input.teamId) throw missing('teamId');
        const team = await client.team.findUnique({
          where: { id: input.teamId },
        });
        if (!team) throw new NotFoundException('Team not found.');
        return {
          scopeType: 'TEAM' as const,
          key: team.id,
          id: team.id,
          data: { organizationId: team.organizationId, teamId: team.id },
          where: { scopeType: 'TEAM' as const, teamId: team.id },
        };
      }
      case 'EMPLOYMENT_ASSIGNMENT': {
        if (!input.employmentAssignmentId)
          throw missing('employmentAssignmentId');
        const assignment = await client.employmentAssignment.findUnique({
          where: { id: input.employmentAssignmentId },
        });
        if (!assignment)
          throw new NotFoundException('Employment assignment not found.');
        if (assignment.status === 'CANCELLED') {
          throw new ConflictException(
            domainError(
              409,
              'TIME_POLICY_SCOPE_INVALID',
              'A cancelled assignment has no time policy.',
            ),
          );
        }
        return {
          scopeType: 'EMPLOYMENT_ASSIGNMENT' as const,
          key: assignment.id,
          id: assignment.id,
          data: { employmentAssignmentId: assignment.id },
          where: {
            scopeType: 'EMPLOYMENT_ASSIGNMENT' as const,
            employmentAssignmentId: assignment.id,
          },
        };
      }
    }
  }

  private async authorizationScope(
    target: { scopeType: string; id: string | null },
    client: Client,
  ): Promise<AuthorizationScope> {
    if (target.scopeType === 'SYSTEM') return { type: 'SYSTEM' };
    if (target.scopeType === 'EMPLOYMENT_ASSIGNMENT') {
      const assignment = await client.employmentAssignment.findUnique({
        where: { id: target.id! },
        select: { positionId: true },
      });
      if (!assignment)
        throw new NotFoundException('Employment assignment not found.');
      return this.targets.scopeForPosition(
        assignment.positionId,
        undefined,
        client,
      );
    }
    return {
      type: target.scopeType as AuthorizationScope['type'],
      id: target.id!,
    };
  }

  private async canManage(userId: string, policy: TimeAttendancePolicy) {
    return this.authorization.canAccess(
      userId,
      PERMISSION,
      await this.authorizationScope(this.targetOf(policy), this.prisma),
    );
  }

  private async assertManage(
    userId: string,
    target: { scopeType: string; id: string | null },
    client: Client,
  ) {
    const scope = await this.authorizationScope(target, client);
    if (
      !(await this.authorization.canAccess(userId, PERMISSION, scope, client))
    ) {
      throw new ForbiddenException(
        'Missing permission time.manage_policy for the policy scope.',
      );
    }
    await this.features.require(
      await this.organizationOfTarget(target, client),
      'ATTENDANCE',
      client,
    );
  }

  /** The organization a policy scope belongs to (null for the SYSTEM layer). */
  private async organizationOfTarget(
    target: { scopeType: string; id: string | null },
    client: Client,
  ): Promise<string | null> {
    if (!target.id || target.scopeType === 'SYSTEM') return null;
    switch (target.scopeType) {
      case 'ORGANIZATION':
        return target.id;
      case 'ORGANIZATIONAL_UNIT':
        return (
          (
            await client.organizationalUnit.findUnique({
              where: { id: target.id },
              select: { organizationId: true },
            })
          )?.organizationId ?? null
        );
      case 'DEPARTMENT':
        return (
          (
            await client.department.findUnique({
              where: { id: target.id },
              select: { organizationId: true },
            })
          )?.organizationId ?? null
        );
      case 'TEAM':
        return (
          (
            await client.team.findUnique({
              where: { id: target.id },
              select: { organizationId: true },
            })
          )?.organizationId ?? null
        );
      default:
        return (
          (
            await client.employmentAssignment.findUnique({
              where: { id: target.id },
              select: { position: { select: { organizationId: true } } },
            })
          )?.position.organizationId ?? null
        );
    }
  }

  /** Any time.manage_policy grant reaching into the organization (unit, department or team). */
  private async hasAnyGrantInOrganization(
    userId: string,
    organizationId: string,
  ) {
    const grants = (await this.authorization.effectiveGrants(userId)).filter(
      (grant) => grant.permission === PERMISSION,
    );
    for (const grant of grants) {
      const id = grant.scope.id;
      if (!id) continue;
      const owner =
        grant.scope.type === 'ORGANIZATIONAL_UNIT'
          ? await this.prisma.organizationalUnit.findUnique({
              where: { id },
              select: { organizationId: true },
            })
          : grant.scope.type === 'DEPARTMENT'
            ? await this.prisma.department.findUnique({
                where: { id },
                select: { organizationId: true },
              })
            : grant.scope.type === 'TEAM'
              ? await this.prisma.team.findUnique({
                  where: { id },
                  select: { organizationId: true },
                })
              : null;
      if (owner?.organizationId === organizationId) return true;
    }
    return false;
  }

  private writeAudit(
    client: Prisma.TransactionClient,
    action: string,
    entityId: string,
    context: TimeRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'TimeAttendancePolicy',
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue(metadata),
      },
      client,
    );
  }
}
