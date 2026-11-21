'use client';

import { useId, useState } from 'react';
import { employeeApi } from '../../../lib/employee/api';
import { employeeLifecycleActionErrorMessage } from '../../../lib/employee/errors';
import type { EmployeeProfile, EmployeeStatusChangeResult } from '../../../lib/employee/types';
import { FormDialog } from '../../ui/form-dialog';
import { inputClass } from '../../ui/tokens';

/**
 * Batch 5C — mark an ACTIVE employee inactive (leave of absence; reason required) or reactivate
 * an INACTIVE one. While inactive the employee gets no new assignments and cannot record time
 * (clock-in, kiosk sign-in); leave, payroll, schedules, history, the login and role grants are
 * unchanged.
 */
export function StatusChangeDialog({
  open,
  profile,
  mode,
  onClose,
  onDone,
}: {
  open: boolean;
  profile: EmployeeProfile;
  mode: 'inactivate' | 'reactivate';
  onClose(): void;
  onDone(result: EmployeeStatusChangeResult): void;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const inactivating = mode === 'inactivate';
  const missingReason = inactivating && !reason.trim();

  async function submit() {
    setTouched(true);
    if (missingReason) return;
    setBusy(true);
    setError(null);
    try {
      onDone(
        inactivating
          ? await employeeApi.inactivate(profile.id, reason.trim())
          : await employeeApi.reactivate(profile.id, reason.trim() || undefined),
      );
    } catch (cause) {
      setError(
        employeeLifecycleActionErrorMessage(
          cause,
          inactivating ? 'Unable to mark the employee inactive.' : 'Unable to reactivate.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open={open}
      title={inactivating ? 'Mark employee inactive' : 'Reactivate employee'}
      description={
        inactivating ? (
          <>
            For a leave of absence. While inactive, the employee cannot record time (clock-in or
            kiosk sign-in) and gets no new assignments. Leave, payroll, schedules, history, the
            login and role grants are not changed. Reactivate to reverse it.
          </>
        ) : (
          <>The employee can record time again and can be given new assignments.</>
        )
      }
      submitLabel={inactivating ? 'Mark inactive' : 'Reactivate'}
      busyLabel="Saving…"
      busy={busy}
      canSubmit={!touched || !missingReason}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div>
        <label htmlFor={reasonId} className="block text-sm font-medium text-slate-800">
          Reason{' '}
          {inactivating ? (
            <span className="font-normal text-slate-600">(required)</span>
          ) : (
            <span className="font-normal text-slate-600">(optional)</span>
          )}
        </label>
        <textarea
          id={reasonId}
          rows={2}
          maxLength={500}
          aria-required={inactivating || undefined}
          aria-invalid={touched && missingReason ? true : undefined}
          aria-describedby={touched && missingReason ? `${reasonId}-error` : undefined}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={inputClass}
        />
        {touched && missingReason && (
          <p id={`${reasonId}-error`} className="mt-1 text-sm text-rose-800">
            Enter the reason for the inactive status.
          </p>
        )}
      </div>
    </FormDialog>
  );
}
