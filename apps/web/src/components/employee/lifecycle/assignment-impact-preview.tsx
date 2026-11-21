'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { employeeApi } from '../../../lib/employee/api';
import { formatDateOnly } from '../../../lib/employee/date';
import { employeeLifecycleActionErrorMessage } from '../../../lib/employee/errors';
import type {
  AssignmentImpact,
  BoundedList,
  TerminationBlocker,
} from '../../../lib/employee/types';
import { offboardingStartHref } from '../../../lib/onboarding/offboarding-link';
import { badgeClass } from '../../ui/tokens';
import { buttonClass } from '../../ui/button';
import { ErrorState, LoadingText } from '../../ui/states';

/**
 * Batch 5C — what ending an assignment on a date would leave behind (GET …/impact; read-only).
 *
 * The preview shows only what the API returns. A section the caller may not read comes back as
 * null and is listed as "not shown with your access" — never as empty, and never with a guess at
 * what it might contain. Counts are the API's exact totals; lists are capped (the API's limit)
 * and say so. Conclusions the API withholds (null) are not drawn here either.
 */
export function AssignmentImpactPreview({
  employeeId,
  assignmentId,
  endDate,
  onLoaded,
  showOffboarding = true,
}: {
  employeeId: string;
  assignmentId: string;
  /** The last day being considered (inclusive); empty = not chosen yet. */
  endDate: string;
  onLoaded?(impact: AssignmentImpact | null): void;
  showOffboarding?: boolean;
}) {
  const [state, setState] = useState<{
    key: string;
    impact: AssignmentImpact | null;
    error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${assignmentId}:${endDate}:${attempt}`;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(endDate);

  useEffect(() => {
    if (!valid) return;
    let active = true;
    // A short pause so typing a date does not send a request per keystroke.
    const timer = window.setTimeout(() => {
      employeeApi
        .assignmentImpact(employeeId, assignmentId, endDate)
        .then((impact) => {
          if (!active) return;
          setState({ key, impact, error: null });
          onLoaded?.(impact);
        })
        .catch((cause) => {
          if (!active) return;
          setState({
            key,
            impact: null,
            error: employeeLifecycleActionErrorMessage(cause, 'Unable to load the impact preview.'),
          });
          onLoaded?.(null);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // onLoaded is a notification; re-running for a new callback identity would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, assignmentId, endDate, valid, key]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (!valid) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-600">
        Choose a date to see what this change would affect.
      </p>
    );
  }
  if (!state || state.key !== key) {
    return <LoadingText>Checking what this change would affect…</LoadingText>;
  }
  if (state.error || !state.impact) {
    return (
      <ErrorState
        title="Impact preview unavailable"
        message={state.error ?? 'Unable to load the impact preview.'}
        onRetry={retry}
      />
    );
  }
  return <AssignmentImpactView impact={state.impact} showOffboarding={showOffboarding} />;
}

/** The impact as returned by the API (presentational; used by the preview and in tests). */
export function AssignmentImpactView({
  impact,
  showOffboarding = true,
}: {
  impact: AssignmentImpact;
  showOffboarding?: boolean;
}) {
  const headingId = useId();
  const hidden: string[] = [];
  if (!impact.attendance) hidden.push('attendance');
  if (!impact.scheduling) hidden.push('scheduling');
  if (!impact.leave) hidden.push('leave');
  if (!impact.compensation) hidden.push('compensation');
  if (!impact.payroll) hidden.push('payroll');
  if (!impact.benefits) hidden.push('benefits');
  if (!impact.access) hidden.push('access');
  if (showOffboarding && !impact.offboarding) hidden.push('offboarding');

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-base font-semibold text-slate-950">
          Impact of ending on {formatDateOnly(impact.endDate)}
        </h3>
        <span className="text-xs text-slate-600">Time zone: {impact.timezone}</span>
      </div>
      <p className="text-sm text-slate-600">
        Nothing below is changed automatically. Review each item in its own module.
      </p>

      {impact.blockers.length > 0 && <BlockerList blockers={impact.blockers} />}
      {impact.blocked && impact.blockers.length === 0 && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
          Finalized records block this date. You do not have access to see which ones; ask an
          administrator who manages time or payroll for this assignment.
        </p>
      )}

      <dl className="divide-y divide-slate-100">
        {impact.attendance && (
          <ImpactRow label="Attendance">
            <CountedList
              list={impact.attendance.openTimeEntries}
              noun={['open time entry', 'open time entries']}
              render={(entry) => `${formatDateOnly(entry.workDate)} (still clocked in)`}
            />
          </ImpactRow>
        )}
        {impact.scheduling && (
          <ImpactRow label="Scheduling">
            <CountedList
              list={impact.scheduling.futurePublishedShifts}
              noun={['published shift after the last day', 'published shifts after the last day']}
              render={(shift) => formatDateOnly(shift.workDate)}
            />
          </ImpactRow>
        )}
        {impact.leave && (
          <ImpactRow label="Leave">
            <CountedList
              list={impact.leave.pending}
              noun={['pending leave request', 'pending leave requests']}
              render={(range) => rangeText(range)}
            />
            <CountedList
              list={impact.leave.approvedAfterEnd}
              noun={[
                'approved leave request after the last day',
                'approved leave requests after the last day',
              ]}
              render={(range) => rangeText(range)}
            />
          </ImpactRow>
        )}
        {impact.compensation && (
          <ImpactRow label="Compensation">
            <CountedList
              list={impact.compensation.recordsBeyondEnd}
              noun={[
                'compensation record continuing past the last day',
                'compensation records continuing past the last day',
              ]}
              render={(record) =>
                `From ${formatDateOnly(record.effectiveFrom)}${record.effectiveTo ? ` to ${formatDateOnly(record.effectiveTo)}` : ' (open-ended)'}`
              }
            />
          </ImpactRow>
        )}
        {impact.payroll && (
          <ImpactRow label="Payroll">
            <p className="text-sm text-slate-800">
              {countText(impact.payroll.openPayrollRuns, [
                'open payroll run covering this date or later',
                'open payroll runs covering this date or later',
              ])}
            </p>
          </ImpactRow>
        )}
        {impact.benefits && (
          <ImpactRow label="Benefits">
            <CountedList
              list={impact.benefits.enrollmentsBeyondEnd}
              noun={[
                'benefit enrollment continuing past the last day',
                'benefit enrollments continuing past the last day',
              ]}
              render={(enrollment) =>
                `From ${formatDateOnly(enrollment.coverageStart)}${enrollment.coverageEnd ? ` to ${formatDateOnly(enrollment.coverageEnd)}` : ' (no end date)'}`
              }
            />
          </ImpactRow>
        )}
        <ImpactRow label="Managers">
          <p className="text-sm text-slate-800">
            {impact.managerRelationships.visibleDirectReportCount === 0
              ? 'No direct reports you can see report to this assignment.'
              : `${countText(impact.managerRelationships.visibleDirectReportCount, [
                  'direct report you can see reports',
                  'direct reports you can see report',
                ])} to this assignment. The links stay in place; reassign them in each employee's profile.`}
          </p>
          {impact.managerRelationships.truncated && (
            <p className="text-xs text-slate-600">
              Listing the first {impact.managerRelationships.limit}.
            </p>
          )}
        </ImpactRow>
        <ImpactRow label="Employment">
          <EmploymentSummary impact={impact} />
        </ImpactRow>
        {impact.access && (
          <ImpactRow label="Access">
            <p className="text-sm text-slate-800">
              Ending an assignment never changes sign-in access or roles.
              {impact.access.loginStatus
                ? ` Login: ${impact.access.loginStatus.toLowerCase()}; ${countText(
                    impact.access.grantsInOrganization,
                    ['role grant', 'role grants'],
                  )} in this organization stay in place.`
                : ' The employee has no login.'}
            </p>
          </ImpactRow>
        )}
        {showOffboarding && impact.offboarding && (
          <ImpactRow label="Offboarding">
            <OffboardingRow
              offboarding={impact.offboarding}
              organizationId={impact.organizationId}
            />
          </ImpactRow>
        )}
      </dl>

      {hidden.length > 0 && (
        <p className="text-xs text-slate-600">
          Not shown with your access: {hidden.join(', ')}. Someone with access to those modules
          should review them.
        </p>
      )}
    </section>
  );
}

function ImpactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-sm font-medium text-slate-700">{label}</dt>
      <dd className="min-w-0 space-y-1">{children}</dd>
    </div>
  );
}

function countText(count: number, [one, many]: [string, string]): string {
  return count === 0 ? `No ${many}` : `${count} ${count === 1 ? one : many}`;
}

function rangeText(range: { startDate: string; endDate: string }): string {
  return `${formatDateOnly(range.startDate)} – ${formatDateOnly(range.endDate)}`;
}

/** An exact total and, when there is anything, the capped list behind a disclosure. */
function CountedList<T extends { id: string }>({
  list,
  noun,
  render,
}: {
  list: BoundedList<T>;
  noun: [string, string];
  render(item: T): string;
}) {
  const summary = countText(list.total, noun);
  if (list.total === 0) return <p className="text-sm text-slate-600">{summary}.</p>;
  return (
    <details className="text-sm text-slate-800">
      <summary className="cursor-pointer break-words">
        <span className="font-medium">{summary}</span>
        {list.truncated && (
          <span className="text-slate-600">
            {' '}
            (showing the first {list.items.length} of {list.total})
          </span>
        )}
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700">
        {list.items.map((item) => (
          <li key={item.id} className="break-words">
            {render(item)}
          </li>
        ))}
      </ul>
    </details>
  );
}

