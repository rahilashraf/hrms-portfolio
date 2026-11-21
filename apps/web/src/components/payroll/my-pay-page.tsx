'use client';

import { useEffect, useState } from 'react';
import { PageHeader, ErrorBanner } from '../organization/shared';
import { payrollApi } from '../../lib/payroll/api';
import { isPayrollForbidden, payrollErrorMessage } from '../../lib/payroll/errors';
import { formatDateOnly, formatMoney } from '../../lib/payroll/format';
import type { MyPayItem, Payslip } from '../../lib/payroll/types';
import { EmptyState, secondaryButton } from './payroll-shared';
import { PayslipDocument, payslipFromSelf } from './payslip-document';
import { PageContainer } from '../ui/page-container';
import { DataTable } from '../ui/data-table';

/** Employee self-service: one's own finalized pay statements, read-only. */
export function MyPayPage() {
  const [items, setItems] = useState<MyPayItem[]>([]);
  const [explanation, setExplanation] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEmployee, setNotEmployee] = useState(false);
  const [payslip, setPayslip] = useState<Payslip | null>(null);
  const [slipError, setSlipError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      payrollApi
        .myPay()
        .then((value) => {
          if (!active) return;
          setItems(value.items);
          setExplanation(value.netPayExplanation);
        })
        .catch((cause) => {
          if (!active) return;
          setNotEmployee(isPayrollForbidden(cause));
          setError(payrollErrorMessage(cause, 'Unable to load your pay.'));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const [opening, setOpening] = useState<string | null>(null);

  async function open(id: string) {
    setSlipError(null);
    setOpening(id);
    try {
      setPayslip(await payrollApi.payslip(id));
    } catch (cause) {
      setSlipError(payrollErrorMessage(cause, 'Unable to load the pay statement.'));
    } finally {
      setOpening(null);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Self-service"
        title="My pay statements"
        description="Your finalized pay, period by period. Contact payroll if something looks wrong."
      />
      <div className="mt-8 space-y-6">
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading pay statements…
          </p>
        ) : notEmployee ? (
          <EmptyState>
            Your account is not linked to an employee record, so there is no pay to show.
          </EmptyState>
        ) : error ? (
          <ErrorBanner>{error}</ErrorBanner>
        ) : items.length === 0 ? (
          <EmptyState>You have no finalized pay statements yet.</EmptyState>
        ) : (
          <>
            {explanation && (
              <p role="note" className="text-sm text-slate-600">
                {explanation}
              </p>
            )}
            <DataTable
              label="Pay statements"
              minWidth="min-w-[720px]"
              rows={items}
              rowKey={(item) => item.id}
              columns={[
                {
                  key: 'payDate',
                  header: 'Pay date',
                  rowHeader: true,
                  cell: (item) => formatDateOnly(item.payDate),
                },
                {
                  key: 'period',
                  header: 'Period',
                  cell: (item) => (
                    <>
                      {formatDateOnly(item.periodStart)} – {formatDateOnly(item.periodEnd)}
                    </>
                  ),
                },
                { key: 'employer', header: 'Employer', cell: (item) => item.employer },
                {
                  key: 'gross',
                  header: 'Gross pay',
                  cell: (item) => formatMoney(item.grossAmount, item.currency),
                },
                {
                  key: 'deductions',
                  header: 'Deductions',
                  cell: (item) => formatMoney(item.deductionAmount, item.currency),
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  cell: (item) => (
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={opening !== null}
                      aria-label={`View pay statement for ${formatDateOnly(item.payDate)}`}
                      onClick={() => void open(item.id)}
                    >
                      {opening === item.id ? 'Opening…' : 'View'}
                    </button>
                  ),
                },
              ]}
            />
          </>
        )}
        {slipError && <ErrorBanner>{slipError}</ErrorBanner>}
        {payslip && (
          <PayslipDocument payslip={payslipFromSelf(payslip)} onClose={() => setPayslip(null)} />
        )}
      </div>
    </PageContainer>
  );
}
