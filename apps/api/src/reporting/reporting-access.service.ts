import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  permissionIsGranted,
  scopeContainsTarget,
} from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  AuthorizationTarget,
  EffectiveGrant,
  ScopeRef,
} from '../authorization/authorization.types.js';
import { domainError, positionTargets } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { DocumentsAccessService } from '../documents/documents-access.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { RecruitmentAccessService } from '../recruitment/recruitment-access.service.js';
import {
  ReportingClock,
  reportingToday,
  type OpeningInfo,
  type PositionInfo,
  type ReportScope,
} from './reporting-common.js';
import {
  hasPlacementFilter,
  parseReportFilters,
  type RawReportFilters,
  type ReportFilters,
} from './reporting-domain.js';
import {
  REPORT_AREAS,
  REPORT_DEFINITIONS,
  REPORTS_BY_KEY,
  reportModules,
  requiredPermissions,
  type ReportDefinition,
} from './reporting-registry.js';

export const REPORT_PERMISSIONS = ['report.read', 'report.export'] as const;

/** Everything about one organization that every report's authorization needs, loaded once. */
interface OrganizationContext {
  organizationId: string;
  timezone: string | null;
  grants: EffectiveGrant[];
  orgTarget: AuthorizationTarget;
  /** Targets of the caller's own unit / department / team grant scopes inside this organization. */
  grantTargets: Array<{ scope: ScopeRef; target: AuthorizationTarget }>;
  positions: PositionInfo[];
  openings: OpeningInfo[] | null;
}

/**
 * Phase 17 reporting authorization. report.read opens the Reporting area and report.export
 * allows exports; neither grants any domain data. A report aggregates only over records whose
 * placement (the assignment's position, or the opening's own placement for recruitment) lies in
 * a scope where the caller holds report.read AND every source-domain read permission — each
 * evaluated with the same permissionIsGranted / positionTargets machinery the domains use. The
 * payroll domain is organization-scoped: its reports evaluate every permission at the
 * organization itself. Filters only narrow: a filter naming anything outside the authorized
 * scope (or another organization) is a 404 that does not reveal whether it exists. A user's
 * own records never widen a scope; where the source domain never shows one's own records
 * through grants (documents, performance, recruitment, onboarding/offboarding) they are left
 * out.
 */
@Injectable()
export class ReportingAccessService {
  /** Phase 18: the REPORTING module gate, and the source modules of each report. */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly documents: DocumentsAccessService,
    private readonly recruitment: RecruitmentAccessService,
    private readonly clock: ReportingClock,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  definition(reportKey: string) {
    const definition = REPORTS_BY_KEY.get(reportKey);
    if (!definition)
      throw new NotFoundException(
        domainError(404, 'REPORT_NOT_FOUND', 'Report not found.'),
      );
    return definition;
  }

