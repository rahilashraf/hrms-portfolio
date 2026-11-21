import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from '@hrms/config';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuditViewerModule } from './audit/audit-viewer.module.js';
import { DatabaseModule } from './database/database.module.js';
import { SecurityModule } from './security/security.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { UsersModule } from './users/users.module.js';
import { RedisModule } from './redis/redis.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { EmployeeModule } from './employee/employee.module.js';
import { CalendarModule } from './calendar/calendar.module.js';
import { LeaveModule } from './leave/leave.module.js';
import { BenefitsModule } from './benefits/benefits.module.js';
import { PerformanceModule } from './performance/performance.module.js';
import { RecruitmentModule } from './recruitment/recruitment.module.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { GoogleWorkspaceModule } from './integrations/google/google-workspace.module.js';
import { ReportingModule } from './reporting/reporting.module.js';
import { CompensationModule } from './compensation/compensation.module.js';
import { KioskModule } from './kiosk/kiosk.module.js';
import { PayrollModule } from './payroll/payroll.module.js';
import { TimeModule } from './time/time.module.js';
import { SchedulingModule } from './scheduling/scheduling.module.js';
import { FeatureGateModule } from './features/feature-gate.module.js';
import { FeaturesModule } from './features/features.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { HealthModule } from './health/health.module.js';
import { BrandingModule } from './branding/branding.module.js';
import { WorkspaceModule } from './workspace/workspace.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: '../../.env',
      isGlobal: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    ObservabilityModule,
    FeatureGateModule,
    SecurityModule,
    UsersModule,
    SessionsModule,
    AuditModule,
    AuditViewerModule,
    AuthModule,
    RedisModule,
    OrganizationModule,
    AuthorizationModule,
    EmployeeModule,
    TimeModule,
    SchedulingModule,
    CalendarModule,
    LeaveModule,
    CompensationModule,
    KioskModule,
    PayrollModule,
    BenefitsModule,
    PerformanceModule,
    RecruitmentModule,
    OnboardingModule,
    DocumentsModule,
    NotificationsModule,
    GoogleWorkspaceModule,
    ReportingModule,
    FeaturesModule,
    RateLimitModule,
    HealthModule,
    BrandingModule,
    WorkspaceModule,
  ],
})
export class AppModule {}
