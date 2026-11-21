'use client';

import type { NotificationCategory } from '../../lib/notifications/types';

export {
  dateTimeText,
  EmptyState,
  Field,
  inputClass,
  primaryButton,
  secondaryButton,
  Section,
} from '../documents/documents-shared';

/** Either of these shows the Notifications administration (the API decides the organizations). */
export const NOTIFICATION_ADMIN_KEYS = [
  'notification.template.manage',
  'notification.settings.manage',
  // Batch 8: the read-only delivery log.
  'notification.delivery.read',
] as const;

/** Dispatched after the inbox changes (read, archived) so the bell refreshes its count. */
export const NOTIFICATIONS_CHANGED_EVENT = 'hrms:notifications-changed';

export function notifyNotificationsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}

/**
 * Notification links are relative application paths. Anything else — absolute URLs,
 * protocol-relative `//host` paths, `javascript:` and the like — is not rendered as a link.
 */
export function isAppPath(link: string | null | undefined): link is string {
  return (
    typeof link === 'string' &&
    link.startsWith('/') &&
    !link.startsWith('//') &&
    !link.startsWith('/\\') &&
    !/[\s\\]/.test(link)
  );
}

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  SECURITY: 'Security',
  HR_REQUIRED: 'Required HR notices',
  ONBOARDING: 'Onboarding & offboarding',
  DOCUMENTS: 'Documents',
  PERFORMANCE: 'Performance',
  RECRUITMENT: 'Recruitment',
  LEAVE: 'Leave',
  SCHEDULING: 'Scheduling',
  TIME: 'Time & attendance',
  PAYROLL: 'Payroll',
  BENEFITS: 'Benefits',
  GENERAL: 'General',
};

export const MANDATORY_EXPLANATION =
  'Security and required HR notices are mandatory: they are always delivered, in the app and by email.';

const badge = 'inline-flex rounded-full px-2.5 py-1 text-xs font-medium';

export function CategoryBadge({ category }: { category: NotificationCategory }) {
  return (
    <span className={`${badge} bg-slate-100 text-slate-700`}>{CATEGORY_LABELS[category]}</span>
  );
}

export function MandatoryBadge() {
  return <span className={`${badge} bg-amber-50 text-amber-800`}>Mandatory</span>;
}

export function LockedBadge() {
  return <span className={`${badge} bg-slate-200 text-slate-700`}>Always on</span>;
}

// Batch 10E-2: the shared 24 px checkbox (was 16 px).
export { checkboxClass as checkbox } from '../ui/tokens';

/** Batch 8: readable names of notification types (the key is shown for unknown ones). */
export const TYPE_LABELS: Record<string, string> = {
  'onboarding.tasks-due': 'Onboarding tasks due',
  'documents.renewal-due': 'Document renewal due',
  'documents.expiry-digest': 'Document expiry digest',
  'documents.required-missing': 'Required documents missing',
  'performance.self-review-due': 'Self-review due',
  'performance.reviews-due': 'Performance reviews due',
  'recruitment.interview-upcoming': 'Upcoming interview',
  'recruitment.feedback-overdue': 'Interview feedback overdue',
  'recruitment.offer-expiring': 'Offer expiring',
  'leave.request-submitted': 'Leave submitted',
  'leave.request-approved': 'Leave approved',
  'leave.request-rejected': 'Leave declined',
  'leave.request-cancelled': 'Leave cancelled',
  'leave.request-changed': 'Leave changed',
  'time.correction-decided': 'Time correction decided',
  'time.timesheet-changes-requested': 'Timesheet changes requested',
  'time.timesheet-approved': 'Timesheet approved',
  'scheduling.schedule-published': 'Schedule published',
  'scheduling.shift-corrected': 'Shift changed',
  'scheduling.shift-cancelled': 'Shift cancelled',
  'payroll.payslip-available': 'Pay statement available',
  'benefits.election-changed': 'Benefit elections updated',
  'security.account-action-refused': 'Login-access action refused',
};

export function typeLabel(key: string) {
  return TYPE_LABELS[key] ?? key;
}
