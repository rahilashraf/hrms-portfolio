'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from 'react';
import { ErrorBanner, FeedbackMessage, PageHeader } from '../organization/shared';
import { buttonClass } from '../ui/button';
import { EmptyState, LoadingState } from '../ui/states';
import { AuthApiError } from '../../lib/auth/types';
import { employeeApi } from '../../lib/employee/api';
import type { EmployeeAssignmentView, EmployeeDirectoryItem } from '../../lib/employee/types';
import { organizationApi } from '../../lib/organization/api';
import type {
  Department,
  OrganizationalUnit,
  Team,
  WorkLocation,
} from '../../lib/organization/types';
import type {
  ConflictOverrideInput,
  ScheduleConflict,
  ScheduleScopeType,
  ScheduleStatus,
  ShiftStatus,
} from '../../lib/scheduling/types';
import { formatTime } from '../../lib/scheduling/time';
import { useWorkspace } from '../../providers/workspace-provider';
import type { WorkspaceOrganization } from '../../lib/workspace/types';
import { employeeOption, type PickerOption } from '../../lib/pickers/sources';
import type { RecordSource } from '../../lib/pickers/use-record-search';
import { RecordCombobox } from '../ui/record-combobox';
import { focusableWithin, restoreFocus } from '../ui/focus';
import { PageContainer } from '../ui/page-container';
import { StatusBadge } from '../ui/status-badge';

export const inputClass =
  'mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-[var(--hrms-accent-text)] disabled:bg-slate-50';

export const SCHEDULE_PERMISSIONS = {
  read: 'schedule.read',
  manage: 'schedule.manage',
  publish: 'schedule.publish',
  override: 'schedule.override_conflict',
  templates: 'schedule.manage_templates',
  patterns: 'schedule.manage_patterns',
  policy: 'schedule.manage_policy',
} as const;

/** The selected workspace organization and the scheduling permissions its grants carry. */
export interface SchedulingContext {
  organization: WorkspaceOrganization;
  /** True when a grant for the key reaches any part of the organization (the API decides scope). */
  can(permission: string): boolean;
}

const SECTIONS: Array<{ href: string; label: string; anyOf: string[] }> = [
  {
    href: '/admin/scheduling',
    label: 'Schedules',
    anyOf: [SCHEDULE_PERMISSIONS.read, SCHEDULE_PERMISSIONS.manage],
  },
  {
    href: '/admin/scheduling/templates',
    label: 'Templates',
    anyOf: [
      SCHEDULE_PERMISSIONS.read,
      SCHEDULE_PERMISSIONS.templates,
      SCHEDULE_PERMISSIONS.patterns,
    ],
  },
  {
    href: '/admin/scheduling/patterns',
    label: 'Recurring patterns',
    anyOf: [SCHEDULE_PERMISSIONS.read, SCHEDULE_PERMISSIONS.patterns],
  },
  {
    href: '/admin/scheduling/policies',
    label: 'Policies',
    anyOf: [SCHEDULE_PERMISSIONS.read, SCHEDULE_PERMISSIONS.policy],
  },
  {
    href: '/admin/scheduling/reports',
    label: 'Scheduled hours',
    anyOf: [SCHEDULE_PERMISSIONS.read, SCHEDULE_PERMISSIONS.manage],
  },
];

/**
 * Frame of every Scheduling administration page: the selected organization, the Scheduling
 * module and at least one of `anyOf` must be present. Hiding is a convenience only — every
 * request is authorized by the API on the exact scope.
 */
