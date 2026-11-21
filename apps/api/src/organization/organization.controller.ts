import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import {
  DepartmentCreateDto,
  DepartmentUpdateDto,
  JobTitleCreateDto,
  JobTitleUpdateDto,
  OrganizationCreateDto,
  OrganizationUpdateDto,
  OrganizationalUnitCreateDto,
  OrganizationalUnitUpdateDto,
  PositionCreateDto,
  PositionUpdateDto,
  TeamCreateDto,
  TeamUpdateDto,
  WorkLocationCreateDto,
  WorkLocationUpdateDto,
} from './organization.dto.js';
import { OrganizationService } from './organization.service.js';
import { OrganizationAuthorizationInterceptor } from './organization-authorization.interceptor.js';

@Controller('organizations')
@UseGuards(AccessTokenGuard)
@UseInterceptors(OrganizationAuthorizationInterceptor)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Post()
  createOrganization(
    @Body() body: OrganizationCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.createOrganization(body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Get()
  listOrganizations(
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.listOrganizations(includeArchived);
  }

  @Get(':id')
  getOrganization(
    @Param('id') id: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.getOrganization(id, includeArchived);
  }

  @Patch(':id')
  updateOrganization(
    @Param('id') id: string,
    @Body() body: OrganizationUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.updateOrganization(id, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':id/archive')
  archiveOrganization(
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.archiveOrganization(id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':id/reactivate')
  reactivateOrganization(
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.reactivateOrganization(id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/units')
  createOrganizationalUnit(
    @Param('organizationId') organizationId: string,
    @Body() body: OrganizationalUnitCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.createOrganizationalUnit(organizationId, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Get(':organizationId/units')
  listOrganizationalUnits(
    @Param('organizationId') organizationId: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.listOrganizationalUnits(
      organizationId,
      includeArchived,
    );
  }

  @Get(':organizationId/units/:id')
  getOrganizationalUnit(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.getOrganizationalUnit(
      organizationId,
      id,
      includeArchived,
    );
  }

  @Patch(':organizationId/units/:id')
  updateOrganizationalUnit(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() body: OrganizationalUnitUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.updateOrganizationalUnit(
      organizationId,
      id,
      body,
      {
        actorUserId: identity.userId,
        ipAddress: request.ip,
        userAgent: request.get('user-agent') ?? undefined,
        correlationId: request.get('x-correlation-id') ?? undefined,
      },
    );
  }

  @Post(':organizationId/units/:id/archive')
  archiveOrganizationalUnit(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.archiveOrganizationalUnit(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/units/:id/reactivate')
  reactivateOrganizationalUnit(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.reactivateOrganizationalUnit(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Get(':organizationId/structure')
  getStructure(@Param('organizationId') organizationId: string) {
    return this.organization.getStructure(organizationId);
  }

  @Post(':organizationId/departments')
  createDepartment(
    @Param('organizationId') organizationId: string,
    @Body() body: DepartmentCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.createDepartment(organizationId, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Get(':organizationId/departments')
  listDepartments(
    @Param('organizationId') organizationId: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.listDepartments(organizationId, includeArchived);
  }

  @Get(':organizationId/departments/:id')
  getDepartment(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.getDepartment(organizationId, id, includeArchived);
  }

  @Patch(':organizationId/departments/:id')
  updateDepartment(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() body: DepartmentUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.updateDepartment(organizationId, id, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/departments/:id/archive')
  archiveDepartment(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.archiveDepartment(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/departments/:id/reactivate')
  reactivateDepartment(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.reactivateDepartment(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/teams')
  createTeam(
    @Param('organizationId') organizationId: string,
    @Body() body: TeamCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.createTeam(organizationId, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Get(':organizationId/teams')
  listTeams(
    @Param('organizationId') organizationId: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.listTeams(organizationId, includeArchived);
  }

  @Get(':organizationId/teams/:id')
  getTeam(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.getTeam(organizationId, id, includeArchived);
  }

  @Patch(':organizationId/teams/:id')
  updateTeam(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() body: TeamUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.updateTeam(organizationId, id, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/teams/:id/archive')
  archiveTeam(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.archiveTeam(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/teams/:id/reactivate')
  reactivateTeam(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.reactivateTeam(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/job-titles')
  createJobTitle(
    @Param('organizationId') organizationId: string,
    @Body() body: JobTitleCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.createJobTitle(organizationId, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Get(':organizationId/job-titles')
  listJobTitles(
    @Param('organizationId') organizationId: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.listJobTitles(organizationId, includeArchived);
  }

  @Get(':organizationId/job-titles/:id')
  getJobTitle(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.getJobTitle(organizationId, id, includeArchived);
  }

  @Patch(':organizationId/job-titles/:id')
  updateJobTitle(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() body: JobTitleUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.updateJobTitle(organizationId, id, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/job-titles/:id/archive')
  archiveJobTitle(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.archiveJobTitle(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/job-titles/:id/reactivate')
  reactivateJobTitle(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.reactivateJobTitle(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/positions')
  createPosition(
    @Param('organizationId') organizationId: string,
    @Body() body: PositionCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.createPosition(organizationId, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  /**
   * R5B: active Job Title and Work Location choices for Position forms, for managers anywhere in
   * the Organization (authorized by the service; see listPositionReferenceOptions).
   */
  @Get(':organizationId/position-reference-options')
  positionReferenceOptions(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.organization.listPositionReferenceOptions(
      organizationId,
      identity.userId,
    );
  }

  @Get(':organizationId/positions')
  listPositions(
    @Param('organizationId') organizationId: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.listPositions(organizationId, includeArchived);
  }

  @Get(':organizationId/positions/:id')
  getPosition(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.getPosition(organizationId, id, includeArchived);
  }

  @Patch(':organizationId/positions/:id')
  updatePosition(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() body: PositionUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.updatePosition(organizationId, id, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/positions/:id/archive')
  archivePosition(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.archivePosition(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/positions/:id/reactivate')
  reactivatePosition(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.reactivatePosition(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/work-locations')
  createWorkLocation(
    @Param('organizationId') organizationId: string,
    @Body() body: WorkLocationCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.createWorkLocation(organizationId, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Get(':organizationId/work-locations')
  listWorkLocations(
    @Param('organizationId') organizationId: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.listWorkLocations(organizationId, includeArchived);
  }

  @Get(':organizationId/work-locations/:id')
  getWorkLocation(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived = false,
  ) {
    return this.organization.getWorkLocation(
      organizationId,
      id,
      includeArchived,
    );
  }

  @Patch(':organizationId/work-locations/:id')
  updateWorkLocation(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() body: WorkLocationUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.updateWorkLocation(organizationId, id, body, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/work-locations/:id/archive')
  archiveWorkLocation(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.archiveWorkLocation(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }

  @Post(':organizationId/work-locations/:id/reactivate')
  reactivateWorkLocation(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.organization.reactivateWorkLocation(organizationId, id, {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    });
  }
}
