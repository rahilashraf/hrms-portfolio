import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseBoolPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { AuthorizationService } from './authorization.service.js';
import {
  ActiveUserQueryDto,
  AssignmentListQueryDto,
  RevokeRoleAssignmentDto,
  RoleAssignmentCreateDto,
  RoleCreateDto,
  RolePermissionsReplaceDto,
  RoleTemplateQueryDto,
  RoleUpdateDto,
} from './authorization.dto.js';
import { RoleManagementService } from './role-management.service.js';

@Controller('authorization')
@UseGuards(AccessTokenGuard)
export class AuthorizationController {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly roles: RoleManagementService,
  ) {}

  @Get('permissions')
  listPermissions(
    @Query('organizationId') organizationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.roles.listPermissions(identity.userId, organizationId);
  }

  /** Phase 20: presets of permission keys for the role editor (never a role by themselves). */
  @Get('role-templates')
  listRoleTemplates(
    @Query() query: RoleTemplateQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.roles.listRoleTemplates(identity.userId, query.organizationId);
  }

  @Get('users')
  searchActiveUsers(
    @Query() query: ActiveUserQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.roles.searchActiveUsers(
      identity.userId,
      query.organizationId,
      query.query,
      query.limit,
      query.afterId,
    );
  }

  @Get('organizations/:organizationId/roles')
  listRoles(
    @Param('organizationId') organizationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.roles.listRoles(
      identity.userId,
      organizationId,
      includeArchived,
    );
  }

  @Post('organizations/:organizationId/roles')
  createRole(
    @Param('organizationId') organizationId: string,
    @Body() body: RoleCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.roles.createRole(
      identity.userId,
      organizationId,
      body,
      auditContext(identity, request),
    );
  }

  @Get('roles/:roleId')
  getRole(
    @Param('roleId') roleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.roles.getRole(identity.userId, roleId);
  }

  @Patch('roles/:roleId')
  updateRole(
    @Param('roleId') roleId: string,
    @Body() body: RoleUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.roles.updateRole(
      identity.userId,
      roleId,
      body,
      auditContext(identity, request),
    );
  }

  @Put('roles/:roleId/permissions')
  replaceRolePermissions(
    @Param('roleId') roleId: string,
    @Body() body: RolePermissionsReplaceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.roles.replaceRolePermissions(
      identity.userId,
      roleId,
      body.permissionKeys,
      auditContext(identity, request),
    );
  }

  @Post('roles/:roleId/archive')
  archiveRole(
    @Param('roleId') roleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.roles.archiveRole(
      identity.userId,
      roleId,
      auditContext(identity, request),
    );
  }

  @Post('roles/:roleId/reactivate')
  reactivateRole(
    @Param('roleId') roleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.roles.reactivateRole(
      identity.userId,
      roleId,
      auditContext(identity, request),
    );
  }

  @Get('roles/:roleId/assignments')
  listAssignments(
    @Param('roleId') roleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Query() query: AssignmentListQueryDto,
  ) {
    return this.roles.listAssignments(identity.userId, roleId, query);
  }

  @Get('assignments/:assignmentId')
  getAssignment(
    @Param('assignmentId') assignmentId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.roles.getAssignment(identity.userId, assignmentId);
  }

  @Post('assignments')
  createAssignment(
    @Body() body: RoleAssignmentCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.roles.createAssignment(
      identity.userId,
      {
        userId: body.userId,
        roleId: body.roleId,
        scope: body.scope,
        startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
      auditContext(identity, request),
    );
  }

  @Post('assignments/:assignmentId/revoke')
  revokeAssignment(
    @Param('assignmentId') assignmentId: string,
    @Body() body: RevokeRoleAssignmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.roles.revokeAssignment(
      identity.userId,
      assignmentId,
      body.reason,
      auditContext(identity, request),
    );
  }
}

@Controller('auth/me')
@UseGuards(AccessTokenGuard)
export class AuthorizationSnapshotController {
  constructor(private readonly authorization: AuthorizationService) {}

  @Get('authorization')
  currentGrants(@AuthUser() identity: AuthenticatedIdentity) {
    return this.authorization.getCurrentGrantSnapshot(identity.userId);
  }
}

function auditContext(identity: AuthenticatedIdentity, request: Request) {
  return {
    actorUserId: identity.userId,
    ipAddress: request.ip,
    userAgent: request.get('user-agent') ?? undefined,
    correlationId: request.get('x-correlation-id') ?? undefined,
  };
}
