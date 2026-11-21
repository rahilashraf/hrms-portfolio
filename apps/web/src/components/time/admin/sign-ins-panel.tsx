'use client';

import { checkboxClass } from '../../ui/tokens';

import type { FormEvent } from 'react';
import { useCallback, useState } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import type { AttendanceOrganization, SignInDetail } from '../../../lib/attendance/types';
import { formatDateOnly, formatInstant, label } from '../../../lib/time/format';
import { StatusPill } from '../employee-time-page';
import { inputClass, primaryButton } from '../../ui/tokens';
import { DataTable } from '../../ui/data-table';
import { isHistoricalOrganization } from '../review/review-shared';
import { TruncatedRecordsNotice } from '../time-notices';
import {
  Empty,
  Feedback,
  Section,
  dangerButton,
  localDateTimeIn,
  secondaryButton,
  usePanel,
} from './attendance-shared';

// Batch 10C: moved from attendance-admin.tsx unchanged.
// ─── Sign-ins ────────────────────────────────────────────────────────────────

export function SignInsPanel({ organization }: { organization: AttendanceOrganization }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [includeVoided, setIncludeVoided] = useState(false);
  const [editing, setEditing] = useState<{
    signIn: SignInDetail;
    mode: 'void' | 'correct' | 'sign-out' | 'void-sign-out';
  } | null>(null);
  const historical = isHistoricalOrganization(organization);
  const load = useCallback(
    () =>
      attendanceApi.managedSignIns({
        organizationId: organization.id,
        from,
        to,
        includeVoided,
        ...(historical ? { includeDisabledOrganizations: true } : {}),
      }),
    [organization.id, from, to, includeVoided, historical],
  );
  const { data: page, error, success, busy, mutate } = usePanel(load);
  const data = page?.items ?? null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('reason') ?? '').trim();
    const { signIn, mode } = editing;
    const action = (): Promise<unknown> => {
      switch (mode) {
        case 'void':
          return attendanceApi.voidSignIn(signIn.id, reason);
        case 'correct':
          return attendanceApi.correctSignIn(signIn.id, {
            signedInAt: String(form.get('signedInAt') ?? ''),
            reason,
          });
        // Batch 4D/4E-2: a manager's sign-out record (presence only, never payable time).
        case 'sign-out':
          return attendanceApi.recordSignOut(signIn.id, {
            signedOutAt: String(form.get('signedOutAt') ?? ''),
            reason,
          });
        case 'void-sign-out':
          return attendanceApi.voidSignOut(signIn.signOut!.id, reason);
      }
    };
    const messages = {
      void: 'Sign-in voided.',
      correct: 'Sign-in corrected.',
      'sign-out': 'Sign-out recorded.',
      'void-sign-out': 'Sign-out voided.',
    } as const;
    void mutate(`${mode}-${signIn.id}`, action, messages[mode]).then((result) => {
      if (result) setEditing(null);
    });
  }

  return (
    <Section title="Sign-ins">
      <div className="space-y-4">
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
          <label className="flex items-end gap-2 pb-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={includeVoided}
              onChange={(event) => setIncludeVoided(event.target.checked)}
            />
            Include voided
          </label>
        </div>
        <Feedback error={error} success={success} />
        <TruncatedRecordsNotice truncated={page?.truncated} limit={page?.limit} />
        {data === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading sign-ins…
          </p>
        ) : data.length === 0 ? (
          <Empty>No sign-ins in this range.</Empty>
        ) : (
          <DataTable
            bare
            label="Sign-ins"
            rows={data}
            rowKey={(signIn) => signIn.id}
            columns={[
              {
                key: 'employee',
                header: 'Employee',
                rowHeader: true,
                cell: (signIn) => (
                  <>
                    <p className="font-medium text-slate-900">
                      {signIn.employeeName ?? signIn.employeeNumber}
                    </p>
                    <p className="text-xs font-normal text-slate-500">{signIn.employeeNumber}</p>
                  </>
                ),
              },
              { key: 'assignment', header: 'Assignment', cell: (signIn) => signIn.positionName },
              {
                key: 'signedIn',
                header: 'Signed in',
                cell: (signIn) => formatInstant(signIn.signedInAt, signIn.timezone),
              },
              {
                key: 'source',
                header: 'Source',
                cell: (signIn) => (
                  <>
                    {label(signIn.source)}
                    {signIn.device && (
                      <span className="block text-xs text-slate-500">{signIn.device.name}</span>
                    )}
                  </>
                ),
              },
              {
                key: 'signedOut',
                header: 'Signed out',
                cell: (signIn) =>
                  signIn.signOut ? (
                    <>
                      {formatInstant(signIn.signOut.signedOutAt, signIn.timezone)}
                      <span className="block text-xs text-slate-500">
                        {label(signIn.signOut.source)}
                        {signIn.signOut.reason ? ` · ${signIn.signOut.reason}` : ''}
                      </span>
                    </>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (signIn) => <StatusPill value={signIn.status} />,
              },
              {
                key: 'exceptions',
                header: 'Exceptions',
                cell: (signIn) =>
                  signIn.exceptions.length === 0
                    ? '—'
                    : signIn.exceptions.map((exception) => (
                        <span
                          key={exception.id}
                          className="mr-1 inline-block rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-900"
                        >
                          {label(exception.type)}
                        </span>
                      )),
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                align: 'right',
                cell: (signIn) => {
                  // Names each row action ("Correct Ada Lovelace, Oct 6, 9:00 AM").
                  const rowName = (
                    <span className="sr-only">
                      {signIn.employeeName ?? signIn.employeeNumber},{' '}
                      {formatInstant(signIn.signedInAt, signIn.timezone)}
                    </span>
                  );
                  return (
                    <div className="flex justify-end gap-2">
                      {signIn.actions?.canCorrect && (
                        <button
                          type="button"
                          className={secondaryButton}
                          onClick={() => setEditing({ signIn, mode: 'correct' })}
                        >
                          Correct {rowName}
                        </button>
                      )}
                      {signIn.actions?.canCorrect &&
                        signIn.status === 'ACTIVE' &&
                        (signIn.signOut ? (
                          <button
                            type="button"
                            className={dangerButton}
                            onClick={() => setEditing({ signIn, mode: 'void-sign-out' })}
                          >
                            Void sign-out {rowName}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={secondaryButton}
                            onClick={() => setEditing({ signIn, mode: 'sign-out' })}
                          >
                            Record sign-out {rowName}
                          </button>
                        ))}
                      {signIn.actions?.canVoid && (
                        <button
                          type="button"
                          className={dangerButton}
                          onClick={() => setEditing({ signIn, mode: 'void' })}
                        >
                          Void {rowName}
                        </button>
                      )}
                    </div>
                  );
                },
              },
            ]}
          />
        )}
        {editing && (
          <form
            onSubmit={submit}
            aria-label={
              {
                void: 'Void sign-in',
                correct: 'Correct sign-in',
                'sign-out': 'Record sign-out',
                'void-sign-out': 'Void sign-out',
              }[editing.mode]
            }
            className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 md:grid-cols-3"
          >
            <p className="text-sm text-slate-700 md:col-span-3">
              {
                {
                  void: 'Void the sign-in',
                  correct: 'Correct the sign-in',
                  'sign-out': 'Record when this person left after the sign-in',
                  'void-sign-out': 'Void the sign-out',
                }[editing.mode]
              }{' '}
              of <strong>{editing.signIn.employeeName ?? editing.signIn.employeeNumber}</strong> on{' '}
              {formatDateOnly(editing.signIn.workDate)}. The original stays on record
              {editing.mode === 'sign-out' || editing.mode === 'void-sign-out'
                ? '; a sign-out is presence only, never payable time.'
                : '.'}
            </p>
            {editing.mode === 'sign-out' && (
              <label className="text-sm font-medium text-slate-700">
                Signed out at ({editing.signIn.timezone})
                <input name="signedOutAt" type="datetime-local" required className={inputClass} />
              </label>
            )}
            {editing.mode === 'correct' && (
              <label className="text-sm font-medium text-slate-700">
                Signed in at ({editing.signIn.timezone})
                <input
                  name="signedInAt"
                  type="datetime-local"
                  required
                  defaultValue={localDateTimeIn(editing.signIn.signedInAt, editing.signIn.timezone)}
                  className={inputClass}
                />
              </label>
            )}
            <label className="text-sm font-medium text-slate-700 md:col-span-2">
              Reason
              <input name="reason" required className={inputClass} />
            </label>
            <div className="flex gap-2 md:col-span-3">
              <button type="submit" disabled={busy !== null} className={primaryButton}>
                {
                  {
                    void: 'Void sign-in',
                    correct: 'Save correction',
                    'sign-out': 'Record sign-out',
                    'void-sign-out': 'Void sign-out',
                  }[editing.mode]
                }
              </button>
              <button type="button" className={secondaryButton} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Section>
  );
}
