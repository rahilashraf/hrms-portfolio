'use client';

import { useMemo } from 'react';
import { employeeApi } from '../../lib/employee/api';
import { formatDateOnly } from '../../lib/employee/date';
import { employeeManagerActionErrorMessage } from '../../lib/employee/errors';
import type { EmployeeManagerAssignmentOption } from '../../lib/employee/types';
import type { RecordSource } from '../../lib/pickers/use-record-search';
import { SearchPickList } from '../ui/search-pick-list';

const optionLimit = 10;

/** A new assignment not created yet (rehire / transfer): its position and dates. */
export interface NewAssignmentManagerTarget {
  positionId: string;
  startDate: string;
  endDate?: string;
  employeeId?: string;
}

/**
 * Assignments that may manage the given one (GET /employees/options/manager-assignments): an
 * existing assignment (`subordinateAssignmentId`) or a new one (`newAssignment`). Managers come
 * from the same organization, over overlapping dates.
 */
export function EmployeeManagerPicker({
  subordinateAssignmentId,
  newAssignment,
  selected,
  onSelect,
}: {
  subordinateAssignmentId?: string;
  newAssignment?: NewAssignmentManagerTarget;
  selected: EmployeeManagerAssignmentOption | null;
  onSelect(manager: EmployeeManagerAssignmentOption): void;
}) {
  const positionId = newAssignment?.positionId;
  const startDate = newAssignment?.startDate;
  const endDate = newAssignment?.endDate;
  const employeeId = newAssignment?.employeeId;
  const source = useMemo<RecordSource<EmployeeManagerAssignmentOption>>(
    () => ({
      async search(query, cursor) {
        const target = subordinateAssignmentId
          ? { subordinateAssignmentId }
          : {
              positionId: positionId!,
              startDate: startDate!,
              ...(endDate ? { endDate } : {}),
              ...(employeeId ? { employeeId } : {}),
            };
        const result = await employeeApi.listManagerAssignmentOptions({
          ...(query ? { search: query } : {}),
          limit: optionLimit,
          ...target,
          ...(cursor ? { afterId: cursor } : {}),
        });
        return { items: result.items, next: result.nextAfterId };
      },
    }),
    [subordinateAssignmentId, positionId, startDate, endDate, employeeId],
  );
  return (
    <SearchPickList
      searchLabel="Search manager assignments"
      placeholder="Search by manager, employee number, or position"
      source={source}
      getKey={(manager) => manager.assignmentId}
      isSelected={(manager) => selected?.assignmentId === manager.assignmentId}
      emptyText="No eligible manager assignments found."
      loadMoreLabel="Load more managers"
      describeError={describeManagerError}
      onSelect={onSelect}
      renderItem={(manager) => (
        <>
          <span className="block font-medium text-slate-950">
            {manager.displayName}{' '}
            <span className="font-mono text-xs text-slate-600">{manager.employeeNumber}</span>
          </span>
          <span className="block text-slate-600">
            {manager.position.name} · {manager.jobTitle.name} · {manager.organization.name}
          </span>
          <span className="block text-xs text-slate-600">
            {formatDateOnly(manager.startDate)} - {formatDateOnly(manager.endDate)} ·{' '}
            {manager.status.toLowerCase()}
          </span>
        </>
      )}
    />
  );
}

const describeManagerError = (cause: unknown) =>
  employeeManagerActionErrorMessage(cause, 'Unable to load manager options.');