export function SchedulingAdminPage({
  title,
  description,
  anyOf,
  children,
}: {
  title: string;
  description: string;
  anyOf: string[];
  children: (context: SchedulingContext) => ReactNode;
}) {
  const { selectedOrganization, status } = useWorkspace();
  const organization = selectedOrganization;
  const context = useMemo<SchedulingContext | null>(
    () =>
      organization
        ? {
            organization,
            can: (permission: string) => organization.permissions.includes(permission),
          }
        : null,
    [organization],
  );
  const pathname = usePathname();

  let body: ReactNode;
  if (status === 'loading') {
    body = <LoadingState label="Loading scheduling…" />;
  } else if (!context) {
    body = (
      <EmptyState
        title="Choose an organization"
        description="Scheduling is managed per organization. Select one in the workspace switcher."
      />
    );
  } else if (!context.organization.enabledModules.includes('SCHEDULING')) {
    body = (
      <EmptyState
        title="Scheduling is turned off"
        description={`Scheduling is not enabled for ${context.organization.name}.`}
      />
    );
  } else if (!anyOf.some((key) => context.can(key))) {
    body = (
      <EmptyState
        title="No access"
        description="You do not have a scheduling permission for this page in this organization."
      />
    );
  } else {
    body = children(context);
  }

  const sections = context
    ? SECTIONS.filter((section) => section.anyOf.some((key) => context.can(key)))
    : [];
  return (
    <PageContainer width="full">
      <PageHeader
        eyebrow={organization ? `Scheduling · ${organization.name}` : 'Scheduling'}
        title={title}
        description={description}
      />
      {sections.length > 1 && (
        <nav aria-label="Scheduling sections" className="mt-6 flex flex-wrap gap-2">
          {sections.map((section) => {
            const active = pathname === section.href;
            return (
              <Link
                key={section.href}
                href={section.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'rounded-full bg-slate-900 px-3 py-1.5 text-sm font-medium text-white'
                    : 'rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50'
                }
              >
                {section.label}
              </Link>
            );
          })}
        </nav>
      )}
      <div className="mt-6">{body}</div>
    </PageContainer>
  );
}

// ─── Status indicators ───────────────────────────────────────────────────────

/**
 * Batch 10C: the shared StatusBadge. A draft schedule is not yet visible to employees
 * ("warning"), a published one is ("success"); words are always shown.
 */
export function ScheduleStatusBadge({ status }: { status: ScheduleStatus }) {
  return status === 'PUBLISHED' ? (
    <StatusBadge status="PUBLISHED" label="Published" tone="success" />
  ) : (
    <StatusBadge status="DRAFT" label="Draft" tone="warning" />
  );
}

/** Only a cancelled shift is marked (an active one needs no badge). */
export function ShiftStatusBadge({ status }: { status: ShiftStatus }) {
  return status === 'CANCELLED' ? (
    <StatusBadge status="CANCELLED" label="Cancelled" tone="danger" />
  ) : null;
}

export function Panel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  const hintId = useId();
  // The hint describes the control (aria-describedby) instead of being part of its name.
  const control =
    hint && isValidElement(children)
      ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
          'aria-describedby': [
            (children as ReactElement<{ 'aria-describedby'?: string }>).props['aria-describedby'],
            hintId,
          ]
            .filter(Boolean)
            .join(' '),
        })
      : children;
  return (
    <div className="block text-sm font-medium text-slate-700">
      <label className="block">
        {label}
        {control}
      </label>
      {hint && (
        <span id={hintId} className="mt-1 block text-xs font-normal text-slate-600">
          {hint}
        </span>
      )}
    </div>
  );
}

export function Feedback({ error, success }: { error: string | null; success: string | null }) {
  return (
    <>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
    </>
  );
}

export const SCOPE_LABELS: Record<ScheduleScopeType, string> = {
  ORGANIZATION: 'Whole organization',
  ORGANIZATIONAL_UNIT: 'Business unit',
  DEPARTMENT: 'Department',
  TEAM: 'Team',
};

// ─── Organization structure lookups ──────────────────────────────────────────

export interface Structure {
  /** False when the user cannot read the organization structure (organization.read). */
  available: boolean;
  loaded: boolean;
  /** Set when a list failed for another reason than permission (the lists that loaded are kept). */
  error: string | null;
  /** Fetches the organization structure again (after `error`). */
  reload(): void;
  units: OrganizationalUnit[];
  departments: Department[];
  teams: Team[];
  workLocations: WorkLocation[];
}

const NO_RELOAD = () => undefined;

