'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { buttonClass } from '../ui/button';
import { GRID_MAX_DAYS, schedulingApi } from '../../lib/scheduling/api';
import { schedulingErrorMessage } from '../../lib/scheduling/errors';
import type {
  Schedule,
  ScheduledHoursDimension,
  ScheduledHoursGroup,
  ScheduledHoursQuery,
} from '../../lib/scheduling/types';
import { addDays, daysBetween, formatDay, startOfWeek, todayIn } from '../../lib/scheduling/time';
import {
  EmployeeAssignmentPicker,
  Feedback,
  Field,
  Panel,
  SCHEDULE_PERMISSIONS,
  SchedulingAdminPage,
  inputClass,
  structureName,
  useStructure,
  StructureLoadError,
  type AssignmentChoice,
  type SchedulingContext,
  type Structure,
} from './scheduling-shared';
import { TableScroll } from '../ui/states';

export function ScheduledHoursPage() {
  return (
    <SchedulingAdminPage
      title="Scheduled hours"
      description="Scheduled shifts and hours over at most 62 days, grouped the way you need. Only shifts in schedules you can read are counted."
      anyOf={[SCHEDULE_PERMISSIONS.read, SCHEDULE_PERMISSIONS.manage]}
    >
      {(context) => <Report key={context.organization.id} context={context} />}
    </SchedulingAdminPage>
  );
}

export const GROUP_LABELS: Record<ScheduledHoursDimension, string> = {
  organizationalUnit: 'Business unit',
  department: 'Department',
  team: 'Team',
  workLocation: 'Work location',
  employee: 'Employee',
  employmentAssignment: 'Assignment',
  position: 'Position',
  workDate: 'Date',
  schedule: 'Schedule',
  status: 'Shift status',
  sourceType: 'Source',
  organization: 'Organization',
};

export function hours(minutes: number): string {
  return (minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 2);
}

function groupLabel(
  groupBy: ScheduledHoursDimension,
  key: string | null,
  structure: Structure,
  schedules: Schedule[],
  organizationName: string,
) {
  if (key === null) return <span className="text-slate-500">None</span>;
  switch (groupBy) {
    case 'organizationalUnit':
    case 'department':
    case 'team':
    case 'workLocation':
      return structureName(structure, key) ?? key.slice(0, 8);
    case 'workDate':
      return formatDay(key);
    case 'status':
      return key === 'CANCELLED' ? 'Cancelled' : 'Active';
    case 'sourceType':
      return key === 'PATTERN' ? 'Recurring pattern' : 'Manual';
    case 'schedule':
      return schedules.find((schedule) => schedule.id === key)?.name ?? key.slice(0, 8);
    case 'organization':
      return organizationName;
    case 'employee':
      return (
        <Link
          className="text-indigo-700 hover:underline"
          href={`/admin/employees/${encodeURIComponent(key)}`}
        >
          Employee {key.slice(0, 8)}
        </Link>
      );
    default:
      return key.slice(0, 8);
  }
}

