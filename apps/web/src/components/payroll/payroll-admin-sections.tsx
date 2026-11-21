'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { DataTable } from '../ui/data-table';
import { FormDialog } from '../ui/form-dialog';
import { useConfirmWithReason } from '../ui/use-confirm';
import { payrollApi } from '../../lib/payroll/api';
import { payrollErrorMessage } from '../../lib/payroll/errors';
import { formatDateOnly, formatMoney, isValidAmount, label } from '../../lib/payroll/format';
import type {
  PayGroupMember,
  PayrollAdjustment,
  PayrollAdjustmentStatus,
  PayrollCadence,
  PayrollCalendar,
  PayrollPayGroup,
  PayrollPeriod,
} from '../../lib/payroll/types';
import { EmptyState, inputClass, primaryButton, secondaryButton } from './payroll-shared';

export const CADENCES: PayrollCadence[] = ['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY'];

const fieldLabel = 'block text-sm font-medium text-slate-800';

/** The end of the calendar's last generated period (the earliest date it may end), if any. */
export function lastPeriodEnd(calendar: PayrollCalendar, periods: PayrollPeriod[]): string | null {
  return periods
    .filter((period) => period.payrollCalendarId === calendar.id)
    .reduce<string | null>(
      (last, period) => (last === null || period.periodEnd > last ? period.periodEnd : last),
      null,
    );
}

/**
 * Batch 6A — edits a pay calendar's rules. The API allows it only while the calendar has no
 * generated periods (`actions.canUpdate`); afterwards the calendar is ended and replaced.
 */
