'use client';

import { useEffect, useMemo, useState } from 'react';
import { buttonClass } from '../ui/button';
import { ErrorState } from '../ui/states';
import { schedulingApi } from '../../lib/scheduling/api';
import { schedulingErrorMessage } from '../../lib/scheduling/errors';
import type {
  ScheduleHolidayMarker,
  GridQuery,
  GridShift,
  Schedule,
  ScheduleStatus,
  ShiftStatus,
} from '../../lib/scheduling/types';
import { addDays, formatDay, formatMonth, startOfWeek, todayIn } from '../../lib/scheduling/time';
import { ScheduleCalendar, stepAnchor, viewRange, type CalendarView } from './schedule-calendar';
import { SchedulesPanel } from './schedules-panel';
import { ShiftDetail } from './shift-detail';
import { ShiftEditor, type ShiftEditorMode } from './shift-editor';
import {
  EmployeeAssignmentPicker,
  Feedback,
  Field,
  SCHEDULE_PERMISSIONS,
  SchedulingAdminPage,
  inputClass,
  useStructure,
  StructureLoadError,
  type AssignmentChoice,
  type SchedulingContext,
} from './scheduling-shared';

/** Grid pages fetched per range (200 shifts each). */
const MAX_PAGES = 25;

export function SchedulesAdminPage() {
  return (
    <SchedulingAdminPage
      title="Schedules"
      description="Plan shifts by day, week or month. Drafts stay private until the schedule is published."
      anyOf={[SCHEDULE_PERMISSIONS.read, SCHEDULE_PERMISSIONS.manage]}
    >
      {(context) => <SchedulesWorkspace key={context.organization.id} context={context} />}
    </SchedulingAdminPage>
  );
}

interface Filters {
  organizationalUnitId: string;
  departmentId: string;
  teamId: string;
  workLocationId: string;
  status: '' | ShiftStatus;
  scheduleStatus: '' | ScheduleStatus;
}

const NO_FILTERS: Filters = {
  organizationalUnitId: '',
  departmentId: '',
  teamId: '',
  workLocationId: '',
  status: '',
  scheduleStatus: '',
};

interface EditorState {
  mode: ShiftEditorMode;
  schedule: Pick<Schedule, 'id' | 'name' | 'periodStart' | 'periodEnd'>;
  shift?: GridShift;
}

/** The dates the calendar loads: month view loads its whole weeks. */
export function loadRange(view: CalendarView, anchor: string) {
  const range = viewRange(view, anchor);
  if (view !== 'month') return range;
  return { from: startOfWeek(range.from), to: addDays(startOfWeek(range.to), 6) };
}

