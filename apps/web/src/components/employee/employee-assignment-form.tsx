'use client';

import { checkboxClass } from '../ui/tokens';

import { buttonClass } from '../ui/button';
import type { FormEvent } from 'react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ErrorBanner } from '../organization/shared';
import type {
  EmployeeAssignmentCreateInput,
  EmployeeAssignmentUpdateInput,
  EmployeeAssignmentView,
  EmployeePositionOption,
  EmploymentType,
} from '../../lib/employee/types';
import { EmployeePositionPicker } from './employee-position-picker';

const employmentTypes: Array<{ value: EmploymentType; label: string }> = [
  { value: 'FULL_TIME', label: 'Full-time' },
  { value: 'PART_TIME', label: 'Part-time' },
  { value: 'CASUAL', label: 'Casual' },
  { value: 'CONTRACT', label: 'Contract' },
];

interface AssignmentFormState {
  position: EmployeePositionOption | null;
  employmentType: EmploymentType | '';
  startDate: string;
  endDate: string;
  isPrimary: boolean;
}

export function AssignmentCreateForm({
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onSubmit(input: EmployeeAssignmentCreateInput): Promise<void>;
  onCancel(): void;
}) {
  const [form, setForm] = useState<AssignmentFormState>({
    position: null,
    employmentType: '',
    startDate: '',
    endDate: '',
    isPrimary: false,
  });
  const [validation, setValidation] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = validateCreate(form);
    if (message) {
      setValidation(message);
      return;
    }
    setValidation(null);
    await onSubmit({
      positionId: form.position!.id,
      employmentType: form.employmentType as EmploymentType,
      startDate: form.startDate,
      ...(form.endDate ? { endDate: form.endDate } : {}),
      isPrimary: form.isPrimary,
    });
  }

  return (
    <AssignmentPanel title="Add assignment">
      <form onSubmit={submit} className="space-y-5">
        {(error || validation) && <ErrorBanner>{error ?? validation}</ErrorBanner>}
        <EmployeePositionPicker
          selected={form.position}
          onSelect={(position) => setForm((current) => ({ ...current, position }))}
        />
        <AssignmentFields
          employmentType={form.employmentType}
          startDate={form.startDate}
          endDate={form.endDate}
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
        />
        <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={form.isPrimary}
            onChange={(event) =>
              setForm((current) => ({ ...current, isPrimary: event.currentTarget.checked }))
            }
            className={checkboxClass}
          />
          Primary assignment
        </label>
        <FormActions
          busy={busy}
          submitLabel="Add assignment"
          busyLabel="Adding..."
          onCancel={onCancel}
        />
      </form>
    </AssignmentPanel>
  );
}

export function AssignmentCorrectForm({
  assignment,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  assignment: EmployeeAssignmentView;
  busy: boolean;
  error: string | null;
  onSubmit(input: EmployeeAssignmentUpdateInput): Promise<void>;
  onCancel(): void;
}) {
  const [form, setForm] = useState({
    employmentType: assignment.employmentType as EmploymentType | '',
    startDate: assignment.startDate,
    endDate: assignment.endDate ?? '',
  });
  const [validation, setValidation] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = validateDates(form.employmentType, form.startDate, form.endDate);
    if (message) {
      setValidation(message);
      return;
    }
    setValidation(null);
    await onSubmit({
      employmentType: form.employmentType as EmploymentType,
      startDate: form.startDate,
      ...(form.endDate ? { endDate: form.endDate } : {}),
    });
  }

  return (
    <AssignmentPanel title="Correct assignment">
      <form onSubmit={submit} className="space-y-5">
        {(error || validation) && <ErrorBanner>{error ?? validation}</ErrorBanner>}
        <AssignmentFields
          employmentType={form.employmentType}
          startDate={form.startDate}
          endDate={form.endDate}
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
        />
        <FormActions
          busy={busy}
          submitLabel="Save correction"
          busyLabel="Saving..."
          onCancel={onCancel}
        />
      </form>
    </AssignmentPanel>
  );
}

