'use client';

import { InlineMessage } from '../ui/inline-message';
import { StatusBadge } from '../ui/status-badge';

/**
 * Batch 4F — small notices shared by the attendance screens: capped lists (Q3) and the history
 * of organizations with Time & attendance turned off (C10). Text carries the meaning; colour
 * only supports it.
 */

/** The message of a capped list: never imply partial results are complete. */
export function truncatedRecordsText(limit: number | undefined): string {
  const count = typeof limit === 'number' ? limit.toLocaleString('en-US') : 'returned';
  return `Showing the first ${count} records. Narrow the date range to see the rest.`;
}

/** Shown when the API capped a list (`truncated: true`); renders nothing otherwise. */
export function TruncatedRecordsNotice({
  truncated,
  limit,
  className,
}: {
  truncated?: boolean;
  limit?: number;
  className?: string;
}) {
  if (!truncated) return null;
  return (
    <InlineMessage tone="warning" className={className}>
      {truncatedRecordsText(limit)}
    </InlineMessage>
  );
}

export const READ_ONLY_LABEL = 'Attendance turned off — read only';

/** Marks a record of an organization with Time & attendance turned off (history only). */
export function ReadOnlyBadge() {
  // Batch 10C: the shared StatusBadge (neutral: history only).
  return <StatusBadge status="READ_ONLY" label={READ_ONLY_LABEL} tone="neutral" />;
}

/** Whether a record's organization is in the response's `attendanceDisabledOrganizationIds`. */
export function isReadOnly(
  disabledOrganizationIds: ReadonlySet<string> | readonly string[] | undefined,
  organizationId: string | null | undefined,
): boolean {
  if (!organizationId || !disabledOrganizationIds) return false;
  return 'has' in disabledOrganizationIds
    ? disabledOrganizationIds.has(organizationId)
    : disabledOrganizationIds.includes(organizationId);
}

/** My Time when every organization of the employee has Time & attendance turned off. */
export function AttendanceTurnedOffNotice() {
  return (
    <InlineMessage tone="info">
      <p className="font-semibold">Time &amp; attendance is turned off for your organization.</p>
      <p className="mt-1">
        Nothing can be recorded right now. Your history stays available in History, Timesheets and
        Requests, read only.
      </p>
    </InlineMessage>
  );
}
