import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { addDays, formatDate } from '../common/domain-support.js';
import type { PrismaService } from '../database/prisma.service.js';
import { FeatureGateService } from '../features/feature-gate.service.js';
import type { FeatureModule } from '../features/features-domain.js';
import { DocumentsAuditAdapter } from '../documents/documents-audit.js';
import { DocumentsAccessService } from '../documents/documents-access.service.js';
import {
  DocumentsClock,
  documentsToday,
} from '../documents/documents-common.js';
import type {
  DocumentExpiryDigest,
  DocumentReminderSink,
} from '../documents/documents-jobs.js';
import { levelWithin } from '../documents/documents-domain.js';
import { DocumentTypeService } from '../documents/document-type.service.js';
import { EmployeeDocumentService } from '../documents/employee-document.service.js';
import type {
  TaskReminderDigest,
  WorkflowReminderSink,
} from '../onboarding/onboarding-jobs.js';
import { OPEN_TASK } from '../onboarding/onboarding-domain.js';
import { PerformanceAccessService } from '../performance/performance-access.service.js';
import { performanceToday } from '../performance/performance-common.js';
import { RecruitmentAccessService } from '../recruitment/recruitment-access.service.js';
import { recruitmentToday } from '../recruitment/recruitment-common.js';
import { NotificationsAccessService } from './notifications-access.service.js';
import { localDay, NotificationsClock } from './notifications-common.js';
import { formatInstant, listTitles } from './notifications-domain.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { NotificationTemplateService } from './notification-template.service.js';
import {
  NotificationService,
  type PublishInput,
} from './notification.service.js';

/**
 * Phase 16 — domain producers. They turn the reminder boundaries the domains already expose
 * (onboarding task digests, document expiry digests) and the attention items they compute on
 * read (performance due dates, interviews, overdue feedback, expiring offers) into
 * notifications. Each re-checks, per recipient, through the domain's own access rules that
 * the recipient can open the linked page, and publishes generic text only: counts, dates and
 * the recipient's own task titles — never candidate details, compensation, screening,
 * feedback, document titles or confidential document types.
 *
 * Dedupe keys make every producer idempotent: re-running a job never duplicates a
 * notification. Daily digests key on the organization's local date; set-based reminders key
 * on a hash of what they report, so a recipient is notified again only when it changes.
 */

export interface ProducerOutcome {
  considered: number;
  created: number;
  existing: number;
  /** Recipients refused by the domain's access re-check or the organization membership check. */
  skipped: number;
  /** Phase 18: organizations skipped because the producing module is disabled there. */
  skippedOrganizations: string[];
  failed: Array<{ message: string }>;
}

export function emptyOutcome(): ProducerOutcome {
  return {
    considered: 0,
    created: 0,
    existing: 0,
    skipped: 0,
    skippedOrganizations: [],
    failed: [],
  };
}

export function setHash(entries: readonly string[]) {
  return createHash('sha256')
    .update([...entries].sort().join('\n'))
    .digest('hex')
    .slice(0, 24);
}

export function notificationServices(
  prisma: PrismaService,
  clock = new NotificationsClock(),
) {
  const authorization = new AuthorizationService(prisma);
  const access = new NotificationsAccessService(prisma, authorization);
  const audit = new AuditService(prisma);
  const templates = new NotificationTemplateService(
    prisma,
    access,
    audit,
    clock,
  );
  const settings = new NotificationSettingsService(prisma, access, audit);
  const notifications = new NotificationService(
    prisma,
    access,
    templates,
    settings,
    clock,
  );
  return { authorization, access, audit, templates, settings, notifications };
}

