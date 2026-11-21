'use client';

import { useMemo } from 'react';
import { employeeApi } from '../../lib/employee/api';
import { employeeActionErrorMessage } from '../../lib/employee/errors';
import type { EmployeePositionOption } from '../../lib/employee/types';
import type { RecordSource } from '../../lib/pickers/use-record-search';
import { SearchPickList } from '../ui/search-pick-list';

const optionLimit = 10;

/** Positions the user may staff (GET /employees/options/positions), searched and paged. */
export function EmployeePositionPicker({
  selected,
  onSelect,
}: {
  selected: EmployeePositionOption | null;
  onSelect(position: EmployeePositionOption): void;
}) {
  const source = useMemo<RecordSource<EmployeePositionOption>>(
    () => ({
      async search(query, cursor) {
        const result = await employeeApi.listPositionOptions({
          ...(query ? { search: query } : {}),
          limit: optionLimit,
          ...(cursor ? { afterId: cursor } : {}),
        });
        return { items: result.items, next: result.nextAfterId };
      },
    }),
    [],
  );
  return (
    <SearchPickList
      searchLabel="Search positions"
      placeholder="Search by position, job title, or organization"
      source={source}
      getKey={(position) => position.id}
      isSelected={(position) => selected?.id === position.id}
      emptyText="No manageable positions are currently available."
      loadMoreLabel="Load more positions"
      describeError={describePositionError}
      onSelect={onSelect}
      renderItem={(position) => (
        <>
          <span className="block font-medium text-slate-950">
            {position.name}{' '}
            <span className="font-mono text-xs text-slate-600">{position.code}</span>
          </span>
          <span className="block text-slate-600">
            {position.jobTitle.name} · {position.organization.name}
          </span>
          <span className="block text-xs text-slate-600">
            {[placementLabel(position), position.workLocation?.name].filter(Boolean).join(' · ')}
          </span>
        </>
      )}
    />
  );
}

const describePositionError = (cause: unknown) =>
  employeeActionErrorMessage(cause, 'Unable to load positions.');

function placementLabel(position: EmployeePositionOption): string | null {
  if (!position.placement) return null;
  if (position.placement.type === 'TEAM') return `Team: ${position.placement.name}`;
  if (position.placement.type === 'DEPARTMENT') return `Department: ${position.placement.name}`;
  return `Business unit: ${position.placement.name}`;
}
