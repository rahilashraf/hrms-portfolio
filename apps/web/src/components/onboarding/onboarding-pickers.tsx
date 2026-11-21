'use client';

import { useEffect, useMemo, useState } from 'react';
import { employeeApi } from '../../lib/employee/api';
import { onboardingOptionSource } from '../../lib/onboarding/pickers';
import type { WorkflowKind } from '../../lib/onboarding/types';
import type { PickerOption } from '../../lib/pickers/sources';
import { displayName } from '../employee/employee-shared';
import { RecordCombobox } from '../ui/record-combobox';

/**
 * Batch 7A — choose the employment to start onboarding or offboarding on, from the assignments
 * the API says the caller may start that workflow on (GET /onboarding/options, kind=assignment).
 * Needs only onboarding / offboarding permissions; offboarding lists ended assignments too.
 * A profile link may preselect an assignment: its label is read from the employee profile when
 * the caller can read it (otherwise the identifier stays visible until another is chosen).
 */
export function WorkflowAssignmentPicker({
  organizationId,
  kind,
  value,
  onChange,
  prefillEmployeeId,
}: {
  organizationId: string;
  kind: WorkflowKind;
  value: string;
  onChange(assignmentId: string): void;
  prefillEmployeeId?: string | null;
}) {
  const source = useMemo(
    () => onboardingOptionSource(organizationId, 'assignment', kind),
    [organizationId, kind],
  );
  const [selected, setSelected] = useState<PickerOption | null>(null);
  useEffect(() => {
    if (!prefillEmployeeId || !value || selected?.id === value) return;
    let active = true;
    const timer = window.setTimeout(() => {
      employeeApi
        .get(prefillEmployeeId)
        .then((profile) => {
          if (!active) return;
          const all = [
            ...profile.assignments.current,
            ...profile.assignments.upcoming,
            ...profile.assignments.historical,
          ];
          const assignment = all.find((a) => a.id === value);
          if (assignment) {
            setSelected({
              id: assignment.id,
              label: displayName(profile.person),
              description: [profile.employeeNumber, assignment.position.name]
                .filter(Boolean)
                .join(' · '),
            });
          }
        })
        .catch(() => {
          // Without employee read access the id stays; the API checks the start anyway.
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [prefillEmployeeId, value, selected]);
  return (
    <RecordCombobox
      label="Employment"
      hint={
        kind === 'OFFBOARDING'
          ? 'Employees whose offboarding you may start, including ended assignments.'
          : 'Employees whose onboarding you may start (planned or active assignments).'
      }
      required
      source={source}
      value={value}
      selected={selected}
      onChange={(id, option) => {
        setSelected(option);
        onChange(id);
      }}
      placeholder="Name or employee number"
      noResultsText="No employment you may start this on matches."
    />
  );
}

/** Batch 7A — eligible task owners (GET /onboarding/options, kind=owner). */
export function TaskOwnerPicker({
  organizationId,
  label,
  value,
  onChange,
  required = false,
  disabled = false,
}: {
  organizationId: string;
  label: string;
  value: string;
  onChange(userId: string): void;
  required?: boolean;
  disabled?: boolean;
}) {
  const source = useMemo(() => onboardingOptionSource(organizationId, 'owner'), [organizationId]);
  return (
    <RecordCombobox
      label={label}
      required={required}
      disabled={disabled}
      source={source}
      value={value}
      onChange={(id) => onChange(id)}
      placeholder="Name or employee number"
      noResultsText="No eligible owner matches (people working in this organization)."
    />
  );
}

/** Batch 7A — recruitment hires not yet onboarded (GET /onboarding/options, kind=hire). */
export function HirePicker({
  organizationId,
  value,
  onChange,
}: {
  organizationId: string;
  value: string;
  onChange(hireId: string): void;
}) {
  const source = useMemo(() => onboardingOptionSource(organizationId, 'hire'), [organizationId]);
  return (
    <RecordCombobox
      label="Hire"
      hint="Recruitment hires not yet onboarded."
      required
      source={source}
      value={value}
      onChange={(id) => onChange(id)}
      placeholder="Name or employee number"
      noResultsText="No hire awaits onboarding."
    />
  );
}
