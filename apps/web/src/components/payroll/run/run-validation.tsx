'use client';

import Link from 'next/link';
import type { PayrollIssue } from '../../../lib/payroll/types';
import { DataTable } from '../../ui/data-table';
import { EmptyState, SeverityBadge } from '../payroll-shared';

// Batch 10D: moved from payroll-run-page.tsx unchanged.
/** A run blocked only by configuration: say where to fix it instead of leaving a dead end. */
export function UnpaidLeaveRuleGuidance() {
  return (
    <div
      role="note"
      className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
    >
      <p className="font-semibold">
        This run needs an unpaid leave rule before it can be approved.
      </p>
      <p className="mt-1">
        Unpaid leave falls on salaried days, but the pay calendar has no rule for reducing a salary.
        Set the rule on the pay calendar, then recalculate this run.
      </p>
      <Link
        href="/admin/payroll?tab=calendars"
        className="mt-2 inline-block font-semibold text-amber-950 underline"
      >
        Configure the pay calendar
      </Link>
    </div>
  );
}

export function ValidationTab({ issues }: { issues: PayrollIssue[] }) {
  if (issues.length === 0)
    return <EmptyState>No validation results. Calculate the run first.</EmptyState>;
  return (
    <DataTable
      label="Validation issues"
      minWidth="min-w-[720px]"
      rows={issues}
      rowKey={(issue) => issue.id}
      columns={[
        {
          key: 'severity',
          header: 'Severity',
          cell: (issue) => <SeverityBadge severity={issue.severity} />,
        },
        { key: 'code', header: 'Code', cell: (issue) => issue.code },
        {
          key: 'employee',
          header: 'Employee',
          cell: (issue) => (
            <>
              {issue.employee
                ? `${issue.employee.displayName} (${issue.employee.employeeNumber})`
                : 'Run'}
              {issue.assignment && (
                <span className="block text-xs text-slate-500">
                  {issue.assignment.positionName}
                </span>
              )}
            </>
          ),
        },
        { key: 'message', header: 'Message', cell: (issue) => issue.message },
      ]}
    />
  );
}