const EMPTY_STRUCTURE: Structure = {
  available: false,
  loaded: false,
  error: null,
  reload: NO_RELOAD,
  units: [],
  departments: [],
  teams: [],
  workLocations: [],
};

function isForbidden(reason: unknown): boolean {
  return reason instanceof AuthApiError && reason.status === 403;
}

/** Units, departments, teams and work locations for pickers and labels (organization.read). */
export function useStructure(organizationId: string): Structure {
  const [state, setState] = useState<{ id: string; value: Omit<Structure, 'reload'> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((current) => current + 1), []);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void Promise.allSettled([
        organizationApi.listUnits(organizationId),
        organizationApi.listDepartments(organizationId),
        organizationApi.listTeams(organizationId),
        organizationApi.listWorkLocations(organizationId),
      ]).then(([units, departments, teams, workLocations]) => {
        if (!active) return;
        const results = [units, departments, teams, workLocations];
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
        // Without organization.read the pages still work: ids are entered and the position's
        // own work location is used for shifts. Any other failure is reported with a retry,
        // and the lists that did load are kept.
        const forbidden = failures.length > 0 && failures.every(isForbidden);
        const list = <T,>(result: PromiseSettledResult<T[]>): T[] =>
          result.status === 'fulfilled' ? result.value : [];
        setState({
          id: organizationId,
          value: {
            available: !forbidden,
            loaded: true,
            error:
              failures.length > 0 && !forbidden
                ? 'The organization structure could not be loaded.'
                : null,
            units: list(units),
            departments: list(departments),
            teams: list(teams),
            workLocations: list(workLocations),
          },
        });
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId, attempt]);
  const value = state?.id === organizationId ? state.value : EMPTY_STRUCTURE;
  return useMemo(() => ({ ...value, reload }), [value, reload]);
}

/** The organization structure failed to load (not a permission refusal): say so, with a retry. */
export function StructureLoadError({ structure }: { structure: Structure }) {
  if (!structure.error) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 p-2 text-sm text-rose-900"
    >
      <span>{structure.error} Unit, department, team and location choices may be incomplete.</span>
      <button type="button" className={buttonClass('secondary', 'sm')} onClick={structure.reload}>
        Retry
      </button>
    </div>
  );
}

export function structureName(structure: Structure, id: string | null | undefined): string | null {
  if (!id) return null;
  const all = [
    ...structure.units,
    ...structure.departments,
    ...structure.teams,
    ...structure.workLocations,
  ];
  return all.find((item) => item.id === id)?.name ?? null;
}

export function scopeLabel(
  structure: Structure,
  scope: {
    scopeType: ScheduleScopeType;
    organizationalUnitId?: string | null;
    departmentId?: string | null;
    teamId?: string | null;
  },
): string {
  const id = scope.organizationalUnitId ?? scope.departmentId ?? scope.teamId ?? null;
  if (scope.scopeType === 'ORGANIZATION' || !id) return SCOPE_LABELS.ORGANIZATION;
  return `${SCOPE_LABELS[scope.scopeType]}: ${structureName(structure, id) ?? id.slice(0, 8)}`;
}

