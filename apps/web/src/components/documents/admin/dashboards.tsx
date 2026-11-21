'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { TruncatedNotice } from '../../organization/shared';
import { documentsApi } from '../../../lib/documents/api';
import type { ExpiryDashboard, MissingDashboard } from '../../../lib/documents/types';
import {
  EmptyState,
  ExpiryBadge,
  Field,
  formatDateOnly,
  inputClass,
  RequirementBadge,
  secondaryButton,
} from '../documents-shared';
import { Loading, useData } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-2: the expiring and missing documents dashboards (moved from
// documents-admin-page.tsx unchanged).
const employeeLink = (employee: {
  id: string;
  displayName: string | null;
  employeeNumber: string;
}) => (
  <>
    <Link className="text-indigo-700 underline" href={`/admin/employees/${employee.id}`}>
      {employee.displayName ?? employee.employeeNumber}
    </Link>
    <span className="block text-xs text-slate-500">{employee.employeeNumber}</span>
  </>
);

export function ExpiringTab({
  organizationId,
  onError,
}: {
  organizationId: string;
  onError(message: string): void;
}) {
  const [draft, setDraft] = useState('30');
  const [withinDays, setWithinDays] = useState(30);
  const load = useCallback(
    () => documentsApi.expiring(organizationId, withinDays),
    [organizationId, withinDays],
  );
  const { data, loaded } = useData<ExpiryDashboard>(load, onError);
  return (
    <div className="space-y-4">
      <form
        aria-label="Expiry window"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const days = Number.parseInt(draft, 10);
          if (Number.isNaN(days)) return;
          setWithinDays(Math.min(365, Math.max(0, days)));
        }}
      >
        <Field label="Expiring within (days)">
          <input
            className={inputClass}
            type="number"
            min={0}
            max={365}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
        </Field>
        <button type="submit" className={secondaryButton}>
          Apply
        </button>
      </form>
      {!loaded ? (
        <Loading />
      ) : !data ? (
        <EmptyState>The expiry dashboard is unavailable.</EmptyState>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            Expired documents and those expiring by{' '}
            {formatDateOnly(addDaysText(data.today, data.withinDays))} (within {data.withinDays}{' '}
            days of {formatDateOnly(data.today)}).
          </p>
          <TruncatedNotice truncated={data.truncated} shown={data.items.length} />
          {data.items.length === 0 ? (
            <EmptyState>No documents expire within {data.withinDays} days.</EmptyState>
          ) : (
            <DataTable
              label="Expiring documents"
              rows={data.items}
              rowKey={(item) => item.documentId}
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  rowHeader: true,
                  cell: (item) => <>{employeeLink(item.employee)}</>,
                },
                {
                  key: 'document',
                  header: 'Document',
                  cell: (item) => (
                    <>
                      <Link
                        className="text-indigo-700 underline"
                        href={`/documents/records/${item.documentId}`}
                      >
                        {item.title}
                      </Link>
                    </>
                  ),
                },
                {
                  key: 'type',
                  header: 'Type',
                  cell: (item) => <>{item.type.name}</>,
                },
                {
                  key: 'expires',
                  header: 'Expires',
                  cell: (item) => <>{formatDateOnly(item.expiresOn)}</>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (item) => (
                    <>
                      <ExpiryBadge status={item.expiryStatus} />
                    </>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
    </div>
  );
}

/** YYYY-MM-DD plus whole days (UTC calendar arithmetic). */
function addDaysText(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.getTime())) return date;
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function MissingTab({
  organizationId,
  onError,
}: {
  organizationId: string;
  onError(message: string): void;
}) {
  const load = useCallback(() => documentsApi.missing(organizationId), [organizationId]);
  const { data, loaded } = useData<MissingDashboard>(load, onError);
  if (!loaded) return <Loading />;
  if (!data) return <EmptyState>The missing documents dashboard is unavailable.</EmptyState>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Employees missing a required document, or whose only one has expired (as of{' '}
        {formatDateOnly(data.today)}).
      </p>
      <TruncatedNotice truncated={data.truncated} shown={data.items.length} />
      {data.items.length === 0 ? (
        <EmptyState>No required documents are missing.</EmptyState>
      ) : (
        <DataTable
          label="Missing documents"
          rows={data.items}
          rowKey={(item) => item.employee.id}
          columns={[
            {
              key: 'employee',
              header: 'Employee',
              rowHeader: true,
              cell: (item) => <>{employeeLink(item.employee)}</>,
            },
            {
              key: 'missing',
              header: 'Missing documents',
              cell: (item) => (
                <>
                  <ul className="space-y-1">
                    {item.missing.map((missing) => (
                      <li key={missing.typeId} className="flex items-center gap-2">
                        {missing.typeName} <RequirementBadge status={missing.status} />
                      </li>
                    ))}
                  </ul>
                </>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
