import {
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import {
  featureDisabled,
  settingDisabled,
  type FeatureModule,
  type SettingKey,
} from '../../features/features-domain.js';
import { advisoryLock, domainError } from '../../common/domain-support.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  GoogleFormBinding,
  GoogleSyncRun,
  GoogleSyncTrigger,
} from '../../generated/prisma/client.js';
import {
  PERFORMANCE_EVIDENCE_INGESTION,
  type PerformanceEvidenceIngestion,
} from '../../performance/performance-evidence.contract.js';
import {
  RECRUITMENT_APPLICATION_INGESTION,
  type RecruitmentApplicationIngestion,
} from '../../recruitment/recruitment-intake.contract.js';
import {
  WORKFLOW_TASK_COMPLETION_INGESTION,
  type WorkflowTaskCompletionIngestion,
} from '../../onboarding/onboarding-task.contract.js';
import { GoogleApiError } from './google-api.client.js';
import { CredentialCipherError } from './google-credential-cipher.js';
import {
  bindingCursor,
  GoogleFormsReader,
  GoogleIntegrationError,
} from './google-forms.adapters.js';
import { GoogleWorkspaceAccessService } from './google-workspace-access.service.js';
import type { GoogleClient } from './google-workspace-common.js';
import {
  conflict,
  GoogleWorkspaceClock,
  tooManyRequests,
  writeGoogleAudit,
  type GoogleRequestContext,
} from './google-workspace-common.js';
import {
  formIdHash,
  MANUAL_SYNC_MIN_INTERVAL_MS,
  MappingError,
  nextSyncAfter,
  SYNC_LEASE_MS,
  toApplicationSubmission,
  toAssessmentResult,
  toTaskSubmission,
  IDENTITY_TARGETS,
  IDENTITY_UNVERIFIED,
  validateFieldMapping,
  type FormFieldMapping,
  type GoogleFormInfo,
  type GoogleFormResponse,
  type ResponseCursor,
} from './google-workspace-domain.js';

const CHUNK = 100;

interface Counts {
  fetched: number;
  accepted: number;
  duplicates: number;
  rejected: number;
}

export type SyncBindingResult =
  | { status: 'SKIPPED'; bindingId: string; reason: string }
  | {
      status: GoogleSyncRun['status'];
      bindingId: string;
      runId: string;
      fetched: number;
      accepted: number;
      duplicates: number;
      rejected: number;
      errorCode: string | null;
      /** Batch 7B (D1): the form does not verify respondent emails (results held for HR). */
      warningCode?: string | null;
    };

export interface SyncDueOutcome {
  bindings: number;
  succeeded: number;
  failed: Array<{ bindingId: string; code: string | null }>;
  skipped: number;
  /** Phase 18: organizations skipped because Google Workspace is disabled for them. */
  skippedOrganizations: string[];
  /** Internal errors (not Google or domain failures, which are recorded on runs). */
  errors: Array<{ bindingId: string; message: string }>;
}

/** Phase 18: the domain module and the google.sync.* setting each binding target needs. */
const TARGET_GATES: Record<
  GoogleFormBinding['target'],
  { module: FeatureModule; setting: SettingKey; domainSetting?: SettingKey }
> = {
  PERFORMANCE_EVIDENCE: {
    module: 'PERFORMANCE',
    setting: 'google.sync.performanceEvidence',
  },
  RECRUITMENT_INTAKE: {
    module: 'RECRUITMENT',
    setting: 'google.sync.recruitmentIntake',
    domainSetting: 'recruitment.externalIntake',
  },
  ONBOARDING_TASKS: {
    module: 'ONBOARDING',
    setting: 'google.sync.onboardingTasks',
  },
};

/** A safe error code for a run (never a message or payload). */
export function syncErrorCode(error: unknown): string {
  if (
    error instanceof GoogleApiError ||
    error instanceof GoogleIntegrationError ||
    error instanceof CredentialCipherError ||
    error instanceof MappingError
  )
    return error.code;
  if (error instanceof HttpException) {
    const body = error.getResponse() as { code?: unknown };
    return typeof body?.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code)
      ? body.code
      : 'DOMAIN_INGESTION_FAILED';
  }
  return 'SYNC_INTERNAL_ERROR';
}

