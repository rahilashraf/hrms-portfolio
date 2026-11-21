'use client';

import { ErrorState, LoadingState } from '../ui/states';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { PageContainer } from '../ui/page-container';
import { RequirePermission } from '../ui/require-permission';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { payrollApi } from '../../lib/payroll/api';
import { PAYROLL_BLOCKED_MESSAGES, payrollErrorMessage } from '../../lib/payroll/errors';
import { formatDateOnly, formatMoney } from '../../lib/payroll/format';
import type {
  PayrollEmployeeDetail,
  PayrollFreshness,
  PayrollIssue,
  PayrollRunDetail,
} from '../../lib/payroll/types';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { keepFocusInPage } from '../ui/focus';
import { DataTable } from '../ui/data-table';
import { useConfirm } from '../ui/use-confirm';
import { lifecycleSteps, Stepper } from '../ui/stepper';
import { PAYROLL_PERMISSION_KEYS } from './payroll-admin-page';
import { PayslipDocument, payslipFromRun } from './payslip-document';
import {
  DualControlNotice,
  EmptyState,
  inputClass,
  primaryButton,
  RunStatusBadge,
  secondaryButton,
  StatutoryNotice,
} from './payroll-shared';
import { AdjustmentsTab } from './run/run-adjustments';
import { DeductionsTab, EarningsTab, ManualLineForm } from './run/run-lines';
import { Summary } from './run/run-summary';
import { UnpaidLeaveRuleGuidance, ValidationTab } from './run/run-validation';

type Tab =
  'summary' | 'employees' | 'earnings' | 'deductions' | 'payslip' | 'validation' | 'adjustments';
/** The real PayrollRunStatus lifecycle (VOIDED is terminal and off this path). */
const RUN_LIFECYCLE = [
  { key: 'DRAFT', label: 'Draft' },
  { key: 'CALCULATED', label: 'Calculated' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'FINALIZED', label: 'Finalized' },
] as const;

/** What happens next for each state, and who can do it. */
export function runNextStep(run: Pick<PayrollRunDetail, 'status' | 'actions'>): string {
  switch (run.status) {
    case 'DRAFT':
      return run.actions.canCalculate
        ? 'Next: calculate the run to produce pay statements.'
        : 'Waiting for someone with payroll calculation access to calculate the run.';
    case 'CALCULATED':
      return run.actions.canApprove
        ? 'Next: review the validation issues, then approve the run.'
        : 'Waiting for review and approval.';
    case 'APPROVED':
      return run.actions.canFinalize
        ? 'Next: finalize the run to lock it and publish pay statements.'
        : 'Waiting to be finalized.';
    case 'FINALIZED':
      return 'This run is finalized. Corrections are made with adjustments.';
    case 'VOIDED':
      return 'This run was voided and is kept for audit only.';
  }
}

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'employees', label: 'Employees' },
  { id: 'earnings', label: 'Earnings' },
  { id: 'deductions', label: 'Deductions' },
  { id: 'payslip', label: 'Payslip' },
  { id: 'validation', label: 'Validation' },
  { id: 'adjustments', label: 'Adjustments' },
];

export function PayrollRunPage({ runId }: { runId: string }) {
  // Batch 10D: loading and the denied state in the run page's own width (it loaded at 5xl and
  // rendered at 6xl). Presentation only — the API checks every payroll request.
  return (
    <RequirePermission
      anyOf={PAYROLL_PERMISSION_KEYS}
      width="wide"
      deniedMessage="You do not have permission to view payroll."
    >
      <PayrollRun runId={runId} />
    </RequirePermission>
  );
}

