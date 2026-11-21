'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { employeeApi } from '../../../lib/employee/api';
import { formatDateOnly } from '../../../lib/employee/date';
import { employeeErrorMessage } from '../../../lib/employee/errors';
import type { LifecycleAssignmentRow, LifecycleDue } from '../../../lib/employee/types';
import { useWorkspace } from '../../../providers/workspace-provider';
import { ErrorBanner, FeedbackMessage, LoadingState, PageHeader } from '../../organization/shared';
import { buttonClass } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { DataTable, type DataTableColumn } from '../../ui/data-table';
import { PageContainer } from '../../ui/page-container';
import { RequirePermission } from '../../ui/require-permission';
import { EmptyState } from '../../ui/states';
import { StatusBadge } from '../../ui/status-badge';
import { employmentTypeLabel } from '../employee-shared';
import { AssignmentImpactPreview } from './assignment-impact-preview';

/** R4-A.1: the windows offered for "ending soon" (the API accepts 0–90 days). */
export const UPCOMING_WINDOWS = [7, 14, 30, 60, 90] as const;
const DEFAULT_WINDOW = 30;

type Overdue = LifecycleDue['assignmentEnds'][number];
type Upcoming = LifecycleDue['upcomingAssignmentEnds'][number];

const days = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;

function employeeCell(row: {
  employeeId: string;
  employeeName: string | null;
  employeeNumber: string;
}) {
  return (
    <Link
      href={`/admin/employees/${encodeURIComponent(row.employeeId)}`}
      className="font-medium text-[var(--hrms-accent-text)] underline-offset-2 hover:underline"
    >
      {row.employeeName ?? 'Unnamed employee'}
      <span className="block text-xs font-normal text-slate-600">{row.employeeNumber}</span>
    </Link>
  );
}

function assignmentCell(row: LifecycleAssignmentRow) {
  return (
    <>
      <span className="font-medium text-slate-900">{row.positionName}</span>
      <span className="block text-xs text-slate-600">
        {employmentTypeLabel(row.employmentType)}
        {row.isPrimary ? ' · primary' : ''} · since {formatDateOnly(row.startDate)}
      </span>
    </>
  );
}

function endCell(row: LifecycleAssignmentRow) {
  return (
    <>
      {formatDateOnly(row.endDate)}
      <span className="block text-xs text-slate-600">Last working day · {row.timezone}</span>
    </>
  );
}

/**
 * Batch R4-A.1 — manual employee lifecycle (lifecycle automation stays off): assignments past
 * their end date that an HR user applies one by one, those ending soon, and due terminations
 * (handled in the termination workflow on the employee's profile). Applying an end only ends
 * that assignment; it never terminates employment. The API decides what is due and who may act.
 */
export function LifecycleDuePage() {
  return (
    <RequirePermission
      anyOf={['employee.manage']}
      width="wide"
      deniedMessage="You do not have permission to manage employee lifecycle changes."
    >
      <LifecycleDueContent />
    </RequirePermission>
  );
}

