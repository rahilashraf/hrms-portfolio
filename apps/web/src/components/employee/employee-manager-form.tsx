'use client';

import { useState, type FormEvent } from 'react';
import type {
  EmployeeAssignmentView,
  EmployeeManagerAssignmentOption,
} from '../../lib/employee/types';
import { ErrorBanner } from '../organization/shared';
import { buttonClass } from '../ui/button';
import { EmployeeManagerPicker } from './employee-manager-picker';

/**
 * Batch 10B: the profile's manager forms, moved out of `employee-profile.tsx` unchanged except
 * for the shared button styles. The profile keeps the state and the API calls.
 */
export function AssignmentManagerForm({
  assignment,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  assignment: EmployeeAssignmentView;
  busy: boolean;
  error: string | null;
  onSubmit(manager: EmployeeManagerAssignmentOption): Promise<void>;
  onCancel(): void;
}) {
  const [selected, setSelected] = useState<EmployeeManagerAssignmentOption | null>(null);
  const [validation, setValidation] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) {
      setValidation('Manager assignment is required.');
      return;
    }
    setValidation(null);
    await onSubmit(selected);
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h3 className="text-base font-semibold text-slate-950">
        {assignment.manager ? 'Change manager' : 'Set manager'}
      </h3>
      <form onSubmit={submit} className="mt-4 space-y-5">
        {(error || validation) && <ErrorBanner>{error ?? validation}</ErrorBanner>}
        <EmployeeManagerPicker
          subordinateAssignmentId={assignment.id}
          selected={selected}
          onSelect={setSelected}
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={buttonClass('secondary')}
          >
            Cancel
          </button>
          <button type="submit" disabled={busy} className={buttonClass('primary')}>
            {busy ? 'Saving...' : 'Save manager'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function AssignmentManagerClearConfirm({
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
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h3 className="text-base font-semibold text-slate-950">Clear manager</h3>
      <div className="mt-4 space-y-5">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <p className="text-sm text-slate-600">
          This clears the manager from this assignment and preserves the assignment history.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={buttonClass('secondary')}
          >
            Keep manager
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onConfirm()}
            className={buttonClass('destructive')}
          >
            {busy ? 'Clearing...' : 'Clear manager'}
          </button>
        </div>
      </div>
    </section>
  );
}
