'use client';

import { EmptyState as SharedEmptyState } from '../ui/states';
import { DataTable } from '../ui/data-table';
import Link from 'next/link';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { PageContainer } from '../ui/page-container';
import { RequirePermission } from '../ui/require-permission';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { payrollApi } from '../../lib/payroll/api';
import { payrollErrorMessage } from '../../lib/payroll/errors';
import { formatDateOnly, formatMoney, label } from '../../lib/payroll/format';
import type {
  PayrollCadence,
  PayrollCalendar,
  PayrollOrganization,
  PayrollPayGroup,
  PayrollPeriod,
  PayrollRunSummary,
} from '../../lib/payroll/types';
import { useAuth } from '../../providers/auth-provider';
import { UnpaidLeaveRuleForm } from './unpaid-leave-rule-form';
import {
  AdjustmentsSection,
  CADENCES,
  EditCalendarDialog,
  EndCalendarDialog,
} from './payroll-admin-sections';
import { canSeeReports, reportHref } from '../reporting/reporting-shared';
import {
  DualControlNotice,
  EmptyState,
  inputClass,
  primaryButton,
  RunStatusBadge,
  secondaryButton,
  StatutoryNotice,
} from './payroll-shared';

export const PAYROLL_PERMISSION_KEYS = [
  'payroll.read',
  'payroll.manage',
  'payroll.calculate',
  'payroll.approve',
  'payroll.finalize',
  'payroll.adjust',
] as const;

type Tab = 'overview' | 'pay-groups' | 'calendars' | 'periods' | 'runs' | 'adjustments';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'pay-groups', label: 'Pay groups' },
  { id: 'calendars', label: 'Calendars' },
  { id: 'periods', label: 'Pay periods' },
  { id: 'runs', label: 'Runs' },
  { id: 'adjustments', label: 'Adjustments' },
];

/** Payroll administration: visible only with a payroll.* permission (never implied by others). */
export function PayrollAdminPage() {
  // Batch 10D: loading and the denied state in the page's own width (it loaded at 5xl and
  // rendered at 6xl). Presentation only — the API checks every payroll request.
  return (
    <RequirePermission
      anyOf={PAYROLL_PERMISSION_KEYS}
      width="wide"
      deniedMessage="You do not have permission to view payroll."
    >
      <PayrollAdmin />
    </RequirePermission>
  );
}