function LifecycleDueContent() {
  const { organizations, selectedOrganization } = useWorkspace();
  const manageable = useMemo(
    () =>
      organizations.filter((organization) => organization.permissions.includes('employee.manage')),
    [organizations],
  );
  const [organizationId, setOrganizationId] = useState('');
  const effectiveOrganizationId =
    organizationId ||
    (selectedOrganization && manageable.some((o) => o.id === selectedOrganization.id)
      ? selectedOrganization.id
      : (manageable[0]?.id ?? ''));
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_WINDOW);
  const [data, setData] = useState<LifecycleDue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [applying, setApplying] = useState<Overdue | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const request = useRef(0);
  const organizationFieldId = useId();
  const windowFieldId = useId();

  const load = useCallback(async () => {
    if (!effectiveOrganizationId) return;
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await employeeApi.lifecycleDue(effectiveOrganizationId, windowDays);
      if (id === request.current) setData(result);
    } catch (cause) {
      if (id === request.current) {
        setData(null);
        setError(employeeErrorMessage(cause, 'Unable to load lifecycle changes.'));
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [effectiveOrganizationId, windowDays]);

  useEffect(() => {
    // Deferred a tick, like the other admin lists (no state is set during the effect itself).
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function apply() {
    if (!applying || busy) return;
    setBusy(true);
    setApplyError(null);
    try {
      await employeeApi.applyAssignmentEnd(applying.employeeId, applying.employmentAssignmentId);
      setSuccess(
        `${applying.positionName} for ${applying.employeeName ?? applying.employeeNumber} has ended. The employee’s employment and other assignments are unchanged.`,
      );
      setApplying(null);
      await load();
    } catch (cause) {
      setApplyError(employeeErrorMessage(cause, 'The assignment end could not be applied.'));
    } finally {
      setBusy(false);
    }
  }

  const overdueColumns: DataTableColumn<Overdue>[] = [
    { key: 'employee', header: 'Employee', rowHeader: true, cell: employeeCell },
    { key: 'assignment', header: 'Assignment', cell: assignmentCell },
    { key: 'organization', header: 'Organization', cell: (row) => row.organizationName },
    { key: 'end', header: 'End date', cell: endCell },
    {
      key: 'overdue',
      header: 'Overdue by',
      cell: (row) => <StatusBadge status="OVERDUE" tone="warning" label={days(row.daysOverdue)} />,
    },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      cardLabel: false,
      cell: (row) => (
        <button
          type="button"
          className={buttonClass('secondary', 'sm')}
          aria-label={`Review and apply end for ${row.employeeName ?? row.employeeNumber}, ${row.positionName}`}
          onClick={() => {
            setApplyError(null);
            setSuccess(null);
            setApplying(row);
          }}
        >
          Review and apply end
        </button>
      ),
    },
  ];

  const upcomingColumns: DataTableColumn<Upcoming>[] = [
    { key: 'employee', header: 'Employee', rowHeader: true, cell: employeeCell },
    { key: 'assignment', header: 'Assignment', cell: assignmentCell },
    { key: 'organization', header: 'Organization', cell: (row) => row.organizationName },
    { key: 'end', header: 'End date', cell: endCell },
    {
      key: 'left',
      header: 'Ends in',
      cell: (row) => (row.daysUntilEnd === 0 ? 'Today is the last day' : days(row.daysUntilEnd)),
    },
    {
      key: 'next',
      header: 'Next step',
      cell: (row) =>
        row.scheduledTerminationId ? (
          <>
            <StatusBadge status="SCHEDULED" label="Ends with scheduled termination" />
            <Link
              href={`/admin/employees/${encodeURIComponent(row.employeeId)}`}
              aria-label={`Open termination for ${row.employeeName ?? row.employeeNumber}`}
              className="mt-1 block text-sm font-medium text-[var(--hrms-accent-text)] underline-offset-2 hover:underline"
            >
              Open termination
            </Link>
          </>
        ) : (
          <span className="text-slate-700">Apply the end once the last day has passed.</span>
        ),
    },
  ];

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Employees"
        title="Ending assignments"
        description="Assignments past or near their end date, and terminations that are due. Applying an end closes that assignment only; it never ends employment."
      >
        <Link href="/admin/employees" className={buttonClass('secondary')}>
          Back to employees
        </Link>
      </PageHeader>

      <section className="mt-8 space-y-6">
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2">
          <div>
            <label
              htmlFor={organizationFieldId}
              className="block text-sm font-medium text-slate-700"
            >
              Organization
            </label>
            <select
              id={organizationFieldId}
              value={effectiveOrganizationId}
              onChange={(event) => {
                setSuccess(null);
                setOrganizationId(event.target.value);
              }}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
            >
              {manageable.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={windowFieldId} className="block text-sm font-medium text-slate-700">
              Show assignments ending within
            </label>
            <select
              id={windowFieldId}
              value={windowDays}
              onChange={(event) => setWindowDays(Number(event.target.value))}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
            >
              {UPCOMING_WINDOWS.map((value) => (
                <option key={value} value={value}>
                  {value} days
                </option>
              ))}
            </select>
          </div>
        </div>

        <div aria-live="polite">{success && <FeedbackMessage>{success}</FeedbackMessage>}</div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {manageable.length === 0 ? (
          <EmptyState
            title="No organization to manage"
            description="You do not manage employees in any organization."
          />
        ) : loading && !data ? (
          <LoadingState />
        ) : data ? (
          <>
            {data.truncated && (
              <p className="text-sm text-slate-700">
                Only the first {data.limit} of each list are shown; apply the oldest first.
              </p>
            )}
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-slate-900">Past their end date</h2>
              <DataTable
                label="Assignments past their end date"
                columns={overdueColumns}
                rows={data.assignmentEnds}
                rowKey={(row) => row.employmentAssignmentId}
                loading={loading}
                empty="No assignment is past its end date."
              />
            </div>
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-slate-900">
                Ending in the next {data.upcomingDays} days
              </h2>
              <DataTable
                label="Assignments ending soon"
                columns={upcomingColumns}
                rows={data.upcomingAssignmentEnds}
                rowKey={(row) => row.employmentAssignmentId}
                loading={loading}
                empty={`No assignment ends in the next ${data.upcomingDays} days.`}
              />
            </div>
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-slate-900">Terminations to apply</h2>
              {data.terminations.length === 0 ? (
                <p className="text-sm text-slate-700">No scheduled termination is due.</p>
              ) : (
                <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
                  {data.terminations.map((termination) => (
                    <li
                      key={termination.terminationId}
                      className="flex flex-wrap items-center justify-between gap-2 p-4"
                    >
                      <span>
                        <span className="font-medium text-slate-900">
                          {termination.employeeName ?? termination.employeeNumber}
                        </span>{' '}
                        <span className="text-sm text-slate-600">
                          · last day {formatDateOnly(termination.terminationDate)}
                        </span>
                      </span>
                      <Link
                        href={`/admin/employees/${encodeURIComponent(termination.employeeId)}`}
                        aria-label={`Open termination for ${termination.employeeName ?? termination.employeeNumber}`}
                        className={buttonClass('secondary', 'sm')}
                      >
                        Open termination
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </section>

      <ConfirmDialog
        open={applying !== null}
        title="Apply this assignment end?"
        description={
          applying ? (
            <>
              {applying.positionName} for {applying.employeeName ?? applying.employeeNumber} ends as
              of {formatDateOnly(applying.endDate)} ({applying.timezone}). Only this assignment
              ends: the employee stays employed, and other assignments are unchanged.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Apply end"
        busy={busy}
        onConfirm={() => void apply()}
        onCancel={() => {
          if (!busy) setApplying(null);
        }}
      >
        {applying && (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-slate-600">Organization</dt>
              <dd className="text-slate-900">{applying.organizationName}</dd>
              <dt className="text-slate-600">Employment type</dt>
              <dd className="text-slate-900">
                {employmentTypeLabel(applying.employmentType)}
                {applying.isPrimary ? ' (primary)' : ''}
              </dd>
              <dt className="text-slate-600">Started</dt>
              <dd className="text-slate-900">{formatDateOnly(applying.startDate)}</dd>
              <dt className="text-slate-600">Overdue by</dt>
              <dd className="text-slate-900">{days(applying.daysOverdue)}</dd>
            </dl>
            <AssignmentImpactPreview
              employeeId={applying.employeeId}
              assignmentId={applying.employmentAssignmentId}
              endDate={applying.endDate}
              showOffboarding={false}
            />
            {applyError && (
              <p role="alert" className="text-sm text-rose-800">
                {applyError}
              </p>
            )}
          </div>
        )}
      </ConfirmDialog>
    </PageContainer>
  );
}
