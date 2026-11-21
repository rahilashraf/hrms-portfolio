'use client';

import { EmptyState } from '../ui/states';
import { DataTable, type DataTableColumn } from '../ui/data-table';
import { buttonClass } from '../ui/button';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader, ErrorBanner, LoadingState } from '../organization/shared';
import { organizationApi } from '../../lib/organization/api';
import type { JobTitle, Organization } from '../../lib/organization/types';
import { employeeApi } from '../../lib/employee/api';
import { employeeErrorMessage } from '../../lib/employee/errors';
import type {
  EmployeeDirectoryItem,
  EmployeeDirectoryQuery,
  EmployeeStatus,
} from '../../lib/employee/types';
import { displayName, EmployeeStatusBadge, employmentTypeLabel } from './employee-shared';
import { hasPermission } from '../../lib/authorization/can';
import { useAuth } from '../../providers/auth-provider';
import { PageContainer } from '../ui/page-container';
import { RequirePermission } from '../ui/require-permission';

const pageSize = 25;

export function EmployeeDirectoryPage() {
  const { authorization } = useAuth();
  // Batch 10B: the shared gate (loading and denied in the directory's own width).
  return (
    <RequirePermission
      anyOf={['employee.read']}
      width="wide"
      deniedMessage="You do not have permission to view employees."
    >
      <EmployeeDirectoryContent canManage={hasPermission(authorization, 'employee.manage')} />
    </RequirePermission>
  );
}

