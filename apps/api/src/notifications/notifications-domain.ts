import { BadRequestException } from '@nestjs/common';
import { domainError } from '../common/domain-support.js';
import type {
  NotificationCategory,
  NotificationSourceDomain,
  NotificationSuppressionReason,
} from '../generated/prisma/client.js';

/**
 * Phase 16 — pure notification rules: the notification type registry (system templates),
 * placeholder parsing and rendering, link validation, email delivery resolution (preferences,
 * organization settings, mandatory notices) and retry backoff.
 */

export const NOTIFICATION_CATEGORIES = [
  'SECURITY',
  'HR_REQUIRED',
  'ONBOARDING',
  'DOCUMENTS',
  'PERFORMANCE',
  'RECRUITMENT',
  'LEAVE',
  'SCHEDULING',
  'TIME',
  'PAYROLL',
  'BENEFITS',
  'GENERAL',
] as const satisfies readonly NotificationCategory[];

/** Categories whose notices are always delivered: no preference or category setting applies. */
export const MANDATORY_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  'SECURITY',
  'HR_REQUIRED',
]);

export const CONFIGURABLE_CATEGORIES = NOTIFICATION_CATEGORIES.filter(
  (category) => !MANDATORY_CATEGORIES.has(category),
);

export function invalid(code: string, message: string): never {
  throw new BadRequestException(domainError(400, code, message));
}

// ─── Notification types (system templates) ───────────────────────────────────

export interface NotificationTypeDefinition {
  key: string;
  category: NotificationCategory;
  sourceDomain: NotificationSourceDomain;
  mandatory: boolean;
  subjectTemplate: string;
  bodyTemplate: string;
  allowedVariables: readonly string[];
  /** Sample values for previews (never real data). */
  sample: Record<string, string>;
  /**
   * Security remediation M1: rendered only from the system template (no organization override)
   * and left out of organization-scoped delivery logs and template lists. For notices whose
   * existence must not be visible to, or editable by, an organization's administrators.
   */
  systemOnly?: boolean;
}

/**
 * The notification types of Phase 16 and their system templates. Seeded idempotently
 * (missing keys only; existing system rows are never overwritten). Content is deliberately
 * generic: counts, dates and the recipient's own task titles — never candidate details,
 * compensation, feedback, document titles or confidential types.
 */
