import { AuthController } from '../auth/auth.controller.js';
import { PublicBrandingController } from '../branding/branding.controller.js';
import { DocumentsController } from '../documents/documents.controller.js';
import {
  GoogleOAuthCallbackController,
  GoogleWorkspaceController,
} from '../integrations/google/google-workspace.controller.js';
import { KioskController } from '../kiosk/kiosk.controller.js';
import { NotificationsController } from '../notifications/notifications.controller.js';
import { OnboardingController } from '../onboarding/onboarding.controller.js';
import { RecruitmentIntakeController } from '../recruitment/recruitment.controller.js';
import { ReportingController } from '../reporting/reporting.controller.js';
import { RATE_LIMIT_METADATA, RATE_LIMITS } from './rate-limit.js';

type Controller = { prototype: object };

function policiesOf(controller: Controller, method: string) {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  expect(typeof handler, method).toBe('function');
  return Reflect.getMetadata(RATE_LIMIT_METADATA, handler as object);
}

/** Phase 19: the abuse-sensitive routes carry their rate-limit policy. */
describe('rate-limited routes', () => {
  const routes: Array<[Controller, string, keyof typeof RATE_LIMITS]> = [
    [AuthController, 'refresh', 'authRefresh'],
    [AuthController, 'logoutAll', 'authLogoutAll'],
    [AuthController, 'forgotPassword', 'authForgotPassword'],
    [AuthController, 'resetPassword', 'authResetPassword'],
    [AuthController, 'acceptInvitation', 'authAcceptInvitation'],
    [AuthController, 'verifyEmail', 'authVerifyEmail'],
    [AuthController, 'resendVerification', 'authResendVerification'],
    [GoogleWorkspaceController, 'startOAuth', 'googleOAuth'],
    [GoogleWorkspaceController, 'completeOAuth', 'googleOAuth'],
    [GoogleWorkspaceController, 'healthCheck', 'googleManual'],
    [GoogleWorkspaceController, 'syncBinding', 'googleManual'],
    [GoogleOAuthCallbackController, 'callback', 'googleOAuthCallback'],
    [NotificationsController, 'readAll', 'notificationsReadAll'],
    [ReportingController, 'exportCsv', 'reportCsvExport'],
    [ReportingController, 'exportGoogleSheets', 'reportSheetsExport'],
    [OnboardingController, 'importCompletions', 'intakeImport'],
    [RecruitmentIntakeController, 'import', 'intakeImport'],
    [DocumentsController, 'provide', 'documentsProvide'],
    [PublicBrandingController, 'get', 'publicBranding'],
  ];

  it.each(routes)('%o.%s', (controller, method, policy) => {
    expect(policiesOf(controller, method)).toEqual(RATE_LIMITS[policy]);
  });

  it('limits every kiosk device route by address', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA, KioskController)).toEqual(
      RATE_LIMITS.kioskDevice,
    );
  });

  it('keeps login on its dedicated limiter (address, and address + account)', () => {
    expect(policiesOf(AuthController, 'login')).toBeUndefined();
  });
});