function PayrollAdmin() {
  const { authorization } = useAuth();
  const [organizations, setOrganizations] = useState<PayrollOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  // Batch 10D: the shared useTabParam in query mode — /admin/payroll?tab=calendars (a blocked
  // run's guidance links there) opens that tab, picking a tab writes it into the URL (removed
  // for Overview; other parameters kept) and Back/Forward follow the URL.
  const [tab, setTab] = useTabParam<Tab>(
    TABS.map((entry) => entry.id),
    'overview',
    { mode: 'query' },
  );
  const tabIdBase = useTabIdBase('payroll');
  const [payGroups, setPayGroups] = useState<PayrollPayGroup[]>([]);
  const [calendars, setCalendars] = useState<PayrollCalendar[]>([]);
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [runs, setRuns] = useState<PayrollRunSummary[]>([]);
  // M2: the organization's dual-control policy (from the run list).
  const [dualControl, setDualControl] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      payrollApi
        .organizations()
        .then((result) => {
          setOrganizations(result.items);
          setOrganizationId((current) => current || result.items[0]?.id || '');
          if (result.items.length === 0) setLoading(false);
        })
        .catch((cause) => {
          setError(payrollErrorMessage(cause, 'Unable to load organizations.'));
          setLoading(false);
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const load = useCallback(async () => {
    if (!organizationId) return;
    try {
      setPayGroups((await payrollApi.payGroups(organizationId)).items);
      setCalendars((await payrollApi.calendars(organizationId)).items);
      setPeriods((await payrollApi.periods(organizationId)).items);
      const runList = await payrollApi.runs(organizationId);
      setRuns(runList.items);
      setDualControl(runList.dualControl);
      setError(null);
    } catch (cause) {
      setError(payrollErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const organization = organizations.find((o) => o.id === organizationId);
  const actions = organization?.actions;

  async function mutate(run: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await run();
      setSuccess(message);
      await load();
      return true;
    } catch (cause) {
      setError(payrollErrorMessage(cause, 'Unable to complete the payroll action.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Payroll"
        title="Payroll"
        description="Pay calendars, pay periods and payroll runs. Gross pay is calculated from approved time, effective compensation and approved leave."
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="payroll-organization">
            Organization
            <select
              id="payroll-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => setOrganizationId(event.currentTarget.value)}
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeader>
      <div className="mt-6 space-y-4">
        <StatutoryNotice />
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading payroll…
          </p>
        ) : organizations.length === 0 ? (
          <EmptyState>No organizations are within your payroll access.</EmptyState>
        ) : (
          <>
            <TabList<Tab>
              tabs={TABS}
              active={tab}
              onChange={setTab}
              label="Payroll sections"
              idBase={tabIdBase}
            />
            <TabPanel idBase={tabIdBase} id={tab}>
              {tab === 'overview' && (
                <Overview payGroups={payGroups} periods={periods} runs={runs} />
              )}
              {tab === 'pay-groups' && <PayGroupsTab payGroups={payGroups} />}
              {tab === 'calendars' && (
                <CalendarsTab
                  calendars={calendars}
                  payGroups={payGroups}
                  canManage={Boolean(actions?.canManage)}
                  timezone={organization?.timezone ?? ''}
                  busy={busy}
                  periods={periods}
                  onSaved={async (message) => {
                    setError(null);
                    setSuccess(message);
                    await load();
                  }}
                  onCreate={(input) =>
                    mutate(() => payrollApi.createCalendar(input), 'Pay calendar created.')
                  }
                  onSetUnpaidLeaveRule={(calendarId, input) =>
                    mutate(
                      () => payrollApi.setSalaryUnpaidLeaveRule(calendarId, input),
                      'Unpaid leave rule saved. Recalculate the affected payroll runs.',
                    )
                  }
                />
              )}
              {tab === 'periods' && (
                <PeriodsTab
                  periods={periods}
                  payGroups={payGroups}
                  runs={runs}
                  canManage={Boolean(actions?.canManage)}
                  busy={busy}
                  onGenerate={(payGroupId, throughDate) =>
                    mutate(
                      () => payrollApi.generatePeriods(payGroupId, throughDate),
                      'Pay periods generated.',
                    )
                  }
                  onMaterialize={(periodId) =>
                    mutate(
                      () => payrollApi.materializeTimesheets(periodId),
                      'Timesheets prepared for the period.',
                    )
                  }
                  onCreateRun={(periodId, currency) =>
                    mutate(() => payrollApi.createRun(periodId, currency), 'Payroll run created.')
                  }
                />
              )}
              {tab === 'runs' && <DualControlNotice dualControl={dualControl} />}
              {tab === 'runs' && (
                <RunsTab
                  runs={runs}
                  registerHref={
                    canSeeReports(authorization)
                      ? reportHref('payroll.register', organizationId)
                      : null
                  }
                />
              )}
              {tab === 'adjustments' && (
                <AdjustmentsSection
                  organizationId={organizationId}
                  payGroups={payGroups}
                  canAdjust={Boolean(actions?.canAdjust)}
                  onChanged={() => void load()}
                />
              )}
            </TabPanel>
          </>
        )}
      </div>
    </PageContainer>
  );
}

function Overview({
  payGroups,
  periods,
  runs,
}: {
  payGroups: PayrollPayGroup[];
  periods: PayrollPeriod[];
  runs: PayrollRunSummary[];
}) {
  const count = (status: string) => runs.filter((run) => run.status === status).length;
  const stats = [
    ['Pay groups', payGroups.filter((group) => !group.archived).length],
    [
      'Open periods',
      periods.filter((p) => p.status === 'OPEN' || p.status === 'PROCESSING').length,
    ],
    ['Runs to review', count('CALCULATED')],
    ['Approved runs', count('APPROVED')],
    ['Finalized runs', count('FINALIZED')],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
      {stats.map(([name, value]) => (
        <div key={name} className="rounded-xl border border-slate-200 bg-white p-4">
          <dt className="text-sm text-slate-500">{name}</dt>
          <dd className="mt-1 text-2xl font-semibold text-slate-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PayGroupsTab({ payGroups }: { payGroups: PayrollPayGroup[] }) {
  if (payGroups.length === 0) {
    return (
      <SharedEmptyState
        compact
        title="No pay groups yet."
        description="Payroll runs belong to a pay group. Pay groups are managed under Compensation."
        action={{ label: 'Open Compensation', href: '/admin/compensation' }}
      />
    );
  }
  return (
    <DataTable
      label="Pay groups"
      minWidth="min-w-[640px]"
      rows={payGroups}
      rowKey={(group) => group.id}
      columns={[
        { key: 'code', header: 'Code', cell: (group) => group.code },
        { key: 'name', header: 'Name', rowHeader: true, cell: (group) => group.name },
        {
          key: 'cadence',
          header: 'Cadence',
          cell: (group) =>
            group.currentCalendar ? label(group.currentCalendar.cadence) : 'No current calendar',
        },
        { key: 'periods', header: 'Periods', cell: (group) => group.periodCount },
        {
          key: 'status',
          header: 'Status',
          cell: (group) => (group.archived ? 'Archived' : 'Active'),
        },
      ]}
    />
  );
}

function CalendarsTab({
  calendars,
  payGroups,
  canManage,
  timezone,
  busy,
  periods,
  onSaved,
  onCreate,
  onSetUnpaidLeaveRule,
}: {
  calendars: PayrollCalendar[];
  payGroups: PayrollPayGroup[];
  canManage: boolean;
  timezone: string;
  busy: boolean;
  periods: PayrollPeriod[];
  onSaved(message: string): Promise<void>;
  onCreate(input: Parameters<typeof payrollApi.createCalendar>[0]): Promise<boolean>;
  onSetUnpaidLeaveRule(
    calendarId: string,
    input: Parameters<typeof payrollApi.setSalaryUnpaidLeaveRule>[1],
  ): Promise<boolean>;
}) {
  const active = payGroups.filter((group) => !group.archived);
  const [editingRuleFor, setEditingRuleFor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'edit' | 'end'; id: string } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const dialogCalendar = calendars.find((calendar) => calendar.id === dialog?.id);
  const openDialog = (kind: 'edit' | 'end', id: string) => {
    setDialogError(null);
    setDialog({ kind, id });
  };
  async function save(action: () => Promise<unknown>, message: string) {
    setDialogBusy(true);
    setDialogError(null);
    try {
      await action();
      setDialog(null);
      await onSaved(message);
    } catch (cause) {
      setDialogError(payrollErrorMessage(cause, 'Unable to save the pay calendar.'));
    } finally {
      setDialogBusy(false);
    }
  }
  const editing = calendars.find((calendar) => calendar.id === editingRuleFor);
  const [form, setForm] = useState({
    payGroupId: '',
    cadence: 'BIWEEKLY' as PayrollCadence,
    timezone,
    anchorDate: '',
    payDateOffsetDays: '5',
    processingCutoffOffsetDays: '2',
    effectiveFrom: '',
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await onCreate({
      payGroupId: form.payGroupId || active[0]?.id || '',
      cadence: form.cadence,
      timezone: form.timezone,
      anchorDate: form.anchorDate,
      payDateOffsetDays: Number(form.payDateOffsetDays),
      processingCutoffOffsetDays: Number(form.processingCutoffOffsetDays),
      effectiveFrom: form.effectiveFrom || form.anchorDate,
    });
    if (ok) setForm((current) => ({ ...current, anchorDate: '', effectiveFrom: '' }));
  }

  return (
    <div className="space-y-4">
      {calendars.length === 0 ? (
        <EmptyState>No pay calendars yet.</EmptyState>
      ) : (
        <DataTable
          label="Pay calendars"
          minWidth="min-w-[880px]"
          rows={calendars}
          rowKey={(calendar) => calendar.id}
          columns={[
            {
              key: 'payGroup',
              header: 'Pay group',
              rowHeader: true,
              cell: (calendar) => calendar.payGroup?.name ?? calendar.payGroupId,
            },
            {
              key: 'cadence',
              header: 'Cadence',
              cell: (calendar) => (
                <>
                  {label(calendar.cadence)}
                  <span className="block text-xs text-slate-500">{calendar.timezone}</span>
                </>
              ),
            },
            {
              key: 'anchor',
              header: 'Anchor',
              cell: (calendar) => formatDateOnly(calendar.anchorDate),
            },
            {
              key: 'payDate',
              header: 'Pay date',
              cell: (calendar) => <>period end + {calendar.payDateOffsetDays} days</>,
            },
            {
              key: 'effective',
              header: 'Effective',
              cell: (calendar) => (
                <>
                  {formatDateOnly(calendar.effectiveFrom)} –{' '}
                  {calendar.effectiveTo ? formatDateOnly(calendar.effectiveTo) : 'ongoing'}
                </>
              ),
            },
            {
              key: 'unpaidLeave',
              header: 'Unpaid salary leave',
              cell: (calendar) => (
                <>
                  {calendar.salaryUnpaidLeaveRule === 'HOURLY_EQUIVALENT'
                    ? `Hourly equivalent (${calendar.salaryStandardAnnualHours} h/yr)`
                    : 'Not configured'}
                  {canManage && calendar.actions?.canUpdate !== false && (
                    <button
                      type="button"
                      onClick={() => setEditingRuleFor(calendar.id)}
                      className="ml-2 text-sm font-semibold text-indigo-800 underline"
                      aria-label={`Configure unpaid leave rule for ${calendar.payGroup?.name ?? 'this calendar'}`}
                    >
                      Configure
                    </button>
                  )}
                </>
              ),
            },
            ...(canManage
              ? [
                  {
                    key: 'actions',
                    header: 'Actions',
                    className: 'whitespace-nowrap',
                    cell: (calendar: PayrollCalendar) => (
                      <>
                        {calendar.actions?.canUpdate && (
                          <button
                            type="button"
                            className={secondaryButton}
                            aria-label={`Edit calendar for ${calendar.payGroup?.name ?? 'this pay group'}`}
                            onClick={() => openDialog('edit', calendar.id)}
                          >
                            Edit
                          </button>
                        )}
                        {calendar.actions?.canEnd && (
                          <button
                            type="button"
                            className={`${secondaryButton} ml-2`}
                            aria-label={`End calendar for ${calendar.payGroup?.name ?? 'this pay group'}`}
                            onClick={() => openDialog('end', calendar.id)}
                          >
                            {calendar.effectiveTo ? 'Change end' : 'End'}
                          </button>
                        )}
                        {!calendar.actions?.canUpdate && (
                          <span className="mt-1 block text-xs text-slate-600">
                            Rules fixed: periods generated
                          </span>
                        )}
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {dialog?.kind === 'edit' && dialogCalendar && (
        <EditCalendarDialog
          calendar={dialogCalendar}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            void save(
              () => payrollApi.updateCalendar(dialogCalendar.id, input),
              'Pay calendar updated.',
            )
          }
        />
      )}
      {dialog?.kind === 'end' && dialogCalendar && (
        <EndCalendarDialog
          calendar={dialogCalendar}
          periods={periods}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(effectiveTo) =>
            void save(
              () => payrollApi.endCalendar(dialogCalendar.id, effectiveTo),
              `Pay calendar ends ${formatDateOnly(effectiveTo)}.`,
            )
          }
        />
      )}
      {canManage && editing && (
        <UnpaidLeaveRuleForm
          key={editing.id}
          calendar={editing}
          busy={busy}
          onCancel={() => setEditingRuleFor(null)}
          onSubmit={async (input) => {
            const ok = await onSetUnpaidLeaveRule(editing.id, input);
            if (ok) setEditingRuleFor(null);
            return ok;
          }}
        />
      )}
      {canManage && active.length > 0 && (
        <form
          aria-label="New pay calendar"
          onSubmit={(event) => void submit(event)}
          className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-4"
        >
          <label className="text-sm font-medium text-slate-800">
            Pay group
            <select
              className={inputClass}
              value={form.payGroupId || active[0]?.id}
              onChange={(event) => set('payGroupId')(event.currentTarget.value)}
            >
              {active.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-800">
            Cadence
            <select
              className={inputClass}
              value={form.cadence}
              onChange={(event) => set('cadence')(event.currentTarget.value)}
            >
              {CADENCES.map((cadence) => (
                <option key={cadence} value={cadence}>
                  {label(cadence)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-800">
            Time zone
            <input
              required
              className={inputClass}
              value={form.timezone}
              placeholder="America/Toronto"
              onChange={(event) => set('timezone')(event.currentTarget.value)}
            />
          </label>
          <label className="text-sm font-medium text-slate-800">
            First period starts
            <input
              required
              type="date"
              className={inputClass}
              value={form.anchorDate}
              onChange={(event) => set('anchorDate')(event.currentTarget.value)}
            />
          </label>
          <label className="text-sm font-medium text-slate-800">
            Pay date offset (days)
            <input
              required
              type="number"
              className={inputClass}
              value={form.payDateOffsetDays}
              onChange={(event) => set('payDateOffsetDays')(event.currentTarget.value)}
            />
          </label>
          <label className="text-sm font-medium text-slate-800">
            Cutoff before pay date (days)
            <input
              required
              type="number"
              className={inputClass}
              value={form.processingCutoffOffsetDays}
              onChange={(event) => set('processingCutoffOffsetDays')(event.currentTarget.value)}
            />
          </label>
          <label className="text-sm font-medium text-slate-800">
            Effective from
            <input
              type="date"
              className={inputClass}
              value={form.effectiveFrom}
              onChange={(event) => set('effectiveFrom')(event.currentTarget.value)}
            />
          </label>
          <div className="flex items-end">
            <button type="submit" disabled={busy} className={primaryButton}>
              Create calendar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function PeriodsTab({
  periods,
  payGroups,
  runs,
  canManage,
  busy,
  onGenerate,
  onMaterialize,
  onCreateRun,
}: {
  periods: PayrollPeriod[];
  payGroups: PayrollPayGroup[];
  runs: PayrollRunSummary[];
  canManage: boolean;
  busy: boolean;
  onGenerate(payGroupId: string, throughDate: string): Promise<boolean>;
  onMaterialize(periodId: string): Promise<boolean>;
  onCreateRun(periodId: string, currency: string): Promise<boolean>;
}) {
  const active = payGroups.filter((group) => !group.archived);
  const [payGroupId, setPayGroupId] = useState('');
  const [throughDate, setThroughDate] = useState('');
  const [currency, setCurrency] = useState('CAD');
  const currencyValid = /^[A-Z]{3}$/.test(currency);
  return (
    <div className="space-y-4">
      {canManage && active.length > 0 && (
        <form
          aria-label="Generate pay periods"
          onSubmit={(event) => {
            event.preventDefault();
            void onGenerate(payGroupId || active[0]!.id, throughDate);
          }}
          className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4"
        >
          <label className="text-sm font-medium text-slate-800">
            Pay group
            <select
              className={inputClass}
              value={payGroupId || active[0]?.id}
              onChange={(event) => setPayGroupId(event.currentTarget.value)}
            >
              {active.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-800">
            Generate through
            <input
              required
              type="date"
              className={inputClass}
              value={throughDate}
              onChange={(event) => setThroughDate(event.currentTarget.value)}
            />
          </label>
          <button type="submit" disabled={busy} className={primaryButton}>
            Generate periods
          </button>
        </form>
      )}
      {canManage && periods.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-slate-800" htmlFor="payroll-run-currency">
            Currency for new runs
            <input
              id="payroll-run-currency"
              className={inputClass}
              value={currency}
              maxLength={3}
              aria-invalid={!currencyValid}
              aria-describedby="payroll-run-currency-hint"
              onChange={(event) => setCurrency(event.currentTarget.value.toUpperCase())}
            />
          </label>
          <p id="payroll-run-currency-hint" className="pb-2 text-sm text-slate-600">
            A period has one run per currency. Every existing run is listed whatever this is set to.
          </p>
        </div>
      )}
      {periods.length === 0 ? (
        <EmptyState>No pay periods yet.</EmptyState>
      ) : (
        <DataTable
          label="Pay periods"
          minWidth="min-w-[880px]"
          rows={periods.map((period) => {
            const periodRuns = runs.filter(
              (run) => run.period.id === period.id && run.status !== 'VOIDED',
            );
            const hasCurrencyRun = periodRuns.some((run) => run.currency === currency);
            const open = period.status === 'OPEN' || period.status === 'PROCESSING';
            return { period, periodRuns, hasCurrencyRun, open };
          })}
          rowKey={({ period }) => period.id}
          columns={[
            {
              key: 'payGroup',
              header: 'Pay group',
              cell: ({ period }) => period.payGroup?.name ?? '—',
            },
            {
              key: 'period',
              header: 'Period',
              rowHeader: true,
              cell: ({ period }) => (
                <>
                  {formatDateOnly(period.periodStart)} – {formatDateOnly(period.periodEnd)}
                </>
              ),
            },
            {
              key: 'payDate',
              header: 'Pay date',
              cell: ({ period }) => formatDateOnly(period.payDate),
            },
            { key: 'status', header: 'Status', cell: ({ period }) => label(period.status) },
            {
              key: 'timesheets',
              header: 'Timesheets',
              cell: ({ period }) => (period.timesheetsMaterializedAt ? 'Prepared' : '—'),
            },
            {
              key: 'runs',
              header: 'Runs',
              cell: ({ periodRuns }) => (
                <>
                  {periodRuns.length === 0 ? (
                    '—'
                  ) : (
                    <ul className="space-y-1">
                      {periodRuns.map((run) => (
                        <li key={run.id} className="whitespace-nowrap">
                          <Link
                            className="text-indigo-700 hover:underline"
                            href={`/admin/payroll/runs/${run.id}`}
                          >
                            Open {run.currency} run
                          </Link>{' '}
                          <span className="text-xs text-slate-600">({label(run.status)})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              className: 'space-x-2 whitespace-nowrap',
              cell: ({ period, hasCurrencyRun, open }) => (
                <>
                  {canManage && open && (
                    <button
                      type="button"
                      disabled={busy}
                      className={secondaryButton}
                      onClick={() => void onMaterialize(period.id)}
                    >
                      Prepare timesheets
                    </button>
                  )}
                  {canManage && open && !hasCurrencyRun && (
                    <button
                      type="button"
                      disabled={busy || !currencyValid}
                      className={secondaryButton}
                      onClick={() => void onCreateRun(period.id, currency)}
                    >
                      Create {currencyValid ? currency : ''} run
                    </button>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function RunsTab({
  runs,
  registerHref,
}: {
  runs: PayrollRunSummary[];
  registerHref: string | null;
}) {
  const register = registerHref && (
    <p className="text-sm text-slate-700">
      Finalized runs, employee by employee:{' '}
      <Link className="font-semibold text-indigo-700 hover:underline" href={registerHref}>
        Payroll register (download CSV from Reports)
      </Link>
    </p>
  );
  if (runs.length === 0)
    return (
      <div className="space-y-3">
        {register}
        <EmptyState>No payroll runs yet.</EmptyState>
      </div>
    );
  return (
    <div className="space-y-3">
      {register}
      <DataTable
        label="Payroll runs"
        minWidth="min-w-[720px]"
        rows={runs}
        rowKey={(run) => run.id}
        columns={[
          { key: 'payGroup', header: 'Pay group', cell: (run) => run.payGroup.name },
          {
            key: 'period',
            header: 'Period',
            rowHeader: true,
            cell: (run) => (
              <Link
                className="text-indigo-700 hover:underline"
                href={`/admin/payroll/runs/${run.id}`}
              >
                {formatDateOnly(run.period.periodStart)} – {formatDateOnly(run.period.periodEnd)}
              </Link>
            ),
          },
          {
            key: 'payDate',
            header: 'Pay date',
            cell: (run) => formatDateOnly(run.period.payDate),
          },
          {
            key: 'status',
            header: 'Status',
            cell: (run) => <RunStatusBadge status={run.status} />,
          },
          { key: 'employees', header: 'Employees', cell: (run) => run.employeeCount ?? '—' },
          {
            key: 'gross',
            header: 'Gross pay',
            cell: (run) => formatMoney(run.totals.grossAmount, run.currency),
          },
        ]}
      />
    </div>
  );
}