/**
 * Phase 16.5 — synchronizes bound Google Forms into the domains through their own contracts
 * (performance evidence ingestion, recruitment application ingestion, onboarding task
 * completion). Never writes a domain table.
 *
 * - One run at a time per binding: an advisory lock plus a partial unique index on RUNNING
 *   runs; a crashed run is reclaimed after its lease.
 * - The cursor (last response submission time + id) advances only after the domain call for a
 *   chunk succeeded, and only forwards; re-delivered responses are the contracts' no-ops.
 * - Failures back off exponentially (consecutiveFailures); refused credentials mark the
 *   connection ERROR, which stops scheduled syncs until an admin fixes it.
 * - Manual syncs need integration.google.manage and are refused while one runs (409) or when
 *   one started less than a minute ago (429).
 */
@Injectable()
export class GoogleSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GoogleWorkspaceAccessService,
    private readonly audit: AuditService,
    private readonly clock: GoogleWorkspaceClock,
    private readonly reader: GoogleFormsReader,
    @Inject(PERFORMANCE_EVIDENCE_INGESTION)
    private readonly performance: PerformanceEvidenceIngestion,
    @Inject(RECRUITMENT_APPLICATION_INGESTION)
    private readonly recruitment: RecruitmentApplicationIngestion,
    @Inject(WORKFLOW_TASK_COMPLETION_INGESTION)
    private readonly onboarding: WorkflowTaskCompletionIngestion,
  ) {}

  /** A manual sync by an integration admin. */
  async syncManually(bindingId: string, context: GoogleRequestContext) {
    const binding = await this.prisma.googleFormBinding.findUnique({
      where: { id: bindingId },
    });
    const grants = context.actorUserId
      ? await this.access.grants(context.actorUserId)
      : [];
    if (
      !binding ||
      !this.access.can(
        grants,
        'integration.google.read',
        binding.organizationId,
      )
    )
      throw new NotFoundException(
        domainError(404, 'GOOGLE_BINDING_NOT_FOUND', 'Binding not found.'),
      );
    await this.access.require(
      context.actorUserId,
      'integration.google.manage',
      binding.organizationId,
    );
    return this.syncBinding(bindingId, 'MANUAL', context);
  }

  async syncBinding(
    bindingId: string,
    trigger: GoogleSyncTrigger,
    context: GoogleRequestContext = {},
  ): Promise<SyncBindingResult> {
    const claim = await this.claim(bindingId, trigger, context);
    if ('skipped' in claim)
      return { status: 'SKIPPED', bindingId, reason: claim.skipped };
    return this.execute(claim.binding, claim.run);
  }

  private async claim(
    bindingId: string,
    trigger: GoogleSyncTrigger,
    context: GoogleRequestContext,
  ): Promise<
    { skipped: string } | { binding: GoogleFormBinding; run: GoogleSyncRun }
  > {
    const manual = trigger === 'MANUAL';
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await advisoryLock(tx, `google-sync:${bindingId}`);
      await tx.$executeRawUnsafe(
        `SELECT 1 FROM "GoogleFormBinding" WHERE "id" = $1::uuid FOR NO KEY UPDATE`,
        bindingId,
      );
      const binding = await tx.googleFormBinding.findUnique({
        where: { id: bindingId },
      });
      if (!binding)
        throw new NotFoundException(
          domainError(404, 'GOOGLE_BINDING_NOT_FOUND', 'Binding not found.'),
        );
      if (binding.archivedAt || !binding.enabled) {
        if (manual)
          throw conflict(
            'GOOGLE_BINDING_DISABLED',
            'The binding is disabled or archived.',
          );
        return { skipped: 'DISABLED' };
      }
      // Phase 18: Google Workspace and the target's module enabled, its sync setting on.
      // A scheduled run skips (nothing recorded, no backoff); a manual one is refused.
      const blocked = await this.blocked(binding, tx);
      if (blocked) {
        if (manual)
          throw 'module' in blocked
            ? featureDisabled(blocked.module)
            : settingDisabled(blocked.setting);
        return {
          skipped:
            'module' in blocked ? 'FEATURE_DISABLED' : 'SETTING_DISABLED',
        };
      }
      const connection = await tx.googleWorkspaceConnection.findFirst({
        where: { organizationId: binding.organizationId, status: 'ACTIVE' },
      });
      if (!connection || !connection.capabilities.includes('FORMS')) {
        if (manual)
          throw conflict(
            'GOOGLE_CONNECTION_REQUIRED',
            'The organization has no active Forms connection.',
          );
        return { skipped: 'NOT_CONNECTED' };
      }
      const running = await tx.googleSyncRun.findFirst({
        where: { bindingId, status: 'RUNNING' },
      });
      if (running && running.leaseExpiresAt > now) {
        if (manual)
          throw conflict(
            'GOOGLE_SYNC_IN_PROGRESS',
            'A synchronization is already running.',
          );
        return { skipped: 'RUNNING' };
      }
      if (running)
        await tx.googleSyncRun.update({
          where: { id: running.id },
          data: {
            status: 'FAILED',
            finishedAt: now,
            errorCode: 'LEASE_EXPIRED',
          },
        });
      if (manual) {
        const recent = await tx.googleSyncRun.count({
          where: {
            bindingId,
            startedAt: {
              gt: new Date(now.getTime() - MANUAL_SYNC_MIN_INTERVAL_MS),
            },
          },
        });
        if (recent > 0)
          throw tooManyRequests(
            'GOOGLE_SYNC_TOO_FREQUENT',
            'A synchronization of this form started less than a minute ago.',
          );
      } else if (binding.nextSyncAfter && binding.nextSyncAfter > now) {
        return { skipped: 'BACKOFF' };
      }
      const run = await tx.googleSyncRun.create({
        data: {
          organizationId: binding.organizationId,
          bindingId,
          target: binding.target,
          trigger,
          triggeredByUserId: manual ? context.actorUserId : null,
          status: 'RUNNING',
          startedAt: now,
          leaseExpiresAt: new Date(now.getTime() + SYNC_LEASE_MS),
        },
      });
      if (manual)
        await writeGoogleAudit(this.audit, tx, {
          action: 'GOOGLE_SYNC_REQUESTED',
          entityType: 'GoogleFormBinding',
          entityId: bindingId,
          context,
          metadata: {
            organizationId: binding.organizationId,
            target: binding.target,
            formIdHash: formIdHash(binding.formId),
            runId: run.id,
          },
        });
      return { binding, run };
    });
  }

  /** Feeds one chunk to the binding's domain contract and counts the outcomes. */
  private async ingest(
    binding: GoogleFormBinding,
    mapping: FormFieldMapping,
    form: GoogleFormInfo,
    responses: GoogleFormResponse[],
  ): Promise<Omit<Counts, 'fetched'>> {
    if (binding.target === 'PERFORMANCE_EVIDENCE') {
      const report = await this.performance.ingest(
        binding.performanceSourceId!,
        responses.map((response) =>
          toAssessmentResult(mapping, form, response),
        ),
        'SYNC',
        null,
      );
      const c = report.counts;
      return {
        accepted: c.CREATED + c.CORRECTED + c.WITHDRAWN + c.PENDING_MATCH,
        duplicates: c.UNCHANGED + c.STALE,
        rejected: c.REJECTED,
      };
    }
    if (binding.target === 'RECRUITMENT_INTAKE') {
      const report = await this.recruitment.ingest(
        binding.recruitmentSourceId!,
        responses.map((response) =>
          toApplicationSubmission(mapping, form, response),
        ),
        'SYNC',
        null,
      );
      const c = report.counts;
      return {
        accepted: c.CREATED + c.ATTACHED + c.CORRECTED + c.PENDING_OPENING,
        duplicates: c.UNCHANGED + c.STALE,
        rejected: c.REJECTED,
      };
    }
    const submissions = responses
      .map((response) => toTaskSubmission(form, response))
      .filter((submission) => submission !== null);
    const { outcomes } = await this.onboarding.completeFromSubmissions(
      binding.organizationId,
      'GOOGLE_FORM',
      submissions,
      null,
    );
    const count = (...kinds: string[]) =>
      outcomes.filter((outcome) => kinds.includes(outcome.outcome)).length;
    return {
      accepted: count('COMPLETED'),
      duplicates: count('UNCHANGED'),
      // Responses without a usable email, unmatched respondents and no open task.
      rejected:
        responses.length -
        submissions.length +
        count('NO_MATCHING_EMPLOYEE', 'NO_OPEN_TASK', 'REJECTED'),
    };
  }

  /** Advances the cursor (forward only) and the run counts after a successful chunk. */
  private async advance(
    binding: GoogleFormBinding,
    run: GoogleSyncRun,
    cursor: ResponseCursor,
    counts: Counts,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "GoogleFormBinding" SET "cursorSubmittedAt" = $2, "cursorResponseId" = $3, "updatedAt" = now()
         WHERE "id" = $1::uuid AND "archivedAt" IS NULL
         AND ("cursorSubmittedAt" IS NULL OR ("cursorSubmittedAt", "cursorResponseId") < ($2, $3))`,
        binding.id,
        cursor.submittedAt,
        cursor.responseId,
      );
      await tx.googleSyncRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: counts,
      });
    });
  }

  private async execute(
    binding: GoogleFormBinding,
    run: GoogleSyncRun,
  ): Promise<SyncBindingResult> {
    const counts: Counts = {
      fetched: 0,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
    };
    let progressed = false;
    let errorCode: string | null = null;
    // Batch 7B (D1): a form that does not verify respondent emails still syncs (results without
    // a trusted identity wait for HR or are not applied) but the binding is flagged.
    let warningCode: string | null = null;
    try {
      const mapping = validateFieldMapping(binding.target, binding.mapping);
      const { form, responses } = await this.reader.responsesAfter(
        binding.organizationId,
        binding.formId,
        bindingCursor(binding),
      );
      if (
        IDENTITY_TARGETS.includes(binding.target) &&
        form.emailCollection !== 'VERIFIED'
      )
        warningCode = IDENTITY_UNVERIFIED;
      counts.fetched = responses.length;
      for (let index = 0; index < responses.length; index += CHUNK) {
        const chunk = responses.slice(index, index + CHUNK);
        const result = await this.ingest(
          binding,
          mapping,
          form,
          chunk.map((entry) => entry.response),
        );
        counts.accepted += result.accepted;
        counts.duplicates += result.duplicates;
        counts.rejected += result.rejected;
        await this.advance(binding, run, chunk[chunk.length - 1]!.key, counts);
        progressed = true;
      }
    } catch (error) {
      errorCode = syncErrorCode(error);
    }
    const now = this.clock.now();
    const status = errorCode
      ? progressed
        ? 'PARTIAL'
        : 'FAILED'
      : 'SUCCEEDED';
    await this.prisma.$transaction(async (tx) => {
      await tx.googleSyncRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: { ...counts, status, finishedAt: now, errorCode },
      });
      if (errorCode) {
        const failures = binding.consecutiveFailures + 1;
        await tx.googleFormBinding.updateMany({
          where: { id: binding.id, archivedAt: null },
          data: {
            lastSyncAt: now,
            lastFailureAt: now,
            lastErrorCode: errorCode,
            consecutiveFailures: { increment: 1 },
            nextSyncAfter: nextSyncAfter(failures, now),
          },
        });
      } else {
        await tx.googleFormBinding.updateMany({
          where: { id: binding.id, archivedAt: null },
          data: {
            lastSyncAt: now,
            lastSuccessAt: now,
            lastErrorCode: warningCode,
            consecutiveFailures: 0,
            nextSyncAfter: null,
          },
        });
      }
    });
    return {
      status,
      bindingId: binding.id,
      runId: run.id,
      ...counts,
      errorCode,
      warningCode,
    };
  }

  /** Phase 18: why a binding may not sync now (module disabled or setting off), or null. */
  private async blocked(
    binding: GoogleFormBinding,
    client: GoogleClient,
  ): Promise<{ module: FeatureModule } | { setting: SettingKey } | null> {
    const gate = TARGET_GATES[binding.target];
    const modules = await this.access.features.modules(
      binding.organizationId,
      client,
    );
    if (!modules.GOOGLE_WORKSPACE) return { module: 'GOOGLE_WORKSPACE' };
    if (!modules[gate.module]) return { module: gate.module };
    for (const key of [gate.setting, gate.domainSetting]) {
      if (
        key &&
        (await this.access.features.setting(
          binding.organizationId,
          key,
          client,
        )) !== true
      )
        return { setting: key };
    }
    return null;
  }

  /** The scheduled sweep: every live binding of an organization with an ACTIVE Forms connection. */
  async syncDue(): Promise<SyncDueOutcome> {
    const now = this.clock.now();
    const skippedOrganizations = [
      ...(await this.access.features.disabledOrganizations('GOOGLE_WORKSPACE')),
    ].sort();
    const bindings = await this.prisma.googleFormBinding.findMany({
      where: {
        archivedAt: null,
        organizationId: { notIn: skippedOrganizations },
        enabled: true,
        OR: [{ nextSyncAfter: null }, { nextSyncAfter: { lte: now } }],
        organization: {
          googleConnections: {
            some: { status: 'ACTIVE', capabilities: { has: 'FORMS' } },
          },
        },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const outcome: SyncDueOutcome = {
      bindings: bindings.length,
      succeeded: 0,
      failed: [],
      skipped: 0,
      skippedOrganizations,
      errors: [],
    };
    for (const { id } of bindings) {
      try {
        const result = await this.syncBinding(id, 'SCHEDULED');
        if (result.status === 'SKIPPED') outcome.skipped += 1;
        else if (result.status === 'SUCCEEDED') outcome.succeeded += 1;
        else outcome.failed.push({ bindingId: id, code: result.errorCode });
      } catch (error) {
        outcome.errors.push({
          bindingId: id,
          message: syncErrorCode(error),
        });
      }
    }
    return outcome;
  }
}
