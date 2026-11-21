import { BadRequestException } from '@nestjs/common';
import { domainError } from '../common/domain-support.js';

/**
 * Phase 19 — audit viewer rules (pure). The viewer shows audit METADATA only: who did what to
 * which entity and when. It never returns arbitrary metadata: each value must be under a
 * whitelisted key AND look like an identifier, an enum code, a field name, a date, a number or
 * a boolean, so a free-text value that slipped into an audit row under a whitelisted key is
 * still never shown.
 */

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;
/** Default window when no `from` is given. */
export const AUDIT_DEFAULT_RANGE_DAYS = 30;
/** The widest window one query may scan. */
export const AUDIT_MAX_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;

/** Identifier, enum, count and flag keys that audit writers use (see docs/security). */
export const AUDIT_METADATA_KEYS: ReadonlySet<string> = new Set([
  // Identifiers
  'organizationId',
  'employeeId',
  'employmentAssignmentId',
  'assignmentId',
  'previousAssignmentId',
  'candidateId',
  'mergedCandidateId',
  'applicationId',
  'openingId',
  'offerId',
  'interviewId',
  'interviewerUserId',
  'hireId',
  'fromStageId',
  'toStageId',
  'reviewId',
  'cycleId',
  'goalId',
  'evidenceId',
  'previousRevisionId',
  'sourceId',
  'templateId',
  'workflowId',
  'taskId',
  'documentId',
  'typeId',
  'policyId',
  'policyVersionId',
  'versionId',
  'requirementId',
  'planId',
  'optionId',
  'previousEnrollmentId',
  'previousOptionId',
  'dependentId',
  'supersededRateId',
  'closedRateId',
  'payGroupId',
  'payrollRunAssignmentId',
  'payrollPeriodId',
  'timePeriodId',
  'calendarId',
  'runId',
  'sourceRunId',
  'removedFromRunId',
  'lineId',
  'reversalLineId',
  'scheduleId',
  'shiftId',
  'revisionId',
  'overrideId',
  'conflictingShiftId',
  'patternId',
  'ruleId',
  'leaveTypeId',
  'accountId',
  'reversedEntryId',
  'amendmentId',
  'timesheetId',
  'timeEntryId',
  'breakEntryId',
  'correctionRequestId',
  'correctedSignInId',
  'attendanceSignInId',
  'scheduledShiftId',
  'roleId',
  'userId',
  'bindingId',
  'workLocationId',
  'linkId',
  'compensationRecordId',
  'previousRecordId',
  'correctedRecordId',
  'replacementRecordId',
  'fromEmployeeId',
  'toEmployeeId',
  'fromEmploymentAssignmentId',
  'toEmploymentAssignmentId',
  // Enum / state codes
  'status',
  'previousStatus',
  'wasStatus',
  'from',
  'to',
  'kind',
  'type',
  'category',
  'module',
  'key',
  'enabled',
  'provider',
  'channel',
  'mode',
  'outcome',
  'confidentiality',
  'benefitType',
  'coverageLevel',
  'reviewerModel',
  'cadence',
  'format',
  'reportKey',
  'target',
  'source',
  'electionType',
  'closeReason',
  'entryType',
  'reversedEntryType',
  'conflictType',
  'selfStatus',
  // Counts, versions and flags
  'version',
  'versionNumber',
  'revision',
  'revisionNumber',
  'count',
  'added',
  'skipped',
  'received',
  'rowCount',
  'tasks',
  'tasksCancelled',
  'ownersMovedToHrPool',
  'levels',
  'sections',
  'items',
  'reviews',
  'withoutReviewer',
  'closedIncomplete',
  'applications',
  'answered',
  'linkedGoals',
  'interviewers',
  'offersWithdrawn',
  'interviewsCancelled',
  'revokedAssignmentCount',
  'revokedSessionCount',
  // Batch 2: account security (codes and flags only; never the free-text `reason`).
  'reasonCode',
  // Security remediation M1: refused login-access actions (codes, flags and ids only).
  'refusedAction',
  'refusalReason',
  'actionClass',
  'highRisk',
  'riskCategory',
  'attemptId',
  'signedOut',
  'attempt',
  'sessionsDeleted',
  'tokensDeleted',
  'electionsEnded',
  'electionsRescinded',
  'adjustmentsApplied',
  'withNote',
  'withReason',
  'withComment',
  'bySelf',
  'asHr',
  'retroactive',
  'created',
  'createdEmployee',
  'internalCandidate',
  'revoked',
  'hadCredential',
  'suppressed',
  'autoApprove',
  'levelsReplaced',
  'contentReplaced',
  'subjectChanged',
  'bodyChanged',
  'overallRatingCorrected',
  'reacknowledgementRequested',
  'approvalWithdrawn',
  'periodFinalized',
  'publicLoginEnabled',
  // Field-name lists (names only, never values)
  'fields',
  'changed',
  'changedFields',
  'filledFields',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** camelCase field names and dotted setting keys, e.g. `documents.selfServiceProvide`. */
const FIELD_NAME = /^[a-z][a-zA-Z0-9]{0,63}(\.[a-z][a-zA-Z0-9]{0,63}){0,3}$/;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const MAX_LIST = 50;

function safeScalar(value: unknown): value is string | number | boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return (
    UUID.test(value) ||
    ENUM_CODE.test(value) ||
    FIELD_NAME.test(value) ||
    ISO_DATE.test(value)
  );
}

/** The whitelisted, value-checked subset of one audit row's metadata. */
export function projectAuditMetadata(
  metadata: unknown,
): Record<
  string,
  string | number | boolean | Array<string | number | boolean>
> {
  const result: Record<
    string,
    string | number | boolean | Array<string | number | boolean>
  > = {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return result;
  for (const [key, value] of Object.entries(
    metadata as Record<string, unknown>,
  )) {
    if (!AUDIT_METADATA_KEYS.has(key)) continue;
    if (safeScalar(value)) result[key] = value;
    else if (
      Array.isArray(value) &&
      value.length <= MAX_LIST &&
      value.every(safeScalar)
    )
      result[key] = value;
  }
  return result;
}

export interface AuditCursor {
  occurredAt: Date;
  id: string;
}

const invalidQuery = (code: string, message: string) =>
  new BadRequestException(domainError(400, code, message));

/** Opaque keyset cursor over (occurredAt DESC, id DESC). */
export function encodeAuditCursor(cursor: AuditCursor) {
  return Buffer.from(
    `${cursor.occurredAt.toISOString()}|${cursor.id}`,
    'utf8',
  ).toString('base64url');
}

export function decodeAuditCursor(value: string): AuditCursor {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const [at, id, extra] = decoded.split('|');
  const occurredAt = at ? new Date(at) : new Date(Number.NaN);
  if (
    extra !== undefined ||
    !id ||
    !UUID.test(id) ||
    Number.isNaN(occurredAt.getTime())
  )
    throw invalidQuery('AUDIT_CURSOR_INVALID', 'The cursor is invalid.');
  return { occurredAt, id };
}

/** [from, to) with the defaults and the maximum window applied. */
export function resolveAuditRange(
  input: { from?: string; to?: string },
  now: Date,
) {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - AUDIT_DEFAULT_RANGE_DAYS * DAY_MS);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime()))
    throw invalidQuery('AUDIT_RANGE_INVALID', 'from and to must be dates.');
  if (from.getTime() >= to.getTime())
    throw invalidQuery('AUDIT_RANGE_INVALID', 'from must be before to.');
  if (to.getTime() - from.getTime() > AUDIT_MAX_RANGE_DAYS * DAY_MS)
    throw invalidQuery(
      'AUDIT_RANGE_TOO_WIDE',
      `A query covers at most ${AUDIT_MAX_RANGE_DAYS} days.`,
    );
  return { from, to };
}

export function auditLimit(limit: number | undefined) {
  return Math.min(
    Math.max(Math.trunc(limit ?? AUDIT_DEFAULT_LIMIT), 1),
    AUDIT_MAX_LIMIT,
  );
}
