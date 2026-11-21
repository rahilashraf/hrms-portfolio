'use client';

import type { FormEvent } from 'react';
import { useState } from 'react';
import { payrollApi } from '../../../lib/payroll/api';
import { formatDateOnly, formatMoney, isValidAmount, label } from '../../../lib/payroll/format';
import type { ManualLineKind, PayrollEmployeeDetail } from '../../../lib/payroll/types';
import { DataTable } from '../../ui/data-table';
import { EmptyState, inputClass, primaryButton, secondaryButton } from '../payroll-shared';

// Batch 10D: earnings, deductions and manual lines of one employee (moved from
// payroll-run-page.tsx unchanged). Amounts are the API's; nothing is recalculated here.
function ReverseButton({
  disabled,
  onReverse,
}: {
  disabled: boolean;
  onReverse(reason: string): Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        className={secondaryButton}
        onClick={() => setOpen(true)}
      >
        Reverse
      </button>
    );
  }
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void onReverse(reason).then((ok) => ok && setOpen(false));
      }}
    >
      <input
        aria-label="Reversal reason"
        required
        className="min-h-8 rounded-lg border border-slate-300 px-2 py-1 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
        value={reason}
        onChange={(event) => setReason(event.currentTarget.value)}
      />
      <button type="submit" disabled={disabled} className={secondaryButton}>
        Confirm
      </button>
    </form>
  );
}

type Reverse = (lineId: string, kind: ManualLineKind, reason: string) => Promise<boolean>;

export function EarningsTab({
  employee,
  currency,
  canEdit,
  busy,
  onReverse,
}: {
  employee: PayrollEmployeeDetail;
  currency: string;
  canEdit: boolean;
  busy: boolean;
  onReverse: Reverse;
}) {
  const lines = employee.assignments.flatMap((assignment) =>
    assignment.earnings.map((line) => ({ ...line, positionName: assignment.positionName })),
  );
  const reversed = new Set(lines.map((line) => line.reversesLineId).filter(Boolean));
  if (lines.length === 0) return <EmptyState>No earnings for this employee.</EmptyState>;
  return (
    <DataTable
      label="Earnings"
      minWidth="min-w-[880px]"
      rows={lines}
      rowKey={(line) => line.id}
      columns={[
        {
          key: 'earning',
          header: 'Earning',
          cell: (line) => (
            <>
              {line.description}
              <span className="block text-xs text-slate-500">
                {label(line.type)} · {line.positionName}
              </span>
            </>
          ),
        },
        {
          key: 'date',
          header: 'Date',
          cell: (line) =>
            line.workDate
              ? formatDateOnly(line.workDate)
              : line.periodFrom
                ? `${formatDateOnly(line.periodFrom)} – ${formatDateOnly(line.periodTo)}`
                : '—',
        },
        {
          key: 'quantity',
          header: 'Quantity',
          cell: (line) => (line.quantity ? `${line.quantity} ${label(line.quantityUnit)}` : '—'),
        },
        { key: 'rate', header: 'Rate', cell: (line) => line.rateAmount ?? '—' },
        { key: 'amount', header: 'Amount', cell: (line) => formatMoney(line.amount, currency) },
        {
          key: 'source',
          header: 'Source',
          cell: (line) => (
            <>
              {label(line.origin)}
              {line.reason && <span className="block text-xs text-slate-500">{line.reason}</span>}
            </>
          ),
        },
        {
          key: 'actions',
          header: <span className="sr-only">Actions</span>,
          cell: (line) =>
            canEdit &&
            line.origin === 'MANUAL' &&
            !line.reversesLineId &&
            !reversed.has(line.id) && (
              <ReverseButton
                disabled={busy}
                onReverse={(reason) => onReverse(line.id, 'EARNING', reason)}
              />
            ),
        },
      ]}
    />
  );
}

