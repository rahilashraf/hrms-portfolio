import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DocumentsAccessService } from '../documents/documents-access.service.js';
import { GoogleWorkspaceCoreModule } from '../integrations/google/google-workspace-core.module.js';
import { RecruitmentAccessService } from '../recruitment/recruitment-access.service.js';
import { BenefitsReportService } from './benefits-report.service.js';
import { CompensationReportService } from './compensation-report.service.js';
import { DocumentsReportService } from './documents-report.service.js';
import { LeaveReportService } from './leave-report.service.js';
import { PayrollReportService } from './payroll-report.service.js';
import { PerformanceReportService } from './performance-report.service.js';
import { RecruitmentReportService } from './recruitment-report.service.js';
import { ReportingAccessService } from './reporting-access.service.js';
import { ReportingClock } from './reporting-common.js';
import { ReportingController } from './reporting.controller.js';
import { ReportingService } from './reporting.service.js';
import { SchedulingReportService } from './scheduling-report.service.js';
import { TimeReportService } from './time-report.service.js';
import { WorkflowReportService } from './workflow-report.service.js';
import { WorkforceReportService } from './workforce-report.service.js';

/**
 * Phase 17 — Reporting & Analytics: permission-aware aggregate reports over the authoritative
 * domain tables (read-only, computed per request; no report tables), CSV export and Google
 * Sheets export through the Phase 16.5 GoogleSheetsExportService. Scope checks reuse the
 * authorization machinery and the documents / recruitment access services.
 */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    GoogleWorkspaceCoreModule,
  ],
  controllers: [ReportingController],
  providers: [
    AccessTokenGuard,
    ReportingClock,
    DocumentsAccessService,
    RecruitmentAccessService,
    ReportingAccessService,
    ReportingService,
    WorkforceReportService,
    TimeReportService,
    SchedulingReportService,
    LeaveReportService,
    CompensationReportService,
    PayrollReportService,
    BenefitsReportService,
    PerformanceReportService,
    RecruitmentReportService,
    WorkflowReportService,
    DocumentsReportService,
  ],
})
export class ReportingModule {}
