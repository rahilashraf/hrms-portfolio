import { Injectable, NotFoundException } from '@nestjs/common';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { positionTargets } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { DocumentsAccessService } from '../documents/documents-access.service.js';
import type { FeatureModule } from '../features/features-domain.js';
import { disabledModules, selfEmployeeId } from './workspace-scope.js';

/**
 * Phase 20 — which tabs and actions of an employee profile the caller can use. UI hints only:
 * each flag is derived from the caller's grants with the same targets and rules as the
 * endpoint behind the tab or action (and that endpoint stays authoritative):
 *
 * - visibility (404 otherwise) and the overview / employment tabs: the profile rule —
 *   employee.read at SYSTEM, or over one non-cancelled assignment (scopeForPosition targets);
 * - edit (person fields): employee.manage at SYSTEM (EmployeeService.update);
 * - changePosition / assignManager: employee.manage over one of the employee's assignments
 *   (assignment mutations); when there is no non-cancelled assignment yet, only SYSTEM
 *   employee.manage can bootstrap the first one;
 * - compensation: compensation.read/manage over an assignment, or one's own (requireRead);
 *   addCompensation: compensation.manage, never oneself (requireManage);
 * - time: time.view (scopeForPosition targets); leave: leave.read/approve/adjust;
 *   benefits: benefit.read/manage; performance: performance.read/manage (never oneself through
 *   grants; one's own through self-service);
 * - documents / manageDocuments: DocumentsAccessService.clearanceOver over the employee's
 *   assignments in an organization, never one's own records;
 * - startOffboarding: offboarding.manage over an active or ended assignment (Batch 7A: an ended
 *   one is offboarded after the fact), never oneself;
 * - startOnboarding (Batch 7A): onboarding.manage over a planned or active assignment, never
 *   oneself;
 * - changePosition: employee.manage over an assignment (or SYSTEM for a first one); never one's
 *   own employment except at SYSTEM scope (Batch 5E, the API's self-target rule);
 * - manageLifecycle (Batch 5C: terminate, scheduled-termination changes, rehire, inactive and
 *   reactivation): the employee-wide rule of EmployeeAccessService.authorizeEmployeeWide —
 *   employee.manage over every assignment still in effect today (or over one, when none is),
 *   or SYSTEM employee.manage; never one's own employment except at SYSTEM scope.
 * Every tab and action of a module counts only assignments in organizations where that
 * module is enabled (Phase 18).
 */
