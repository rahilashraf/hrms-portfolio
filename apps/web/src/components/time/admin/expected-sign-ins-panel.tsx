'use client';

import type { FormEvent } from 'react';
import { useCallback, useState } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import type { AttendanceOrganization, ExpectedSignIn } from '../../../lib/attendance/types';
import { formatDateOnly, formatInstant } from '../../../lib/time/format';
import { StatusPill } from '../employee-time-page';
import { inputClass, primaryButton } from '../../ui/tokens';
import { TruncatedRecordsNotice } from '../time-notices';
import {
  Empty,
  Feedback,
  Section,
  localDateTimeIn,
  secondaryButton,
  usePanel,
} from './attendance-shared';

// Batch 10C: moved from attendance-admin.tsx unchanged.
export function ExpectedSignInsPanel({ organization }: { organization: AttendanceOrganization }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [recording, setRecording] = useState<ExpectedSignIn | null>(null);
  const load = useCallback(
    () => attendanceApi.expectedSignIns({ organizationId: organization.id, from, to }),
    [organization.id, from, to],
  );
  const { data: page, error, success, busy, mutate } = usePanel(load);
  const data = page?.items ?? null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recording) return;
    const form = new FormData(event.currentTarget);
    void mutate(
      `record-${recording.scheduledShiftId}`,
      () =>
        attendanceApi.recordSignIn({
          employmentAssignmentId: recording.employmentAssignmentId,
          scheduledShiftId: recording.scheduledShiftId,
          signedInAt: String(form.get('signedInAt') ?? ''),
          reason: String(form.get('reason') ?? '').trim(),
        }),
      'Sign-in recorded.',
    ).then((result) => {
      if (result) setRecording(null);
    });
  }

  return (
    <Section title="Expected sign-ins">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Published shifts of sign-in-only assignments and whether each was attended. Missing
          sign-ins can be recorded with a reason.
        </p>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-sm font-medium text-slate-700">
            From
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            To
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        <Feedback error={error} success={success} />
        <TruncatedRecordsNotice truncated={page?.truncated} limit={page?.limit} />
        {data === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading expected sign-ins…
          </p>
        ) : data.length === 0 ? (
          <Empty>No published sign-in-only shifts in this range.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {data.map((item) => (
              <li
                key={item.scheduledShiftId}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <div>
                  <p className="font-medium text-slate-900">
                    {item.employeeName ?? item.employeeNumber} · {item.positionName}
                  </p>
                  <p className="text-sm text-slate-600">
                    {formatInstant(item.startsAt, item.timezone)} –{' '}
                    {formatInstant(item.endsAt, item.timezone)}
                    {item.signIn && (
                      <>
                        {' '}
                        · signed in {formatInstant(item.signIn.signedInAt, item.timezone)}
                        {item.signIn.minutesAfterStart > 0 &&
                          ` (${item.signIn.minutesAfterStart} min late)`}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill value={item.status} />
                  {organization.actions.canCorrectSignIns &&
                    (item.status === 'MISSING' || item.status === 'PENDING') && (
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={() => setRecording(item)}
                      >
                        Record sign-in
                      </button>
                    )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {recording && (
          <form
            onSubmit={submit}
            aria-label="Record sign-in"
            className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 md:grid-cols-3"
          >
            <p className="text-sm text-slate-700 md:col-span-3">
              Record a sign-in for{' '}
              <strong>{recording.employeeName ?? recording.employeeNumber}</strong> on{' '}
              {formatDateOnly(recording.workDate)}.
            </p>
            <label className="text-sm font-medium text-slate-700">
              Signed in at ({recording.timezone})
              <input
                name="signedInAt"
                type="datetime-local"
                required
                defaultValue={localDateTimeIn(recording.startsAt, recording.timezone)}
                className={inputClass}
              />
            </label>
            <label className="text-sm font-medium text-slate-700 md:col-span-2">
              Reason
              <input name="reason" required className={inputClass} />
            </label>
            <div className="flex gap-2 md:col-span-3">
              <button type="submit" disabled={busy !== null} className={primaryButton}>
                Record sign-in
              </button>
              <button type="button" className={secondaryButton} onClick={() => setRecording(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Section>
  );
}