  /** Organizations where the caller holds report.read (SYSTEM: every organization). */
  async organizations(userId: string) {
    const grants = (await this.authorization.effectiveGrants(userId)).filter(
      (grant) => grant.permission === 'report.read',
    );
    if (grants.length === 0) return { items: [] };
    const ids = (type: string) =>
      grants
        .filter((g) => g.scope.type === type && g.scope.id)
        .map((g) => g.scope.id!);
    const system = grants.some((g) => g.scope.type === 'SYSTEM');
    const [units, departments, teams] = await Promise.all([
      this.prisma.organizationalUnit.findMany({
        where: { id: { in: ids('ORGANIZATIONAL_UNIT') } },
        select: { organizationId: true },
      }),
      this.prisma.department.findMany({
        where: { id: { in: ids('DEPARTMENT') } },
        select: { organizationId: true },
      }),
      this.prisma.team.findMany({
        where: { id: { in: ids('TEAM') } },
        select: { organizationId: true },
      }),
    ]);
    const organizationIds = new Set([
      ...ids('ORGANIZATION'),
      ...[...units, ...departments, ...teams].map((r) => r.organizationId),
    ]);
    const disabled = await this.features.disabledOrganizations('REPORTING');
    const rows = await this.prisma.organization.findMany({
      where: {
        archivedAt: null,
        ...(system
          ? { id: { notIn: [...disabled] } }
          : {
              id: {
                in: [...organizationIds].filter((id) => !disabled.has(id)),
              },
            }),
      },
      select: { id: true, name: true, code: true, timezone: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { items: rows };
  }

  /** The reports (by area) the caller can run — and export — in an organization. */
  async catalog(userId: string, organizationId: string) {
    const context = await this.organizationContext(
      userId,
      organizationId,
      true,
    );
    const areas = REPORT_AREAS.map((area) => ({
      area,
      reports: [] as unknown[],
    }));
    // Phase 19: the gate runs only for a caller who reaches at least one report of this
    // organization; anyone else gets the same empty catalog whatever the module state.
    const reachable = context
      ? REPORT_DEFINITIONS.filter((definition) =>
          this.reachable(context, definition, false),
        )
      : [];
    if (context && reachable.length > 0) {
      // Phase 18: Reporting itself must be enabled; reports of disabled modules are omitted.
      const modules = await this.features.modules(organizationId);
      if (!modules.REPORTING)
        await this.features.require(organizationId, 'REPORTING');
      for (const definition of reachable) {
        if (reportModules(definition).some((module) => !modules[module]))
          continue;
        areas
          .find((entry) => entry.area === definition.area)!
          .reports.push({
            key: definition.key,
            title: definition.title,
            description: definition.description,
            sourcePermissions: definition.sourcePermissions,
            organizationPermissions: definition.organizationPermissions ?? [],
            dateMode: definition.dateMode,
            filters: definition.filters,
            groupBy: definition.groupBy ?? null,
            defaultGroupBy: definition.groupBy
              ? (definition.defaultGroupBy ?? definition.groupBy[0])
              : null,
            sensitive: definition.sensitive,
            excludesSelf: definition.excludesSelf,
            columns: definition.columns,
            canExport: this.reachable(context, definition, true),
          });
      }
    }
    return {
      organizationId,
      items: areas.filter((entry) => entry.reports.length > 0),
    };
  }

  /**
   * Authorizes a report run (or export) and resolves the records it may aggregate over:
   * 404 for an unknown report, 403 without report.read and the source permission(s) anywhere
   * in the organization, 400 for invalid filters, 404 for a filter outside the scope.
   */
  async resolve(
    userId: string,
    reportKey: string,
    organizationId: string,
    raw: RawReportFilters,
    forExport = false,
  ): Promise<ReportScope> {
    const definition = this.definition(reportKey);
    const context = await this.organizationContext(
      userId,
      organizationId,
      definition.placement === 'OPENING',
    );
    if (!context || !this.reachable(context, definition, forExport)) {
      throw new ForbiddenException(
        domainError(
          403,
          'REPORT_ACCESS_DENIED',
          `Missing ${[...requiredPermissions(definition, forExport), ...(definition.organizationPermissions ?? [])].join(' + ')} for the organization.`,
        ),
      );
    }
    // Phase 18: Reporting and every source module of the report must be enabled.
    await this.features.requireAll(organizationId, [
      'REPORTING',
      ...reportModules(definition),
    ]);
    const now = this.clock.now();
    const today = reportingToday(now, context.timezone);
    const filters = parseReportFilters(definition, raw, today);
    const granted = this.grantedAt(context, definition, forExport);

    await this.validateFilterScope(context, filters, granted);

    const inFilter = (target: AuthorizationTarget, positionId: string | null) =>
      (!filters.organizationalUnitId ||
        scopeContainsTarget(
          { type: 'ORGANIZATIONAL_UNIT', id: filters.organizationalUnitId },
          target,
        )) &&
      (!filters.departmentId ||
        scopeContainsTarget(
          { type: 'DEPARTMENT', id: filters.departmentId },
          target,
        )) &&
      (!filters.teamId ||
        scopeContainsTarget({ type: 'TEAM', id: filters.teamId }, target)) &&
      (!filters.positionId || positionId === filters.positionId);

    const positions = context.positions.filter(
      (position) =>
        granted(position.target) && inFilter(position.target, position.id),
    );
    const openings =
      context.openings?.filter(
        (opening) =>
          granted(opening.target) &&
          inFilter(opening.target, opening.positionId) &&
          (!filters.employmentType ||
            opening.employmentType === filters.employmentType) &&
          (!filters.openingId || opening.id === filters.openingId),
      ) ?? [];

    const self = definition.excludesSelf
      ? await this.recruitment.userContext(userId)
      : { userId, employeeId: null, personId: null, email: null };

    const documentClearance = new Map<string, number>();
    if (definition.area === 'documents') {
      const base = ['report.read', ...(forExport ? ['report.export'] : [])];
      for (const position of positions) {
        const reportable = base.every((permission) =>
          permissionIsGranted(context.grants, permission, position.target),
        );
        documentClearance.set(
          position.id,
          reportable
            ? this.documents.clearanceOver(context.grants, [position.target])
                .clearance
            : -1,
        );
      }
    }

    const [units, departments, teams] = await Promise.all([
      this.prisma.organizationalUnit.findMany({
        where: { organizationId },
        select: { id: true, name: true },
      }),
      this.prisma.department.findMany({
        where: { organizationId },
        select: { id: true, name: true },
      }),
      this.prisma.team.findMany({
        where: { organizationId },
        select: { id: true, name: true },
      }),
    ]);

    const scopes = context.grantTargets
      .filter(
        ({ scope, target }) =>
          context.grants.some(
            (g) =>
              g.permission === 'report.read' &&
              g.scope.type === scope.type &&
              g.scope.id === scope.id,
          ) && granted(target),
      )
      .map(({ scope }) => ({ type: scope.type, id: scope.id ?? null }));
    const organizationWide = granted(context.orgTarget);
    if (organizationWide)
      scopes.unshift({ type: 'ORGANIZATION', id: organizationId });

    return {
      definition,
      organizationId,
      organizationTimezone: context.timezone,
      now,
      today,
      filters,
      positionIds: positions.map((p) => p.id),
      openingIds: openings.map((o) => o.id),
      excludedEmployeeId: definition.excludesSelf ? self.employeeId : null,
      self: {
        employeeId: self.employeeId,
        personId: self.personId,
        email: self.email,
      },
      documentClearance,
      labels: {
        units: new Map(units.map((u) => [u.id, u.name])),
        departments: new Map(departments.map((d) => [d.id, d.name])),
        teams: new Map(teams.map((t) => [t.id, t.name])),
        positions: new Map(context.positions.map((p) => [p.id, p.name])),
      },
      summary: {
        organizationId,
        placement: definition.placement,
        organizationWide: organizationWide && !hasPlacementFilter(filters),
        scopes,
        positions: positions.length,
        openings: definition.placement === 'OPENING' ? openings.length : null,
        selfExcluded: definition.excludesSelf,
      },
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** Whether a placement target carries every permission the report needs. */
  private grantedAt(
    context: OrganizationContext,
    definition: ReportDefinition,
    forExport: boolean,
  ) {
    const permissions = requiredPermissions(definition, forExport);
    const organizationLevel = (definition.organizationPermissions ?? []).every(
      (permission) =>
        permissionIsGranted(context.grants, permission, context.orgTarget),
    );
    if (definition.placement === 'ORGANIZATION') {
      // Organization-scoped domain (payroll): every permission at the organization itself.
      const atOrganization =
        organizationLevel &&
        permissions.every((permission) =>
          permissionIsGranted(context.grants, permission, context.orgTarget),
        );
      return () => atOrganization;
    }
    return (target: AuthorizationTarget) =>
      organizationLevel &&
      permissions.every((permission) =>
        permissionIsGranted(context.grants, permission, target),
      );
  }

  /** Whether any scope in the organization carries every permission the report needs. */
  private reachable(
    context: OrganizationContext,
    definition: ReportDefinition,
    forExport: boolean,
  ) {
    const granted = this.grantedAt(context, definition, forExport);
    if (granted(context.orgTarget)) return true;
    if (definition.placement === 'ORGANIZATION') return false;
    if (context.grantTargets.some(({ target }) => granted(target))) return true;
    const placements =
      definition.placement === 'OPENING'
        ? (context.openings ?? [])
        : context.positions;
    return placements.some((placement) => granted(placement.target));
  }

  private async organizationContext(
    userId: string,
    organizationId: string,
    withOpenings: boolean,
  ): Promise<OrganizationContext | null> {
    // Grants are evaluated now (like every domain); the clock only dates the report.
    const grants = await this.authorization.effectiveGrants(userId);
    // Without any report.read there is nothing to resolve (and nothing is revealed).
    if (!grants.some((grant) => grant.permission === 'report.read'))
      return null;
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, timezone: true },
    });
    if (!organization) return null;
    const orgTarget: AuthorizationTarget = {
      type: 'ORGANIZATION',
      organizationId,
    };

    const grantTargets: OrganizationContext['grantTargets'] = [];
    const seen = new Set<string>();
    for (const grant of grants) {
      if (
        grant.permission !== 'report.read' ||
        !grant.scope.id ||
        !['ORGANIZATIONAL_UNIT', 'DEPARTMENT', 'TEAM'].includes(
          grant.scope.type,
        )
      )
        continue;
      const key = `${grant.scope.type}:${grant.scope.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        grantTargets.push({
          scope: grant.scope,
          target: await this.authorization.resolveTarget({
            type: grant.scope.type,
            id: grant.scope.id,
            organizationId,
          }),
        });
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
        // A grant scope in another organization: irrelevant here.
      }
    }

    const positionRows = await this.prisma.position.findMany({
      where: { organizationId },
      select: {
        id: true,
        organizationId: true,
        organizationalUnitId: true,
        departmentId: true,
        teamId: true,
        name: true,
        code: true,
      },
    });
    const targets = await positionTargets(this.prisma, positionRows);
    const positions = positionRows.map((row) => ({
      ...row,
      target: targets.get(row.id)!,
    }));

    let openings: OpeningInfo[] | null = null;
    if (withOpenings) {
      const rows = await this.prisma.jobOpening.findMany({
        where: { organizationId },
        select: {
          id: true,
          organizationId: true,
          organizationalUnitId: true,
          departmentId: true,
          teamId: true,
          positionId: true,
          employmentType: true,
          hiringManagerEmployeeId: true,
        },
      });
      // The recruitment domain's own placement → target resolution.
      const openingTargets = await this.recruitment.openingTargets(
        this.prisma,
        rows,
      );
      openings = rows.map((row) => ({
        ...row,
        target: openingTargets.get(row.id)!,
      }));
    }
    return {
      organizationId,
      timezone: organization.timezone,
      grants,
      orgTarget,
      grantTargets,
      positions,
      openings,
    };
  }

  /**
   * Every filter must name something in the organization that lies inside the authorized
   * scope. Anything else — unknown, another organization's, or outside the caller's scope — is
   * the same 404.
   */
  private async validateFilterScope(
    context: OrganizationContext,
    filters: ReportFilters,
    granted: (target: AuthorizationTarget) => boolean,
  ) {
    const notFound = () =>
      new NotFoundException(
        domainError(
          404,
          'REPORT_FILTER_NOT_FOUND',
          'A filter names something outside the reporting scope.',
        ),
      );
    const structural = [
      ['ORGANIZATIONAL_UNIT', filters.organizationalUnitId],
      ['DEPARTMENT', filters.departmentId],
      ['TEAM', filters.teamId],
    ] as const;
    for (const [type, id] of structural) {
      if (!id) continue;
      let target: AuthorizationTarget;
      try {
        target = await this.authorization.resolveTarget({
          type,
          id,
          organizationId: context.organizationId,
        });
      } catch (error) {
        if (error instanceof NotFoundException) throw notFound();
        throw error;
      }
      if (!granted(target)) throw notFound();
    }
    if (filters.positionId) {
      const position = context.positions.find(
        (p) => p.id === filters.positionId,
      );
      if (!position || !granted(position.target)) throw notFound();
    }
    if (filters.openingId) {
      const opening = context.openings?.find((o) => o.id === filters.openingId);
      if (!opening || !granted(opening.target)) throw notFound();
    }
    if (filters.cycleId) {
      const cycle = await this.prisma.performanceCycle.findFirst({
        where: { id: filters.cycleId, organizationId: context.organizationId },
        select: { id: true },
      });
      if (!cycle) throw notFound();
    }
  }
}
