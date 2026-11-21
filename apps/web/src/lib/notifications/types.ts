/** Phase 16 Notifications & Communications read and write models (mirror the API). */

export type NotificationCategory =
  | 'SECURITY'
  | 'HR_REQUIRED'
  | 'ONBOARDING'
  | 'DOCUMENTS'
  | 'PERFORMANCE'
  | 'RECRUITMENT'
  | 'LEAVE'
  | 'SCHEDULING'
  | 'TIME'
  | 'PAYROLL'
  | 'BENEFITS'
  | 'GENERAL';

export type NotificationSourceDomain =
  | 'SYSTEM'
  | 'AUTH'
  | 'ONBOARDING'
  | 'DOCUMENTS'
  | 'PERFORMANCE'
  | 'RECRUITMENT'
  | 'LEAVE'
  | 'SCHEDULING'
  | 'PAYROLL'
  | 'BENEFITS'
  | 'TIME';

export type NotificationTemplateStatus = 'ACTIVE' | 'ARCHIVED';

/** One of the caller's own in-app notifications. `link` is a relative application path. */
export interface NotificationView {
  id: string;
  organizationId: string;
  organization?: { id: string; name: string };
  type: string;
  category: NotificationCategory;
  mandatory: boolean;
  title: string;
  body: string;
  link: string | null;
  sourceDomain: NotificationSourceDomain;
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
}

export interface InboxQuery {
  limit?: number;
  cursor?: string | null;
  unreadOnly?: boolean;
  archived?: boolean;
  organizationId?: string | null;
}

export interface CategoryEmailSetting {
  category: NotificationCategory;
  mandatory: boolean;
  configurable: boolean;
  emailEnabled: boolean;
}

export interface NotificationPreferences {
  inApp: 'ALWAYS';
  items: CategoryEmailSetting[];
}

export interface CategoryEmailInput {
  category: NotificationCategory;
  emailEnabled: boolean;
}

export interface NotificationsOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  actions: {
    canManageTemplates: boolean;
    canManageSettings: boolean;
    /** Batch 8: notification.delivery.read (the read-only delivery log). */
    canReadDeliveries: boolean;
  };
}

export interface TemplateView {
  id: string;
  organizationId: string | null;
  key: string;
  category: NotificationCategory;
  subjectTemplate: string;
  bodyTemplate: string;
  allowedVariables: string[];
  mandatory: boolean;
  status: NotificationTemplateStatus;
  version: number;
  system: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** A notification type: its system default and the organization's active override. */
export interface TemplateEntry {
  key: string;
  category: NotificationCategory;
  mandatory: boolean;
  allowedVariables: string[];
  sample: Record<string, string>;
  system: TemplateView;
  override: TemplateView | null;
  archived?: TemplateView[];
}

export interface TemplatePreview {
  key: string;
  variables: Record<string, string>;
  subject: string;
  body: string;
}

export interface OrganizationNotificationSettings {
  organizationId: string;
  emailEnabled: boolean;
  suppressMandatoryEmail: boolean;
  categories: CategoryEmailSetting[];
  updatedAt: string | null;
}

// ─── Batch 8: delivery log (read-only) ───────────────────────────────────────

export type NotificationChannel = 'IN_APP' | 'EMAIL';
export type DeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED';
export type SuppressionReason =
  | 'USER_PREFERENCE'
  | 'ORGANIZATION_CATEGORY_DISABLED'
  | 'ORGANIZATION_EMAIL_DISABLED'
  | 'RECIPIENT_INACTIVE'
  | 'EMAIL_PROVIDER_NOT_CONFIGURED'
  | 'DELIVERY_EXPIRED';
export type AttemptOutcome =
  'SUCCEEDED' | 'RETRYABLE' | 'PERMANENT' | 'UNCERTAIN' | 'ABANDONED' | 'IN_PROGRESS';

/** One delivery (never the subject, body, address or variables). */
export interface DeliveryView {
  id: string;
  type: string;
  category: NotificationCategory;
  mandatory: boolean;
  recipientName: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  sentAt: string | null;
  lastErrorCode: string | null;
  suppressedReason: SuppressionReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryAttemptView {
  attemptNumber: number;
  status: string;
  outcome: AttemptOutcome;
  provider: string;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DeliveryDetail extends DeliveryView {
  attempts: DeliveryAttemptView[];
}

export interface DeliveryPage {
  items: DeliveryView[];
  nextCursor: string | null;
  /** The organization's time zone: date filters are its local dates. */
  timezone: string;
  types: Array<{ key: string; category: NotificationCategory }>;
}

export interface DeliveryQuery {
  organizationId: string;
  type?: string;
  category?: NotificationCategory | '';
  channel?: NotificationChannel | '';
  status?: DeliveryStatus | '';
  from?: string;
  to?: string;
  recipient?: string;
  cursor?: string | null;
  limit?: number;
}
