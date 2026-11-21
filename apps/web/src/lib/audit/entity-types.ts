import type { PickerOption } from '../pickers/sources';
import type { RecordSource } from '../pickers/use-record-search';
import { auditApi } from './api';

/**
 * Batch R3.3 — the entity types the API records in the audit log (the `entityType` it writes),
 * for the viewer's entity-type filter. A type not listed here can still be typed in ("Other"),
 * so a new module never becomes unfilterable.
 */
export const AUDIT_ENTITY_TYPES = [
  'AttendanceCredential',
  'AttendanceDevice',
  'AuthSession',
  'BenefitCoverageOption',
  'BenefitDependent',
  'BenefitEligibilityRule',
  'BenefitEnrollment',
  'BenefitPlan',
  'BenefitRate',
  'CompensationRecord',
  'Employee',
  'EmployeeSchedulePattern',
  'EmployeeWorkflow',
  'EmployeeWorkflowTask',
  'EmploymentAssignment',
  'GoogleFormBinding',
  'GoogleWorkspaceConnection',
  'JobOpening',
  'LeaveLedgerEntry',
  'LeaveRequest',
  'NotificationTemplate',
  'Organization',
  'OrganizationBranding',
  'OrganizationHoliday',
  'PayGroup',
  'PayrollAdjustment',
  'PayrollCalendar',
  'PayrollPeriod',
  'PayrollRun',
  'PerformanceCycle',
  'PerformanceEvidenceSource',
  'PerformanceGoal',
  'PerformanceReview',
  'PhysicalSite',
  'RecruitmentApplication',
  'RecruitmentCandidate',
  'RecruitmentCandidateDocument',
  'RecruitmentHire',
  'RecruitmentIntakeSource',
  'RecruitmentIntakeSubmission',
  'RecruitmentInterview',
  'RecruitmentInterviewFeedback',
  'RecruitmentOffer',
  'RecruitmentStage',
  'Schedule',
  'SchedulePolicy',
  'ScheduleTemplate',
  'ScheduledShift',
  'TimeAttendancePolicy',
  'User',
  'WorkflowTemplate',
] as const;

/** "BenefitCoverageOption" → "Benefit coverage option" (the code stays the filter value). */
export function auditEntityTypeLabel(type: string): string {
  const words = type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
  return words
    .map((word, index) => (index === 0 ? word : word.toLowerCase()))
    .join(' ')
    .replace(/\bauth session\b/i, 'Sign-in session');
}

/**
 * The actor filter's options: people who acted in the entries the reader may see, within the
 * window of the current results. Name first; a short id tells same-named people apart.
 */
export function auditActorSource(
  organizationId: string,
  range: { from?: string; to?: string },
): RecordSource<PickerOption> {
  return {
    async search(query, cursor) {
      const page = await auditApi.actors({
        organizationId,
        ...range,
        query,
        afterId: cursor,
        limit: 20,
      });
      return {
        items: page.items.map((actor) => ({
          id: actor.userId,
          label: actor.displayName ?? 'Unnamed user',
          description: `User ${actor.userId.slice(0, 8)}`,
        })),
        next: page.nextAfterId,
      };
    },
  };
}
