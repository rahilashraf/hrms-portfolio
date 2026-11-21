'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { employeeApi } from '../../lib/employee/api';
import type { EmployeeAssignmentView } from '../../lib/employee/types';
import { employeeSource } from '../../lib/pickers/sources';
import { displayName } from '../employee/employee-shared';
import { FormField } from './form/form-field';
import { RecordCombobox } from './record-combobox';
import { inputClass } from './tokens';

function assignmentText(assignment: EmployeeAssignmentView): string {
  return [
    assignment.position.name,
    assignment.organization.name,
    assignment.isPrimary ? 'primary' : null,
    assignment.status === 'PLANNED' ? `starts ${assignment.startDate}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Batch 3B — choose an employment assignment by searching the employee, then picking one of
 * their current or upcoming assignments (assignments in another organization are shown but not
 * selectable when `organizationId` is given). Users who cannot search employees, or who have
 * the identifier at hand, can type the assignment ID instead. The value is the assignment id.
 */
export function AssignmentIdPicker({
  label,
  organizationId,
  value,
  onChange,
  required = false,
  hint,
  initialEmployeeId,
}: {
  label: string;
  organizationId?: string;
  value: string;
  onChange(assignmentId: string): void;
  required?: boolean;
  hint?: string;
  /** Batch 5C: an employee chosen elsewhere (e.g. a link from their profile). */
  initialEmployeeId?: string;
}) {
  const selectId = useId();
  const [employeeId, setEmployeeId] = useState(initialEmployeeId ?? '');
  const [employeeOption, setEmployeeOption] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [assignments, setAssignments] = useState<EmployeeAssignmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const source = useMemo(
    () => employeeSource({ organizationId, status: 'ACTIVE' }),
    [organizationId],
  );

  useEffect(() => {
    if (!employeeId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      employeeApi
        .get(employeeId)
        .then((profile) => {
          if (!active) return;
          setAssignments([...profile.assignments.current, ...profile.assignments.upcoming]);
          setEmployeeOption({ id: profile.id, label: displayName(profile.person) });
        })
        .catch(() => {
          if (active) setError('This employee’s assignments could not be loaded.');
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [employeeId]);

  if (manual) {
    return (
      <div>
        <FormField label={`${label} (assignment ID)`} hint={hint} required={required}>
          {(control) => (
            <input
              {...control}
              className={`${inputClass} font-mono`}
              value={value}
              onChange={(event) => onChange(event.target.value.trim())}
            />
          )}
        </FormField>
        <button
          type="button"
          className="mt-1 text-xs font-medium text-[var(--hrms-accent-text)] underline"
          onClick={() => {
            setManual(false);
            onChange('');
          }}
        >
          Search employees instead
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <RecordCombobox
        label={`${label} — employee`}
        hint={hint}
        required={required}
        source={source}
        value={employeeId}
        selected={employeeOption}
        placeholder="Name or employee number"
        noResultsText="No active employees match."
        onChange={(id) => {
          setEmployeeId(id);
          setAssignments(null);
          setError(null);
          onChange('');
        }}
      />
      {employeeId && (
        <div>
          <label htmlFor={selectId} className="block text-sm font-medium text-slate-800">
            {label} — assignment
          </label>
          {assignments === null && !error ? (
            <p role="status" className="mt-1 text-sm text-slate-600">
              Loading assignments…
            </p>
          ) : (
            <select
              id={selectId}
              className={inputClass}
              required={required}
              value={value}
              onChange={(event) => onChange(event.target.value)}
            >
              <option value="">Choose the assignment…</option>
              {(assignments ?? []).map((assignment) => {
                const elsewhere =
                  organizationId !== undefined && assignment.organization.id !== organizationId;
                return (
                  <option key={assignment.id} value={assignment.id} disabled={elsewhere}>
                    {assignmentText(assignment)}
                    {elsewhere ? ' (other organization)' : ''}
                  </option>
                );
              })}
            </select>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-800">
          {error}
        </p>
      )}
      <button
        type="button"
        className="text-xs font-medium text-[var(--hrms-accent-text)] underline"
        onClick={() => {
          setManual(true);
          setEmployeeId('');
          onChange('');
        }}
      >
        Enter an assignment ID instead
      </button>
    </div>
  );
}