function PayrollRun({ runId }: { runId: string }) {
  const [run, setRun] = useState<PayrollRunDetail | null>(null);
  const [issues, setIssues] = useState<PayrollIssue[]>([]);
  // Batch 10D: the run's sections are deep-linkable (/admin/payroll/runs/:id?tab=validation)
  // through the shared useTabParam in query mode; Back/Forward follow the URL.
  const [tab, setTab] = useTabParam<Tab>(
    TABS.map((entry) => entry.id),
    'summary',
    { mode: 'query' },
  );
  const tabIdBase = useTabIdBase('payroll');
  const [employeeId, setEmployeeId] = useState('');
  const [employee, setEmployee] = useState<PayrollEmployeeDetail | null>(null);
  const [freshness, setFreshness] = useState<PayrollFreshness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [voidReason, setVoidReason] = useState('');
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      const detail = await payrollApi.run(runId);
      setRun(detail);
      // Batch 7C: a freshness check describes the run as it was; once the run is reloaded
      // (recalculated, approved…) the old result would mislead, so it is cleared.
      setFreshness(null);
      setIssues((await payrollApi.issues(runId)).items);
      setEmployeeId((current) => current || detail.employees[0]?.id || '');
      setError(null);
    } catch (cause) {
      setError(payrollErrorMessage(cause, 'Unable to load the payroll run.'));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const loadEmployee = useCallback(async () => {
    if (!employeeId) {
      setEmployee(null);
      return;
    }
    try {
      setEmployee(await payrollApi.employee(runId, employeeId));
    } catch (cause) {
      setError(payrollErrorMessage(cause, 'Unable to load the employee.'));
    }
  }, [runId, employeeId]);

  useEffect(() => {
    if (tab !== 'earnings' && tab !== 'deductions' && tab !== 'payslip') return;
    const timer = window.setTimeout(() => void loadEmployee(), 0);
    return () => window.clearTimeout(timer);
  }, [tab, loadEmployee]);

  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      setSuccess(message);
      await load();
      if (tab === 'earnings' || tab === 'deductions' || tab === 'payslip') await loadEmployee();
      return true;
    } catch (cause) {
      // A stale or blocked run changes status server-side: show what it is now, then why.
      await load();
      setError(payrollErrorMessage(cause, 'Unable to complete the payroll action.'));
      return false;
    } finally {
      setBusy(false);
      // Batch 11C: the action may have removed its own button (Approve, Finalize, Void); keep
      // keyboard and screen-reader focus in the page rather than on <body>.
      window.requestAnimationFrame(keepFocusInPage);
    }
  }

  if (loading) {
    return (
      <PageContainer width="wide">
        <LoadingState label="Loading payroll run…" />
      </PageContainer>
    );
  }
  if (!run) {
    return (
      <PageContainer width="wide">
        <ErrorState
          title="Payroll run unavailable"
          message={error ?? 'The payroll run was not found.'}
          onRetry={() => void load()}
          action={{ label: 'Back to payroll', href: '/admin/payroll' }}
        />
      </PageContainer>
    );
  }

  const money = (value: string | null) => formatMoney(value, run.currency);
  const { actions } = run;

  return (
    // Batch 10D: the breadcrumb (Payroll › Payroll run) links back; the old "← Payroll" link
    // repeated it.
    <PageContainer width="wide">
      <PageHeader
        eyebrow={`${run.payGroup.name} · ${run.currency}`}
        title={`Pay period ${formatDateOnly(run.period.periodStart)} – ${formatDateOnly(run.period.periodEnd)}`}
        description={`Pay date ${formatDateOnly(run.period.payDate)}`}
      >
        <RunStatusBadge status={run.status} />
      </PageHeader>
      <div className="mt-6 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <Stepper
          label="Payroll run progress"
          steps={lifecycleSteps(RUN_LIFECYCLE, run.status, {
            completeAtEnd: true,
            reached: run.approvedAt ? 'APPROVED' : run.calculatedAt ? 'CALCULATED' : 'DRAFT',
          })}
        />
        <p className="text-sm text-slate-700" data-testid="run-next-step">
          {runNextStep(run)}
        </p>
      </div>
      <div className="mt-6 space-y-4">
        <StatutoryNotice />
        <DualControlNotice dualControl={run.dualControl} />
        {issues.some((issue) => issue.code === 'SALARY_UNPAID_LEAVE_REQUIRES_RULE') && (
          <UnpaidLeaveRuleGuidance />
        )}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Run actions">
          {actions.canCalculate && (
            <button
              type="button"
              disabled={busy}
              className={primaryButton}
              onClick={() =>
                void act(
                  () => payrollApi.calculate(run.id),
                  run.status === 'DRAFT' ? 'Run calculated.' : 'Run recalculated.',
                )
              }
            >
              {run.status === 'DRAFT' ? 'Calculate' : 'Recalculate'}
            </button>
          )}
          {actions.canApprove && (
            <button
              type="button"
              disabled={busy}
              className={primaryButton}
              onClick={async () => {
                const period = `${formatDateOnly(run.period.periodStart)} – ${formatDateOnly(run.period.periodEnd)}`;
                const issues = run.issueCounts.WARNING;
                if (
                  await confirm({
                    title: 'Approve this payroll run?',
                    description: `Approving confirms the ${run.payGroup.name} ${run.currency} run for ${period} (gross ${money(run.totals.grossAmount)}, ${run.employees.length} employee(s)${issues ? `, ${issues} warning(s)` : ''}) is ready to be finalized. Manual lines can no longer be added; recalculating the run later withdraws the approval.`,
                    confirmLabel: 'Approve run',
                    destructive: false,
                  })
                )
                  void act(() => payrollApi.approve(run.id), 'Run approved.');
              }}
            >
              Approve
            </button>
          )}
          {actions.canFinalize && (
            <button
              type="button"
              disabled={busy}
              className={primaryButton}
              onClick={async () => {
                const period = `${formatDateOnly(run.period.periodStart)} – ${formatDateOnly(run.period.periodEnd)}`;
                if (
                  await confirm({
                    title: 'Finalize this payroll run?',
                    description: `Finalizing locks the ${run.payGroup.name} run for ${period}: it can no longer be recalculated or edited, and later corrections become adjustments in a later period.`,
                    confirmLabel: 'Finalize run',
                    destructive: false,
                  })
                )
                  void act(() => payrollApi.finalize(run.id), 'Run finalized.');
              }}
            >
              Finalize
            </button>
          )}
          {run.calculatedAt && (
            <button
              type="button"
              disabled={busy}
              className={secondaryButton}
              onClick={() =>
                void payrollApi
                  .freshness(run.id)
                  .then(setFreshness)
                  .catch((cause) => setError(payrollErrorMessage(cause)))
              }
            >
              Check sources
            </button>
          )}
          {actions.canVoid && (
            <form
              aria-label="Void run"
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setConfirmVoid(true);
              }}
            >
              <input
                aria-label="Void reason"
                required
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
                placeholder="Reason to void"
                value={voidReason}
                onChange={(event) => setVoidReason(event.currentTarget.value)}
              />
              <button type="submit" disabled={busy} className={secondaryButton}>
                Void
              </button>
            </form>
          )}
          {confirmDialog}
          <ConfirmDialog
            open={confirmVoid}
            title="Void this payroll run?"
            description="Voiding is permanent: the run and its statements are kept for audit but can no longer be approved, finalized or paid."
            confirmLabel="Void run"
            busy={busy}
            onCancel={() => setConfirmVoid(false)}
            onConfirm={() =>
              void act(() => payrollApi.void(run.id, voidReason), 'Run voided.').finally(() =>
                setConfirmVoid(false),
              )
            }
          />
        </div>
        {/* M2: why the viewer cannot approve or finalize (the server decides). */}
        {run.status === 'CALCULATED' && actions.approveBlockedReason && (
          <p className="text-sm text-slate-700">
            {PAYROLL_BLOCKED_MESSAGES[actions.approveBlockedReason] ??
              'You cannot approve this run.'}
          </p>
        )}
        {run.status === 'APPROVED' && actions.finalizeBlockedReason && (
          <p className="text-sm text-slate-700">
            {PAYROLL_BLOCKED_MESSAGES[actions.finalizeBlockedReason] ??
              'You cannot finalize this run.'}
          </p>
        )}
        {freshness && (
          <p role="status" className="text-sm text-slate-700">
            {freshness.stale
              ? `Sources changed since calculation (${freshness.changedAssignmentIds.length} assignment(s)); recalculate before approval.`
              : 'Sources are unchanged since calculation.'}
          </p>
        )}
        <TabList<Tab>
          tabs={TABS}
          active={tab}
          onChange={setTab}
          label="Run sections"
          idBase={tabIdBase}
        />
        <TabPanel idBase={tabIdBase} id={tab}>
          {tab === 'summary' && <Summary run={run} />}
          {tab === 'employees' && (
            <DataTable
              label="Employees in this run"
              minWidth="min-w-[800px]"
              rows={run.employees}
              rowKey={(row) => row.id}
              empty="No employees in this run yet."
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  rowHeader: true,
                  cell: (row) => (
                    <>
                      {row.displayName}
                      <span className="block text-xs text-slate-500">{row.employeeNumber}</span>
                    </>
                  ),
                },
                {
                  key: 'assignments',
                  header: 'Assignments',
                  cell: (row) => row.assignments.map((a) => a.positionName).join(', '),
                },
                { key: 'gross', header: 'Gross pay', cell: (row) => money(row.grossAmount) },
                {
                  key: 'deductions',
                  header: 'Deductions',
                  cell: (row) => money(row.deductionAmount),
                },
                {
                  key: 'employer',
                  header: 'Employer contributions',
                  cell: (row) => money(row.employerContributionAmount),
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  cell: (row) => (
                    <>
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Earnings for ${row.displayName}`}
                        onClick={() => {
                          setEmployeeId(row.id);
                          setTab('earnings');
                        }}
                      >
                        Earnings
                      </button>
                      <button
                        type="button"
                        className={`${secondaryButton} ml-2`}
                        aria-label={`Payslip for ${row.displayName}`}
                        onClick={() => {
                          setEmployeeId(row.id);
                          setTab('payslip');
                        }}
                      >
                        Payslip
                      </button>
                    </>
                  ),
                },
              ]}
            />
          )}
          {(tab === 'earnings' || tab === 'deductions' || tab === 'payslip') && (
            <div className="space-y-4">
              {run.employees.length === 0 ? (
                <EmptyState>No employees in this run yet.</EmptyState>
              ) : (
                <label className="block max-w-sm text-sm font-medium text-slate-800">
                  Employee
                  <select
                    className={inputClass}
                    value={employeeId}
                    onChange={(event) => setEmployeeId(event.currentTarget.value)}
                  >
                    {run.employees.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.displayName} ({row.employeeNumber})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {employee && tab === 'payslip' && employee.id === employeeId && (
                <PayslipDocument payslip={payslipFromRun(run, employee)} />
              )}
              {employee && tab === 'earnings' && (
                <EarningsTab
                  employee={employee}
                  currency={run.currency}
                  canEdit={actions.canAddManualLines}
                  busy={busy}
                  onReverse={(lineId, kind, reason) =>
                    act(
                      () => payrollApi.reverseManualLine(run.id, lineId, kind, reason),
                      'Line reversed.',
                    )
                  }
                />
              )}
              {employee && tab === 'deductions' && (
                <DeductionsTab
                  employee={employee}
                  currency={run.currency}
                  canEdit={actions.canAddManualLines}
                  busy={busy}
                  onReverse={(lineId, kind, reason) =>
                    act(
                      () => payrollApi.reverseManualLine(run.id, lineId, kind, reason),
                      'Line reversed.',
                    )
                  }
                />
              )}
              {employee && tab !== 'payslip' && actions.canAddManualLines && (
                <ManualLineForm
                  employee={employee}
                  defaultKind={tab === 'earnings' ? 'EARNING' : 'DEDUCTION'}
                  busy={busy}
                  onSubmit={(input) =>
                    act(() => payrollApi.addManualLine(run.id, input), 'Manual line added.')
                  }
                />
              )}
            </div>
          )}
          {tab === 'validation' && <ValidationTab issues={issues} />}
          {tab === 'adjustments' && <AdjustmentsTab run={run} busy={busy} act={act} />}
        </TabPanel>
      </div>
    </PageContainer>
  );
}
