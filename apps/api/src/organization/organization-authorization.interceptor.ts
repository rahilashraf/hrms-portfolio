import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { from, mergeMap, type Observable } from 'rxjs';
import { RoleAssignmentScopeType } from '../generated/prisma/enums.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';

type ScopeRef = {
  type: RoleAssignmentScopeType;
  id?: string;
};

type OrganizationRequest = Request & {
  auth?: { userId: string; sessionId: string };
  params: Record<string, string>;
  body: Record<string, unknown>;
};

type ResourceKind =
  | 'Organization'
  | 'OrganizationalUnit'
  | 'Department'
  | 'Team'
  | 'JobTitle'
  | 'Position'
  | 'WorkLocation';

@Injectable()
export class OrganizationAuthorizationInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() positionTargets?: PositionAuthorizationTargetResolver,
  ) {
    this.positionTargets =
      positionTargets ?? new PositionAuthorizationTargetResolver(prisma);
  }

  private readonly positionTargets: PositionAuthorizationTargetResolver;

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<OrganizationRequest>();
    const handlerName = context.getHandler().name;
    const userId = request.auth?.userId;
    if (!userId) throw new UnauthorizedException();

    return from(this.authorizeRequest(userId, handlerName, request)).pipe(
      mergeMap((filterKind) =>
        next
          .handle()
          .pipe(
            mergeMap((result: unknown) =>
              from(this.filterResult(userId, filterKind, result)),
            ),
          ),
      ),
    );
  }

  private async authorizeRequest(
    userId: string,
    handler: string,
    request: OrganizationRequest,
  ): Promise<ResourceKind | 'structure' | undefined> {
    // R5B: position reference options are not a resource list — they are authorized as a whole
    // by OrganizationService.listPositionReferenceOptions (organization.manage anywhere within
    // the Organization; 404/403 like physical sites) and must never be row-filtered by
    // organization.read here, which would hide them from Unit/Department/Team managers.
    if (handler === 'positionReferenceOptions') return undefined;

    const isRead =
      handler.startsWith('list') ||
      handler.startsWith('get') ||
      handler === 'getStructure';
    const permission = isRead ? 'organization.read' : 'organization.manage';

    if (handler === 'listOrganizations') return 'Organization';
    if (handler === 'getStructure') return 'structure';

    const resource = this.resourceFromHandler(handler);
    if (!resource) throw new ForbiddenException();

    if (handler.startsWith('list')) return resource;

    if (handler === 'createOrganization') {
      await this.authorization.assertAccess(userId, permission, {
        type: RoleAssignmentScopeType.SYSTEM,
      });
      return undefined;
    }

    const organizationId = request.params.organizationId;
    const entityId =
      resource === 'Organization' ? request.params.id : request.params.id;

    if (handler.startsWith('create')) {
      const destination = await this.creationScope(
        resource,
        organizationId,
        request.body,
      );
      await this.authorization.assertAccess(userId, permission, destination);
      return undefined;
    }

    const current = await this.resourceScope(
      resource,
      entityId,
      organizationId,
    );
    if (!current) return undefined;
    await this.authorization.assertAccess(userId, permission, current);

    if (handler.startsWith('update')) {
      const destination = await this.updateDestinationScope(
        resource,
        organizationId,
        entityId,
        current,
        request.body,
      );
      if (destination) {
        await this.authorization.assertAccess(userId, permission, destination);
      }
    }
    return undefined;
  }

  private async filterResult(
    userId: string,
    filterKind: ResourceKind | 'structure' | undefined,
    result: unknown,
  ): Promise<unknown> {
    if (filterKind === 'structure') {
      return Array.isArray(result)
        ? this.filterStructure(userId, result)
        : result;
    }
    if (!filterKind || !Array.isArray(result)) return result;

    const visible: unknown[] = [];
    for (const entity of result) {
      if (!entity || typeof entity !== 'object') continue;
      const row = entity as Record<string, unknown>;
      const organizationId =
        filterKind === 'Organization'
          ? String(row.id)
          : String(row.organizationId);
      const scope = await this.resourceScope(
        filterKind,
        String(row.id),
        organizationId,
      );
      if (
        scope &&
        (await this.authorization.canAccess(userId, 'organization.read', scope))
      ) {
        visible.push(entity);
      }
    }
    return visible;
  }

  private async filterStructure(
    userId: string,
    tree: unknown[],
  ): Promise<unknown[]> {
    const filtered: unknown[] = [];
    for (const value of tree) {
      if (!value || typeof value !== 'object') continue;
      const node = value as Record<string, unknown>;
      const id = String(node.id);
      const scope: ScopeRef = {
        type: RoleAssignmentScopeType.ORGANIZATIONAL_UNIT,
        id,
      };
      const children = Array.isArray(node.children)
        ? await this.filterStructure(userId, node.children)
        : [];
      if (
        await this.authorization.canAccess(userId, 'organization.read', scope)
      ) {
        filtered.push({ ...node, children });
      } else {
        filtered.push(...children);
      }
    }
    return filtered;
  }

  private async creationScope(
    resource: ResourceKind,
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<ScopeRef> {
    if (resource === 'Organization') {
      return { type: RoleAssignmentScopeType.SYSTEM };
    }
    if (resource === 'JobTitle' || resource === 'WorkLocation') {
      return { type: RoleAssignmentScopeType.ORGANIZATION, id: organizationId };
    }
    if (resource === 'OrganizationalUnit') {
      return body.parentUnitId
        ? this.requireScopeForResource(
            'OrganizationalUnit',
            this.requiredId(body.parentUnitId),
            organizationId,
          )
        : { type: RoleAssignmentScopeType.ORGANIZATION, id: organizationId };
    }
    if (resource === 'Department') {
      return body.organizationalUnitId
        ? this.requireScopeForResource(
            'OrganizationalUnit',
            this.requiredId(body.organizationalUnitId),
            organizationId,
          )
        : { type: RoleAssignmentScopeType.ORGANIZATION, id: organizationId };
    }
    if (resource === 'Team') {
      return body.departmentId
        ? this.requireScopeForResource(
            'Department',
            this.requiredId(body.departmentId),
            organizationId,
          )
        : this.requireScopeForResource(
            'OrganizationalUnit',
            this.requiredId(body.organizationalUnitId),
            organizationId,
          );
    }
    return this.positionTargets.scopeForPlacement(
      organizationId,
      body.teamId,
      body.departmentId,
      body.organizationalUnitId,
    );
  }

  private async updateDestinationScope(
    resource: ResourceKind,
    organizationId: string,
    entityId: string,
    current: ScopeRef,
    body: Record<string, unknown>,
  ): Promise<ScopeRef | undefined> {
    if (resource === 'OrganizationalUnit' && 'parentUnitId' in body) {
      return body.parentUnitId
        ? this.requireScopeForResource(
            'OrganizationalUnit',
            this.requiredId(body.parentUnitId),
            organizationId,
          )
        : { type: RoleAssignmentScopeType.ORGANIZATION, id: organizationId };
    }
    if (resource === 'Department' && 'organizationalUnitId' in body) {
      return body.organizationalUnitId
        ? this.requireScopeForResource(
            'OrganizationalUnit',
            this.requiredId(body.organizationalUnitId),
            organizationId,
          )
        : { type: RoleAssignmentScopeType.ORGANIZATION, id: organizationId };
    }
    if (
      resource === 'Team' &&
      ('departmentId' in body || 'organizationalUnitId' in body)
    ) {
      if (body.departmentId) {
        return this.requireScopeForResource(
          'Department',
          this.requiredId(body.departmentId),
          organizationId,
        );
      }
      if (body.organizationalUnitId) {
        return this.requireScopeForResource(
          'OrganizationalUnit',
          this.requiredId(body.organizationalUnitId),
          organizationId,
        );
      }
      throw new ForbiddenException('A Team must retain exactly one anchor.');
    }
    if (
      resource === 'Position' &&
      ('teamId' in body ||
        'departmentId' in body ||
        'organizationalUnitId' in body)
    ) {
      const existing = await this.prisma.position.findFirst({
        where: { id: entityId, organizationId },
      });
      if (!existing) return undefined;
      return this.positionTargets.scopeForPlacement(
        organizationId,
        'teamId' in body ? body.teamId : existing.teamId,
        'departmentId' in body ? body.departmentId : existing.departmentId,
        'organizationalUnitId' in body
          ? body.organizationalUnitId
          : existing.organizationalUnitId,
      );
    }
    return undefined;
  }

  private async resourceScope(
    resource: ResourceKind,
    id: string,
    organizationId: string,
  ): Promise<ScopeRef | undefined> {
    if (resource === 'Organization') {
      const entity = await this.prisma.organization.findFirst({
        where: { id },
        select: { id: true },
      });
      return entity
        ? { type: RoleAssignmentScopeType.ORGANIZATION, id: entity.id }
        : undefined;
    }

    const entity =
      resource === 'OrganizationalUnit'
        ? await this.prisma.organizationalUnit.findFirst({
            where: { id, organizationId },
            select: { id: true },
          })
        : resource === 'Department'
          ? await this.prisma.department.findFirst({
              where: { id, organizationId },
              select: { id: true },
            })
          : resource === 'Team'
            ? await this.prisma.team.findFirst({
                where: { id, organizationId },
                select: { id: true },
              })
            : resource === 'JobTitle'
              ? await this.prisma.jobTitle.findFirst({
                  where: { id, organizationId },
                  select: { id: true },
                })
              : resource === 'Position'
                ? await this.prisma.position.findFirst({
                    where: { id, organizationId },
                    select: {
                      id: true,
                      organizationalUnitId: true,
                      departmentId: true,
                      teamId: true,
                    },
                  })
                : await this.prisma.workLocation.findFirst({
                    where: { id, organizationId },
                    select: { id: true },
                  });
    if (!entity) return undefined;

    if (resource === 'OrganizationalUnit') {
      return { type: RoleAssignmentScopeType.ORGANIZATIONAL_UNIT, id };
    }
    if (resource === 'Department') {
      return { type: RoleAssignmentScopeType.DEPARTMENT, id };
    }
    if (resource === 'Team') {
      return { type: RoleAssignmentScopeType.TEAM, id };
    }
    if (resource === 'Position') {
      const position = entity as {
        id: string;
        organizationalUnitId: string | null;
        departmentId: string | null;
        teamId: string | null;
      };
      return this.positionTargets.scopeForPlacement(
        organizationId,
        position.teamId,
        position.departmentId,
        position.organizationalUnitId,
      );
    }
    return { type: RoleAssignmentScopeType.ORGANIZATION, id: organizationId };
  }

  private async requireScopeForResource(
    resource: ResourceKind,
    id: string,
    organizationId: string,
  ): Promise<ScopeRef> {
    const scope = await this.resourceScope(resource, id, organizationId);
    if (!scope) throw new ForbiddenException('Invalid authorization scope.');
    return scope;
  }

  private requiredId(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ForbiddenException('Invalid authorization scope.');
    }
    return value;
  }

  private resourceFromHandler(handler: string): ResourceKind | undefined {
    if (handler.endsWith('Organization')) return 'Organization';
    if (handler.includes('OrganizationalUnit')) return 'OrganizationalUnit';
    if (handler.includes('Department')) return 'Department';
    if (handler.includes('Team')) return 'Team';
    if (handler.includes('JobTitle')) return 'JobTitle';
    if (handler.includes('WorkLocation')) return 'WorkLocation';
    if (handler.includes('Position')) return 'Position';
    return undefined;
  }
}
