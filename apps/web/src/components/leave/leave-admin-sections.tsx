'use client';

import { checkboxClass } from '../ui/tokens';

import { useEffect, useId, useRef, useState } from 'react';
import { leaveApi } from '../../lib/leave/api';
import { leaveErrorMessage } from '../../lib/leave/errors';
import { formatDateOnly, formatLeaveAmount, label, todayIso } from '../../lib/leave/format';
import type {
  LeaveOrganization,
  LeavePreview,
  LeaveRequestInput,
  LeaveType,
  ResolvedLeavePolicy,
} from '../../lib/leave/types';
import { AssignmentIdPicker } from '../ui/assignment-id-picker';
import { FormDialog } from '../ui/form-dialog';
import { EmptyState, inputClass, LeaveDaysTable, Panel, primaryButton } from './leave-shared';

const fieldLabel = 'block text-sm font-medium text-slate-700';

/** The organization's active leave types (for the record and resolver forms). */
function useLeaveTypes(organizationId: string) {
  const [types, setTypes] = useState<LeaveType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      leaveApi
        .types(organizationId)
        .then((result) => active && setTypes(result.items))
        .catch((cause) => {
          if (!active) return;
          setTypes([]);
          setError(leaveErrorMessage(cause, 'Unable to load leave types.'));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId]);
  return { types, error };
}

/**
 * Batch 6B — record leave for an employee (leave.approve over their assignment): pick the
 * employee and assignment, the type and dates, preview the days (holidays marked) and the
 * balance effect, then record it as pending or approve it at once. Nobody records their own
 * leave (D5); the API refuses it and the message says so.
 */
