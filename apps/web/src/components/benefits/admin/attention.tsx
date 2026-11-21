'use client';

import Link from 'next/link';
import { benefitsApi } from '../../../lib/benefits/api';
import { TruncatedNotice } from '../../organization/shared';
import { coveragePeriod, EmptyState, FlagList } from '../benefits-shared';
import { SectionState, useSectionData, type SectionProps } from './shared';
import { DataTable } from '../../ui/data-table';

/** Elections needing attention (lost eligibility, ended sponsors, missing rates …). */
export function AttentionTab({ organizationId, version }: SectionProps) {
  const attention = useSectionData(
    () => benefitsApi.attention(organizationId),
    [organizationId, version],
  );
  const items = attention.data?.items ?? [];
  return (
    <SectionState
      loading={attention.loading}
      error={attention.error}
      onRetry={attention.reload}
      what="elections needing attention"
      hasData={attention.data !== null}
    >
      {items.length === 0 ? (
        <EmptyState>No elections need attention.</EmptyState>
      ) : (
        <div className="space-y-3">
          <TruncatedNotice truncated={attention.data?.truncated} shown={items.length} />
          <DataTable
            label="Elections needing attention"
            rows={items}
            rowKey={(item) => item.enrollmentId}
            columns={[
              {
                key: 'employee',
                header: 'Employee',
                rowHeader: true,
                cell: (item) => (
                  <>
                    <Link
                      className="underline"
                      href={`/admin/benefits/employees/${item.employeeId}`}
                    >
                      {item.displayName}
                    </Link>{' '}
                    <span className="text-xs text-slate-500">{item.employeeNumber}</span>
                    <Link
                      className="mt-1 block text-xs text-indigo-700 underline"
                      href={`/admin/benefits/employees/${item.employeeId}`}
                      aria-label={`Review ${item.plan.name} benefits of ${item.displayName}`}
                    >
                      Review benefits
                    </Link>
                  </>
                ),
              },
              {
                key: 'plan',
                header: 'Plan',
                cell: (item) => <>{item.plan.name}</>,
              },
              {
                key: 'coverage',
                header: 'Coverage',
                cell: (item) => <>{coveragePeriod(item.coverageStart, item.coverageEnd)}</>,
              },
              {
                key: 'flags',
                header: 'Needs attention',
                cell: (item) => (
                  <>
                    <FlagList flags={item.flags} />
                  </>
                ),
              },
            ]}
          />
        </div>
      )}
    </SectionState>
  );
}
