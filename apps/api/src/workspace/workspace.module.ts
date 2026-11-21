import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { BrandingModule } from '../branding/branding.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { DashboardService } from './dashboard.service.js';
import { EmployeeCapabilitiesService } from './employee-capabilities.service.js';
import { SetupService } from './setup.service.js';
import {
  DashboardController,
  EmployeeCapabilitiesController,
  SetupController,
  WorkspaceController,
} from './workspace.controller.js';
import { WorkspaceService } from './workspace.service.js';

/** Phase 20 — workspace context, dashboard, setup checklist and employee capabilities. */
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    BrandingModule,
    DocumentsModule,
    LeaveModule,
  ],
  controllers: [
    WorkspaceController,
    DashboardController,
    SetupController,
    EmployeeCapabilitiesController,
  ],
  providers: [
    AccessTokenGuard,
    WorkspaceService,
    DashboardService,
    SetupService,
    EmployeeCapabilitiesService,
  ],
})
export class WorkspaceModule {}
