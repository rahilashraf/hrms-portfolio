'use client';

import { useState } from 'react';
import type { TimePeriod, Timesheet } from '../../../lib/time/types';
import type { ReviewOrganization } from './review-shared';
import { ApprovalQueue } from './timesheet-approval-queue';
import { TimesheetDetail } from './timesheet-detail';
import { PeriodBrowser, PeriodTimesheets } from './timesheet-period-browser';
export { TimesheetDetail } from './timesheet-detail';

/**
 * Batch 4E-1 — timesheet review: the approval queue, periods (generation and timesheet
 * creation for attendance-only organizations), the timesheets of a period, and one timesheet in
 * detail with its daily time, exceptions, approval history and the manager actions the API
 * allows (approve, request changes, submit on behalf, lock, reopen). Approval sends the minutes
 * and version the reviewer saw, so a timesheet that changed meanwhile is never approved blind.
 */

// ─── The tab ─────────────────────────────────────────────────────────────────

export function TimesheetReview({
  organization,
  currentUserId,
  selection,
  onSelect,
}: {
  organization: ReviewOrganization;
  currentUserId: string | null;
  /** The open timesheet (deep-linkable: ?timesheetPeriod=…&timesheetEmployee=…#timesheets). */
  selection: { periodId: string; employeeId: string } | null;
  onSelect(selection: { periodId: string; employeeId: string } | null): void;
}) {
  const [period, setPeriod] = useState<TimePeriod | null>(null);
  if (selection) {
    return (
      <TimesheetDetail
        key={`${selection.periodId}-${selection.employeeId}`}
        organization={organization}
        periodId={selection.periodId}
        employeeId={selection.employeeId}
        currentUserId={currentUserId}
        onBack={() => onSelect(null)}
      />
    );
  }
  const open = (sheet: Timesheet) =>
    onSelect({ periodId: sheet.timePeriodId, employeeId: sheet.employeeId });
  return (
    <div className="space-y-6">
      {organization.actions.canApproveTimesheets && (
        <ApprovalQueue organization={organization} onOpen={open} />
      )}
      <PeriodBrowser
        organization={organization}
        selected={period?.id ?? null}
        onSelect={setPeriod}
      />
      {period && <PeriodTimesheets organization={organization} period={period} onOpen={open} />}
    </div>
  );
}
