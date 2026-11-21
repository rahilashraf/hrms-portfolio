'use client';

import { useState } from 'react';
import { timeApi } from '../../../lib/time/api';
import { isStaleConflict, timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatMinutes } from '../../../lib/time/format';
import type { Timesheet, TimesheetSegment } from '../../../lib/time/types';
import { useConfirmWithReason } from '../../ui/use-confirm';

// Batch 10C: helpers shared by the timesheet review pieces (moved from timesheet-review.tsx).
export function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function periodLabel(period: { startDate: string; endDate: string } | null | undefined) {
  return period ? `${formatDateOnly(period.startDate)} – ${formatDateOnly(period.endDate)}` : '—';
}

/** Shared segment decisions: approve as seen, or return with a required note. */
export function useSegmentDecisions(onDone: (message: string) => Promise<void> | void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmWithReason, reasonDialog] = useConfirmWithReason();

  async function approve(sheet: Timesheet, segment: TimesheetSegment) {
    setBusy(segment.id);
    setError(null);
    try {
      await timeApi.approveSegmentAsSeen(segment.id, {
        netWorkedMinutes: segment.netWorkedMinutes,
        version: sheet.version,
      });
      await onDone('Timesheet segment approved.');
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to approve this timesheet.'));
      if (isStaleConflict(cause)) await onDone('');
    } finally {
      setBusy(null);
    }
  }

  async function requestChanges(segment: TimesheetSegment) {
    const note = await confirmWithReason({
      title: 'Return for changes?',
      description:
        'The employee sees your note and can correct their time and submit again. Nothing is approved.',
      confirmLabel: 'Request changes',
      destructive: false,
      reason: { label: 'What needs to change', required: true, maxLength: 1000 },
    });
    if (note === null) return;
    setBusy(segment.id);
    setError(null);
    try {
      await timeApi.requestTimesheetChanges(segment.id, note);
      await onDone('Changes requested.');
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to request changes.'));
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, approve, requestChanges, reasonDialog };
}

export function Feedback({ error, success }: { error: string | null; success: string | null }) {
  return (
    <>
      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {success}
        </p>
      )}
    </>
  );
}

export function MinutesSummary({ segment }: { segment: TimesheetSegment }) {
  return (
    <span>
      {formatMinutes(segment.netWorkedMinutes)} net · {formatMinutes(segment.grossMinutes)} gross
      {segment.unpaidBreakMinutes > 0 &&
        ` · ${formatMinutes(segment.unpaidBreakMinutes)} unpaid breaks`}
      {segment.policyDeductionMinutes > 0 &&
        ` · ${formatMinutes(segment.policyDeductionMinutes)} auto deduction`}
    </span>
  );
}
