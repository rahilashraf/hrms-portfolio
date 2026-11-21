import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { DashboardService } from './dashboard.service.js';
import { EmployeeCapabilitiesService } from './employee-capabilities.service.js';
import { SetupService } from './setup.service.js';
import { DashboardQueryDto } from './workspace.dto.js';
import { WorkspaceService } from './workspace.service.js';

/**
 * Phase 20 — navigation, dashboard, setup and capability hints. Authenticated; every number
 * and flag is computed with the caller's own scoped grants and is never authorization by
 * itself (the domain endpoints authorize every request).
 */
@Controller('auth/me')
@UseGuards(AccessTokenGuard)
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('workspace')
  get(@AuthUser() identity: AuthenticatedIdentity) {
    return this.workspace.workspace(identity.userId);
  }
}

@Controller('dashboard')
@UseGuards(AccessTokenGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(
    @Query() query: DashboardQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.dashboard.dashboard(identity.userId, query.organizationId);
  }
}

@Controller('organizations/:organizationId/setup')
@UseGuards(AccessTokenGuard)
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get()
  get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.setup.checklist(identity.userId, organizationId);
  }
}

@Controller('employees/:employeeId/capabilities')
@UseGuards(AccessTokenGuard)
export class EmployeeCapabilitiesController {
  constructor(private readonly capabilities: EmployeeCapabilitiesService) {}

  @Get()
  get(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.capabilities.capabilities(identity.userId, employeeId);
  }
}