abstract class Producer {
  outcome = emptyOutcome();
  protected readonly notifications: NotificationService;

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly clock: { now(): Date } = new NotificationsClock(),
  ) {
    this.notifications = notificationServices(prisma, {
      now: () => clock.now(),
    }).notifications;
  }

  protected async publish(input: PublishInput) {
    this.outcome.considered += 1;
    try {
      const result = await this.notifications.publish(input);
      if (result.outcome === 'CREATED') this.outcome.created += 1;
      else if (result.outcome === 'EXISTING') this.outcome.existing += 1;
      else this.outcome.skipped += 1;
    } catch (error) {
      this.outcome.failed.push({
        message: `${input.type} for ${input.recipientUserId}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** Phase 18: the organizations where a module is disabled (reported as skipped). */
  protected async disabledFor(module: FeatureModule) {
    const disabled = [
      ...(await new FeatureGateService(this.prisma).disabledOrganizations(
        module,
      )),
    ].sort();
    this.outcome.skippedOrganizations = disabled;
    return disabled;
  }

  protected skip() {
    this.outcome.considered += 1;
    this.outcome.skipped += 1;
  }

  /** Fails the run (so the job retries; publishing is idempotent) when any publish failed. */
  protected finish() {
    if (this.outcome.failed.length > 0) {
      throw new Error(
        `${this.outcome.failed.length} notification(s) failed: ${this.outcome.failed
          .map((failure) => failure.message)
          .join('; ')}`.slice(0, 1000),
      );
    }
    return this.outcome;
  }

  private readonly timezones = new Map<string, string | null>();

  protected async timezoneOf(organizationId: string) {
    if (!this.timezones.has(organizationId)) {
      const row = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      });
      this.timezones.set(organizationId, row?.timezone ?? null);
    }
    return this.timezones.get(organizationId) ?? null;
  }

  protected async userOfEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        archivedAt: true,
        person: { select: { user: { select: { id: true } } } },
      },
    });
    return employee && !employee.archivedAt
      ? (employee.person.user?.id ?? null)
      : null;
  }
}

// ─── Onboarding / offboarding ────────────────────────────────────────────────

/**
 * Registered WorkflowReminderSink: one 'onboarding.tasks-due' digest per task owner,
 * organization and local day, listing counts and the titles of the tasks the owner owns
 * (re-read: still theirs, still open), linking to /onboarding where owners work their tasks.
 */
export class OnboardingTaskReminderNotifier
  extends Producer
  implements WorkflowReminderSink
{
  async deliver(digests: readonly TaskReminderDigest[]) {
    this.outcome = emptyOutcome();
    const now = this.clock.now();
    for (const digest of digests) {
      const entries = [...digest.overdue, ...digest.dueSoon];
      const tasks = await this.prisma.employeeWorkflowTask.findMany({
        where: {
          id: { in: entries.map((task) => task.taskId) },
          ownerUserId: digest.ownerUserId,
          status: { in: OPEN_TASK },
          workflow: { status: 'ACTIVE' },
        },
        select: {
          id: true,
          organizationId: true,
          workflow: {
            select: { organization: { select: { timezone: true } } },
          },
        },
      });
      const byOrganization = new Map<
        string,
        { timezone: string | null; ids: Set<string> }
      >();
      for (const task of tasks) {
        const group = byOrganization.get(task.organizationId) ?? {
          timezone: task.workflow.organization.timezone,
          ids: new Set<string>(),
        };
        group.ids.add(task.id);
        byOrganization.set(task.organizationId, group);
      }
      for (const [organizationId, group] of byOrganization) {
        const overdue = digest.overdue.filter((t) => group.ids.has(t.taskId));
        const dueSoon = digest.dueSoon.filter((t) => group.ids.has(t.taskId));
        await this.publish({
          organizationId,
          recipientUserId: digest.ownerUserId,
          type: 'onboarding.tasks-due',
          variables: {
            overdueCount: overdue.length,
            dueSoonCount: dueSoon.length,
            taskTitles: listTitles(
              [...overdue, ...dueSoon].map((t) => t.title),
            ),
          },
          link: '/onboarding',
          dedupeKey: `onboarding.tasks-due:${localDay(now, group.timezone)}`,
        });
      }
    }
    this.finish();
  }
}

// ─── Documents ───────────────────────────────────────────────────────────────

/**
 * Registered DocumentReminderSink:
 * - 'documents.renewal-due' to the employee for their own EMPLOYEE_VISIBLE documents that
 *   expired or expire soon (counts only; link /documents);
 * - 'documents.expiry-digest' (counts only) to users holding document.manage at organization
 *   scope, counting only documents within their read clearance and never their own records
 *   (link /admin/documents);
 * - 'documents.required-missing' (HR_REQUIRED, mandatory; count only) to employees missing
 *   required documents of an organization (link /documents).
 */
export class DocumentReminderNotifier
  extends Producer
  implements DocumentReminderSink
{
  private readonly documentAccess: DocumentsAccessService;
  private readonly documents: EmployeeDocumentService;
  private readonly access: NotificationsAccessService;

  constructor(
    prisma: PrismaService,
    clock: { now(): Date } = new DocumentsClock(),
  ) {
    super(prisma, clock);
    const authorization = new AuthorizationService(prisma);
    this.documentAccess = new DocumentsAccessService(prisma, authorization);
    this.access = new NotificationsAccessService(prisma, authorization);
    const documentsClock = Object.assign(new DocumentsClock(), {
      now: () => clock.now(),
    });
    const audit = new DocumentsAuditAdapter(new AuditService(prisma));
    this.documents = new EmployeeDocumentService(
      prisma,
      this.documentAccess,
      audit,
      documentsClock,
      new DocumentTypeService(
        prisma,
        this.documentAccess,
        audit,
        documentsClock,
      ),
      new RecruitmentAccessService(prisma, authorization),
    );
  }

  async deliver(digests: readonly DocumentExpiryDigest[]) {
    this.outcome = emptyOutcome();
    for (const digest of digests) await this.expiry(digest);
    await this.missingRequired();
    this.finish();
  }

  private async expiry(digest: DocumentExpiryDigest) {
    const entries = [
      ...digest.expired.map((row) => ({ ...row, state: 'EXPIRED' })),
      ...digest.expiringSoon.map((row) => ({ ...row, state: 'EXPIRING_SOON' })),
    ];
    const rows = await this.prisma.employeeDocument.findMany({
      where: {
        id: { in: entries.map((entry) => entry.documentId) },
        organizationId: digest.organizationId,
        status: 'ACTIVE',
      },
      select: { id: true, employeeId: true, confidentiality: true },
    });
    const level = new Map(rows.map((row) => [row.id, row.confidentiality]));
    const live = entries.filter((entry) => level.has(entry.documentId));
    const key = (entry: (typeof live)[number]) =>
      `${entry.documentId}:${entry.state}:${entry.expiresOn}`;

    // The employee: their own employee-visible documents only.
    const byEmployee = new Map<string, typeof live>();
    for (const entry of live) {
      if (level.get(entry.documentId) !== 'EMPLOYEE_VISIBLE') continue;
      byEmployee.set(entry.employeeId, [
        ...(byEmployee.get(entry.employeeId) ?? []),
        entry,
      ]);
    }
    for (const [employeeId, own] of byEmployee) {
      const userId = await this.userOfEmployee(employeeId);
      if (!userId) {
        this.skip();
        continue;
      }
      const access = await this.documentAccess.employeeAccess(
        userId,
        employeeId,
        digest.organizationId,
      );
      if (
        !this.documentAccess.canReadLevel(access, 'EMPLOYEE_VISIBLE') ||
        !access.isSelf
      ) {
        this.skip();
        continue;
      }
      await this.publish({
        organizationId: digest.organizationId,
        recipientUserId: userId,
        type: 'documents.renewal-due',
        variables: {
          expiredCount: own.filter((e) => e.state === 'EXPIRED').length,
          expiringSoonCount: own.filter((e) => e.state === 'EXPIRING_SOON')
            .length,
        },
        link: '/documents',
        sourceEntityType: 'Employee',
        sourceEntityId: employeeId,
        dedupeKey: `documents.renewal-due:${setHash(own.map(key))}`,
      });
    }

    // HR: document.manage at organization scope, counts within clearance, never own records.
    const managers = await this.access.usersWithOrganizationPermission(
      'document.manage',
      digest.organizationId,
    );
    for (const { userId, grants } of managers) {
      const { clearance } = this.documentAccess.clearanceOver(grants, [
        { type: 'ORGANIZATION', organizationId: digest.organizationId },
      ]);
      const self = await this.documentAccess.employeeIdOfUser(userId);
      const counted = live.filter(
        (entry) =>
          entry.employeeId !== self &&
          levelWithin(level.get(entry.documentId)!, clearance),
      );
      if (counted.length === 0) continue;
      await this.publish({
        organizationId: digest.organizationId,
        recipientUserId: userId,
        type: 'documents.expiry-digest',
        variables: {
          expiredCount: counted.filter((e) => e.state === 'EXPIRED').length,
          expiringSoonCount: counted.filter((e) => e.state === 'EXPIRING_SOON')
            .length,
        },
        link: '/admin/documents',
        dedupeKey: `documents.expiry-digest:${setHash(counted.map(key))}`,
      });
    }
  }

  private async missingRequired() {
    // Phase 18: organizations with Documents disabled are skipped (like the expiry digests).
    const disabled = await new FeatureGateService(
      this.prisma,
    ).disabledOrganizations('DOCUMENTS');
    const organizations = await this.prisma.organization.findMany({
      where: {
        archivedAt: null,
        id: { notIn: [...disabled] },
        documentRequirements: { some: { archivedAt: null } },
      },
      select: { id: true, timezone: true },
    });
    for (const organization of organizations) {
      const today = documentsToday(this.clock.now(), organization.timezone);
      const employees = await this.prisma.employmentAssignment.findMany({
        where: {
          status: { in: ['ACTIVE', 'PLANNED'] },
          position: { organizationId: organization.id },
        },
        select: { employeeId: true },
        distinct: ['employeeId'],
      });
      for (const { employeeId } of employees) {
        const missing = (
          await this.documents.requirementStatus(
            this.prisma,
            organization.id,
            employeeId,
            today,
          )
        ).filter((row) => row.status !== 'SATISFIED');
        if (missing.length === 0) continue;
        const userId = await this.userOfEmployee(employeeId);
        if (!userId) {
          this.skip();
          continue;
        }
        await this.publish({
          organizationId: organization.id,
          recipientUserId: userId,
          type: 'documents.required-missing',
          variables: { missingCount: missing.length },
          link: '/documents',
          sourceEntityType: 'Employee',
          sourceEntityId: employeeId,
          dedupeKey: `documents.required-missing:${setHash(
            missing.map((row) => `${row.typeId}:${row.status}`),
          )}`,
        });
      }
    }
  }
}

// ─── Performance ─────────────────────────────────────────────────────────────

export const PERFORMANCE_DUE_SOON_DAYS = 3;

/**
 * Performance review reminders over open cycles, from the cycle due dates:
 * - 'performance.self-review-due' to the employee whose self part is unsubmitted and due
 *   within PERFORMANCE_DUE_SOON_DAYS or overdue (link /performance/reviews/:id);
 * - 'performance.reviews-due' (counts only) to each current reviewer with reviewer parts due
 *   or overdue (link /performance).
 * Each recipient is re-checked through PerformanceAccessService.reviewAccess (the employee
 * themselves; the review's current reviewer).
 */
export class PerformanceReminderProducer extends Producer {
  private readonly performanceAccess: PerformanceAccessService;

  constructor(prisma: PrismaService, clock?: { now(): Date }) {
    super(prisma, clock);
    this.performanceAccess = new PerformanceAccessService(
      prisma,
      new AuthorizationService(prisma),
    );
  }

  async run() {
    this.outcome = emptyOutcome();
    const now = this.clock.now();
    const disabled = await this.disabledFor('PERFORMANCE');
    const reviews = await this.prisma.performanceReview.findMany({
      where: {
        status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
        cycle: { status: 'OPEN' },
        organizationId: { notIn: disabled },
      },
      include: {
        cycle: {
          select: {
            selfReviewEnabled: true,
            selfReviewDueDate: true,
            reviewerDueDate: true,
            organization: { select: { timezone: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    const reviewerDigests = new Map<
      string,
      {
        organizationId: string;
        reviewerEmployeeId: string;
        entries: Array<{ reviewId: string; state: 'OVERDUE' | 'DUE_SOON' }>;
        sample: (typeof reviews)[number];
      }
    >();
    for (const review of reviews) {
      const today = performanceToday(now, review.cycle.organization.timezone);
      const state = (due: Date | null) =>
        !due
          ? null
          : due < today
            ? ('OVERDUE' as const)
            : due <= addDays(today, PERFORMANCE_DUE_SOON_DAYS)
              ? ('DUE_SOON' as const)
              : null;
      const selfState =
        review.cycle.selfReviewEnabled &&
        (review.selfStatus === 'NOT_STARTED' ||
          review.selfStatus === 'IN_PROGRESS')
          ? state(review.cycle.selfReviewDueDate)
          : null;
      if (selfState) {
        const userId = await this.userOfEmployee(review.employeeId);
        const access = userId
          ? await this.performanceAccess.reviewAccess(userId, review)
          : null;
        if (!userId || !access?.isSelf) this.skip();
        else
          await this.publish({
            organizationId: review.organizationId,
            recipientUserId: userId,
            type: 'performance.self-review-due',
            variables: {
              dueState: selfState === 'OVERDUE' ? 'overdue' : 'due soon',
              dueDate: formatDate(review.cycle.selfReviewDueDate!),
            },
            link: `/performance/reviews/${review.id}`,
            sourceEntityType: 'PerformanceReview',
            sourceEntityId: review.id,
            dedupeKey: `performance.self-review-due:${review.id}:${selfState}:${formatDate(review.cycle.selfReviewDueDate!)}`,
          });
      }
      const reviewerState =
        review.reviewerEmployeeId &&
        (review.reviewerStatus === 'NOT_STARTED' ||
          review.reviewerStatus === 'IN_PROGRESS')
          ? state(review.cycle.reviewerDueDate)
          : null;
      if (reviewerState) {
        const digestKey = `${review.organizationId}:${review.reviewerEmployeeId}`;
        const digest = reviewerDigests.get(digestKey) ?? {
          organizationId: review.organizationId,
          reviewerEmployeeId: review.reviewerEmployeeId!,
          entries: [],
          sample: review,
        };
        digest.entries.push({ reviewId: review.id, state: reviewerState });
        reviewerDigests.set(digestKey, digest);
      }
    }
    for (const digest of reviewerDigests.values()) {
      const userId = await this.userOfEmployee(digest.reviewerEmployeeId);
      if (!userId) {
        this.skip();
        continue;
      }
      const allowed = [];
      for (const entry of digest.entries) {
        const review = reviews.find((row) => row.id === entry.reviewId)!;
        const access = await this.performanceAccess.reviewAccess(
          userId,
          review,
        );
        if (access.isReviewer && !access.isSelf) allowed.push(entry);
      }
      if (allowed.length === 0) {
        this.skip();
        continue;
      }
      await this.publish({
        organizationId: digest.organizationId,
        recipientUserId: userId,
        type: 'performance.reviews-due',
        variables: {
          overdueCount: allowed.filter((e) => e.state === 'OVERDUE').length,
          dueSoonCount: allowed.filter((e) => e.state === 'DUE_SOON').length,
        },
        link: '/performance',
        dedupeKey: `performance.reviews-due:${setHash(allowed.map((e) => `${e.reviewId}:${e.state}`))}`,
      });
    }
    return this.finish();
  }
}

// ─── Recruitment ─────────────────────────────────────────────────────────────

export const INTERVIEW_REMINDER_HOURS = 24;
export const FEEDBACK_OVERDUE_LOOKBACK_DAYS = 30;
export const OFFER_EXPIRING_DAYS = 3;

/**
 * Recruitment reminders (never candidate names, contact details, compensation, screening or
 * feedback content):
 * - 'recruitment.interview-upcoming' to each active interviewer of an interview starting in
 *   the next 24 hours (once per scheduled start; link /interviews);
 * - 'recruitment.feedback-overdue' to each active interviewer without submitted feedback once
 *   the feedback due time has passed (once per interview; link /interviews);
 * - 'recruitment.offer-expiring' to the users who created or approved a sent offer expiring
 *   within OFFER_EXPIRING_DAYS, only while they still read the application in full
 *   (link /recruitment/applications/:id).
 * Recipients are re-checked through RecruitmentAccessService.applicationAccess; nobody is
 * reminded about their own candidacy.
 */
export class RecruitmentReminderProducer extends Producer {
  private readonly recruitmentAccess: RecruitmentAccessService;

  constructor(prisma: PrismaService, clock?: { now(): Date }) {
    super(prisma, clock);
    this.recruitmentAccess = new RecruitmentAccessService(
      prisma,
      new AuthorizationService(prisma),
    );
  }

  async run() {
    this.outcome = emptyOutcome();
    const now = this.clock.now();
    const disabled = await this.disabledFor('RECRUITMENT');
    await this.upcomingInterviews(now, disabled);
    await this.overdueFeedback(now, disabled);
    await this.expiringOffers(now, disabled);
    return this.finish();
  }

  private async interviewerMayOpen(
    userId: string,
    applicationId: string,
    interviewId: string,
  ) {
    const access = await this.recruitmentAccess.applicationAccess(
      userId,
      applicationId,
    );
    return !access.isSelf && access.interviewerOn.includes(interviewId);
  }

  private async upcomingInterviews(now: Date, disabled: string[]) {
    const interviews = await this.prisma.recruitmentInterview.findMany({
      where: {
        organizationId: { notIn: disabled },
        status: 'SCHEDULED',
        scheduledStart: {
          gte: now,
          lt: new Date(now.getTime() + INTERVIEW_REMINDER_HOURS * 3_600_000),
        },
      },
      include: {
        interviewers: { where: { removedAt: null } },
      },
      orderBy: { scheduledStart: 'asc' },
    });
    for (const interview of interviews) {
      for (const { userId } of interview.interviewers) {
        if (
          !(await this.interviewerMayOpen(
            userId,
            interview.applicationId,
            interview.id,
          ))
        ) {
          this.skip();
          continue;
        }
        await this.publish({
          organizationId: interview.organizationId,
          recipientUserId: userId,
          type: 'recruitment.interview-upcoming',
          variables: {
            startsAt: formatInstant(
              interview.scheduledStart,
              await this.timezoneOf(interview.organizationId),
            ),
            durationMinutes: interview.durationMinutes,
          },
          link: '/interviews',
          sourceEntityType: 'RecruitmentInterview',
          sourceEntityId: interview.id,
          dedupeKey: `recruitment.interview-upcoming:${interview.id}:${interview.scheduledStart.getTime()}`,
        });
      }
    }
  }

  private async overdueFeedback(now: Date, disabled: string[]) {
    const interviews = await this.prisma.recruitmentInterview.findMany({
      where: {
        organizationId: { notIn: disabled },
        status: { in: ['SCHEDULED', 'COMPLETED'] },
        feedbackDueAt: {
          lt: now,
          gte: addDays(now, -FEEDBACK_OVERDUE_LOOKBACK_DAYS),
        },
      },
      include: {
        interviewers: { where: { removedAt: null } },
        feedback: {
          where: { supersededAt: null, status: 'SUBMITTED' },
          select: { interviewerUserId: true },
        },
      },
    });
    for (const interview of interviews) {
      for (const { userId } of interview.interviewers) {
        if (interview.feedback.some((f) => f.interviewerUserId === userId))
          continue;
        if (
          !(await this.interviewerMayOpen(
            userId,
            interview.applicationId,
            interview.id,
          ))
        ) {
          this.skip();
          continue;
        }
        await this.publish({
          organizationId: interview.organizationId,
          recipientUserId: userId,
          type: 'recruitment.feedback-overdue',
          variables: {
            dueAt: formatInstant(
              interview.feedbackDueAt!,
              await this.timezoneOf(interview.organizationId),
            ),
          },
          link: '/interviews',
          sourceEntityType: 'RecruitmentInterview',
          sourceEntityId: interview.id,
          dedupeKey: `recruitment.feedback-overdue:${interview.id}`,
        });
      }
    }
  }

  private async expiringOffers(now: Date, disabled: string[]) {
    const offers = await this.prisma.recruitmentOffer.findMany({
      where: {
        organizationId: { notIn: disabled },
        status: 'SENT',
        expiresOn: {
          not: null,
          gte: addDays(now, -1),
          lte: addDays(now, OFFER_EXPIRING_DAYS + 1),
        },
      },
      include: {},
    });
    for (const offer of offers) {
      const today = recruitmentToday(
        now,
        await this.timezoneOf(offer.organizationId),
      );
      if (
        offer.expiresOn! < today ||
        offer.expiresOn! > addDays(today, OFFER_EXPIRING_DAYS)
      )
        continue;
      const recipients = [
        ...new Set(
          [offer.createdByUserId, offer.approvedByUserId].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ];
      for (const userId of recipients) {
        const access = await this.recruitmentAccess.applicationAccess(
          userId,
          offer.applicationId,
        );
        if (access.isSelf || access.view !== 'FULL') {
          this.skip();
          continue;
        }
        await this.publish({
          organizationId: offer.organizationId,
          recipientUserId: userId,
          type: 'recruitment.offer-expiring',
          variables: { expiresOn: formatDate(offer.expiresOn!) },
          link: `/recruitment/applications/${offer.applicationId}`,
          sourceEntityType: 'RecruitmentOffer',
          sourceEntityId: offer.id,
          dedupeKey: `recruitment.offer-expiring:${offer.id}:${formatDate(offer.expiresOn!)}`,
        });
      }
    }
  }
}
