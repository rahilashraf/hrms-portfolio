'use client';

import { checkboxClass } from '../../ui/tokens';

import { useId, useState } from 'react';
import { employeeApi } from '../../../lib/employee/api';
import { addDaysToDateOnly, formatDateOnly } from '../../../lib/employee/date';
import {
  employeeLifecycleActionErrorMessage,
  lifecycleErrorCode,
} from '../../../lib/employee/errors';
import type {
  AssignmentImpact,
  EmployeeAssignmentView,
  EmployeeManagerAssignmentOption,
  EmployeePositionOption,
  EmployeeProfile,
  EmployeeTransferResult,
  EmploymentType,
  ManagerDroppedReason,
} from '../../../lib/employee/types';
import { FormDialog } from '../../ui/form-dialog';
import { inputClass } from '../../ui/tokens';
import { buttonClass } from '../../ui/button';
import { employmentTypeLabel } from '../employee-shared';
import { EmployeeManagerPicker } from '../employee-manager-picker';
import { EmployeePositionPicker } from '../employee-position-picker';
import { AssignmentImpactPreview } from './assignment-impact-preview';

type ManagerChoice = 'carry' | 'choose' | 'none';

const EMPLOYMENT_TYPES: EmploymentType[] = ['FULL_TIME', 'PART_TIME', 'CASUAL', 'CONTRACT'];

/** Client-side checks before the API (which stays authoritative). */
export function validateTransfer(
  assignment: Pick<EmployeeAssignmentView, 'startDate' | 'endDate' | 'position'>,
  input: {
    position: EmployeePositionOption | null;
    effectiveDate: string;
    endDate: string;
    managerChoice: ManagerChoice;
    manager: EmployeeManagerAssignmentOption | null;
  },
): string | null {
  if (!input.position) return 'Choose the new position.';
  if (input.position.id === assignment.position.id)
    return 'Choose a different position for the transfer.';
  if (!input.effectiveDate) return 'Enter the first day in the new position.';
  if (input.effectiveDate <= assignment.startDate)
    return `The first day in the new position must be after ${formatDateOnly(assignment.startDate)}, when the current assignment started.`;
  if (assignment.endDate && input.effectiveDate > assignment.endDate)
    return `The first day in the new position must be on or before ${formatDateOnly(assignment.endDate)}, when the current assignment ends.`;
  if (input.endDate && input.endDate < input.effectiveDate)
    return 'The end date must be on or after the first day in the new position.';
  if (input.managerChoice === 'choose' && !input.manager) return 'Choose the manager.';
  return null;
}

const DROPPED: Record<ManagerDroppedReason, string> = {
  MANAGER_ASSIGNMENT_ENDED: 'the previous manager’s assignment has ended',
  MANAGER_ORGANIZATION_MISMATCH: 'the previous manager works in another organization',
  MANAGER_NOT_VALID_FOR_NEW_ASSIGNMENT: 'the previous manager does not cover the new dates',
};

/** What the transfer did, including the compensation reminder (compensation is never copied). */
export function transferSummary(result: EmployeeTransferResult): string {
  const parts = [
    result.replayed
      ? 'This transfer had already been recorded; nothing changed.'
      : `Transfer recorded: the new assignment starts ${formatDateOnly(result.destinationAssignment.startDate)}.`,
  ];
  if (result.manager.carried) parts.push('The manager was carried over.');
  else if (result.manager.droppedReason)
    parts.push(`The manager was not carried over: ${DROPPED[result.manager.droppedReason]}.`);
  if (result.compensationRequired)
    parts.push(
      result.sourceHadCompensation
        ? 'Compensation is not copied: add a compensation record for the new assignment.'
        : 'Compensation is not copied: add a compensation record for the new assignment if it is paid.',
    );
  return parts.join(' ');
}

/**
 * Batch 5C — atomic transfer to another position (Batch 5B K6). The current assignment ends the
 * day before the effective date; the new one starts on it. The impact preview shows what ending
 * the current assignment on that day leaves behind; finalized records block the transfer.
 */
