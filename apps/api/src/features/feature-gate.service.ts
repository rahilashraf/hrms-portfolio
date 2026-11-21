import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  effectiveSettingValue,
  featureDisabled,
  ORGANIZATION_MODULES,
  settingDefinition,
  settingDisabled,
  type FeatureModule,
  type SettingKey,
  type SettingValue,
} from './features-domain.js';

export type FeatureClient = PrismaService | Prisma.TransactionClient;

/**
 * Phase 18 — the one place every gated module asks whether it may run for an organization.
 *
 * Enforcement lives in the service layer (access funnels, entity-id paths, contracts and jobs),
 * never only in controllers, so API, contract and worker paths share it:
 *
 *   await this.features.require(organizationId, 'PAYROLL');      // 403 FEATURE_DISABLED
 *   await this.features.requireSetting(orgId, 'documents.selfServiceProvide'); // 403 SETTING_DISABLED
 *
 * No row means enabled / the registry default (existing organizations keep their behaviour).
 *
 * Deliberately uncached: each check is one lookup on a unique (organizationId, module|key)
 * index, read through the caller's client (so a check inside a transaction sees that
 * transaction's state), and a change takes effect on the very next request in every API and
 * worker process — no stale window, no cross-process invalidation. Jobs use the batch methods
 * (one query per run).
 */
@Injectable()
export class FeatureGateService {
  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(
    organizationId: string,
    module: FeatureModule,
    client: FeatureClient = this.prisma,
  ): Promise<boolean> {
    const row = await client.organizationModuleSetting.findUnique({
      where: { organizationId_module: { organizationId, module } },
      select: { enabled: true },
    });
    return row?.enabled ?? true;
  }

  /** Throws 403 { code: 'FEATURE_DISABLED', module } when the module is disabled. */
  async require(
    organizationId: string | null | undefined,
    module: FeatureModule,
    client: FeatureClient = this.prisma,
  ): Promise<void> {
    if (!organizationId) return;
    if (!(await this.isEnabled(organizationId, module, client)))
      throw featureDisabled(module);
  }

  /** Whether the module is enabled for the organization of a position (unknown: yes). */
  async isEnabledForPosition(
    positionId: string,
    module: FeatureModule,
    client: FeatureClient = this.prisma,
  ): Promise<boolean> {
    const position = await client.position.findUnique({
      where: { id: positionId },
      select: { organizationId: true },
    });
    return (
      !position ||
      (await this.isEnabled(position.organizationId, module, client))
    );
  }

  /** 403 FEATURE_DISABLED when the module is disabled for a position's organization. */
  async requireForPosition(
    positionId: string,
    module: FeatureModule,
    client: FeatureClient = this.prisma,
  ): Promise<void> {
    if (!(await this.isEnabledForPosition(positionId, module, client)))
      throw featureDisabled(module);
  }

  /**
   * Employee-level self-service that is not tied to one organization: refused when the module
   * is disabled in every organization the employee works in (no assignment: allowed).
   */
  async requireForEmployee(
    employeeId: string,
    module: FeatureModule,
    client: FeatureClient = this.prisma,
  ): Promise<void> {
    const rows = await client.employmentAssignment.findMany({
      where: { employeeId, status: { not: 'CANCELLED' } },
      select: { position: { select: { organizationId: true } } },
    });
    const organizations = [
      ...new Set(rows.map((row) => row.position.organizationId)),
    ];
    if (organizations.length === 0) return;
    const disabled = await this.disabledAmong(module, organizations, client);
    if (disabled.size === organizations.length) throw featureDisabled(module);
  }

  /** Every module enabled (one query); the first disabled one is reported. */
  async requireAll(
    organizationId: string,
    modules: readonly FeatureModule[],
    client: FeatureClient = this.prisma,
  ): Promise<void> {
    if (modules.length === 0) return;
    const rows = await client.organizationModuleSetting.findMany({
      where: { organizationId, module: { in: [...modules] }, enabled: false },
      select: { module: true },
    });
    const disabled = modules.find((m) => rows.some((r) => r.module === m));
    if (disabled) throw featureDisabled(disabled);
  }

  /** The state of every module for an organization (one query). */
  async modules(
    organizationId: string,
    client: FeatureClient = this.prisma,
  ): Promise<Record<FeatureModule, boolean>> {
    const rows = await client.organizationModuleSetting.findMany({
      where: { organizationId },
      select: { module: true, enabled: true },
    });
    return Object.fromEntries(
      ORGANIZATION_MODULES.map((module) => [
        module,
        rows.find((row) => row.module === module)?.enabled ?? true,
      ]),
    ) as Record<FeatureModule, boolean>;
  }

  /** Organizations where the module is disabled (one query; for jobs and multi-org lists). */
  async disabledOrganizations(
    module: FeatureModule,
    client: FeatureClient = this.prisma,
  ): Promise<Set<string>> {
    const rows = await client.organizationModuleSetting.findMany({
      where: { module, enabled: false },
      select: { organizationId: true },
    });
    return new Set(rows.map((row) => row.organizationId));
  }

  /** The organizations, among `organizationIds`, where the module is disabled (one query). */
  async disabledAmong(
    module: FeatureModule,
    organizationIds: readonly string[],
    client: FeatureClient = this.prisma,
  ): Promise<Set<string>> {
    if (organizationIds.length === 0) return new Set();
    const rows = await client.organizationModuleSetting.findMany({
      where: {
        module,
        enabled: false,
        organizationId: { in: [...new Set(organizationIds)] },
      },
      select: { organizationId: true },
    });
    return new Set(rows.map((row) => row.organizationId));
  }

  /** The effective value of a registered setting (the registry default without a row). */
  async setting(
    organizationId: string,
    key: SettingKey,
    client: FeatureClient = this.prisma,
  ): Promise<SettingValue> {
    const definition = settingDefinition(key);
    if (!definition) throw new Error(`Unknown setting ${key}.`);
    const row = await client.organizationSetting.findUnique({
      where: { organizationId_key: { organizationId, key } },
      select: { value: true, schemaVersion: true },
    });
    return effectiveSettingValue(definition, row).value;
  }

  /** Throws 403 { code: 'SETTING_DISABLED', key } when a boolean setting is off. */
  async requireSetting(
    organizationId: string,
    key: SettingKey,
    client: FeatureClient = this.prisma,
  ): Promise<void> {
    if ((await this.setting(organizationId, key, client)) !== true)
      throw settingDisabled(key);
  }

  /** Organizations where a boolean setting is off (one query; for jobs). */
  async settingOffOrganizations(
    key: SettingKey,
    client: FeatureClient = this.prisma,
  ): Promise<Set<string>> {
    const definition = settingDefinition(key);
    if (!definition) throw new Error(`Unknown setting ${key}.`);
    const rows = await client.organizationSetting.findMany({
      where: { key },
      select: { organizationId: true, value: true, schemaVersion: true },
    });
    return new Set(
      rows
        .filter((row) => effectiveSettingValue(definition, row).value !== true)
        .map((row) => row.organizationId),
    );
  }
}

/** For framework-free composition (jobs, CLIs, specs) and optional constructor injection. */
export function featureGateFor(
  prisma: PrismaService,
  features?: FeatureGateService | null,
): FeatureGateService {
  return features ?? new FeatureGateService(prisma);
}