@Injectable()
export class EmployeeCapabilitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly documents: DocumentsAccessService,
  ) {}

  async capabilities(userId: string, employeeId: string) {
    const notFound = () => new NotFoundException('Employee not found');
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        status: true,
        assignments: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            status: true,
            endDate: true,
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
        },
      },
    });
    if (!employee) throw notFound();
    const grants = await this.authorization.effectiveGrants(userId);
    const granted = (permission: string, target: AuthorizationTarget) =>
      permissionIsGranted(grants, permission, target);
    const system = (permission: string) =>
      grants.some(
        (grant) =>
          grant.permission === permission && grant.scope.type === 'SYSTEM',
      );

    // Domain targets (positionTargets) and Core HR / Time targets (scopeForPosition).
    const domainTargets = await positionTargets(
      this.prisma,
      employee.assignments.map((a) => a.position),
    );
    const rows: Array<{
      assignment: (typeof employee.assignments)[number];
      organizationId: string;
      domain: AuthorizationTarget;
      resolved: AuthorizationTarget;
    }> = [];
    for (const assignment of employee.assignments) {
      const scope = await this.targets.scopeForPosition(assignment.position.id);
      rows.push({
        assignment,
        organizationId: assignment.position.organizationId,
        domain: domainTargets.get(assignment.position.id)!,
        resolved: await this.authorization.resolveTarget(scope),
      });
    }
    const canBootstrapFirstAssignment =
      rows.length === 0 && system('employee.manage');
    const readable = rows.filter((row) =>
      granted('employee.read', row.resolved),
    );
    if (
      readable.length === 0 &&
      !system('employee.read') &&
      !canBootstrapFirstAssignment
    )
      throw notFound();

    const isSelf = (await selfEmployeeId(this.prisma, userId)) === employeeId;
    const disabled = await disabledModules(
      this.prisma,
      rows.map((row) => row.organizationId),
    );
    const on = (row: (typeof rows)[number], module: FeatureModule) =>
      !disabled.get(row.organizationId)?.has(module);
    const any = (
      module: FeatureModule | null,
      test: (row: (typeof rows)[number]) => boolean,
      subset = rows,
    ) => subset.some((row) => (!module || on(row, module)) && test(row));
    const current = rows.filter(
      (row) =>
        row.assignment.status === 'ACTIVE' ||
        row.assignment.status === 'PLANNED',
    );
    // The employee-wide lifecycle rule (authorizeEmployeeWide with today as the reference).
    const startOfToday = new Date(new Date().toISOString().slice(0, 10));
    const inEffect = rows.filter(
      (row) =>
        row.assignment.status === 'ACTIVE' ||
        row.assignment.status === 'PLANNED' ||
        (row.assignment.endDate !== null &&
          row.assignment.endDate.getTime() >= startOfToday.getTime()),
    );
    const managesEmployment = (row: (typeof rows)[number]) =>
      granted('employee.manage', row.resolved);
    const coversEmployment =
      inEffect.length > 0
        ? inEffect.every(managesEmployment)
        : rows.some(managesEmployment);
    const anyOf = (keys: string[], target: AuthorizationTarget) =>
      keys.some((key) => granted(key, target));

    // Documents: clearance per organization, exactly as DocumentsAccessService computes it.
    const documentGrants = await this.documents.grants(userId);
    const documentOrgs = [...new Set(rows.map((row) => row.organizationId))]
      .filter(
        (organizationId) => !disabled.get(organizationId)?.has('DOCUMENTS'),
      )
      .map((organizationId) =>
        this.documents.clearanceOver(
          documentGrants,
          rows
            .filter((row) => row.organizationId === organizationId)
            .map((row) => row.domain),
        ),
      );

    const organizationIds = [
      ...new Set(
        (system('employee.read') ? rows : readable).map(
          (row) => row.organizationId,
        ),
      ),
    ].sort();

    return {
      employeeId,
      organizationIds,
      tabs: {
        overview: true,
        employment: true,
        compensation: any(
          'COMPENSATION',
          (row) =>
            isSelf ||
            anyOf(['compensation.read', 'compensation.manage'], row.domain),
        ),
        time: any('ATTENDANCE', (row) => granted('time.view', row.resolved)),
        leave: any('LEAVE', (row) =>
          anyOf(['leave.read', 'leave.approve', 'leave.adjust'], row.domain),
        ),
        benefits: any('BENEFITS', (row) =>
          anyOf(['benefit.read', 'benefit.manage'], row.domain),
        ),
        documents:
          !isSelf &&
          documentOrgs.some(
            (access) => access.clearance >= 0 || access.canManage,
          ),
        performance: any(
          'PERFORMANCE',
          (row) =>
            isSelf ||
            anyOf(['performance.read', 'performance.manage'], row.domain),
        ),
      },
      actions: {
        edit: system('employee.manage'),
        // Batch 5E (D1): the API refuses assignment changes on one's own employment
        // (LIFECYCLE_SELF_TARGET) unless the caller holds System employee.manage.
        changePosition:
          (!isSelf || system('employee.manage')) &&
          (canBootstrapFirstAssignment ||
            any(null, (row) => granted('employee.manage', row.resolved))),
        assignManager: any(
          null,
          (row) => granted('employee.manage', row.resolved),
          current,
        ),
        addCompensation:
          !isSelf &&
          any(
            'COMPENSATION',
            (row) => granted('compensation.manage', row.domain),
            current,
          ),
        manageDocuments:
          !isSelf && documentOrgs.some((access) => access.canManage),
        startOffboarding:
          !isSelf &&
          any(
            'ONBOARDING',
            (row) =>
              (row.assignment.status === 'ACTIVE' ||
                row.assignment.status === 'ENDED') &&
              granted('offboarding.manage', row.domain),
          ),
        startOnboarding:
          !isSelf &&
          employee.status !== 'TERMINATED' &&
          any(
            'ONBOARDING',
            (row) =>
              (row.assignment.status === 'PLANNED' ||
                row.assignment.status === 'ACTIVE') &&
              granted('onboarding.manage', row.domain),
          ),
        manageLifecycle:
          system('employee.manage') || (!isSelf && coversEmployment),
      },
    };
  }
}