export function DeductionsTab({
  employee,
  currency,
  canEdit,
  busy,
  onReverse,
}: {
  employee: PayrollEmployeeDetail;
  currency: string;
  canEdit: boolean;
  busy: boolean;
  onReverse: Reverse;
}) {
  const rows = employee.assignments.flatMap((assignment) => [
    ...assignment.deductions.map((line) => ({ ...line, kind: 'DEDUCTION' as const })),
    ...assignment.employerContributions.map((line) => ({ ...line, kind: 'CONTRIBUTION' as const })),
  ]);
  const reversed = new Set(rows.map((line) => line.reversesLineId).filter(Boolean));
  if (rows.length === 0) {
    return (
      <EmptyState>
        No deductions or employer contributions. Statutory deductions are not calculated.
      </EmptyState>
    );
  }
  return (
    <DataTable
      label="Deductions and employer contributions"
      minWidth="min-w-[720px]"
      rows={rows}
      rowKey={(line) => line.id}
      columns={[
        {
          key: 'line',
          header: 'Line',
          cell: (line) => (
            <>
              {line.description}
              {line.reason && <span className="block text-xs text-slate-500">{line.reason}</span>}
            </>
          ),
        },
        {
          key: 'kind',
          header: 'Kind',
          cell: (line) => (line.kind === 'DEDUCTION' ? 'Deduction' : 'Employer contribution'),
        },
        {
          key: 'category',
          header: 'Category',
          cell: (line) => (
            <>
              {label(line.category)}
              {line.code && <span className="block text-xs text-slate-500">{line.code}</span>}
            </>
          ),
        },
        { key: 'amount', header: 'Amount', cell: (line) => formatMoney(line.amount, currency) },
        {
          key: 'actions',
          header: <span className="sr-only">Actions</span>,
          cell: (line) =>
            canEdit &&
            line.category === 'MANUAL' &&
            !line.reversesLineId &&
            !reversed.has(line.id) && (
              <ReverseButton
                disabled={busy}
                onReverse={(reason) => onReverse(line.id, line.kind, reason)}
              />
            ),
        },
      ]}
    />
  );
}

export function ManualLineForm({
  employee,
  defaultKind,
  busy,
  onSubmit,
}: {
  employee: PayrollEmployeeDetail;
  defaultKind: ManualLineKind;
  busy: boolean;
  onSubmit(input: Parameters<typeof payrollApi.addManualLine>[1]): Promise<boolean>;
}) {
  const [kind, setKind] = useState<ManualLineKind>(defaultKind);
  const [assignmentId, setAssignmentId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isValidAmount(amount)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const ok = await onSubmit({
      payrollRunAssignmentId: assignmentId || employee.assignments[0]!.id,
      kind,
      amount: amount.trim(),
      description,
      reason,
    });
    if (ok) {
      setAmount('');
      setDescription('');
      setReason('');
    }
  }

  return (
    <form
      aria-label="Add manual line"
      onSubmit={(event) => void submit(event)}
      className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
    >
      <label className="text-sm font-medium text-slate-800">
        Kind
        <select
          className={inputClass}
          value={kind}
          onChange={(e) => setKind(e.currentTarget.value as ManualLineKind)}
        >
          <option value="EARNING">Earning</option>
          <option value="DEDUCTION">Deduction</option>
          <option value="CONTRIBUTION">Employer contribution</option>
        </select>
      </label>
      <label className="text-sm font-medium text-slate-800">
        Assignment
        <select
          className={inputClass}
          value={assignmentId || employee.assignments[0]?.id}
          onChange={(e) => setAssignmentId(e.currentTarget.value)}
        >
          {employee.assignments.map((assignment) => (
            <option key={assignment.id} value={assignment.id}>
              {assignment.positionName}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium text-slate-800">
        Amount
        <input
          required
          inputMode="decimal"
          className={inputClass}
          value={amount}
          aria-invalid={invalid}
          onChange={(e) => setAmount(e.currentTarget.value)}
        />
      </label>
      <label className="text-sm font-medium text-slate-800 sm:col-span-1">
        Description
        <input
          required
          className={inputClass}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </label>
      <label className="text-sm font-medium text-slate-800 sm:col-span-2">
        Reason
        <input
          required
          className={inputClass}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
      </label>
      {invalid && (
        <p role="alert" className="text-sm text-rose-800 sm:col-span-3">
          Enter a positive amount with at most two decimals.
        </p>
      )}
      <div>
        <button type="submit" disabled={busy} className={primaryButton}>
          Add line
        </button>
      </div>
    </form>
  );
}