export function RecordLeaveDialog({
  organization,
  initialEmployeeId,
  onClose,
  onRecorded,
}: {
  organization: LeaveOrganization;
  initialEmployeeId?: string;
  onClose(): void;
  onRecorded(message: string): void;
}) {
  const id = useId();
  const { types, error: typesError } = useLeaveTypes(organization.id);
  const [assignmentId, setAssignmentId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [approve, setApprove] = useState(true);
  // The preview and the exact input it was calculated for: recording sends that input.
  const [previewed, setPreviewed] = useState<{
    input: LeaveRequestInput;
    preview: LeavePreview;
  } | null>(null);
  const preview = previewed?.preview ?? null;
  // Bumped on every edit, so a preview answered after an edit is discarded.
  const version = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typeId = leaveTypeId || types?.[0]?.id || '';
  const input = {
    employmentAssignmentId: assignmentId,
    leaveTypeId: typeId,
    startDate,
    endDate: endDate || startDate,
    ...(reason.trim() ? { reason: reason.trim() } : {}),
  };
  const complete = Boolean(assignmentId && typeId && startDate);
  const ordered = !endDate || endDate >= startDate;
  // Any change invalidates the preview: what is recorded is always what was previewed.
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      version.current += 1;
      setPreviewed(null);
      setError(null);
    };

  async function runPreview() {
    const requested = { ...input };
    const at = version.current;
    setBusy(true);
    setError(null);
    try {
      const result = await leaveApi.previewForEmployee(requested);
      // Edited while the preview was calculated: it no longer describes the form.
      if (version.current === at) setPreviewed({ input: requested, preview: result });
    } catch (cause) {
      if (version.current === at)
        setError(leaveErrorMessage(cause, 'Unable to preview the leave.'));
    } finally {
      setBusy(false);
    }
  }

  async function record() {
    if (!previewed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await leaveApi.recordForEmployee({
        ...previewed.input,
        approve,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onRecorded(
        result.status === 'APPROVED'
          ? 'Leave recorded and approved.'
          : 'Leave recorded as pending.',
      );
    } catch (cause) {
      setError(leaveErrorMessage(cause, 'Unable to record the leave.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open
      size="lg"
      title="Record leave for an employee"
      description="Preview first: the days, holidays and balance effect are calculated as they will be recorded."
      submitLabel={preview ? (approve ? 'Record and approve' : 'Record as pending') : 'Preview'}
      busyLabel={preview ? 'Recording…' : 'Previewing…'}
      busy={busy}
      canSubmit={complete && ordered && (!preview || preview.balance?.sufficient !== false)}
      error={error ?? typesError}
      onClose={onClose}
      onSubmit={() => void (preview ? record() : runPreview())}
    >
      <AssignmentIdPicker
        label="Employee"
        organizationId={organization.id}
        required
        value={assignmentId}
        initialEmployeeId={initialEmployeeId}
        onChange={changed(setAssignmentId)}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={fieldLabel} htmlFor={`${id}-type`}>
          Leave type
          <select
            id={`${id}-type`}
            className={inputClass}
            value={typeId}
            disabled={!types?.length}
            onChange={(event) => changed(setLeaveTypeId)(event.currentTarget.value)}
          >
            {(types ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
        <div />
        <label className={fieldLabel} htmlFor={`${id}-start`}>
          First day
          <input
            id={`${id}-start`}
            type="date"
            required
            className={inputClass}
            value={startDate}
            onChange={(event) => changed(setStartDate)(event.currentTarget.value)}
          />
        </label>
        <label className={fieldLabel} htmlFor={`${id}-end`}>
          Last day
          <input
            id={`${id}-end`}
            type="date"
            className={inputClass}
            min={startDate || undefined}
            value={endDate}
            aria-invalid={!ordered}
            onChange={(event) => changed(setEndDate)(event.currentTarget.value)}
          />
        </label>
        <label className={`${fieldLabel} sm:col-span-2`} htmlFor={`${id}-reason`}>
          Reason (optional, visible to the employee and approvers)
          <input
            id={`${id}-reason`}
            maxLength={2000}
            className={inputClass}
            value={reason}
            onChange={(event) => changed(setReason)(event.currentTarget.value)}
          />
        </label>
      </div>
      {!ordered && (
        <p role="alert" className="text-sm text-rose-800">
          The last day cannot be before the first day.
        </p>
      )}
      {preview && (
        <section aria-label="Leave preview" className="space-y-2 rounded-lg bg-slate-50 p-3">
          <p className="text-sm font-medium text-slate-900">
            {formatLeaveAmount(preview.totalMinutes, preview.leaveType.displayUnit)} over{' '}
            {preview.days.filter((day) => day.minutes > 0).length} day(s)
          </p>
          <LeaveDaysTable days={preview.days} timezone={preview.timezone} />
          {preview.balance && (
            <p
              className={`text-sm ${preview.balance.sufficient ? 'text-slate-700' : 'font-semibold text-rose-800'}`}
            >
              {preview.balance.sufficient
                ? `Balance after this leave: ${formatLeaveAmount(preview.balance.availableAfterMinutes, preview.leaveType.displayUnit)}.`
                : 'The balance is not sufficient for this leave.'}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={approve}
              onChange={(event) => setApprove(event.currentTarget.checked)}
            />
            Approve now
          </label>
          {approve && (
            <label className={fieldLabel} htmlFor={`${id}-note`}>
              Approval note (optional)
              <input
                id={`${id}-note`}
                maxLength={2000}
                className={inputClass}
                value={note}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
            </label>
          )}
        </section>
      )}
    </FormDialog>
  );
}

/**
 * Batch 6B — "which policy applies?": for an employee's assignment, a leave type and a date, the
 * policy that resolves (most specific scope wins) and whether the employee is eligible.
 */
export function PolicyResolverPanel({ organization }: { organization: LeaveOrganization }) {
  const id = useId();
  const { types, error: typesError } = useLeaveTypes(organization.id);
  const [assignmentId, setAssignmentId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [result, setResult] = useState<ResolvedLeavePolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typeId = leaveTypeId || types?.[0]?.id || '';

  async function resolve() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await leaveApi.resolvePolicy({
          employmentAssignmentId: assignmentId,
          leaveTypeId: typeId,
          date,
        }),
      );
    } catch (cause) {
      setError(leaveErrorMessage(cause, 'Unable to resolve the policy.'));
    } finally {
      setBusy(false);
    }
  }

  const policy = result?.policy;
  return (
    <Panel title="Which policy applies?">
      <form
        aria-label="Which policy applies"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void resolve();
        }}
      >
        <AssignmentIdPicker
          label="Employee"
          organizationId={organization.id}
          required
          value={assignmentId}
          onChange={(value) => {
            setAssignmentId(value);
            setResult(null);
          }}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className={fieldLabel} htmlFor={`${id}-type`}>
            Leave type
            <select
              id={`${id}-type`}
              className={inputClass}
              value={typeId}
              onChange={(event) => {
                setLeaveTypeId(event.currentTarget.value);
                setResult(null);
              }}
            >
              {(types ?? []).map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>
          <label className={fieldLabel} htmlFor={`${id}-date`}>
            Date
            <input
              id={`${id}-date`}
              type="date"
              required
              className={inputClass}
              value={date}
              onChange={(event) => {
                setDate(event.currentTarget.value);
                setResult(null);
              }}
            />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              className={primaryButton}
              disabled={busy || !assignmentId || !typeId || !date}
            >
              {busy ? 'Checking…' : 'Check'}
            </button>
          </div>
        </div>
      </form>
      {(error ?? typesError) && (
        <p role="alert" className="mt-3 text-sm text-rose-800">
          {error ?? typesError}
        </p>
      )}
      {result && (
        <div role="status" className="mt-4 space-y-2 text-sm text-slate-800">
          {!policy ? (
            <EmptyState>
              No policy applies to this assignment for this leave type on{' '}
              {formatDateOnly(result.date)}.
            </EmptyState>
          ) : (
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-slate-600">Policy</dt>
                <dd className="font-medium">{policy.name ?? label(policy.scopeType)}</dd>
              </div>
              <div>
                <dt className="text-slate-600">Scope</dt>
                <dd className="font-medium">{label(policy.scopeType)}</dd>
              </div>
              <div>
                <dt className="text-slate-600">Effective</dt>
                <dd className="font-medium">
                  {formatDateOnly(policy.effectiveFrom)} –{' '}
                  {policy.effectiveTo ? formatDateOnly(policy.effectiveTo) : 'ongoing'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-600">Eligible</dt>
                <dd className="font-medium">
                  {result.eligible
                    ? 'Yes'
                    : 'No — the policy makes this employee ineligible on this date'}
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </Panel>
  );
}