function EmployeeDirectoryContent({ canManage }: { canManage: boolean }) {
  const [search, setSearch] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [status, setStatus] = useState<EmployeeStatus | ''>('');
  const [organizationId, setOrganizationId] = useState('');
  const [jobTitleId, setJobTitleId] = useState('');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [jobTitles, setJobTitles] = useState<JobTitle[]>([]);
  const [items, setItems] = useState<EmployeeDirectoryItem[]>([]);
  const [nextAfterId, setNextAfterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const requestId = useRef(0);
  const nextAfterIdRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchTerm(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    organizationApi
      .listOrganizations(false)
      .then((value) => {
        if (active) setOrganizations(value);
      })
      .catch((cause) => {
        if (active)
          setLookupError(employeeErrorMessage(cause, 'Unable to load organization filters.'));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!organizationId) {
      return;
    }
    let active = true;
    organizationApi
      .listJobTitles(organizationId, false)
      .then((value) => {
        if (active) setJobTitles(value);
      })
      .catch((cause) => {
        if (active)
          setLookupError(employeeErrorMessage(cause, 'Unable to load job title filters.'));
      });
    return () => {
      active = false;
    };
  }, [organizationId]);

  const query = useMemo<EmployeeDirectoryQuery>(
    () => ({
      ...(searchTerm ? { search: searchTerm } : {}),
      ...(status ? { status } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(jobTitleId ? { jobTitleId } : {}),
      limit: pageSize,
    }),
    [searchTerm, status, organizationId, jobTitleId],
  );

  const load = useCallback(
    async (append: boolean) => {
      const current = ++requestId.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const cursor = nextAfterIdRef.current;
        const result = await employeeApi.list(
          append && cursor ? { ...query, afterId: cursor } : query,
        );
        if (current !== requestId.current) return;
        setItems((previous) => (append ? [...previous, ...result.items] : result.items));
        setNextAfterId(result.nextAfterId);
        nextAfterIdRef.current = result.nextAfterId;
      } catch (cause) {
        if (current === requestId.current) setError(employeeErrorMessage(cause));
      } finally {
        if (current === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [query],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(false), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function changeOrganization(value: string) {
    setOrganizationId(value);
    setJobTitles([]);
    setJobTitleId('');
    setLookupError(null);
  }

  const filtered = Boolean(searchTerm || status || organizationId || jobTitleId);
  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Admin"
        title="Employees"
        description="Search and view employees available in your authorized scope."
      >
        {canManage && (
          // R4-A.1: assignments past or near their end date, applied by hand (no automation).
          <Link href="/admin/employees/lifecycle" className={buttonClass('secondary')}>
            Ending assignments
          </Link>
        )}
        {canManage && (
          <Link
            href="/admin/employees/new"
            className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-800"
          >
            Add employee
          </Link>
        )}
      </PageHeader>
      <section className="mt-8 space-y-4">
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-5 md:grid-cols-4">
          <label className="text-sm font-medium text-slate-700 md:col-span-2">
            Search employees
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by employee number or name"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as EmployeeStatus | '')}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="TERMINATED">Terminated</option>
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">
            Organization
            <select
              value={organizationId}
              onChange={(event) => changeOrganization(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
            >
              <option value="">All organizations</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700 md:col-start-4">
            Job title
            <select
              value={jobTitleId}
              disabled={!organizationId}
              onChange={(event) => setJobTitleId(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 disabled:bg-slate-50"
            >
              <option value="">
                {organizationId ? 'All job titles' : 'Select an organization first'}
              </option>
              {jobTitles.map((title) => (
                <option key={title.id} value={title.id}>
                  {title.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {lookupError && <ErrorBanner>{lookupError}</ErrorBanner>}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {loading ? (
          <LoadingState />
        ) : items.length === 0 ? (
          <EmptyState
            icon="users"
            title={filtered ? 'No employees match these filters.' : 'No employees found.'}
            description={
              filtered
                ? 'Try clearing a filter or searching by name or employee number.'
                : canManage
                  ? 'Employees you add, and employees within your access, appear here.'
                  : 'Only employees within your access appear here. Ask an administrator if someone is missing.'
            }
          />
        ) : (
          <DataTable
            label="Employees"
            minWidth="min-w-[760px]"
            columns={DIRECTORY_COLUMNS}
            rows={items}
            rowKey={(item) => item.id}
          />
        )}
        {!loading && nextAfterId && (
          <div className="flex justify-center">
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void load(true)}
              className={buttonClass('secondary')}
            >
              {loadingMore ? 'Loading…' : 'Load more employees'}
            </button>
          </div>
        )}
      </section>
    </PageContainer>
  );
}

/** Batch 10B: the shared DataTable (named, keyboard-scrollable region; the name is the row header). */
const DIRECTORY_COLUMNS: ReadonlyArray<DataTableColumn<EmployeeDirectoryItem>> = [
  {
    key: 'number',
    header: 'Employee #',
    className: 'font-mono text-xs text-slate-600',
    cell: (item) => (
      <Link
        href={`/admin/employees/${item.id}`}
        className="text-[var(--hrms-accent-text)] hover:underline"
      >
        {item.employeeNumber}
      </Link>
    ),
  },
  {
    key: 'name',
    header: 'Name',
    rowHeader: true,
    className: 'text-slate-900',
    cell: (item) => (
      <Link href={`/admin/employees/${item.id}`} className="hover:text-[var(--hrms-accent-text)]">
        {displayName(item.person)}
      </Link>
    ),
  },
  {
    key: 'position',
    header: 'Position',
    cell: (item) => item.displayAssignment?.position.name || 'No assignment',
  },
  {
    key: 'jobTitle',
    header: 'Job title',
    cell: (item) => item.displayAssignment?.jobTitle.name || '—',
  },
  {
    key: 'organization',
    header: 'Organization',
    cell: (item) => item.displayAssignment?.organization.name || '—',
  },
  {
    key: 'employmentType',
    header: 'Employment type',
    cell: (item) =>
      item.displayAssignment ? employmentTypeLabel(item.displayAssignment.employmentType) : '—',
  },
  {
    key: 'status',
    header: 'Status',
    cell: (item) => (
      <EmployeeStatusBadge status={item.status} terminationDate={item.terminationDate} />
    ),
  },
];