function Report({ context }: { context: SchedulingContext }) {
  const organization = context.organization;
  const structure = useStructure(organization.id);
  const today = todayIn(organization.timezone);
  const [from, setFrom] = useState(() => startOfWeek(today));
  const [to, setTo] = useState(() => addDays(startOfWeek(today), 6));
  const [groupBy, setGroupBy] = useState<ScheduledHoursDimension>('organizationalUnit');
  const [scheduleStatus, setScheduleStatus] = useState<'PUBLISHED' | 'DRAFT'>('PUBLISHED');
  const [status, setStatus] = useState<'ACTIVE' | 'CANCELLED'>('ACTIVE');
  const [filters, setFilters] = useState({
    organizationalUnitId: '',
    departmentId: '',
    teamId: '',
    workLocationId: '',
  });
  const [employee, setEmployee] = useState<AssignmentChoice['employee'] | null>(null);
  const [assignment, setAssignment] = useState<AssignmentChoice | null>(null);
  const [groups, setGroups] = useState<ScheduledHoursGroup[] | null>(null);
  const [shown, setShown] = useState<{
    groupBy: ScheduledHoursDimension;
    query: ScheduledHoursQuery;
  } | null>(null);
  const [nextKey, setNextKey] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(query: ScheduledHoursQuery, append: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await schedulingApi.scheduledHours(query);
      setGroups((current) => (append && current ? [...current, ...result.groups] : result.groups));
      setNextKey(result.nextAfterKey);
      setShown({ groupBy: query.groupBy, query });
      if (query.groupBy === 'schedule') {
        const page = await schedulingApi
          .listSchedules({
            organizationId: organization.id,
            from: query.from,
            to: query.to,
            limit: 100,
          })
          .catch(() => ({ items: [] as Schedule[] }));
        setSchedules(page.items);
      }
    } catch (cause) {
      setError(schedulingErrorMessage(cause, 'The report could not be loaded.'));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (to < from) {
      setError('The end date must be on or after the start date.');
      return;
    }
    if (daysBetween(from, to) + 1 > GRID_MAX_DAYS) {
      setError(`The range can cover at most ${GRID_MAX_DAYS} days.`);
      return;
    }
    void load(
      {
        organizationId: organization.id,
        from,
        to,
        groupBy,
        scheduleStatus,
        status,
        ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
        ...(employee ? { employeeId: employee.id } : {}),
        ...(assignment ? { employmentAssignmentId: assignment.assignment.id } : {}),
      },
      false,
    );
  }

  const totals = (groups ?? []).reduce(
    (sum, group) => ({
      shifts: sum.shifts + group.shiftCount,
      minutes: sum.minutes + group.scheduledMinutes,
    }),
    { shifts: 0, minutes: 0 },
  );
  const structureFilters: Array<[keyof typeof filters, string, Structure[keyof Structure]]> = [
    ['organizationalUnitId', 'Business unit', structure.units],
    ['departmentId', 'Department', structure.departments],
    ['teamId', 'Team', structure.teams],
    ['workLocationId', 'Work location', structure.workLocations],
  ];

  return (
    <div className="space-y-5">
      <Panel title="Report">
        <form onSubmit={submit} aria-label="Scheduled hours report" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="From">
              <input
                type="date"
                required
                className={inputClass}
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                required
                className={inputClass}
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
            <Field label="Group by">
              <select
                className={inputClass}
                value={groupBy}
                onChange={(event) => setGroupBy(event.target.value as ScheduledHoursDimension)}
              >
                {(Object.keys(GROUP_LABELS) as ScheduledHoursDimension[]).map((key) => (
                  <option key={key} value={key}>
                    {GROUP_LABELS[key]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Schedules">
              <select
                className={inputClass}
                value={scheduleStatus}
                onChange={(event) => setScheduleStatus(event.target.value as 'PUBLISHED' | 'DRAFT')}
              >
                <option value="PUBLISHED">Published</option>
                <option value="DRAFT">Drafts</option>
              </select>
            </Field>
            <Field label="Shifts">
              <select
                className={inputClass}
                value={status}
                onChange={(event) => setStatus(event.target.value as 'ACTIVE' | 'CANCELLED')}
              >
                <option value="ACTIVE">Active</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </Field>
            {structure.available &&
              structureFilters.map(([key, label, items]) => (
                <Field key={key} label={label}>
                  <select
                    className={inputClass}
                    value={filters[key]}
                    onChange={(event) =>
                      setFilters((current) => ({ ...current, [key]: event.target.value }))
                    }
                  >
                    <option value="">All</option>
                    {(items as Array<{ id: string; name: string }>).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
          </div>
          <StructureLoadError structure={structure} />
          <EmployeeAssignmentPicker
            organizationId={organization.id}
            value={assignment}
            onChange={setAssignment}
            onEmployeeChange={(next) => {
              setEmployee(next);
              setAssignment(null);
            }}
          />
          <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
            Run report
          </button>
        </form>
      </Panel>
      <Feedback error={error} success={null} />
      {groups && shown && (
        <Panel title={`Scheduled hours by ${GROUP_LABELS[shown.groupBy].toLowerCase()}`}>
          {groups.length === 0 ? (
            <p className="text-sm text-slate-600">No shifts match.</p>
          ) : (
            <>
              <TableScroll bare label="Scheduled hours table">
                <table className="w-full text-left text-sm" aria-label="Scheduled hours">
                  <thead className="text-xs uppercase text-slate-500">
                    <tr>
                      <th scope="col" className="py-1">
                        {GROUP_LABELS[shown.groupBy]}
                      </th>
                      <th scope="col" className="py-1 text-right">
                        Shifts
                      </th>
                      <th scope="col" className="py-1 text-right">
                        Hours
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {groups.map((group) => (
                      <tr key={group.key ?? 'none'}>
                        <td className="py-1">
                          {groupLabel(
                            shown.groupBy,
                            group.key,
                            structure,
                            schedules,
                            organization.name,
                          )}
                        </td>
                        <td className="py-1 text-right">{group.shiftCount}</td>
                        <td className="py-1 text-right">{hours(group.scheduledMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 font-semibold">
                      <td className="py-1">Total{nextKey ? ' (loaded groups)' : ''}</td>
                      <td className="py-1 text-right">{totals.shifts}</td>
                      <td className="py-1 text-right">{hours(totals.minutes)}</td>
                    </tr>
                  </tfoot>
                </table>
              </TableScroll>
              {nextKey && (
                <button
                  type="button"
                  disabled={busy}
                  className={`${buttonClass('secondary', 'sm')} mt-3`}
                  onClick={() => void load({ ...shown.query, afterKey: nextKey }, true)}
                >
                  Load more groups
                </button>
              )}
            </>
          )}
        </Panel>
      )}
    </div>
  );
}