export const NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] = [
  {
    key: 'onboarding.tasks-due',
    category: 'ONBOARDING',
    sourceDomain: 'ONBOARDING',
    mandatory: false,
    subjectTemplate: 'Onboarding tasks need your attention',
    bodyTemplate:
      'You have {{overdueCount}} overdue and {{dueSoonCount}} upcoming workflow tasks: {{taskTitles}}.',
    allowedVariables: ['overdueCount', 'dueSoonCount', 'taskTitles'],
    sample: {
      overdueCount: '1',
      dueSoonCount: '2',
      taskTitles: 'Set up accounts, Supervisor welcome meeting',
    },
  },
  {
    key: 'documents.renewal-due',
    category: 'DOCUMENTS',
    sourceDomain: 'DOCUMENTS',
    mandatory: false,
    subjectTemplate: 'A document needs renewal',
    bodyTemplate:
      '{{expiredCount}} of your documents have expired and {{expiringSoonCount}} expire soon. Please provide renewed copies.',
    allowedVariables: ['expiredCount', 'expiringSoonCount'],
    sample: { expiredCount: '0', expiringSoonCount: '1' },
  },
  {
    key: 'documents.expiry-digest',
    category: 'DOCUMENTS',
    sourceDomain: 'DOCUMENTS',
    mandatory: false,
    subjectTemplate: 'Employee documents need renewal',
    bodyTemplate:
      '{{expiredCount}} employee documents have expired and {{expiringSoonCount}} expire soon.',
    allowedVariables: ['expiredCount', 'expiringSoonCount'],
    sample: { expiredCount: '2', expiringSoonCount: '5' },
  },
  {
    key: 'documents.required-missing',
    category: 'HR_REQUIRED',
    sourceDomain: 'DOCUMENTS',
    mandatory: true,
    subjectTemplate: 'Required documents are missing',
    bodyTemplate:
      '{{missingCount}} required documents are missing or expired in your records.',
    allowedVariables: ['missingCount'],
    sample: { missingCount: '1' },
  },
  {
    key: 'performance.self-review-due',
    category: 'PERFORMANCE',
    sourceDomain: 'PERFORMANCE',
    mandatory: false,
    subjectTemplate: 'Your self-review is {{dueState}}',
    bodyTemplate:
      'Your performance self-review is {{dueState}} (due {{dueDate}}).',
    allowedVariables: ['dueState', 'dueDate'],
    sample: { dueState: 'due soon', dueDate: '2026-03-31' },
  },
  {
    key: 'performance.reviews-due',
    category: 'PERFORMANCE',
    sourceDomain: 'PERFORMANCE',
    mandatory: false,
    subjectTemplate: 'Performance reviews need your attention',
    bodyTemplate:
      'You have {{overdueCount}} overdue and {{dueSoonCount}} upcoming performance reviews to write.',
    allowedVariables: ['overdueCount', 'dueSoonCount'],
    sample: { overdueCount: '1', dueSoonCount: '3' },
  },
  {
    key: 'recruitment.interview-upcoming',
    category: 'RECRUITMENT',
    sourceDomain: 'RECRUITMENT',
    mandatory: false,
    subjectTemplate: 'Upcoming interview',
    bodyTemplate:
      'You have an interview at {{startsAt}} ({{durationMinutes}} minutes).',
    allowedVariables: ['startsAt', 'durationMinutes'],
    sample: {
      startsAt: '2026-03-16 10:00 America/Toronto',
      durationMinutes: '45',
    },
  },
  {
    key: 'recruitment.feedback-overdue',
    category: 'RECRUITMENT',
    sourceDomain: 'RECRUITMENT',
    mandatory: false,
    subjectTemplate: 'Interview feedback is overdue',
    bodyTemplate: 'Your feedback for an interview was due {{dueAt}}.',
    allowedVariables: ['dueAt'],
    sample: { dueAt: '2026-03-17 10:00 America/Toronto' },
  },
  {
    key: 'recruitment.offer-expiring',
    category: 'RECRUITMENT',
    sourceDomain: 'RECRUITMENT',
    mandatory: false,
    subjectTemplate: 'An offer expires soon',
    bodyTemplate:
      'An offer you prepared or approved expires on {{expiresOn}} and has not been answered.',
    allowedVariables: ['expiresOn'],
    sample: { expiresOn: '2026-03-25' },
  },
  // ─── Batch 8: business event notifications ────────────────────────────────
  // Plain text with dates, counts and names only: never leave types, reasons or notes,
  // decision notes, time values, pay amounts, plan or option names, dependents or HR notes.
  {
    key: 'leave.request-submitted',
    category: 'LEAVE',
    sourceDomain: 'LEAVE',
    mandatory: false,
    subjectTemplate: 'Leave request awaiting a decision',
    bodyTemplate:
      'A leave request for {{employeeName}} from {{startDate}} to {{endDate}} was submitted and awaits a decision.',
    allowedVariables: ['employeeName', 'startDate', 'endDate'],
    sample: {
      employeeName: 'Jordan Lee',
      startDate: '2026-03-16',
      endDate: '2026-03-18',
    },
  },
  {
    key: 'leave.request-approved',
    category: 'LEAVE',
    sourceDomain: 'LEAVE',
    mandatory: false,
    subjectTemplate: 'Your leave was approved',
    bodyTemplate: 'Your leave from {{startDate}} to {{endDate}} was approved.',
    allowedVariables: ['startDate', 'endDate'],
    sample: { startDate: '2026-03-16', endDate: '2026-03-18' },
  },
  {
    key: 'leave.request-rejected',
    category: 'LEAVE',
    sourceDomain: 'LEAVE',
    mandatory: false,
    subjectTemplate: 'Your leave request was declined',
    bodyTemplate:
      'Your leave request from {{startDate}} to {{endDate}} was declined.',
    allowedVariables: ['startDate', 'endDate'],
    sample: { startDate: '2026-03-16', endDate: '2026-03-18' },
  },
  {
    key: 'leave.request-cancelled',
    category: 'LEAVE',
    sourceDomain: 'LEAVE',
    mandatory: false,
    subjectTemplate: 'Leave cancelled',
    bodyTemplate:
      'The leave of {{employeeName}} from {{startDate}} to {{endDate}} was cancelled.',
    allowedVariables: ['employeeName', 'startDate', 'endDate'],
    sample: {
      employeeName: 'Jordan Lee',
      startDate: '2026-03-16',
      endDate: '2026-03-18',
    },
  },
  {
    // Batch 8 (N6): a partial shortening of approved leave is a change, not a cancellation.
    key: 'leave.request-changed',
    category: 'LEAVE',
    sourceDomain: 'LEAVE',
    mandatory: false,
    subjectTemplate: 'Leave changed',
    bodyTemplate:
      'The approved leave of {{employeeName}} from {{startDate}} to {{endDate}} was shortened; {{cancelledDayCount}} day(s) no longer apply.',
    allowedVariables: [
      'employeeName',
      'startDate',
      'endDate',
      'cancelledDayCount',
    ],
    sample: {
      employeeName: 'Jordan Lee',
      startDate: '2026-03-16',
      endDate: '2026-03-18',
      cancelledDayCount: '1',
    },
  },
  {
    key: 'time.correction-decided',
    category: 'TIME',
    sourceDomain: 'TIME',
    mandatory: false,
    subjectTemplate: 'Your time correction was {{decision}}',
    bodyTemplate:
      'Your time correction request submitted on {{requestedOn}} was {{decision}}.',
    allowedVariables: ['decision', 'requestedOn'],
    sample: { decision: 'approved', requestedOn: '2026-03-16' },
  },
  {
    key: 'time.timesheet-changes-requested',
    category: 'TIME',
    sourceDomain: 'TIME',
    mandatory: false,
    subjectTemplate: 'Changes requested on your timesheet',
    bodyTemplate:
      'Changes were requested on your timesheet for {{periodStart}} to {{periodEnd}}. Please review and resubmit it.',
    allowedVariables: ['periodStart', 'periodEnd'],
    sample: { periodStart: '2026-03-02', periodEnd: '2026-03-15' },
  },
  {
    key: 'time.timesheet-approved',
    category: 'TIME',
    sourceDomain: 'TIME',
    mandatory: false,
    subjectTemplate: 'Your timesheet was approved',
    bodyTemplate:
      'Your timesheet for {{periodStart}} to {{periodEnd}} was approved.',
    allowedVariables: ['periodStart', 'periodEnd'],
    sample: { periodStart: '2026-03-02', periodEnd: '2026-03-15' },
  },
  {
    key: 'scheduling.schedule-published',
    category: 'SCHEDULING',
    sourceDomain: 'SCHEDULING',
    mandatory: false,
    subjectTemplate: 'Your schedule is published',
    bodyTemplate:
      'A schedule for {{periodStart}} to {{periodEnd}} was published with {{shiftCount}} shift(s) for you.',
    allowedVariables: ['periodStart', 'periodEnd', 'shiftCount'],
    sample: {
      periodStart: '2026-03-16',
      periodEnd: '2026-03-29',
      shiftCount: '8',
    },
  },
  {
    key: 'scheduling.shift-corrected',
    category: 'SCHEDULING',
    sourceDomain: 'SCHEDULING',
    mandatory: false,
    subjectTemplate: 'Your shift on {{workDate}} changed',
    bodyTemplate:
      'Your shift on {{workDate}} is now {{startTime}} to {{endTime}} ({{timezone}}).',
    allowedVariables: ['workDate', 'startTime', 'endTime', 'timezone'],
    sample: {
      workDate: '2026-03-16',
      startTime: '09:00',
      endTime: '17:00',
      timezone: 'America/Toronto',
    },
  },
  {
    key: 'scheduling.shift-cancelled',
    category: 'SCHEDULING',
    sourceDomain: 'SCHEDULING',
    mandatory: false,
    subjectTemplate: 'Your shift on {{workDate}} was cancelled',
    bodyTemplate:
      'Your shift on {{workDate}} from {{startTime}} to {{endTime}} ({{timezone}}) was cancelled.',
    allowedVariables: ['workDate', 'startTime', 'endTime', 'timezone'],
    sample: {
      workDate: '2026-03-16',
      startTime: '09:00',
      endTime: '17:00',
      timezone: 'America/Toronto',
    },
  },
  {
    key: 'payroll.payslip-available',
    category: 'PAYROLL',
    sourceDomain: 'PAYROLL',
    mandatory: false,
    subjectTemplate: 'Your pay statement is available',
    bodyTemplate:
      'Your pay statement for {{periodStart}} to {{periodEnd}} (pay date {{payDate}}) is available.',
    allowedVariables: ['periodStart', 'periodEnd', 'payDate'],
    sample: {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-15',
      payDate: '2026-03-20',
    },
  },
  {
    key: 'benefits.election-changed',
    category: 'BENEFITS',
    sourceDomain: 'BENEFITS',
    mandatory: false,
    subjectTemplate: 'Your benefit elections were updated',
    bodyTemplate:
      'Your benefit elections were updated (effective {{effectiveDate}}). Review them in My Benefits.',
    allowedVariables: ['effectiveDate'],
    sample: { effectiveDate: '2026-04-01' },
  },
  // Security remediation M1: a high-risk refused login-access action, for SYSTEM-scope security
  // administrators. Names no organization, role or person; the details stay in the audit log.
  {
    key: 'security.account-action-refused',
    category: 'SECURITY',
    sourceDomain: 'AUTH',
    mandatory: true,
    subjectTemplate: 'A login-access action was refused',
    bodyTemplate:
      'An administrator tried to {{action}} an employee login and was refused because {{risk}}. Review the audit log.',
    allowedVariables: ['action', 'risk'],
    systemOnly: true,
    sample: {
      action: 'enable',
      risk: 'the person is employed or holds access in another organization',
    },
  },
];