const BLOCKER_TEXT: Record<TerminationBlocker['kind'], string> = {
  APPROVED_TIMESHEET: 'Approved timesheet',
  FINALIZED_PAYROLL: 'Finalized payroll',
  TIME_RECORDED: 'Time recorded after the date',
  SIGN_INS_RECORDED: 'Sign-ins recorded after the date',
};

export function BlockerList({
  blockers,
  title = 'This date is blocked by finalized records',
  description = 'Choose a later date, or have these records reopened first. Nothing has been changed.',
}: {
  blockers: TerminationBlocker[];
  title?: string;
  description?: string;
}) {
  return (
    <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-900">
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm">{description}</p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
        {blockers.map((blocker, index) => (
          <li key={`${blocker.kind}-${index}`}>
            {BLOCKER_TEXT[blocker.kind] ?? blocker.kind}
            {'periodStart' in blocker
              ? `: ${formatDateOnly(blocker.periodStart)} – ${formatDateOnly(blocker.periodEnd)}`
              : 'count' in blocker
                ? ` (${blocker.count})`
                : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmploymentSummary({ impact }: { impact: AssignmentImpact }) {
  const { otherCurrentAssignments, remainsEmployedInOrganization, endsLastCurrentEmployment } =
    impact.employment;
  return (
    <div className="space-y-1 text-sm text-slate-800">
      {otherCurrentAssignments.length === 0 ? (
        <p>No other current assignments you can see continue after this date.</p>
      ) : (
        <>
          <p>Other current assignments you can see that continue:</p>
          <ul className="list-disc pl-5">
            {otherCurrentAssignments.map((other) => (
              <li key={other.employmentAssignmentId} className="break-words">
                {other.positionName}{' '}
                <span className={badgeClass(other.status === 'PLANNED' ? 'info' : 'success')}>
                  {other.status === 'PLANNED' ? 'Planned' : 'Active'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {remainsEmployedInOrganization === false && (
        <p>The employee would have no other employment in this organization.</p>
      )}
      {endsLastCurrentEmployment === true && (
        <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
          This is the employee&apos;s last current assignment. To end all employment, use Terminate
          employee instead.
        </p>
      )}
    </div>
  );
}

function OffboardingRow({
  offboarding,
  organizationId,
}: {
  offboarding: NonNullable<AssignmentImpact['offboarding']>;
  organizationId: string;
}) {
  if (offboarding.openWorkflowId) {
    return (
      <p className="text-sm text-slate-800">
        An offboarding workflow is already open for this assignment.{' '}
        <Link
          href={`/onboarding/workflows/${offboarding.openWorkflowId}`}
          className="font-medium text-indigo-700 underline"
        >
          Open the workflow
        </Link>
      </p>
    );
  }
  return (
    <div className="space-y-2 text-sm text-slate-800">
      <p>
        No offboarding workflow is open.
        {offboarding.defaultTemplate
          ? ` The default template is "${offboarding.defaultTemplate.name}".`
          : ' No default offboarding template is set for this organization.'}{' '}
        Offboarding never starts automatically.
      </p>
      <OffboardingLink
        employeeId={offboarding.employeeId}
        organizationId={organizationId}
        employmentAssignmentId={offboarding.employmentAssignmentId}
        templateId={offboarding.defaultTemplate?.id ?? null}
        plannedEndDate={offboarding.plannedEndDate}
      />
    </div>
  );
}

/** A link to the prefilled Offboarding form (the administrator still starts it). */
export function OffboardingLink(props: {
  employeeId: string;
  organizationId?: string | null;
  employmentAssignmentId?: string | null;
  templateId?: string | null;
  plannedEndDate?: string | null;
  label?: string;
}) {
  return (
    <Link href={offboardingStartHref(props)} className={buttonClass('secondary', 'sm')}>
      {props.label ?? 'Review offboarding'}
    </Link>
  );
}
