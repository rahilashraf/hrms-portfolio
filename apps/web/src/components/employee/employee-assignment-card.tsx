'use client';

import { useState } from 'react';
import { formatDateOnly } from '../../lib/employee/date';
import type { EmployeeAssignmentView, EmployeeProfile } from '../../lib/employee/types';
import { buttonClass } from '../ui/button';
import { inputClass } from '../ui/tokens';
import { AssignmentStatusBadge, Detail, employmentTypeLabel } from './employee-shared';
import { AssignmentImpactPreview } from './lifecycle/assignment-impact-preview';

/**
 * Batch 10B: an employment assignment's summary card and its read-only impact preview, moved out
 * of `employee-profile.tsx` unchanged (the date input now uses the shared input style).
 */
const MANAGER_WARNINGS: Record<string, string> = {
  MANAGER_ASSIGNMENT_ENDED:
    'The manager’s assignment has ended. The link is kept; choose a current manager.',
  MANAGER_ORGANIZATION_MISMATCH:
    'The manager works in another organization. The link is kept from before; choose a manager in this organization.',
};

export function AssignmentCard({
  assignment,
  showWarnings = false,
}: {
  assignment: EmployeeAssignmentView;
  showWarnings?: boolean;
}) {
  const warnings = showWarnings ? (assignment.managerWarnings ?? []) : [];
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-slate-950">{assignment.position.name}</h4>
          <p className="mt-1 text-sm text-slate-600">
            {assignment.jobTitle.name} · {assignment.organization.name}
          </p>
        </div>
        <AssignmentStatusBadge status={assignment.status} />
      </div>
      <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Detail label="Employment type">{employmentTypeLabel(assignment.employmentType)}</Detail>
        <Detail label="Dates">
          {formatDateOnly(assignment.startDate)} – {formatDateOnly(assignment.endDate)}
        </Detail>
        {assignment.isPrimary && <Detail label="Primary">Primary assignment</Detail>}
        {assignment.placement && (
          <Detail
            label={
              assignment.placement.type === 'TEAM'
                ? 'Team'
                : assignment.placement.type === 'DEPARTMENT'
                  ? 'Department'
                  : 'Business unit'
            }
          >
            {assignment.placement.name}
          </Detail>
        )}
        {assignment.workLocation && (
          <Detail label="Work location">{assignment.workLocation.name}</Detail>
        )}
        {assignment.manager && (
          <Detail label="Manager">
            <span>{assignment.manager.displayName}</span>
            <span className="block text-slate-600">{assignment.manager.positionName}</span>
          </Detail>
        )}
      </dl>
      {warnings.length > 0 && (
        <ul className="mt-4 space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
              {MANAGER_WARNINGS[warning] ?? warning}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** Read-only: what ending this assignment on a chosen date would leave behind. */
export function ImpactPanel({
  profile,
  assignment,
  onClose,
}: {
  profile: EmployeeProfile;
  assignment: EmployeeAssignmentView;
  onClose(): void;
}) {
  const [endDate, setEndDate] = useState(assignment.endDate ?? '');
  const id = `impact-${assignment.id}`;
  return (
    <section
      aria-label={`Impact preview for ${assignment.position.name}`}
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label htmlFor={id} className="block text-sm font-medium text-slate-800">
            If this assignment ended on (inclusive)
          </label>
          <input
            id={id}
            type="date"
            min={assignment.startDate}
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            className={inputClass}
          />
        </div>
        <button type="button" onClick={onClose} className={buttonClass('secondary', 'sm')}>
          Close preview
        </button>
      </div>
      <AssignmentImpactPreview
        employeeId={profile.id}
        assignmentId={assignment.id}
        endDate={endDate}
      />
    </section>
  );
}