export function AssignmentEndForm({
  assignment,
  busy,
  error,
  onSubmit,
  onCancel,
  renderPreview,
}: {
  assignment: EmployeeAssignmentView;
  busy: boolean;
  error: string | null;
  onSubmit(endDate: string): Promise<void>;
  onCancel(): void;
  /** Batch 5C: what ending on the chosen date would leave behind (impact preview). */
  renderPreview?(endDate: string): ReactNode;
}) {
  const [endDate, setEndDate] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!endDate) {
      setValidation('End date is required.');
      return;
    }
    if (endDate < assignment.startDate) {
      setValidation('End date must be on or after start date.');
      return;
    }
    setValidation(null);
    await onSubmit(endDate);
  }

  return (
    <AssignmentPanel title="End assignment">
      <form onSubmit={submit} className="space-y-5">
        {(error || validation) && <ErrorBanner>{error ?? validation}</ErrorBanner>}
        <p className="text-sm text-slate-600">
          This ends the assignment and preserves its employment history. The end date is inclusive.
        </p>
        <label className="block text-sm font-medium text-slate-700">
          End date
          <input
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        {renderPreview?.(endDate)}
        <FormActions
          busy={busy}
          submitLabel="End assignment"
          busyLabel="Ending..."
          onCancel={onCancel}
        />
      </form>
    </AssignmentPanel>
  );
}

export function AssignmentCancelConfirm({
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onConfirm(): Promise<void>;
  onCancel(): void;
}) {
  return (
    <AssignmentPanel title="Cancel assignment">
      <div className="space-y-5">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <p className="text-sm text-slate-600">
          This cancels a planned assignment before it takes effect. It does not delete the
          assignment record.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={buttonClass('secondary')}
          >
            Keep assignment
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onConfirm()}
            className={buttonClass('destructive')}
          >
            {busy ? 'Cancelling...' : 'Confirm cancel'}
          </button>
        </div>
      </div>
    </AssignmentPanel>
  );
}

export function AssignmentActivateConfirm({
  assignment,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  assignment: { startDate: string; position: { name: string } };
  busy: boolean;
  error: string | null;
  onConfirm(): Promise<void>;
  onCancel(): void;
}) {
  return (
    <AssignmentPanel title="Activate assignment">
      <div className="space-y-5">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <p className="text-sm text-slate-600">
          This makes the planned {assignment.position.name} assignment active from its start date (
          {assignment.startDate}), so attendance, sign-in and corrections can be recorded for it.
          Its dates, position, manager and compensation do not change, and the activation is
          recorded in the audit log.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={buttonClass('secondary')}
          >
            Keep planned
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onConfirm()}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Activating...' : 'Confirm activation'}
          </button>
        </div>
      </div>
    </AssignmentPanel>
  );
}

export function AssignmentFields({
  employmentType,
  startDate,
  endDate,
  onChange,
}: {
  employmentType: EmploymentType | '';
  startDate: string;
  endDate: string;
  onChange(
    patch: Partial<{ employmentType: EmploymentType | ''; startDate: string; endDate: string }>,
  ): void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className="text-sm font-medium text-slate-700">
        Employment type
        <select
          value={employmentType}
          onChange={(event) =>
            onChange({ employmentType: event.target.value as EmploymentType | '' })
          }
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="">Select employment type</option>
          {employmentTypes.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700">
        Start date
        <input
          type="date"
          value={startDate}
          onChange={(event) => onChange({ startDate: event.target.value })}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        End date
        <input
          type="date"
          value={endDate}
          onChange={(event) => onChange({ endDate: event.target.value })}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
    </div>
  );
}

function AssignmentPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h3 className="text-base font-semibold text-slate-950">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function FormActions({
  busy,
  submitLabel,
  busyLabel,
  onCancel,
}: {
  busy: boolean;
  submitLabel: string;
  busyLabel: string;
  onCancel(): void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" disabled={busy} onClick={onCancel} className={buttonClass('secondary')}>
        Cancel
      </button>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        {busy ? busyLabel : submitLabel}
      </button>
    </div>
  );
}

function validateCreate(form: AssignmentFormState): string | null {
  if (!form.position) return 'Position is required.';
  return validateDates(form.employmentType, form.startDate, form.endDate);
}

function validateDates(
  employmentType: EmploymentType | '',
  startDate: string,
  endDate: string,
): string | null {
  if (!employmentType) return 'Employment type is required.';
  if (!startDate) return 'Start date is required.';
  if (endDate && endDate < startDate) return 'End date must be on or after start date.';
  return null;
}
