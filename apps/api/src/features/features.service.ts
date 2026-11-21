import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  advisoryLock,
  domainError,
  formatDate,
  jsonValue,
  requireActor,
  type DomainRequestContext,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  Prisma,
  type OrganizationModuleSetting,
  type OrganizationSetting,
} from '../generated/prisma/client.js';
import { GoogleConnectionService } from '../integrations/google/google-connection.service.js';
import { NotificationSettingsService } from '../notifications/notification-settings.service.js';
import { attendanceModes } from '../time/time-policy.js';
import { TimePolicyService } from '../time/time-policy.service.js';
import type { TimeAttendancePolicyConfig } from '../time/time-domain.service.js';
import type { FeatureClient } from './feature-gate.service.js';
import { FeaturesAccessService } from './features-access.service.js';
import {
  dependentsOf,
  effectiveSettingValue,
  isOrganizationModule,
  MODULE_DEFINITIONS,
  moduleChangeProblem,
  ORGANIZATION_MODULES,
  SETTING_DEFINITIONS,
  settingDefinition,
  validateSettingValue,
  type FeatureModule,
  type SettingDefinition,
  type SettingValue,
} from './features-domain.js';

type Tx = Prisma.TransactionClient;

/** The areas that can never be disabled (shown read-only in the admin area). */
export const CORE_AREAS = [
  'Organization structure',
  'Employees',
  'Employment assignments',
  'Users, roles and authentication',
  'Audit',
] as const;

const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException(domainError(409, code, message, extra));

const versionConflict = (
  subject: Record<string, unknown>,
  currentVersion: number,
) =>
  conflict(
    'FEATURE_VERSION_CONFLICT',
    'The configuration changed since it was loaded; reload and try again.',
    { ...subject, currentVersion },
  );

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Phase 18 — per-organization feature administration: module switches (with dependency rules)
 * and typed settings (validated against the registry), both under optimistic concurrency
 * (`expectedVersion`; 0 = never changed) and an organization-wide advisory lock, so two
 * concurrent changes can never both apply or leave a dependency broken. Every change is
 * audited (identifiers and the old → new boolean / integer / enum value only) and appended to
 * the change history. Nothing here reads or changes domain data.
 */
/**
 * Security remediation M2 — settings that relax a security control. Relaxing one needs a SYSTEM
 * administrator (feature.manage at SYSTEM scope), an explicit confirmation and a reason (10–500
 * characters); restoring it needs neither, and both directions are audited with their own
 * action, the actor, the organization, old and new values and the reason. This is enforced here,
 * on the only write path for settings (set and reset), never by the client.
 */
const GUARDED_SETTINGS: Readonly<
  Record<
    string,
    {
      relaxes: (value: SettingValue) => boolean;
      disabledAction: string;
      enabledAction: string;
      systemCode: string;
    }
  >
> = Object.freeze({
  'payroll.dualControl': {
    relaxes: (value) => value === false,
    disabledAction: 'PAYROLL_DUAL_CONTROL_DISABLED',
    enabledAction: 'PAYROLL_DUAL_CONTROL_ENABLED',
    systemCode: 'PAYROLL_DUAL_CONTROL_SYSTEM_REQUIRED',
  },
});

/** A change reason: trimmed, 10–500 characters. */
function changeReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 10 || text.length > 500)
    throw new BadRequestException(
      domainError(
        400,
        'SETTING_REASON_REQUIRED',
        'Give a reason of 10 to 500 characters.',
      ),
    );
  return text;
}