export function EditCalendarDialog({
  calendar,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  calendar: PayrollCalendar;
  busy: boolean;
  error: string | null;
  onSubmit(input: Parameters<typeof payrollApi.updateCalendar>[1]): void;
  onClose(): void;
}) {
  const [form, setForm] = useState({
    cadence: calendar.cadence,
    timezone: calendar.timezone,
    anchorDate: calendar.anchorDate,
    payDateOffsetDays: String(calendar.payDateOffsetDays),
    processingCutoffOffsetDays: String(calendar.processingCutoffOffsetDays),
    effectiveFrom: calendar.effectiveFrom,
    effectiveTo: calendar.effectiveTo ?? '',
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const whole = (value: string) => /^\d{1,3}$/.test(value.trim());
  const valid =
    form.timezone.trim() !== '' &&
    form.anchorDate !== '' &&
    form.effectiveFrom !== '' &&
    whole(form.payDateOffsetDays) &&
    whole(form.processingCutoffOffsetDays) &&
    (form.effectiveTo === '' || form.effectiveTo >= form.effectiveFrom);
  const id = useId();
  return (
    <FormDialog
      open
      title={`Edit ${calendar.payGroup?.name ?? 'pay'} calendar`}
      description="A calendar's rules can change only until its first pay periods are generated."
      submitLabel="Save calendar"
      busy={busy}
      canSubmit={valid}
      error={error}
      size="lg"
      onClose={onClose}
      onSubmit={() =>
        onSubmit({
          cadence: form.cadence,
          timezone: form.timezone.trim(),
          anchorDate: form.anchorDate,
          payDateOffsetDays: Number(form.payDateOffsetDays),
          processingCutoffOffsetDays: Number(form.processingCutoffOffsetDays),
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || null,
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldLabel} htmlFor={`${id}-cadence`}>
          Cadence
          <select
            id={`${id}-cadence`}
            className={inputClass}
            value={form.cadence}
            onChange={(event) => set('cadence')(event.currentTarget.value)}
          >
            {CADENCES.map((cadence) => (
              <option key={cadence} value={cadence}>
                {label(cadence)}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldLabel} htmlFor={`${id}-timezone`}>
          Time zone
          <input
            id={`${id}-timezone`}
            required
            className={inputClass}
            value={form.timezone}
            onChange={(event) => set('timezone')(event.currentTarget.value)}
          />
        </label>
        <label className={fieldLabel} htmlFor={`${id}-anchor`}>
          First period starts
          <input
            id={`${id}-anchor`}
            required
            type="date"
            className={inputClass}
            value={form.anchorDate}
            onChange={(event) => set('anchorDate')(event.currentTarget.value)}
          />
        </label>
        <label className={fieldLabel} htmlFor={`${id}-pay-offset`}>
          Pay date offset (days)
          <input
            id={`${id}-pay-offset`}
            required
            inputMode="numeric"
            className={inputClass}
            value={form.payDateOffsetDays}
            onChange={(event) => set('payDateOffsetDays')(event.currentTarget.value)}
          />
        </label>
        <label className={fieldLabel} htmlFor={`${id}-cutoff`}>
          Cutoff before pay date (days)
          <input
            id={`${id}-cutoff`}
            required
            inputMode="numeric"
            className={inputClass}
            value={form.processingCutoffOffsetDays}
            onChange={(event) => set('processingCutoffOffsetDays')(event.currentTarget.value)}
          />
        </label>
        <label className={fieldLabel} htmlFor={`${id}-from`}>
          Effective from
          <input
            id={`${id}-from`}
            required
            type="date"
            className={inputClass}
            value={form.effectiveFrom}
            onChange={(event) => set('effectiveFrom')(event.currentTarget.value)}
          />
        </label>
        <label className={fieldLabel} htmlFor={`${id}-to`}>
          Effective to (optional)
          <input
            id={`${id}-to`}
            type="date"
            className={inputClass}
            min={form.effectiveFrom || undefined}
            value={form.effectiveTo}
            onChange={(event) => set('effectiveTo')(event.currentTarget.value)}
          />
        </label>
      </div>
    </FormDialog>
  );
}

/**
 * Batch 6A — ends a pay calendar (the confirmation). A calendar with generated periods can end
 * no earlier than its last period's end; its periods and runs are kept.
 */
export function EndCalendarDialog({
  calendar,
  periods,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  calendar: PayrollCalendar;
  periods: PayrollPeriod[];
  busy: boolean;
  error: string | null;
  onSubmit(effectiveTo: string): void;
  onClose(): void;
}) {
  const last = lastPeriodEnd(calendar, periods);
  const earliest = last ?? calendar.effectiveFrom;
  const [effectiveTo, setEffectiveTo] = useState(calendar.effectiveTo ?? '');
  const id = useId();
  const tooEarly = effectiveTo !== '' && effectiveTo < earliest;
  const count = calendar.periodCount;
  return (
    <FormDialog
      open
      tone="destructive"
      title={`End the ${calendar.payGroup?.name ?? 'pay'} calendar?`}
      description={
        count > 0 ? (
          <>
            {count} pay period{count === 1 ? ' has' : 's have'} been generated
            {last ? `, the last ending ${formatDateOnly(last)}` : ''}. The calendar can end no
            earlier than that. Existing periods and runs are kept; no periods are generated after
            the end date. Add a new calendar to continue paying this pay group.
          </>
        ) : (
          <>
            No pay periods have been generated from this calendar. Ending it stops periods from
            being generated after the end date.
          </>
        )
      }
      submitLabel="End calendar"
      busy={busy}
      canSubmit={effectiveTo !== '' && !tooEarly}
      error={error}
      onClose={onClose}
      onSubmit={() => onSubmit(effectiveTo)}
    >
      <label className={fieldLabel} htmlFor={`${id}-end`}>
        Last day of the calendar
        <input
          id={`${id}-end`}
          required
          type="date"
          className={inputClass}
          min={earliest}
          value={effectiveTo}
          aria-invalid={tooEarly}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setEffectiveTo(event.currentTarget.value)}
        />
      </label>
      <p id={`${id}-hint`} className="text-sm text-slate-600">
        {tooEarly
          ? `Choose ${formatDateOnly(earliest)} or later.`
          : `Earliest allowed: ${formatDateOnly(earliest)}.`}
      </p>
    </FormDialog>
  );
}

const STATUS_FILTERS: ReadonlyArray<{ id: PayrollAdjustmentStatus | ''; label: string }> = [
  { id: 'PENDING', label: 'Pending' },
  { id: 'APPLIED', label: 'Applied' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: '', label: 'All' },
];

/**
 * Batch 6A — off-cycle adjustments: a one-off earning or deduction for an employee's assignment
 * in a pay group, carried by the pay group's next run in the chosen currency when it is
 * calculated. Pending adjustments can be cancelled (with a reason); applied ones are history.
 */
export function AdjustmentsSection({
  organizationId,
  payGroups,
  canAdjust,
  onChanged,
}: {
  organizationId: string;
  payGroups: PayrollPayGroup[];
  canAdjust: boolean;
  onChanged(): void;
}) {
  const [status, setStatus] = useState<PayrollAdjustmentStatus | ''>('PENDING');
  const [items, setItems] = useState<PayrollAdjustment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, cancelDialog] = useConfirmWithReason();
  const groupName = (id: string) => payGroups.find((group) => group.id === id)?.name ?? '—';

  const load = useCallback(async () => {
    try {
      setItems((await payrollApi.adjustments(organizationId, status ? { status } : {})).items);
      setError(null);
    } catch (cause) {
      setItems([]);
      setError(payrollErrorMessage(cause, 'Unable to load adjustments.'));
    }
  }, [organizationId, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function cancel(adjustment: PayrollAdjustment) {
    const reason = await confirmCancel({
      title: 'Cancel this adjustment?',
      description: `${adjustment.description} — ${formatMoney(adjustment.amount, adjustment.currency)} ${adjustment.kind === 'EARNING' ? 'earning' : 'deduction'} for ${adjustment.displayName ?? 'the employee'}. ${
        adjustment.payrollRunId
          ? 'It is carried by a run that has not been approved: it is removed from that run, which must be recalculated before approval.'
          : 'It will not be paid.'
      }`,
      confirmLabel: 'Cancel adjustment',
      cancelLabel: 'Keep it',
      destructive: true,
      reason: { label: 'Reason', required: true },
    });
    if (reason === null) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await payrollApi.cancelAdjustment(adjustment.id, reason);
      setSuccess('Adjustment cancelled.');
      await load();
      onChanged();
    } catch (cause) {
      setError(payrollErrorMessage(cause, 'Unable to cancel the adjustment.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">
        Off-cycle adjustments are one-off earnings or deductions, paid by the pay group&apos;s next
        run in their currency when that run is calculated. Corrections of a finalized run are
        created from the run&apos;s Adjustments tab.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className={fieldLabel}>
          Show
          <select
            className={inputClass}
            value={status}
            onChange={(event) =>
              setStatus(event.currentTarget.value as PayrollAdjustmentStatus | '')
            }
          >
            {STATUS_FILTERS.map((filter) => (
              <option key={filter.label} value={filter.id}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>
        {canAdjust && (
          <button
            type="button"
            className={primaryButton}
            disabled={payGroups.every((group) => group.archived)}
            onClick={() => setCreating(true)}
          >
            New adjustment
          </button>
        )}
      </div>
      {items === null ? (
        <p role="status" className="text-sm text-slate-600">
          Loading adjustments…
        </p>
      ) : items.length === 0 ? (
        <EmptyState>No adjustments.</EmptyState>
      ) : (
        <DataTable
          label="Adjustments"
          minWidth="min-w-[880px]"
          rows={items}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'employee',
              header: 'Employee',
              rowHeader: true,
              cell: (row) => (
                <>
                  {row.displayName ?? '—'}
                  <span className="block text-xs text-slate-600">
                    {[row.employeeNumber, row.positionName].filter(Boolean).join(' · ')}
                  </span>
                </>
              ),
            },
            { key: 'payGroup', header: 'Pay group', cell: (row) => groupName(row.payGroupId) },
            {
              key: 'description',
              header: 'Description',
              cell: (row) => (
                <>
                  {row.description}
                  <span className="block text-xs text-slate-600">{row.reason}</span>
                </>
              ),
            },
            {
              key: 'kind',
              header: 'Kind',
              cell: (row) => (
                <>
                  {label(row.kind)}
                  {row.retroactive && (
                    <span className="block text-xs text-slate-600">Retroactive</span>
                  )}
                </>
              ),
            },
            {
              key: 'amount',
              header: 'Amount',
              className: 'whitespace-nowrap',
              cell: (row) => formatMoney(row.amount, row.currency),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (row) => (
                <>
                  {label(row.status)}
                  {row.status === 'PENDING' && row.payrollRunId && (
                    <span className="block text-xs text-slate-600">In a run</span>
                  )}
                </>
              ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (row) =>
                canAdjust &&
                row.status === 'PENDING' && (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy}
                    aria-label={`Cancel adjustment ${row.description} for ${row.displayName ?? 'employee'}`}
                    onClick={() => void cancel(row)}
                  >
                    Cancel
                  </button>
                ),
            },
          ]}
        />
      )}
      {cancelDialog}
      {creating && (
        <NewAdjustmentDialog
          payGroups={payGroups.filter((group) => !group.archived)}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            setSuccess(
              'Adjustment created. It is paid by the next calculated run of the pay group.',
            );
            setStatus('PENDING');
            await load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function NewAdjustmentDialog({
  payGroups,
  onClose,
  onCreated,
}: {
  payGroups: PayrollPayGroup[];
  onClose(): void;
  onCreated(): Promise<void>;
}) {
  const id = useId();
  const [payGroupId, setPayGroupId] = useState(payGroups[0]?.id ?? '');
  const [members, setMembers] = useState<PayGroupMember[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [assignmentId, setAssignmentId] = useState('');
  const [currency, setCurrency] = useState('');
  const [kind, setKind] = useState<'EARNING' | 'DEDUCTION'>('EARNING');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!payGroupId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setMembers(null);
      setMembersError(null);
      payrollApi
        .payGroupMembers(payGroupId)
        .then((result) => {
          if (!active) return;
          setMembers(result.items);
          const first = result.items[0];
          setAssignmentId(first?.employmentAssignmentId ?? '');
          setCurrency(first?.currencies[0] ?? '');
        })
        .catch((cause) => {
          if (!active) return;
          setMembers([]);
          setMembersError(payrollErrorMessage(cause, 'Unable to load the pay group’s employees.'));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [payGroupId]);

  const member = members?.find((entry) => entry.employmentAssignmentId === assignmentId);
  const amountValid = isValidAmount(amount);
  const valid =
    Boolean(member) &&
    currency !== '' &&
    amountValid &&
    description.trim() !== '' &&
    reason.trim() !== '';

  async function submit() {
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      await payrollApi.createAdjustment({
        payGroupId,
        employmentAssignmentId: member.employmentAssignmentId,
        currency,
        kind,
        amount: amount.trim(),
        description: description.trim(),
        reason: reason.trim(),
      });
      await onCreated();
    } catch (cause) {
      setError(payrollErrorMessage(cause, 'Unable to create the adjustment.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open
      title="New off-cycle adjustment"
      description="A one-off earning or deduction, paid by the pay group's next run in the chosen currency when it is calculated."
      submitLabel="Create adjustment"
      busy={busy}
      canSubmit={valid}
      error={error}
      size="lg"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldLabel} htmlFor={`${id}-group`}>
          Pay group
          <select
            id={`${id}-group`}
            className={inputClass}
            value={payGroupId}
            onChange={(event) => setPayGroupId(event.currentTarget.value)}
          >
            {payGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name} ({group.code})
              </option>
            ))}
          </select>
        </label>
        <div>
          <label className={fieldLabel} htmlFor={`${id}-member`}>
            Employee and assignment
          </label>
          {members === null ? (
            <p role="status" className="mt-2 text-sm text-slate-600">
              Loading employees…
            </p>
          ) : membersError ? (
            <p role="alert" className="mt-2 text-sm text-rose-800">
              {membersError}
            </p>
          ) : members.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">
              Nobody is paid through this pay group yet.
            </p>
          ) : (
            <select
              id={`${id}-member`}
              className={inputClass}
              value={assignmentId}
              onChange={(event) => {
                const next = members.find(
                  (entry) => entry.employmentAssignmentId === event.currentTarget.value,
                );
                setAssignmentId(event.currentTarget.value);
                setCurrency(next?.currencies[0] ?? '');
              }}
            >
              {members.map((entry) => (
                <option key={entry.employmentAssignmentId} value={entry.employmentAssignmentId}>
                  {entry.displayName} · {entry.employeeNumber} · {entry.positionName}
                  {entry.assignmentStatus !== 'ACTIVE' ? ` (${label(entry.assignmentStatus)})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        <label className={fieldLabel} htmlFor={`${id}-currency`}>
          Currency
          <select
            id={`${id}-currency`}
            className={inputClass}
            value={currency}
            disabled={!member}
            onChange={(event) => setCurrency(event.currentTarget.value)}
          >
            {(member?.currencies ?? []).map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="text-sm font-medium text-slate-800">Kind</legend>
          <div className="mt-2 flex gap-4 text-sm text-slate-800">
            {(['EARNING', 'DEDUCTION'] as const).map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-kind`}
                  value={value}
                  checked={kind === value}
                  onChange={() => setKind(value)}
                />
                {value === 'EARNING' ? 'Earning' : 'Deduction'}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={fieldLabel} htmlFor={`${id}-amount`}>
          Amount
          <input
            id={`${id}-amount`}
            required
            inputMode="decimal"
            className={inputClass}
            value={amount}
            aria-invalid={amount !== '' && !amountValid}
            aria-describedby={`${id}-amount-hint`}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
          <span id={`${id}-amount-hint`} className="mt-1 block text-xs font-normal text-slate-600">
            A positive amount with at most two decimals
            {currency ? ` (${currency})` : ''}.
          </span>
        </label>
        <label className={fieldLabel} htmlFor={`${id}-description`}>
          Description (shown on the payslip)
          <input
            id={`${id}-description`}
            required
            maxLength={200}
            className={inputClass}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </label>
        <label className={`${fieldLabel} sm:col-span-2`} htmlFor={`${id}-reason`}>
          Reason (audit)
          <input
            id={`${id}-reason`}
            required
            maxLength={1000}
            className={inputClass}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </label>
      </div>
    </FormDialog>
  );
}