/** Types rendered only from their system template and hidden from organization views. */
export const SYSTEM_ONLY_NOTIFICATION_TYPES: readonly string[] =
  NOTIFICATION_TYPES.filter((type) => type.systemOnly).map((type) => type.key);

export function isSystemOnlyNotificationType(key: string) {
  return SYSTEM_ONLY_NOTIFICATION_TYPES.includes(key);
}

export function notificationType(key: string) {
  return NOTIFICATION_TYPES.find((type) => type.key === key) ?? null;
}

export function isMandatory(
  category: NotificationCategory,
  mandatory: boolean,
) {
  return mandatory || MANDATORY_CATEGORIES.has(category);
}

// ─── Templates ───────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const URL_LIKE = /([a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)/i;
/**
 * Batch 8 (O2): a bare domain such as "portal.example.com/reset" (mail clients turn it into a
 * link): dot-separated labels ending in an alphabetic top-level label, followed by a path,
 * punctuation, a space or the end of the text.
 */
const BARE_DOMAIN =
  /(^|[^A-Za-z0-9@.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?=$|[/:?#\s),;!'".])/;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 2000;

/** Whether text contains a URL, an email-like scheme or a bare domain (Batch 8, O2 / L5). */
export function containsLink(text: string) {
  return URL_LIKE.test(text) || BARE_DOMAIN.test(text);
}

/** The placeholders of a template; malformed braces are refused. */
export function placeholdersOf(template: string, field: string) {
  const names: string[] = [];
  const rest = template.replace(PLACEHOLDER, (_, name: string) => {
    names.push(name);
    return '';
  });
  if (rest.includes('{') || rest.includes('}')) {
    invalid(
      'NOTIFICATION_TEMPLATE_SYNTAX',
      `${field} has malformed placeholders; use {{name}}.`,
    );
  }
  return names;
}

/**
 * Validates template text before it is saved: non-empty, bounded, only allowed placeholders,
 * and no links (the notification link is set by the producer, never by template text).
 */
export function validateTemplateText(
  subjectTemplate: unknown,
  bodyTemplate: unknown,
  allowedVariables: readonly string[],
) {
  const text = (value: unknown, field: string, max: number) => {
    if (typeof value !== 'string' || value.trim() === '')
      invalid('NOTIFICATION_TEMPLATE_INVALID', `${field} is required.`);
    const trimmed = value.trim();
    if (trimmed.length > max)
      invalid(
        'NOTIFICATION_TEMPLATE_INVALID',
        `${field} must be at most ${max} characters.`,
      );
    // oxlint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed))
      invalid(
        'NOTIFICATION_TEMPLATE_INVALID',
        `${field} contains control characters.`,
      );
    if (containsLink(trimmed))
      invalid(
        'NOTIFICATION_TEMPLATE_LINK',
        `${field} must not contain links; notifications link to the application themselves.`,
      );
    const unknown = placeholdersOf(trimmed, field).filter(
      (name) => !allowedVariables.includes(name),
    );
    if (unknown.length > 0)
      invalid(
        'NOTIFICATION_TEMPLATE_PLACEHOLDER',
        `${field} uses unknown placeholders: ${[...new Set(unknown)].join(', ')}.`,
      );
    return trimmed;
  };
  return {
    subjectTemplate: text(subjectTemplate, 'subjectTemplate', SUBJECT_MAX),
    bodyTemplate: text(bodyTemplate, 'bodyTemplate', BODY_MAX),
  };
}

/**
 * A variable value as safe plain text: control characters and line breaks become spaces,
 * braces are removed (no value can introduce a placeholder) and the length is bounded.
 * Notifications are plain text everywhere; an HTML email adapter must HTML-escape it again.
 */
export type VariableValue = string | number | boolean | Date | null | undefined;

export function escapeValue(value: VariableValue, max = 300) {
  const text = (
    value === null || value === undefined
      ? ''
      : value instanceof Date
        ? value.toISOString()
        : String(value)
  )
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Single-pass rendering: only allowed variables are substituted, values escaped. */
export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, VariableValue>>,
  allowedVariables: readonly string[],
  max: number,
) {
  const rendered = template
    .replace(PLACEHOLDER, (_, name: string) =>
      allowedVariables.includes(name) && name in variables
        ? escapeValue(variables[name])
        : '',
    )
    .replace(/[ \t]+/g, ' ')
    .trim();
  return rendered.length > max ? `${rendered.slice(0, max - 1)}…` : rendered;
}

// ─── Links and keys ──────────────────────────────────────────────────────────

const LINK = /^\/[A-Za-z0-9/_.~?=&%-]*$/;

/** A relative application path (e.g. /onboarding); external URLs are refused. */
export function validateLink(link: string | null | undefined) {
  if (link === null || link === undefined) return null;
  if (
    typeof link !== 'string' ||
    link.length > 300 ||
    !LINK.test(link) ||
    link.startsWith('//') ||
    /(^|\/)\.\.(\/|$|\?)/.test(link)
  ) {
    invalid(
      'NOTIFICATION_LINK_INVALID',
      'A notification links to a relative application path only.',
    );
  }
  return link;
}

const DEDUPE = /^[A-Za-z0-9:._-]{1,200}$/;

export function validateDedupeKey(key: unknown) {
  if (typeof key !== 'string' || !DEDUPE.test(key))
    invalid(
      'NOTIFICATION_DEDUPE_INVALID',
      'A dedupe key is 1–200 letters, digits or :._-',
    );
  return key;
}

// ─── Email delivery resolution ───────────────────────────────────────────────

export interface EmailDecisionInput {
  category: NotificationCategory;
  mandatory: boolean;
  /** The user's preference for the category (undefined: default on). */
  userEmailEnabled?: boolean | null;
  /** The organization's category setting (undefined: default on). */
  organizationCategoryEmailEnabled?: boolean | null;
  organizationPolicy?: {
    emailEnabled: boolean;
    suppressMandatoryEmail: boolean;
  } | null;
}

export type EmailDecision =
  { deliver: true } | { deliver: false; reason: NotificationSuppressionReason };

/**
 * Mandatory notices (mandatory categories or notifications) ignore user preferences and
 * category settings; only the organization kill switch with an explicit
 * suppressMandatoryEmail decision stops them. Otherwise the organization kill switch, then the
 * organization category setting, then the user's preference may suppress email.
 */
export function resolveEmailDelivery(input: EmailDecisionInput): EmailDecision {
  const mandatory = isMandatory(input.category, input.mandatory);
  const policy = input.organizationPolicy;
  if (policy && !policy.emailEnabled) {
    if (!mandatory || policy.suppressMandatoryEmail)
      return { deliver: false, reason: 'ORGANIZATION_EMAIL_DISABLED' };
  }
  if (mandatory) return { deliver: true };
  if (input.organizationCategoryEmailEnabled === false)
    return { deliver: false, reason: 'ORGANIZATION_CATEGORY_DISABLED' };
  if (input.userEmailEnabled === false)
    return { deliver: false, reason: 'USER_PREFERENCE' };
  return { deliver: true };
}

// ─── Retries ─────────────────────────────────────────────────────────────────

export const MAX_EMAIL_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 6 * 3_600_000;
/** How long a claimed delivery stays SENDING before another worker may reclaim it. */
export const SEND_LEASE_MS = 5 * 60_000;
/**
 * Batch 8 (D1): the longest a worker waits for one send. Well inside the lease (renewed just
 * before each send), so no other worker can reclaim a delivery while its send is in flight; a
 * send that outlives it is recorded as UNCERTAIN and never retried automatically.
 */
export const SEND_TIMEOUT_MS = 2 * 60_000;
/**
 * Batch 8 (O1): email older than this when it would be sent (a module disabled for days, a
 * long worker outage) is suppressed as DELIVERY_EXPIRED instead of sending a stale backlog.
 * The in-app notification is unaffected.
 */
export const EMAIL_MAX_AGE_MS = 72 * 3_600_000;

/** Exponential backoff after the n-th failed attempt: 1, 2, 4, 8 … minutes (capped at 6 h). */
export function backoffMs(attemptNumber: number) {
  return Math.min(
    BACKOFF_CAP_MS,
    BACKOFF_BASE_MS * 2 ** Math.max(0, attemptNumber - 1),
  );
}

/** What to do after a failed attempt. */
export function afterFailure(
  attemptNumber: number,
  retryable: boolean,
  now: Date,
): { status: 'PENDING'; nextAttemptAt: Date } | { status: 'FAILED' } {
  if (!retryable || attemptNumber >= MAX_EMAIL_ATTEMPTS)
    return { status: 'FAILED' };
  return {
    status: 'PENDING',
    nextAttemptAt: new Date(now.getTime() + backoffMs(attemptNumber)),
  };
}

const EMAIL_LIKE = /[^\s@<>()]+@[^\s@<>()]+/g;

/** A short, safe error message for the attempt record: addresses redacted, length bounded. */
export function safeErrorMessage(message: string | null | undefined) {
  if (!message) return null;
  const text = escapeValue(message.replace(EMAIL_LIKE, '[redacted]'), 300);
  return text || null;
}

export function safeErrorCode(code: string | null | undefined) {
  const normalized = (code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 64);
  return /^[A-Z]/.test(normalized) ? normalized : 'TRANSPORT_ERROR';
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 100;

export function encodeCursor(row: { createdAt: Date; id: string }) {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string | undefined | null) {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [at, id] = decoded.split('|');
  const createdAt = at ? new Date(at) : null;
  if (
    !createdAt ||
    Number.isNaN(createdAt.getTime()) ||
    !id ||
    !/^[0-9a-f-]{36}$/i.test(id)
  )
    invalid('NOTIFICATION_CURSOR_INVALID', 'The cursor is invalid.');
  return { createdAt, id };
}

// ─── Formatting for producers ────────────────────────────────────────────────

/** "2026-03-16 10:00 America/Toronto" (or UTC when the organization has no timezone). */
export function formatInstant(instant: Date, timezone: string | null) {
  const zone = timezone ?? 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${zone}`;
  } catch {
    return `${instant.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}

/** Up to `max` titles, then "and N more". */
export function listTitles(titles: readonly string[], max = 5) {
  const shown = titles.slice(0, max).map((title) => escapeValue(title, 80));
  return titles.length > max
    ? `${shown.join(', ')} and ${titles.length - max} more`
    : shown.join(', ');
}
