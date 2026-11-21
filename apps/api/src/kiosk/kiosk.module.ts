import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { RefreshCookieService } from '../auth/refresh-cookie.service.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { SecurityModule } from '../security/security.module.js';
import { TimeModule } from '../time/time.module.js';
import {
  AttendanceCredentialController,
  AttendanceDeviceController,
  MyAttendancePinController,
} from './attendance-admin.controller.js';
import { AttendanceCredentialService } from './attendance-credential.service.js';
import { AttendanceDeviceService } from './attendance-device.service.js';
import { AttendanceKioskService } from './attendance-kiosk.service.js';
import { KioskController } from './kiosk.controller.js';
import { KioskDeviceGuard } from './kiosk-device.guard.js';
import { KioskRateLimiterService } from './kiosk-rate-limiter.service.js';

/** Phase 9.5 — trusted attendance devices, attendance PINs and the onsite kiosk. */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    SecurityModule,
    TimeModule,
  ],
  controllers: [
    KioskController,
    AttendanceDeviceController,
    AttendanceCredentialController,
    MyAttendancePinController,
  ],
  providers: [
    AccessTokenGuard,
    RefreshCookieService,
    KioskDeviceGuard,
    KioskRateLimiterService,
    AttendanceDeviceService,
    AttendanceCredentialService,
    AttendanceKioskService,
  ],
})
export class KioskModule {}