/** Scope type plus its target (unit, department or team) for schedules and policies. */
export function ScopeFields({
  structure,
  scopeType,
  targetId,
  onChange,
  disabled,
}: {
  structure: Structure;
  scopeType: ScheduleScopeType;
  targetId: string;
  onChange(next: { scopeType: ScheduleScopeType; targetId: string }): void;
  disabled?: boolean;
}) {
  const targets =
    scopeType === 'ORGANIZATIONAL_UNIT'
      ? structure.units
      : scopeType === 'DEPARTMENT'
        ? structure.departments
        : scopeType === 'TEAM'
          ? structure.teams
          : [];
  return (
    <>
      <Field label="Scope">
        <select
          className={inputClass}
          value={scopeType}
          disabled={disabled}
          onChange={(event) =>
            onChange({ scopeType: event.target.value as ScheduleScopeType, targetId: '' })
          }
        >
          {(Object.keys(SCOPE_LABELS) as ScheduleScopeType[]).map((type) => (
            <option key={type} value={type}>
              {SCOPE_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>
      {scopeType !== 'ORGANIZATION' && (
        <Field
          label={SCOPE_LABELS[scopeType]}
          hint={
            structure.available
              ? undefined
              : 'Enter the id (organization structure is not readable).'
          }
        >
          {structure.available ? (
            <select
              className={inputClass}
              required
              value={targetId}
              disabled={disabled}
              onChange={(event) => onChange({ scopeType, targetId: event.target.value })}
            >
              <option value="">Select…</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={inputClass}
              required
              value={targetId}
              disabled={disabled}
              onChange={(event) => onChange({ scopeType, targetId: event.target.value.trim() })}
            />
          )}
        </Field>
      )}
      {scopeType !== 'ORGANIZATION' && <StructureLoadError structure={structure} />}
    </>
  );
}

export function scopePayload(scopeType: ScheduleScopeType, targetId: string) {
  return {
    scopeType,
    ...(scopeType === 'ORGANIZATIONAL_UNIT' ? { organizationalUnitId: targetId } : {}),
    ...(scopeType === 'DEPARTMENT' ? { departmentId: targetId } : {}),
    ...(scopeType === 'TEAM' ? { teamId: targetId } : {}),
  };
}

// ─── Employee → assignment selection ────────────────────────────────────────

export interface AssignmentChoice {
  employee: { id: string; employeeNumber: string; displayName: string };
  assignment: EmployeeAssignmentView;
}

export function employeeName(item: { person: EmployeeDirectoryItem['person'] }): string {
  const person = item.person;
  return (
    person.preferredName ||
    [person.firstName, person.lastName].filter(Boolean).join(' ') ||
    'Unnamed employee'
  );
}

/** "Position · Business unit · Organization (primary)" for an employment assignment. */
export function assignmentLabel(assignment: EmployeeAssignmentView): string {
  return [assignment.position.name, assignment.placement?.name, assignment.organization.name]
    .filter(Boolean)
    .join(' · ')
    .concat(assignment.isPrimary ? ' (primary)' : '')
    .concat(assignment.status === 'PLANNED' ? ' — starts ' + assignment.startDate : '');
}

/**
 * Search an employee, then pick one of their assignments. Employees holding several positions
 * choose the exact assignment the shift belongs to. Assignments of another organization are
 * shown but cannot be chosen: a schedule only holds shifts of its own organization.
 * The employee search is the shared RecordCombobox (keyboard, paging, stale answers ignored).
 */
export function EmployeeAssignmentPicker({
  organizationId,
  value,
  onChange,
  disabled,
  label = 'Employee',
  onEmployeeChange,
}: {
  organizationId: string;
  value: AssignmentChoice | null;
  onChange(choice: AssignmentChoice | null): void;
  disabled?: boolean;
  label?: string;
  /** Filter mode: the employee alone may be chosen (“All assignments”). */
  onEmployeeChange?(employee: AssignmentChoice['employee'] | null): void;
}) {
  const [employee, setEmployee] = useState<AssignmentChoice['employee'] | null>(
    value?.employee ?? null,
  );
  const [assignments, setAssignments] = useState<EmployeeAssignmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The directory rows behind the options, to know each employee's number.
  const found = useRef(new Map<string, EmployeeDirectoryItem>());
  const source = useMemo<RecordSource<PickerOption>>(
    () => ({
      async search(query, cursor) {
        const page = await employeeApi.list({
          organizationId,
          status: 'ACTIVE',
          limit: 15,
          ...(query ? { search: query } : {}),
          ...(cursor ? { afterId: cursor } : {}),
        });
        for (const item of page.items) found.current.set(item.id, item);
        return { items: page.items.map(employeeOption), next: page.nextAfterId };
      },
    }),
    [organizationId],
  );

  const employeeId = employee?.id ?? null;
  useEffect(() => {
    if (!employeeId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      employeeApi
        .get(employeeId)
        .then((profile) => {
          if (active)
            setAssignments([...profile.assignments.current, ...profile.assignments.upcoming]);
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

  if (disabled && value) {
    return (
      <Field label={label}>
        <p className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          {value.employee.displayName} ({value.employee.employeeNumber}) —{' '}
          {assignmentLabel(value.assignment)}
        </p>
      </Field>
    );
  }

  return (
    <div className="space-y-2">
      <RecordCombobox
        label={`${label} (name or employee number)`}
        source={source}
        value={employee?.id ?? ''}
        selected={
          employee
            ? {
                id: employee.id,
                label: employee.displayName,
                description: employee.employeeNumber,
              }
            : null
        }
        placeholder="Search active employees"
        noResultsText="No active employees match."
        disabled={disabled}
        onChange={(id) => {
          setError(null);
          setAssignments(null);
          onChange(null);
          const item = id ? found.current.get(id) : undefined;
          const picked = item
            ? { id: item.id, employeeNumber: item.employeeNumber, displayName: employeeName(item) }
            : null;
          setEmployee(picked);
          onEmployeeChange?.(picked);
        }}
      />
      {employee && (
        <Field label="Assignment">
          {assignments === null ? (
            <p role="status" className="mt-1 text-sm text-slate-600">
              Loading assignments…
            </p>
          ) : (
            <select
              className={inputClass}
              required={!onEmployeeChange}
              value={value?.assignment.id ?? ''}
              onChange={(event) => {
                const assignment = assignments.find((a) => a.id === event.target.value);
                onChange(assignment ? { employee, assignment } : null);
              }}
            >
              <option value="">
                {onEmployeeChange ? 'All assignments' : 'Select the position this shift is for…'}
              </option>
              {assignments.map((assignment) => (
                <option
                  key={assignment.id}
                  value={assignment.id}
                  disabled={assignment.organization.id !== organizationId}
                >
                  {assignmentLabel(assignment)}
                  {assignment.organization.id !== organizationId ? ' (other organization)' : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}

// ─── Conflicts and overrides ─────────────────────────────────────────────────

const CONFLICT_LABELS: Record<ScheduleConflict['type'], string> = {
  SAME_ASSIGNMENT_OVERLAP: 'Overlaps another shift of the same assignment',
  EMPLOYEE_ASSIGNMENT_OVERLAP: 'Overlaps a shift of another of this employee’s assignments',
  MINIMUM_REST_VIOLATION: 'Not enough rest between shifts',
  MAXIMUM_SHIFT_DURATION_EXCEEDED: 'Longer than the maximum shift duration',
};

export function conflictLabel(type: ScheduleConflict['type']): string {
  return CONFLICT_LABELS[type] ?? type;
}

/** Overrides the user explicitly gave a reason for; nothing is overridden silently. */
export function overridesFrom(
  conflicts: ScheduleConflict[],
  reasons: Record<string, string>,
): ConflictOverrideInput[] {
  return conflicts
    .filter((conflict) => conflict.overrideAllowed && !conflict.overridden)
    .filter((conflict) => (reasons[conflict.key] ?? '').trim())
    .map((conflict) => ({
      conflictType: conflict.type,
      conflictKey: conflict.key,
      reason: reasons[conflict.key]!.trim(),
    }));
}

export function ConflictList({
  conflicts,
  canOverride,
  reasons,
  onReasonChange,
  timezone,
}: {
  conflicts: ScheduleConflict[];
  canOverride: boolean;
  reasons: Record<string, string>;
  onReasonChange(key: string, reason: string): void;
  timezone: string | null;
}) {
  if (conflicts.length === 0) {
    return (
      <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
        No scheduling conflicts.
      </p>
    );
  }
  return (
    <ul aria-label="Scheduling conflicts" className="space-y-2">
      {conflicts.map((conflict) => (
        <li
          key={conflict.key}
          className={`rounded-lg border p-3 text-sm ${
            conflict.severity === 'ERROR'
              ? 'border-rose-300 bg-rose-50 text-rose-950'
              : 'border-amber-300 bg-amber-50 text-amber-950'
          }`}
        >
          <p className="font-semibold">
            {conflict.severity === 'ERROR' ? 'Blocking' : 'Warning'}: {conflictLabel(conflict.type)}
          </p>
          <p className="mt-1">{conflict.message}</p>
          {conflict.conflictingShift && (
            <p className="mt-1 text-xs">
              Conflicting shift {conflict.conflictingShift.workDate},{' '}
              {formatTime(conflict.conflictingShift.startsAt, timezone)}–
              {formatTime(conflict.conflictingShift.endsAt, timezone)}
              {conflict.conflictingShift.scheduleId === null &&
                ' (in a schedule outside your access)'}
            </p>
          )}
          {conflict.overridden ? (
            <p className="mt-1 text-xs font-medium">Already overridden.</p>
          ) : !conflict.overrideAllowed ? (
            <p className="mt-1 text-xs font-medium">
              This conflict cannot be overridden; change the shift.
            </p>
          ) : canOverride ? (
            <label className="mt-2 block text-xs font-medium">
              Override reason (required to save despite this conflict)
              <textarea
                className={`${inputClass} bg-white`}
                rows={2}
                maxLength={1000}
                value={reasons[conflict.key] ?? ''}
                onChange={(event) => onReasonChange(conflict.key, event.target.value)}
              />
            </label>
          ) : (
            <p className="mt-1 text-xs font-medium">
              Overriding needs the “Override schedule conflicts” permission; change the shift or ask
              an authorized scheduler.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function RequiredReason({
  value,
  onChange,
  label = 'Reason (required)',
}: {
  value: string;
  onChange(value: string): void;
  label?: string;
}) {
  return (
    <Field label={label} hint="Recorded in the shift’s revision history and the audit log.">
      <textarea
        className={inputClass}
        rows={2}
        required
        maxLength={1000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/**
 * R4-A.6 — a read-only holiday marker. The kind is spelled out ("Holiday" or "Closure"), never
 * shown by colour alone; it changes nothing about the shifts on that day.
 */
export function HolidayMarker({
  holiday,
  organizationName,
}: {
  holiday: { name: string; kind: string };
  organizationName?: string | null;
}) {
  const kind = holiday.kind === 'CLOSURE' ? 'Closure' : 'Holiday';
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-950">
      <span aria-hidden="true">★</span>
      <span className="truncate">
        {kind}: {holiday.name}
        {organizationName ? ` (${organizationName})` : ''}
      </span>
    </span>
  );
}

/** Holidays by date (several organizations may share a date). */
export function holidaysByDate<T extends { date: string }>(holidays: readonly T[] | undefined) {
  const map = new Map<string, T[]>();
  for (const holiday of holidays ?? []) {
    map.set(holiday.date, [...(map.get(holiday.date) ?? []), holiday]);
  }
  return map;
}

/**
 * R4-A.7 — an edit form opened in place: focus moves to its first field, and when it closes
 * (Cancel or a successful save) focus returns to the control that opened it, or to the main
 * region if that control is gone.
 *
 * The opener is captured once and a pending restore is cancelled if the effect runs again: React
 * StrictMode (development) mounts, unmounts and remounts the effect, and that second run is not
 * a new opening (it would otherwise send focus back to the opener and remember the field).
 */
export function useEditFormFocus(form: RefObject<HTMLFormElement | null>) {
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  const pendingRestore = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (pendingRestore.current !== undefined) {
      window.clearTimeout(pendingRestore.current);
      pendingRestore.current = undefined;
    }
    if (opener.current === undefined) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const first = form.current ? focusableWithin(form.current)[0] : undefined;
    first?.focus();
    return () => {
      const target = opener.current ?? null;
      pendingRestore.current = window.setTimeout(() => {
        pendingRestore.current = undefined;
        restoreFocus(target);
      }, 0);
    };
  }, [form]);
}

/** R4-A.7: a save refused by the API, shown inside the form it belongs to. */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-red-700">
      {message}
    </p>
  );
}
