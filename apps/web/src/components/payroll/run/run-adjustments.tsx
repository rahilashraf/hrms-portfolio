'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../../organization/shared';
import { payrollApi } from '../../../lib/payroll/api';
import { payrollErrorMessage } from '../../../lib/payroll/errors';
import { formatMoney, label } from '../../../lib/payroll/format';
import type {
  PayrollAdjustment,
  PayrollRunDetail,
  RetroDifference,
} from '../../../lib/payroll/types';
import { DataTable } from '../../ui/data-table';
import { FormDialog } from '../../ui/form-dialog';
import { EmptyState, inputClass, primaryButton } from '../payroll-shared';

// Batch 10D: the run's adjustments and benefit retro differences (moved from
// payroll-run-page.tsx unchanged).
export function AdjustmentsTab({
  run,
  busy,
  act,
}: {
  run: PayrollRunDetail;
  busy: boolean;
  act(action: () => Promise<unknown>, message: string): Promise<boolean>;
}) {
  const [carried, setCarried] = useState<PayrollAdjustment[]>([]);
  const [retro, setRetro] = useState<RetroDifference[] | null>(null);
  const [created, setCreated] = useState<PayrollAdjustment[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const finalized = run.status === 'FINALIZED';

  const load = useCallback(async () => {
    try {
      setCarried(
        (await payrollApi.adjustments(run.organizationId, { payrollRunId: run.id })).items,
      );
      if (finalized) {
        setCreated(
          (await payrollApi.adjustments(run.organizationId, { sourceRunId: run.id })).items,
        );
        setRetro((await payrollApi.retroPreview(run.id)).items);
      }
      setError(null);
    } catch (cause) {
      setError(payrollErrorMessage(cause, 'Unable to load adjustments.'));
    }
  }, [run.organizationId, run.id, finalized]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const money = (value: string) => formatMoney(value, run.currency);
  const owed = retro?.filter((item) => !item.blocked && item.difference !== '0.00') ?? [];
  // Batch 7C (C2): benefit cost differences a person resolves explicitly.
  const benefitPending =
    retro?.filter((item) => item.warnings?.includes('BENEFIT_DIFFERENCE_UNRESOLVED')) ?? [];
  const [resolving, setResolving] = useState<RetroDifference | null>(null);

  return (
    <div className="space-y-4">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <h2 className="text-sm font-semibold uppercase text-slate-500">
        {finalized ? 'Adjustments applied by this run' : 'Adjustments carried by this run'}
      </h2>
      <AdjustmentTable
        label={finalized ? 'Applied adjustments' : 'Carried adjustments'}
        rows={carried}
        money={money}
      />
      {finalized && (
        <>
          <h2 className="text-sm font-semibold uppercase text-slate-500">
            Retroactive differences (current sources vs. finalized)
          </h2>
          {retro === null ? (
            <p role="status" className="text-sm text-slate-600">
              Loading…
            </p>
          ) : retro.every(
              (item) =>
                item.difference === '0.00' &&
                !item.blocked &&
                (item.benefitDifference?.employeeDeductions ?? '0.00') === '0.00' &&
                (item.benefitDifference?.employerContributions ?? '0.00') === '0.00',
            ) ? (
            <EmptyState>The finalized run still matches its sources.</EmptyState>
          ) : (
            <DataTable
              label="Retroactive differences"
              minWidth="min-w-[880px]"
              rows={retro.map((item) => {
                const pending = item.warnings?.includes('BENEFIT_DIFFERENCE_UNRESOLVED');
                const benefit = item.benefitDifference;
                const changed =
                  benefit &&
                  (benefit.employeeDeductions !== '0.00' ||
                    benefit.employerContributions !== '0.00');
                return { item, pending, benefit, changed };
              })}
              rowKey={({ item }) => item.employmentAssignmentId}
              columns={[
                {
                  key: 'assignment',
                  header: 'Assignment',
                  rowHeader: true,
                  cell: ({ item }) => (
                    <>
                      {item.displayName ?? 'Unnamed employee'}
                      {item.blocked && (
                        <span className="block text-xs text-rose-700">
                          Blocked: {item.blockingCodes.join(', ')}
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  key: 'finalized',
                  header: 'Finalized',
                  cell: ({ item }) => money(item.finalizedGross),
                },
                { key: 'current', header: 'Current', cell: ({ item }) => money(item.currentGross) },
                {
                  key: 'alreadyAdjusted',
                  header: 'Already adjusted',
                  cell: ({ item }) => money(item.alreadyAdjusted),
                },
                {
                  key: 'difference',
                  header: 'Difference',
                  cell: ({ item }) => money(item.difference),
                },
                {
                  key: 'benefit',
                  header: 'Benefit costs',
                  cell: ({ pending, benefit, changed }) => (
                    <>
                      {changed && benefit ? (
                        <>
                          <span className="block">
                            Employee deductions {money(benefit.employeeDeductions)}
                          </span>
                          <span className="block">
                            Employer contributions {money(benefit.employerContributions)}
                          </span>
                          <span
                            className={`block text-xs font-medium ${pending ? 'text-amber-800' : 'text-emerald-800'}`}
                          >
                            {pending ? 'Needs a decision' : 'Resolved'}
                          </span>
                        </>
                      ) : (
                        'No change'
                      )}
                    </>
                  ),
                },
              ]}
            />
          )}
          {benefitPending.length > 0 && (
            <section aria-labelledby="benefit-differences-heading" className="space-y-2">
              <h3 id="benefit-differences-heading" className="text-sm font-semibold text-amber-900">
                Benefit cost differences to resolve
              </h3>
              <p className="text-sm text-slate-700">
                Benefit costs changed after this run was finalized. They are never corrected
                automatically: correct the employee&apos;s deduction in the next run with an
                adjustment, or record that no adjustment is required. Until then later runs keep
                warning about this run.
              </p>
              {run.actions.canAdjust ? (
                <ul className="flex flex-wrap gap-2">
                  {benefitPending.map((item) =>
                    item.blocked || item.difference !== '0.00' ? (
                      // The API resolves a benefit difference once pay differences are settled.
                      <li key={item.employmentAssignmentId} className="text-sm text-slate-700">
                        {item.displayName ?? 'This employee'}: create the retroactive pay
                        adjustments first, then resolve the benefit difference.
                      </li>
                    ) : (
                      <li key={item.employmentAssignmentId}>
                        <button
                          type="button"
                          className={primaryButton}
                          disabled={busy}
                          onClick={() => setResolving(item)}
                        >
                          Resolve benefit difference for {item.displayName ?? 'this employee'}
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p className="text-sm text-slate-600">
                  Someone with payroll adjustment access resolves these.
                </p>
              )}
            </section>
          )}
          {resolving && (
            <BenefitDifferenceDialog
              run={run}
              item={resolving}
              onClose={() => setResolving(null)}
              onResolved={() => {
                setResolving(null);
                void load();
              }}
            />
          )}
          {run.actions.canAdjust && owed.length > 0 && (
            <form
              aria-label="Create retroactive adjustments"
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void act(
                  () => payrollApi.createRetroAdjustments(run.id, reason),
                  'Retroactive adjustments created for the next run.',
                ).then(() => load());
              }}
            >
              <label className="text-sm font-medium text-slate-800">
                Reason
                <input
                  required
                  className={inputClass}
                  value={reason}
                  onChange={(event) => setReason(event.currentTarget.value)}
                />
              </label>
              <button type="submit" disabled={busy} className={primaryButton}>
                Create adjustments
              </button>
            </form>
          )}
          <h2 className="text-sm font-semibold uppercase text-slate-500">
            Adjustments correcting this run
          </h2>
          <AdjustmentTable label="Correcting adjustments" rows={created} money={money} />
        </>
      )}
    </div>
  );
}

/**
 * Batch 7C (C2) — resolving one assignment's benefit cost difference: either a DEDUCTION
 * adjustment correcting the employee's share in the next run (the existing authorized adjustment
 * workflow), or an explicit "no adjustment required" decision. Both need a reason.
 */
function BenefitDifferenceDialog({
  run,
  item,
  onClose,
  onResolved,
}: {
  run: PayrollRunDetail;
  item: RetroDifference;
  onClose(): void;
  onResolved(): void;
}) {
  const employee = item.benefitDifference?.employeeDeductions ?? '0.00';
  const employer = item.benefitDifference?.employerContributions ?? '0.00';
  const [outcome, setOutcome] = useState<'ADJUSTED' | 'NO_ADJUSTMENT_REQUIRED'>(
    employee === '0.00' ? 'NO_ADJUSTMENT_REQUIRED' : 'ADJUSTED',
  );
  const [amount, setAmount] = useState(employee);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = item.displayName ?? 'this employee';
  const valid =
    reason.trim() !== '' &&
    (outcome === 'NO_ADJUSTMENT_REQUIRED' ||
      (/^-?\d{1,12}(\.\d{1,2})?$/.test(amount.trim()) && /[1-9]/.test(amount)));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // One request: the deduction adjustment is created with the resolution, so a retry
      // after a failure never leaves an extra adjustment behind.
      await payrollApi.resolveBenefitDifference(run.id, {
        employmentAssignmentId: item.employmentAssignmentId,
        outcome,
        reason,
        ...(outcome === 'ADJUSTED'
          ? { adjustment: { amount, description: 'Benefit deduction correction' } }
          : {}),
      });
      onResolved();
    } catch (cause) {
      setError(payrollErrorMessage(cause, 'Unable to resolve the benefit difference.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open
      title={`Resolve benefit difference for ${name}`}
      description={`Employee deductions changed by ${formatMoney(employee, run.currency)}; employer contributions by ${formatMoney(employer, run.currency)}. The finalized run never changes.`}
      submitLabel={outcome === 'ADJUSTED' ? 'Create adjustment and resolve' : 'Record decision'}
      busy={busy}
      canSubmit={valid}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">Resolution</legend>
        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input
            type="radio"
            name="benefit-outcome"
            checked={outcome === 'ADJUSTED'}
            onChange={() => setOutcome('ADJUSTED')}
          />
          Correct the employee&apos;s deduction in the next run (a deduction adjustment)
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input
            type="radio"
            name="benefit-outcome"
            checked={outcome === 'NO_ADJUSTMENT_REQUIRED'}
            onChange={() => setOutcome('NO_ADJUSTMENT_REQUIRED')}
          />
          No adjustment required (for example, settled with the carrier)
        </label>
      </fieldset>
      {outcome === 'ADJUSTED' && (
        <label className="block text-sm font-medium text-slate-800">
          Deduction adjustment ({run.currency}; negative refunds the employee)
          <input
            className={inputClass}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
        </label>
      )}
      <label className="block text-sm font-medium text-slate-800">
        Reason
        <textarea
          required
          className={inputClass}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </label>
    </FormDialog>
  );
}

function AdjustmentTable({
  label: tableLabel,
  rows,
  money,
}: {
  label: string;
  rows: PayrollAdjustment[];
  money(value: string): string;
}) {
  if (rows.length === 0) return <EmptyState>None.</EmptyState>;
  return (
    <DataTable
      label={tableLabel}
      minWidth="min-w-[720px]"
      rows={rows}
      rowKey={(row) => row.id}
      columns={[
        {
          key: 'employee',
          header: 'Employee',
          rowHeader: true,
          cell: (row) => (
            <>
              {row.displayName ?? row.employeeId}
              {row.positionName && (
                <span className="block text-xs text-slate-500">{row.positionName}</span>
              )}
            </>
          ),
        },
        {
          key: 'description',
          header: 'Description',
          cell: (row) => (
            <>
              {row.description}
              <span className="block text-xs text-slate-500">{row.reason}</span>
            </>
          ),
        },
        { key: 'kind', header: 'Kind', cell: (row) => label(row.kind) },
        { key: 'amount', header: 'Amount', cell: (row) => money(row.amount) },
        { key: 'status', header: 'Status', cell: (row) => label(row.status) },
      ]}
    />
  );
}
