import { AuditService } from '../../src/audit/audit.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../../src/authorization/position-authorization-target.resolver.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { FeatureGateService } from '../../src/features/feature-gate.service.js';
import { FeaturesAccessService } from '../../src/features/features-access.service.js';
import type { FeatureModule } from '../../src/features/features-domain.js';
import { FeaturesService } from '../../src/features/features.service.js';
import { notificationServices } from '../../src/notifications/notifications-producers.js';
import { TimePolicyService } from '../../src/time/time-policy.service.js';
import { BENEFIT_PERMISSION_KEYS } from './benefits-fixtures.js';
import { COMPENSATION_PERMISSIONS } from './compensation-fixtures.js';
import { DOCUMENT_PERMISSION_KEYS } from './documents-fixtures.js';
import { GOOGLE_PERMISSION_KEYS } from './google-fixtures.js';
import { LEAVE_PERMISSIONS, TIME_PERMISSIONS } from './leave-fixtures.js';
import { NOTIFICATION_PERMISSION_KEYS } from './notifications-fixtures.js';
import { ONBOARDING_PERMISSION_KEYS } from './onboarding-fixtures.js';
import { PAYROLL_PERMISSION_KEYS } from './payroll-fixtures.js';
import { PERFORMANCE_PERMISSION_KEYS } from './performance-fixtures.js';
import { RECRUITMENT_PERMISSION_KEYS } from './recruitment-fixtures.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  ctx,
  type SchedulingFixtures,
  type UserSpec,
} from './scheduling-fixtures.js';

/** Phase 18 feature-management fixtures shared by the feature specs. */

/** Every domain permission (HR-style administrators of one organization). */
export const ALL_DOMAIN_PERMISSIONS = [
  ...new Set([
    'employee.read',
    'employee.manage',
    ...ALL_SCHEDULE_PERMISSIONS,
    ...LEAVE_PERMISSIONS,
    ...TIME_PERMISSIONS,
    'time.manage_policy',
    'time.device.manage',
    'time.credential.manage',
    ...COMPENSATION_PERMISSIONS,
    ...PAYROLL_PERMISSION_KEYS,
    ...BENEFIT_PERMISSION_KEYS,
    ...PERFORMANCE_PERMISSION_KEYS,
    ...RECRUITMENT_PERMISSION_KEYS,
    ...ONBOARDING_PERMISSION_KEYS,
    ...DOCUMENT_PERMISSION_KEYS,
    ...NOTIFICATION_PERMISSION_KEYS,
    ...GOOGLE_PERMISSION_KEYS,
    'report.read',
    'report.export',
  ]),
];

export const FEATURE_USERS: Record<string, UserSpec[]> = {
  featureAdmin: [{ permissions: ['feature.manage'], scope: 'org' }],
  featureAdmin2: [{ permissions: ['feature.manage'], scope: 'org' }],
  featureReader: [{ permissions: ['feature.read'], scope: 'org' }],
  /** Organization-scope only: a team grant never manages features. */
  teamFeature: [{ permissions: ['feature.manage'], scope: 'teamA' }],
  featureB: [{ permissions: ['feature.manage'], scope: 'orgB' }],
  /** Every domain permission, but no feature permission. */
  hr: [{ permissions: ALL_DOMAIN_PERMISSIONS, scope: 'org' }],
  templateAdmin: [{ permissions: ALL_DOMAIN_PERMISSIONS, scope: 'org' }],
  hiringAdmin: [{ permissions: ALL_DOMAIN_PERMISSIONS, scope: 'org' }],
  hrB: [{ permissions: ALL_DOMAIN_PERMISSIONS, scope: 'orgB' }],
  self1: [{ permissions: ['time.clock', 'leave.request'], scope: 'org' }],
  // Works in Org A without any permission (a role with none): may own onboarding tasks.
  itDesk: [{ permissions: [], scope: 'org' }],
};

export function featureServices(
  prisma: PrismaService,
  overrides: { audit?: AuditService } = {},
) {
  const authorization = new AuthorizationService(prisma);
  const audit = overrides.audit ?? new AuditService(prisma);
  const access = new FeaturesAccessService(prisma, authorization);
  const notifications = notificationServices(prisma);
  const timePolicies = new TimePolicyService(
    prisma,
    authorization,
    new PositionAuthorizationTargetResolver(prisma),
    audit,
  );
  return {
    access,
    gate: new FeatureGateService(prisma),
    features: new FeaturesService(
      prisma,
      access,
      audit,
      timePolicies,
      notifications.settings,
    ),
  };
}

export type FeatureServices = ReturnType<typeof featureServices>;

/** Sets a module through the admin API (reading the current version first). */
export async function setModule(
  svc: FeatureServices,
  fx: SchedulingFixtures,
  module: FeatureModule,
  enabled: boolean,
  organizationId = fx.orgA,
  admin = organizationId === fx.orgA
    ? fx.users.featureAdmin!
    : fx.users.featureB!,
) {
  const overview = await svc.features.overview(admin, organizationId);
  const current = overview.modules.find((m) => m.module === module)!;
  return svc.features.setModule(
    { organizationId, module, enabled, expectedVersion: current.version },
    ctx(admin),
  );
}

export async function setSetting(
  svc: FeatureServices,
  fx: SchedulingFixtures,
  key: string,
  value: unknown,
  organizationId = fx.orgA,
) {
  const admin =
    organizationId === fx.orgA ? fx.users.featureAdmin! : fx.users.featureB!;
  const overview = await svc.features.overview(admin, organizationId);
  const current = overview.settings.find((s) => s.key === key)!;
  return svc.features.setSetting(
    { organizationId, key, value, expectedVersion: current.version },
    ctx(admin),
  );
}

export const disabled = (module: FeatureModule) => ({
  status: 403,
  code: 'FEATURE_DISABLED',
  module,
});

/** Status, code and module of an expected failure (FEATURE_DISABLED carries the module). */
export async function refusal(promise: Promise<unknown>) {
  const result = await promise.then(
    () => {
      throw new Error('Expected the operation to be refused.');
    },
    (error: unknown) => error,
  );
  const http = result as {
    getStatus?: () => number;
    getResponse?: () => unknown;
    message?: string;
  };
  if (!http.getStatus) throw result;
  const body = http.getResponse?.() as
    { code?: string; module?: string; key?: string } | undefined;
  return {
    status: http.getStatus(),
    code: body?.code,
    ...(body?.module ? { module: body.module } : {}),
    ...(body?.key ? { key: body.key } : {}),
  };
}