@Injectable()
export class FeaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: FeaturesAccessService,
    private readonly audit: AuditService,
    /** Linked sections, read with the caller's own permissions (absent in isolation). */
    @Optional() private readonly timePolicies?: TimePolicyService,
    @Optional()
    private readonly notificationSettings?: NotificationSettingsService,
    @Optional() private readonly google?: GoogleConnectionService,
  ) {}

  organizations(userId: string) {
    return this.access.organizations(userId);
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async overview(userId: string, organizationId: string) {
    const grants = await this.access.require(
      userId,
      'feature.read',
      organizationId,
    );
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { id: true, name: true, code: true },
    });
    const state = await this.state(this.prisma, organizationId);
    return {
      organization,
      canManage: this.access.can(grants, 'feature.manage', organizationId),
      // M2: whether the viewer may relax a guarded setting (a SYSTEM feature administrator).
      canRelaxGuardedSettings: grants.some(
        (grant) =>
          grant.permission === 'feature.manage' &&
          grant.scope.type === 'SYSTEM',
      ),
      core: CORE_AREAS,
      ...state,
      linked: await this.linked(userId, organizationId),
    };
  }

  async history(
    userId: string,
    organizationId: string,
    query: { limit?: number; before?: string } = {},
  ) {
    await this.access.require(userId, 'feature.read', organizationId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = await this.prisma.organizationSettingChange.findMany({
      where: {
        organizationId,
        ...(query.before ? { changedAt: { lt: new Date(query.before) } } : {}),
      },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id,
        kind: row.kind,
        subject: row.subject,
        oldValue: row.oldValue,
        newValue: row.newValue,
        version: row.version,
        actorUserId: row.actorUserId,
        reason: row.reason,
        changedAt: row.changedAt.toISOString(),
      })),
      nextBefore:
        rows.length > limit ? rows[limit - 1]!.changedAt.toISOString() : null,
    };
  }

  /** Modules and settings of an organization as the admin area shows them. */
  async state(client: FeatureClient, organizationId: string) {
    const moduleRows = await client.organizationModuleSetting.findMany({
      where: { organizationId },
    });
    const settingRows = await client.organizationSetting.findMany({
      where: { organizationId },
    });
    return {
      modules: ORGANIZATION_MODULES.map((module) =>
        this.moduleShape(
          module,
          moduleRows.find((row) => row.module === module),
          moduleRows,
        ),
      ),
      settings: SETTING_DEFINITIONS.map((definition) =>
        this.settingShape(
          definition,
          settingRows.find((row) => row.key === definition.key),
        ),
      ),
    };
  }

  private moduleShape(
    module: FeatureModule,
    row: OrganizationModuleSetting | undefined,
    rows: readonly OrganizationModuleSetting[],
  ) {
    const definition = MODULE_DEFINITIONS[module];
    const enabledOf = (m: FeatureModule) =>
      rows.find((r) => r.module === m)?.enabled ?? true;
    return {
      module,
      name: definition.name,
      description: definition.description,
      enabled: row?.enabled ?? true,
      isDefault: !row,
      requires: [...definition.requires],
      dependents: dependentsOf(module),
      /** Required modules currently disabled (enabling this one is refused until they are on). */
      blockedBy: definition.requires.filter((m) => !enabledOf(m)),
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedByUserId: row?.updatedByUserId ?? null,
    };
  }

  private settingShape(
    definition: SettingDefinition,
    row: OrganizationSetting | undefined,
  ) {
    const effective = effectiveSettingValue(definition, row ?? null);
    return {
      key: definition.key,
      section: definition.module,
      name: definition.name,
      description: definition.description,
      type: definition.type,
      value: effective.value,
      default: definition.default,
      isDefault: effective.isDefault,
      schemaVersion: definition.schemaVersion,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedByUserId: row?.updatedByUserId ?? null,
      // M2: relaxing it needs a SYSTEM administrator, a reason and a confirmation.
      guarded: definition.key in GUARDED_SETTINGS,
    };
  }

  // ─── Linked sections (existing services, the caller's own authorization) ──

  private async linked(userId: string, organizationId: string) {
    return {
      timeAttendance: await this.linkedSection(
        this.timePolicies,
        async (policies) => {
          const { items } = await policies.list(userId, { organizationId });
          const today = formatDate(new Date());
          const current = items.filter(
            (item) =>
              !item.archivedAt &&
              item.effectiveFrom <= today &&
              (!item.effectiveTo || item.effectiveTo >= today),
          );
          const organizationLayer =
            current.find(
              (item) =>
                item.scopeType === 'ORGANIZATION' &&
                item.organizationId === organizationId,
            ) ?? null;
          const config = (organizationLayer?.config ??
            {}) as TimeAttendancePolicyConfig;
          const section = (name: string) =>
            ((config as Record<string, unknown>)[name] ?? {}) as Record<
              string,
              unknown
            >;
          return {
            endpoint: `/time/policies?organizationId=${organizationId}`,
            activeLayers: items.filter((item) => !item.archivedAt).length,
            currentLayers: current.length,
            organizationLayer: organizationLayer && {
              id: organizationLayer.id,
              effectiveFrom: organizationLayer.effectiveFrom,
              effectiveTo: organizationLayer.effectiveTo,
              inheritanceMode: organizationLayer.inheritanceMode,
              attendance: attendanceModes(config),
              clockMode: section('clock').mode ?? null,
              breaksMode: section('breaks').mode ?? null,
              missedPunchEnabled: section('missedPunch').enabled ?? null,
            },
          };
        },
      ),
      notifications: await this.linkedSection(
        this.notificationSettings,
        async (settings) => {
          const current = await settings.organizationSettings(
            userId,
            organizationId,
          );
          return {
            endpoint: `/notifications/settings?organizationId=${organizationId}`,
            emailEnabled: current.emailEnabled,
            suppressMandatoryEmail: current.suppressMandatoryEmail,
            categoriesEmailDisabled: current.categories
              .filter((c) => !c.emailEnabled)
              .map((c) => c.category),
            updatedAt: current.updatedAt,
          };
        },
      ),
      googleWorkspace: await this.linkedSection(this.google, async (google) => {
        const status = await google.status(userId, organizationId);
        return {
          endpoint: `/integrations/google/status?organizationId=${organizationId}`,
          status: status.connection?.status ?? 'NOT_CONNECTED',
          mode: status.connection?.mode ?? null,
          capabilities: status.connection?.capabilities ?? [],
          lastHealthOk: status.connection?.lastHealthOk ?? null,
          lastHealthCheckAt:
            status.connection?.lastHealthCheckAt?.toISOString() ?? null,
        };
      }),
    };
  }

  private async linkedSection<S, T extends object>(
    service: S | undefined,
    read: (service: S) => Promise<T>,
  ): Promise<
    | ({ available: true } & T)
    | {
        available: false;
        reason: 'FORBIDDEN' | 'FEATURE_DISABLED' | 'UNAVAILABLE';
      }
  > {
    if (!service) return { available: false, reason: 'UNAVAILABLE' };
    try {
      return { available: true, ...(await read(service)) };
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 403) {
        const body = error.getResponse() as { code?: string };
        return {
          available: false,
          reason:
            body?.code === 'FEATURE_DISABLED'
              ? 'FEATURE_DISABLED'
              : 'FORBIDDEN',
        };
      }
      throw error;
    }
  }

  // ─── Module switches ─────────────────────────────────────────────────────

  async setModule(
    input: {
      organizationId: string;
      module: string;
      enabled: boolean;
      expectedVersion: number;
    },
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    if (!isOrganizationModule(input.module))
      throw new NotFoundException(
        domainError(404, 'FEATURE_MODULE_UNKNOWN', 'Unknown module.'),
      );
    const module = input.module;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.access.require(
          actor,
          'feature.manage',
          input.organizationId,
          tx,
        );
        await this.lock(tx, input.organizationId);
        const rows = await tx.organizationModuleSetting.findMany({
          where: { organizationId: input.organizationId },
        });
        const current = rows.find((row) => row.module === module);
        const currentVersion = current?.version ?? 0;
        if (input.expectedVersion !== currentVersion)
          throw versionConflict({ module }, currentVersion);
        const before = current?.enabled ?? true;
        if (before !== input.enabled) {
          const problem = moduleChangeProblem(module, input.enabled, (m) =>
            m === module
              ? input.enabled
              : (rows.find((row) => row.module === m)?.enabled ?? true),
          );
          if (problem?.code === 'FEATURE_DEPENDENCY_DISABLED')
            throw conflict(
              problem.code,
              `${MODULE_DEFINITIONS[module].name} requires ${problem.modules
                .map((m) => MODULE_DEFINITIONS[m].name)
                .join(
                  ', ',
                )}; enable ${problem.modules.length > 1 ? 'them' : 'it'} first.`,
              { module, requires: problem.modules },
            );
          if (problem?.code === 'FEATURE_DEPENDENTS_ENABLED')
            throw conflict(
              problem.code,
              `${problem.modules
                .map((m) => MODULE_DEFINITIONS[m].name)
                .join(
                  ', ',
                )} ${problem.modules.length > 1 ? 'depend' : 'depends'} on ${MODULE_DEFINITIONS[module].name}; disable ${problem.modules.length > 1 ? 'them' : 'it'} first.`,
              { module, dependents: problem.modules },
            );
        }
        // An unchanged value still records an explicit decision (and bumps the version).
        const version = currentVersion + 1;
        if (current) {
          const updated = await tx.organizationModuleSetting.updateMany({
            where: { id: current.id, version: currentVersion },
            data: {
              enabled: input.enabled,
              version,
              updatedByUserId: actor,
            },
          });
          if (updated.count !== 1)
            throw versionConflict({ module }, currentVersion + 1);
        } else {
          await tx.organizationModuleSetting.create({
            data: {
              organizationId: input.organizationId,
              module,
              enabled: input.enabled,
              updatedByUserId: actor,
            },
          });
        }
        await this.record(tx, context, {
          organizationId: input.organizationId,
          kind: 'MODULE',
          subject: module,
          oldValue: before,
          newValue: input.enabled,
          version,
          action: 'ORGANIZATION_MODULE_UPDATED',
          metadata: { module, enabled: input.enabled, previous: before },
        });
        return {
          module: this.moduleShape(
            module,
            (await tx.organizationModuleSetting.findUnique({
              where: {
                organizationId_module: {
                  organizationId: input.organizationId,
                  module,
                },
              },
            }))!,
            await tx.organizationModuleSetting.findMany({
              where: { organizationId: input.organizationId },
            }),
          ),
        };
      });
    } catch (error) {
      // Two first writes raced past the lock-free create: the loser is a version conflict.
      if (isUniqueViolation(error)) throw versionConflict({ module }, 1);
      throw error;
    }
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  async setSetting(
    input: {
      organizationId: string;
      key: string;
      value: unknown;
      expectedVersion: number;
      /** M2: required (with confirm) to relax a guarded setting. */
      reason?: unknown;
      confirm?: unknown;
    },
    context: DomainRequestContext,
  ) {
    const definition = this.definitionOrThrow(input.key);
    const value = validateSettingValue(definition, input.value);
    return this.writeSetting(definition, input, value, context);
  }

  async resetSetting(
    input: {
      organizationId: string;
      key: string;
      expectedVersion: number;
      reason?: unknown;
      confirm?: unknown;
    },
    context: DomainRequestContext,
  ) {
    const definition = this.definitionOrThrow(input.key);
    return this.writeSetting(definition, input, null, context);
  }

  private definitionOrThrow(key: string) {
    const definition = settingDefinition(key);
    if (!definition)
      throw new NotFoundException(
        domainError(404, 'SETTING_UNKNOWN', 'Unknown setting.', { key }),
      );
    return definition;
  }

  private async writeSetting(
    definition: SettingDefinition,
    input: {
      organizationId: string;
      expectedVersion: number;
      reason?: unknown;
      confirm?: unknown;
    },
    value: SettingValue | null,
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    const key = definition.key;
    const guard = GUARDED_SETTINGS[key];
    try {
      return await this.prisma.$transaction(async (tx) => {
        const grants = await this.access.require(
          actor,
          'feature.manage',
          input.organizationId,
          tx,
        );
        // M2: relaxing a guarded control (the value it would take, the default included).
        const target = effectiveSettingValue(
          definition,
          value === null
            ? null
            : { value, schemaVersion: definition.schemaVersion },
        ).value;
        let reason: string | null = null;
        if (guard) {
          if (guard.relaxes(target)) {
            const system = grants.some(
              (grant) =>
                grant.permission === 'feature.manage' &&
                grant.scope.type === 'SYSTEM',
            );
            if (!system)
              throw new ForbiddenException(
                domainError(
                  403,
                  guard.systemCode,
                  'Only a System administrator may turn this control off.',
                ),
              );
            reason = changeReason(input.reason);
            if (reason === null)
              throw new BadRequestException(
                domainError(
                  400,
                  'SETTING_REASON_REQUIRED',
                  'Give a reason of 10 to 500 characters.',
                ),
              );
            if (input.confirm !== true)
              throw new BadRequestException(
                domainError(
                  400,
                  'SETTING_CONFIRMATION_REQUIRED',
                  'Confirm that you want to turn this control off.',
                ),
              );
          } else {
            reason = changeReason(input.reason);
          }
        }
        await this.lock(tx, input.organizationId);
        const current = await tx.organizationSetting.findUnique({
          where: {
            organizationId_key: { organizationId: input.organizationId, key },
          },
        });
        const currentVersion = current?.version ?? 0;
        if (input.expectedVersion !== currentVersion)
          throw versionConflict({ key }, currentVersion);
        const before = effectiveSettingValue(definition, current);
        const stored = value === null ? Prisma.DbNull : jsonValue(value);
        const version = currentVersion + 1;
        if (current) {
          const updated = await tx.organizationSetting.updateMany({
            where: { id: current.id, version: currentVersion },
            data: {
              value: stored,
              schemaVersion: definition.schemaVersion,
              version,
              updatedByUserId: actor,
            },
          });
          if (updated.count !== 1)
            throw versionConflict({ key }, currentVersion + 1);
        } else {
          await tx.organizationSetting.create({
            data: {
              organizationId: input.organizationId,
              key,
              value: stored,
              schemaVersion: definition.schemaVersion,
              updatedByUserId: actor,
            },
          });
        }
        const after = effectiveSettingValue(
          definition,
          value === null
            ? null
            : { value, schemaVersion: definition.schemaVersion },
        );
        await this.record(tx, context, {
          organizationId: input.organizationId,
          kind: 'SETTING',
          subject: key,
          oldValue: before.isDefault ? null : before.value,
          newValue: value,
          reason,
          version,
          action:
            value === null
              ? 'ORGANIZATION_SETTING_RESET'
              : 'ORGANIZATION_SETTING_UPDATED',
          metadata: {
            key,
            schemaVersion: definition.schemaVersion,
            previous: before.value,
            previousIsDefault: before.isDefault,
            value: after.value,
            isDefault: after.isDefault,
            ...(guard ? { reason } : {}),
          },
        });
        if (guard && before.value !== after.value) {
          await this.audit.write(
            {
              action: guard.relaxes(after.value)
                ? guard.disabledAction
                : guard.enabledAction,
              actorUserId: context.actorUserId,
              entityType: 'Organization',
              entityId: input.organizationId,
              ipAddress: context.ipAddress,
              userAgent: context.userAgent,
              correlationId: context.correlationId,
              metadata: jsonValue({
                organizationId: input.organizationId,
                key,
                previous: before.value,
                value: after.value,
                reason,
                version,
              }),
            },
            tx,
          );
        }
        const row = await tx.organizationSetting.findUniqueOrThrow({
          where: {
            organizationId_key: { organizationId: input.organizationId, key },
          },
        });
        return { setting: this.settingShape(definition, row) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw versionConflict({ key }, 1);
      throw error;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** One lock per organization: module and setting changes (and dependency checks) serialize. */
  private lock(tx: Tx, organizationId: string) {
    return advisoryLock(tx, `organization-features:${organizationId}`);
  }

  /** Audit + change history: identifiers and boolean / integer / enum values only. */
  private async record(
    tx: Tx,
    context: DomainRequestContext,
    input: {
      organizationId: string;
      kind: 'MODULE' | 'SETTING';
      subject: string;
      oldValue: SettingValue | null;
      newValue: SettingValue | null;
      reason?: string | null;
      version: number;
      action: string;
      metadata: Record<string, unknown>;
    },
  ) {
    await tx.organizationSettingChange.create({
      data: {
        organizationId: input.organizationId,
        kind: input.kind,
        subject: input.subject,
        oldValue:
          input.oldValue === null ? Prisma.DbNull : jsonValue(input.oldValue),
        newValue:
          input.newValue === null ? Prisma.DbNull : jsonValue(input.newValue),
        version: input.version,
        actorUserId: context.actorUserId ?? null,
        reason: input.reason ?? null,
      },
    });
    await this.audit.write(
      {
        action: input.action,
        actorUserId: context.actorUserId,
        entityType: 'Organization',
        entityId: input.organizationId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue({
          organizationId: input.organizationId,
          version: input.version,
          ...input.metadata,
        }),
      },
      tx,
    );
  }
}