function SchedulesWorkspace({ context }: { context: SchedulingContext }) {
  const organization = context.organization;
  const structure = useStructure(organization.id);
  const [view, setView] = useState<CalendarView>('week');
  const [anchor, setAnchor] = useState(() => todayIn(organization.timezone));
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [employee, setEmployee] = useState<AssignmentChoice['employee'] | null>(null);
  const [assignment, setAssignment] = useState<AssignmentChoice | null>(null);
  const [shifts, setShifts] = useState<GridShift[] | null>(null);
  const [holidays, setHolidays] = useState<ScheduleHolidayMarker[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<GridShift | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const range = useMemo(() => loadRange(view, anchor), [view, anchor]);
  const shownRange = viewRange(view, anchor);
  const query = useMemo<GridQuery>(
    () => ({
      organizationId: organization.id,
      from: range.from,
      to: range.to,
      ...(filters.organizationalUnitId
        ? { organizationalUnitId: filters.organizationalUnitId }
        : {}),
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      ...(filters.teamId ? { teamId: filters.teamId } : {}),
      ...(filters.workLocationId ? { workLocationId: filters.workLocationId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.scheduleStatus ? { scheduleStatus: filters.scheduleStatus } : {}),
      ...(employee ? { employeeId: employee.id } : {}),
      ...(assignment ? { employmentAssignmentId: assignment.assignment.id } : {}),
    }),
    [organization.id, range.from, range.to, filters, employee, assignment],
  );

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setShifts(null);
      setLoadError(null);
      (async () => {
        const items: GridShift[] = [];
        let holidays: ScheduleHolidayMarker[] = [];
        let afterId: string | undefined;
        let more = false;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await schedulingApi.grid({ ...query, limit: 200, afterId });
          items.push(...result.items);
          // R4-A.6: the same on every page.
          if (page === 0) holidays = result.holidays ?? [];
          more = result.nextAfterId !== null;
          if (!more) break;
          afterId = result.nextAfterId!;
        }
        return { items, more, holidays };
      })()
        .then(({ items, more, holidays }) => {
          if (!active) return;
          setShifts(items);
          setHolidays(holidays);
          setTruncated(more);
          setSelected((current) =>
            current ? (items.find((s) => s.id === current.id) ?? null) : null,
          );
        })
        .catch((cause) => {
          if (!active) return;
          setLoadError(schedulingErrorMessage(cause, 'Shifts could not be loaded.'));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, reloadKey]);

  function changed(message: string) {
    setSuccess(message);
    setEditor(null);
    setReloadKey((key) => key + 1);
  }

  const setFilter = (key: keyof Filters) => (value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const rangeTitle =
    view === 'day'
      ? formatDay(anchor, 'long')
      : view === 'week'
        ? `${formatDay(shownRange.from)} – ${formatDay(shownRange.to)}`
        : formatMonth(anchor);
  const counts = shifts
    ? {
        draft: shifts.filter((s) => s.schedule.status === 'DRAFT').length,
        published: shifts.filter((s) => s.schedule.status === 'PUBLISHED' && s.status === 'ACTIVE')
          .length,
        cancelled: shifts.filter((s) => s.status === 'CANCELLED').length,
      }
    : null;

  return (
    <div className="space-y-5">
      <Feedback error={null} success={success} />
      <div className="flex flex-wrap items-end gap-3">
        <div
          role="group"
          aria-label="Calendar view"
          className="inline-flex rounded-lg border border-slate-300 p-0.5"
        >
          {(['day', 'week', 'month'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize ${
                view === option ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            aria-label={`Previous ${view}`}
            onClick={() => setAnchor((current) => stepAnchor(view, current, -1))}
          >
            ←
          </button>
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            onClick={() => setAnchor(todayIn(organization.timezone))}
          >
            Today
          </button>
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            aria-label={`Next ${view}`}
            onClick={() => setAnchor((current) => stepAnchor(view, current, 1))}
          >
            →
          </button>
        </div>
        <label className="text-sm font-medium text-slate-700">
          Go to date
          <input
            type="date"
            className={`${inputClass} w-44`}
            value={anchor}
            onChange={(event) => event.target.value && setAnchor(event.target.value)}
          />
        </label>
        <h2 aria-live="polite" className="ml-auto text-lg font-semibold text-slate-950">
          {rangeTitle}
        </h2>
      </div>

      <details className="rounded-xl border border-slate-200 bg-white p-4" open>
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">Filters</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {structure.available && (
            <>
              <Field label="Business unit">
                <select
                  className={inputClass}
                  value={filters.organizationalUnitId}
                  onChange={(event) => setFilter('organizationalUnitId')(event.target.value)}
                >
                  <option value="">All units</option>
                  {structure.units.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Department">
                <select
                  className={inputClass}
                  value={filters.departmentId}
                  onChange={(event) => setFilter('departmentId')(event.target.value)}
                >
                  <option value="">All departments</option>
                  {structure.departments.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Team">
                <select
                  className={inputClass}
                  value={filters.teamId}
                  onChange={(event) => setFilter('teamId')(event.target.value)}
                >
                  <option value="">All teams</option>
                  {structure.teams.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Work location">
                <select
                  className={inputClass}
                  value={filters.workLocationId}
                  onChange={(event) => setFilter('workLocationId')(event.target.value)}
                >
                  <option value="">All locations</option>
                  {structure.workLocations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          <Field label="Publication">
            <select
              className={inputClass}
              value={filters.scheduleStatus}
              onChange={(event) => setFilter('scheduleStatus')(event.target.value)}
            >
              <option value="">Draft and published</option>
              <option value="DRAFT">Draft only</option>
              <option value="PUBLISHED">Published only</option>
            </select>
          </Field>
          <Field label="Shift status">
            <select
              className={inputClass}
              value={filters.status}
              onChange={(event) => setFilter('status')(event.target.value)}
            >
              <option value="">Active and cancelled</option>
              <option value="ACTIVE">Active</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </Field>
          <div className="sm:col-span-2">
            <EmployeeAssignmentPicker
              organizationId={organization.id}
              value={assignment}
              onChange={setAssignment}
              onEmployeeChange={(next) => {
                setEmployee(next);
                setAssignment(null);
              }}
            />
          </div>
        </div>
        {structure.error && (
          <div className="mt-2">
            <StructureLoadError structure={structure} />
          </div>
        )}
        {!structure.available && structure.loaded && (
          <p className="mt-2 text-xs text-slate-500">
            Unit, department, team and location filters need permission to read the organization
            structure.
          </p>
        )}
      </details>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section
          aria-label="Calendar"
          className="min-w-0 space-y-2 rounded-xl border border-slate-200 bg-white p-3 sm:p-4"
        >
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="inline-flex items-center gap-1">
              <span className="size-3 rounded border border-dashed border-amber-400 bg-amber-50" />{' '}
              Draft
              {counts && ` (${counts.draft})`}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="size-3 rounded border border-emerald-300 bg-white" /> Published
              {counts && ` (${counts.published})`}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="size-3 rounded border border-rose-200 bg-rose-50" /> Cancelled
              {counts && ` (${counts.cancelled})`}
            </span>
            <span>Times are shown in each shift’s location timezone.</span>
          </div>
          {truncated && (
            <p role="note" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
              Only the first {MAX_PAGES * 200} shifts are shown. Narrow the filters or the view.
            </p>
          )}
          {loadError ? (
            <ErrorState
              title="Shifts could not be loaded"
              message={loadError}
              onRetry={() => setReloadKey((key) => key + 1)}
            />
          ) : shifts === null ? (
            <p role="status" className="p-6 text-sm text-slate-600">
              Loading shifts…
            </p>
          ) : (
            <ScheduleCalendar
              view={view}
              anchor={anchor}
              shifts={shifts}
              holidays={holidays}
              selectedId={selected?.id ?? null}
              onSelect={(shift) => {
                setSelected(shift);
                setEditor(null);
              }}
              onOpenDay={(day) => {
                setAnchor(day);
                setView('day');
              }}
            />
          )}
        </section>
        <aside className="space-y-4" aria-label="Shift panel">
          {editor ? (
            <ShiftEditor
              key={`${editor.mode}-${editor.shift?.id ?? editor.schedule.id}`}
              mode={editor.mode}
              schedule={editor.schedule}
              shift={editor.shift}
              organizationId={organization.id}
              organizationTimezone={organization.timezone}
              structure={structure}
              canOverride={
                editor.shift
                  ? editor.shift.actions.canOverrideConflict
                  : context.can(SCHEDULE_PERMISSIONS.override)
              }
              onCancel={() => setEditor(null)}
              onSaved={changed}
            />
          ) : selected ? (
            <ShiftDetail
              key={selected.id}
              shift={selected}
              organizationId={organization.id}
              canReadAudit={context.can('audit.read')}
              onEdit={(shift) => setEditor({ mode: 'edit', schedule: shift.schedule, shift })}
              onCorrect={(shift) => setEditor({ mode: 'correct', schedule: shift.schedule, shift })}
              onChanged={(message) => {
                setSelected(null);
                changed(message);
              }}
              onClose={() => setSelected(null)}
            />
          ) : (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
              Select a shift to see its details and actions, or use “Add shift” on a schedule below.
            </p>
          )}
        </aside>
      </div>

      <SchedulesPanel
        context={context}
        structure={structure}
        range={shownRange}
        shifts={shifts ?? []}
        reloadKey={reloadKey}
        onAddShift={(schedule) => {
          setSelected(null);
          setEditor({ mode: schedule.status === 'DRAFT' ? 'create' : 'add', schedule });
        }}
        onChanged={changed}
      />
    </div>
  );
}