export function TransferDialog({
  open,
  profile,
  assignment,
  onClose,
  onDone,
}: {
  open: boolean;
  profile: EmployeeProfile;
  assignment: EmployeeAssignmentView;
  onClose(): void;
  onDone(result: EmployeeTransferResult): void;
}) {
  const dateId = useId();
  const endId = useId();
  const typeId = useId();
  const reasonId = useId();
  const [position, setPosition] = useState<EmployeePositionOption | null>(null);
  const [effectiveDate, setEffectiveDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [employmentType, setEmploymentType] = useState<EmploymentType>(assignment.employmentType);
  const [isPrimary, setIsPrimary] = useState(assignment.isPrimary);
  const [managerChoice, setManagerChoice] = useState<ManagerChoice>(
    assignment.manager ? 'carry' : 'none',
  );
  const [manager, setManager] = useState<EmployeeManagerAssignmentOption | null>(null);
  const [reason, setReason] = useState('');
  const [impact, setImpact] = useState<AssignmentImpact | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const validation = validateTransfer(assignment, {
    position,
    effectiveDate,
    endDate,
    managerChoice,
    manager,
  });
  const sourceEnd =
    effectiveDate && !validation?.startsWith('The first day')
      ? addDaysToDateOnly(effectiveDate, -1)
      : '';
  const blocked = Boolean(impact?.blocked);

  async function submit() {
    setTouched(true);
    if (validation || blocked || !reviewed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await employeeApi.transferAssignment(profile.id, assignment.id, {
        positionId: position!.id,
        effectiveDate,
        employmentType,
        ...(endDate ? { endDate } : {}),
        isPrimary,
        ...(managerChoice === 'none'
          ? { managerAssignmentId: null }
          : managerChoice === 'choose' && manager
            ? { managerAssignmentId: manager.assignmentId }
            : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onDone(result);
    } catch (cause) {
      const code = lifecycleErrorCode(cause);
      setError(
        code === 'TRANSFER_SOURCE_CHANGED' || code === 'EMPLOYEE_CHANGED_CONCURRENTLY'
          ? 'This assignment changed while you were working. Close this dialog, refresh and try again.'
          : employeeLifecycleActionErrorMessage(cause, 'Unable to transfer this assignment.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open={open}
      title={`Transfer from ${assignment.position.name}`}
      description={
        <>
          The current assignment ends the day before the effective date and the new assignment
          starts on it, in one step. <strong>Compensation is not copied</strong>: add a record for
          the new assignment afterwards.
        </>
      }
      submitLabel="Transfer"
      busyLabel="Transferring…"
      busy={busy}
      canSubmit={!blocked && reviewed && (!touched || !validation)}
      error={error ?? (touched ? validation : null)}
      onSubmit={() => void submit()}
      onClose={onClose}
      size="lg"
    >
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-800">New position (required)</legend>
        {position && (
          <p className="text-sm text-slate-700">
            Selected: <span className="font-medium">{position.name}</span> ·{' '}
            {position.organization.name}
            {position.organization.id !== assignment.organization.id && (
              <span className="block text-amber-900">
                Another organization: the current manager cannot be carried over.
              </span>
            )}
          </p>
        )}
        <EmployeePositionPicker
          selected={position}
          onSelect={(next) => {
            setPosition(next);
            setManager(null);
            if (next.organization.id !== assignment.organization.id && managerChoice === 'carry')
              setManagerChoice('none');
          }}
        />
      </fieldset>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={dateId} className="block text-sm font-medium text-slate-800">
            First day in the new position
          </label>
          <input
            id={dateId}
            type="date"
            required
            min={addDaysToDateOnly(assignment.startDate, 1)}
            max={assignment.endDate ?? undefined}
            value={effectiveDate}
            aria-describedby={`${dateId}-help`}
            onChange={(event) => {
              setEffectiveDate(event.target.value);
              setReviewed(false);
              setManager(null);
            }}
            className={inputClass}
          />
          <p id={`${dateId}-help`} className="mt-1 text-xs text-slate-600">
            {sourceEnd
              ? `${assignment.position.name} ends ${formatDateOnly(sourceEnd)} (inclusive).`
              : 'The current assignment ends the day before.'}
          </p>
        </div>
        <div>
          <label htmlFor={endId} className="block text-sm font-medium text-slate-800">
            End date <span className="font-normal text-slate-600">(optional)</span>
          </label>
          <input
            id={endId}
            type="date"
            value={endDate}
            min={effectiveDate || undefined}
            onChange={(event) => {
              setEndDate(event.target.value);
              setManager(null);
            }}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={typeId} className="block text-sm font-medium text-slate-800">
            Employment type
          </label>
          <select
            id={typeId}
            value={employmentType}
            onChange={(event) => setEmploymentType(event.target.value as EmploymentType)}
            className={inputClass}
          >
            {EMPLOYMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {employmentTypeLabel(type)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-start gap-2 self-end text-sm text-slate-800">
          <input
            type="checkbox"
            checked={isPrimary}
            onChange={(event) => setIsPrimary(event.target.checked)}
            className={`${checkboxClass} mt-0.5`}
          />
          <span>Primary assignment</span>
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">Manager</legend>
        {assignment.manager && (
          <label className="flex items-start gap-2 text-sm text-slate-800">
            <input
              type="radio"
              name="transfer-manager"
              checked={managerChoice === 'carry'}
              disabled={Boolean(
                position && position.organization.id !== assignment.organization.id,
              )}
              onChange={() => setManagerChoice('carry')}
              className="mt-0.5"
            />
            <span>Keep {assignment.manager.displayName} if still valid for the new assignment</span>
          </label>
        )}
        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input
            type="radio"
            name="transfer-manager"
            checked={managerChoice === 'choose'}
            onChange={() => setManagerChoice('choose')}
            className="mt-0.5"
          />
          <span>Choose a manager</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input
            type="radio"
            name="transfer-manager"
            checked={managerChoice === 'none'}
            onChange={() => setManagerChoice('none')}
            className="mt-0.5"
          />
          <span>No manager</span>
        </label>
        {managerChoice === 'choose' &&
          (position && effectiveDate ? (
            manager ? (
              <p className="text-sm text-slate-700">
                {manager.displayName} · {manager.position.name}{' '}
                <button
                  type="button"
                  onClick={() => setManager(null)}
                  className="font-medium text-indigo-700 underline"
                >
                  Change
                </button>
              </p>
            ) : (
              <EmployeeManagerPicker
                newAssignment={{
                  positionId: position.id,
                  startDate: effectiveDate,
                  ...(endDate ? { endDate } : {}),
                  employeeId: profile.id,
                }}
                selected={manager}
                onSelect={setManager}
              />
            )
          ) : (
            <p className="text-xs text-slate-600">Choose the new position and first day first.</p>
          ))}
      </fieldset>
      <div>
        <label htmlFor={reasonId} className="block text-sm font-medium text-slate-800">
          Reason <span className="font-normal text-slate-600">(optional)</span>
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
      {sourceEnd && sourceEnd >= assignment.startDate ? (
        <AssignmentImpactPreview
          employeeId={profile.id}
          assignmentId={assignment.id}
          endDate={sourceEnd}
          onLoaded={(value) => {
            setImpact(value);
            setReviewed(false);
          }}
          showOffboarding={false}
        />
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-600">
          Choose a valid first day to see what ending the current assignment would affect.
        </p>
      )}
      {impact && !impact.blocked && (
        <label className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
            className={`${checkboxClass} mt-0.5`}
          />
          <span>I reviewed the impact above, and compensation for the new assignment.</span>
        </label>
      )}
    </FormDialog>
  );
}

/** After a transfer: what happened, and the compensation reminder with a direct link. */
export function TransferResultNotice({
  result,
  canAddCompensation,
  onOpenCompensation,
  onDismiss,
}: {
  result: EmployeeTransferResult;
  canAddCompensation: boolean;
  onOpenCompensation(): void;
  onDismiss(): void;
}) {
  return (
    <section
      role="status"
      aria-label="Transfer recorded"
      className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950"
    >
      <p className="text-sm">{transferSummary(result)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {result.compensationRequired && canAddCompensation && (
          <button
            type="button"
            onClick={onOpenCompensation}
            className={buttonClass('primary', 'sm')}
          >
            Add compensation
          </button>
        )}
        <button type="button" onClick={onDismiss} className={buttonClass('secondary', 'sm')}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
