'use client';

import { checkboxClass } from '../../ui/tokens';

import { useId, useState } from 'react';
import { employeeApi } from '../../../lib/employee/api';
import { addDaysToDateOnly, formatDateOnly } from '../../../lib/employee/date';
import { employeeLifecycleActionErrorMessage } from '../../../lib/employee/errors';
import type {
  EmployeeManagerAssignmentOption,
  EmployeePositionOption,
  EmployeeProfile,
  EmployeeRehireResult,
  EmploymentType,
} from '../../../lib/employee/types';
import { FormDialog } from '../../ui/form-dialog';
import { inputClass } from '../../ui/tokens';
import { buttonClass } from '../../ui/button';
import { AssignmentFields } from '../employee-assignment-form';
import { EmployeeManagerPicker } from '../employee-manager-picker';
import { EmployeePositionPicker } from '../employee-position-picker';

/** Client-side checks before the API (which stays authoritative). */
export function validateRehire(
  input: {
    position: EmployeePositionOption | null;
    employmentType: EmploymentType | '';
    startDate: string;
    endDate: string;
  },
  lastDay: string | null,
): string | null {
  if (!input.position) return 'Choose the position for the new assignment.';
  if (!input.employmentType) return 'Choose the employment type.';
  if (!input.startDate) return 'Enter the start date.';
  if (lastDay && input.startDate <= lastDay)
    return `The new assignment must start after the last day of employment (${formatDateOnly(lastDay)}).`;
  if (input.endDate && input.endDate < input.startDate)
    return 'The end date must be on or after the start date.';
  return null;
}

/**
 * Batch 5C — rehire a TERMINATED employee into a new assignment (required). The original hire
 * date and the history are kept. Sign-in access and role grants are not restored: they are
 * reviewed in the access review afterwards.
 */
export function RehireDialog({
  open,
  profile,
  onClose,
  onDone,
}: {
  open: boolean;
  profile: EmployeeProfile;
  onClose(): void;
  onDone(result: EmployeeRehireResult): void;
}) {
  const reasonId = useId();
  const lastDay = profile.terminationDate;
  const [position, setPosition] = useState<EmployeePositionOption | null>(null);
  const [fields, setFields] = useState<{
    employmentType: EmploymentType | '';
    startDate: string;
    endDate: string;
  }>({
    employmentType: '',
    startDate: lastDay ? addDaysToDateOnly(lastDay, 1) : '',
    endDate: '',
  });
  const [isPrimary, setIsPrimary] = useState(true);
  const [manager, setManager] = useState<EmployeeManagerAssignmentOption | null>(null);
  const [choosingManager, setChoosingManager] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const validation = validateRehire({ position, ...fields }, lastDay);
  const managerTargetReady = Boolean(position && fields.startDate);

  async function submit() {
    setTouched(true);
    if (validation) return;
    setBusy(true);
    setError(null);
    try {
      const result = await employeeApi.rehire(profile.id, {
        assignment: {
          positionId: position!.id,
          employmentType: fields.employmentType as EmploymentType,
          startDate: fields.startDate,
          ...(fields.endDate ? { endDate: fields.endDate } : {}),
          isPrimary,
          ...(manager ? { managerAssignmentId: manager.assignmentId } : {}),
        },
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onDone(result);
    } catch (cause) {
      setError(employeeLifecycleActionErrorMessage(cause, 'Unable to rehire this employee.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open={open}
      title="Rehire employee"
      description={
        <>
          A rehire creates a new assignment starting after the last day of employment
          {lastDay ? ` (${formatDateOnly(lastDay)})` : ''}. The original hire date and history are
          kept. <strong>Sign-in access and role grants are not restored</strong>; review them after
          the rehire.
        </>
      }
      submitLabel="Rehire employee"
      busyLabel="Rehiring…"
      busy={busy}
      canSubmit={!touched || !validation}
      error={error ?? (touched ? validation : null)}
      onSubmit={() => void submit()}
      onClose={onClose}
      size="lg"
    >
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-800">Position (required)</legend>
        {position && (
          <p className="text-sm text-slate-700">
            Selected: <span className="font-medium">{position.name}</span> ·{' '}
            {position.organization.name}
          </p>
        )}
        <EmployeePositionPicker
          selected={position}
          onSelect={(next) => {
            setPosition(next);
            setManager(null);
          }}
        />
      </fieldset>
      <AssignmentFields
        employmentType={fields.employmentType}
        startDate={fields.startDate}
        endDate={fields.endDate}
        onChange={(patch) => {
          setFields((current) => ({ ...current, ...patch }));
          if (patch.startDate !== undefined || patch.endDate !== undefined) setManager(null);
        }}
      />
      <label className="flex items-start gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          checked={isPrimary}
          onChange={(event) => setIsPrimary(event.target.checked)}
          className={`${checkboxClass} mt-0.5`}
        />
        <span>Make this the primary assignment</span>
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">
          Manager <span className="font-normal text-slate-600">(optional)</span>
        </legend>
        <p className="text-sm text-slate-700">
          {manager ? (
            <>
              {manager.displayName} · {manager.position.name}{' '}
              <button
                type="button"
                onClick={() => setManager(null)}
                className="font-medium text-indigo-700 underline"
              >
                Remove
              </button>
            </>
          ) : (
            'No manager selected.'
          )}
        </p>
        {!managerTargetReady ? (
          <p className="text-xs text-slate-600">Choose the position and start date first.</p>
        ) : choosingManager ? (
          <EmployeeManagerPicker
            newAssignment={{
              positionId: position!.id,
              startDate: fields.startDate,
              ...(fields.endDate ? { endDate: fields.endDate } : {}),
              employeeId: profile.id,
            }}
            selected={manager}
            onSelect={(next) => {
              setManager(next);
              setChoosingManager(false);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setChoosingManager(true)}
            className={buttonClass('secondary', 'sm')}
          >
            Choose manager
          </button>
        )}
      </fieldset>
      <div>
        <label htmlFor={reasonId} className="block text-sm font-medium text-slate-800">
          Note <span className="font-normal text-slate-600">(optional)</span>
        </label>
        <textarea
          id={reasonId}
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={inputClass}
        />
      </div>
    </FormDialog>
  );
}
