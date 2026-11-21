'use client';

import type { FormEvent } from 'react';
import { useState } from 'react';
import { benefitsApi, type RateInput } from '../../../lib/benefits/api';
import type {
  BenefitOption,
  BenefitPlanDetail,
  BenefitRate,
  CoverageLevel,
  RateFrequency,
} from '../../../lib/benefits/types';
import { FormDialog } from '../../ui/form-dialog';
import type { useConfirm } from '../../ui/use-confirm';
import {
  coveragePeriod,
  EmptyState,
  formatDateOnly,
  formatMoney,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../benefits-shared';
import {
  AMOUNT_PATTERN,
  COVERAGE_LEVELS,
  Field,
  FREQUENCIES,
  isAmount,
  type Mutate,
} from './shared';
import { DataTable } from '../../ui/data-table';

type Confirm = ReturnType<typeof useConfirm>[0];

const rateText = (rate: BenefitRate) =>
  `${coveragePeriod(rate.effectiveFrom, rate.effectiveTo)}: ${formatMoney(
    rate.employeeAmount,
    rate.currency,
  )} employee / ${formatMoney(rate.employerAmount, rate.currency)} employer, ${label(
    rate.frequency,
  ).toLowerCase()}`;

/** Coverage options with their rate history; option and rate maintenance. */
export function OptionsAndRates({
  plan,
  busy,
  mutate,
  confirm,
}: {
  plan: BenefitPlanDetail;
  busy: boolean;
  mutate: Mutate;
  confirm: Confirm;
}) {
  const { actions } = plan;
  const activeOptions = plan.options.filter((option) => !option.archived);
  const [editingOption, setEditingOption] = useState<BenefitOption | null>(null);
  const [correcting, setCorrecting] = useState<{ rate: BenefitRate; option: BenefitOption } | null>(
    null,
  );
  // Each option with its current and superseded rates (the API's rates, split as before).
  const optionRows = plan.options.map((option) => {
    const rates = plan.rates.filter((rate) => rate.optionId === option.id);
    return {
      option,
      current: rates.filter((rate) => !rate.supersededAt),
      history: rates.filter((rate) => rate.supersededAt),
    };
  });
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-slate-900">Coverage options and rates</h3>
      {plan.options.length === 0 ? (
        <EmptyState>Add at least one coverage option before activating the plan.</EmptyState>
      ) : (
        <DataTable
          label={`Coverage options of ${plan.name}`}
          minWidth="min-w-[760px]"
          rows={optionRows}
          rowKey={(row) => row.option.id}
          columns={[
            {
              key: 'option',
              header: 'Option',
              rowHeader: true,
              cell: ({ option }) => (
                <>
                  {option.name} <span className="text-xs text-slate-500">({option.code})</span>
                  {option.archived && <span className="ml-1 text-xs">· archived</span>}
                </>
              ),
            },
            {
              key: 'coverage',
              header: 'Coverage',
              cell: ({ option }) => <>{label(option.coverageLevel)}</>,
            },
            {
              key: 'rates',
              header: 'Rates',
              cell: ({ option, current, history }) => (
                <>
                  {current.length === 0 ? (
                    <span className="text-amber-800">No rate</span>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {current.map((rate) => (
                        <li key={rate.id} className="flex flex-wrap items-center gap-2">
                          <span>
                            {rateText(rate)}
                            {rate.recordType === 'CORRECTION' ? ' (corrected)' : ''}
                          </span>
                          {rate.actions?.canCorrect && (
                            <button
                              type="button"
                              className="text-xs font-medium text-indigo-700 underline"
                              disabled={busy}
                              aria-label={`Correct ${option.name} rate from ${formatDateOnly(
                                rate.effectiveFrom,
                              )}`}
                              onClick={() => setCorrecting({ rate, option })}
                            >
                              Correct
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {history.length > 0 && (
                    <details className="mt-1 text-xs text-slate-600">
                      <summary>Superseded rates ({history.length})</summary>
                      <ul className="mt-1 space-y-0.5">
                        {history.map((rate) => (
                          <li key={rate.id}>
                            <span className="line-through">{rateText(rate)}</span>
                            {rate.reason && <span> — {rate.reason}</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              ),
            },
            {
              key: 'enrolled',
              header: 'Enrolled',
              cell: ({ option }) => <>{option.currentAndFutureEnrollments ?? 0}</>,
            },
            {
              key: 'actions',
              header: 'Actions',
              cell: ({ option }) => (
                <>
                  <div className="flex flex-wrap gap-2">
                    {option.actions?.canEdit && (
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        aria-label={`Edit option ${option.name}`}
                        onClick={() => setEditingOption(option)}
                      >
                        Edit
                      </button>
                    )}
                    {option.actions?.canArchive && (
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        aria-label={`Archive option ${option.name}`}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Archive the ${option.name} option?`,
                              description:
                                'It can no longer be chosen for new enrollments. Past elections keep it.',
                              confirmLabel: 'Archive option',
                            })
                          )
                            await mutate(
                              () => benefitsApi.archiveOption(option.id),
                              'Coverage option archived.',
                            );
                        }}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </>
              ),
            },
          ]}
        />
      )}
      {actions.canManageOptions && <OptionForm planId={plan.id} busy={busy} mutate={mutate} />}
      {actions.canManageRates && activeOptions.length > 0 && (
        <RateForm options={activeOptions} busy={busy} mutate={mutate} />
      )}
      {editingOption && (
        <EditOptionDialog
          option={editingOption}
          busy={busy}
          mutate={mutate}
          onClose={() => setEditingOption(null)}
        />
      )}
      {correcting && (
        <CorrectRateDialog
          {...correcting}
          busy={busy}
          mutate={mutate}
          onClose={() => setCorrecting(null)}
        />
      )}
    </div>
  );
}

function OptionForm({ planId, busy, mutate }: { planId: string; busy: boolean; mutate: Mutate }) {
  const [form, setForm] = useState({
    code: '',
    name: '',
    coverageLevel: 'EMPLOYEE_ONLY' as CoverageLevel,
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await mutate(
      () =>
        benefitsApi.addOption(planId, {
          code: form.code.trim(),
          name: form.name.trim(),
          coverageLevel: form.coverageLevel,
        }),
      'Coverage option added.',
    );
    if (ok) setForm({ code: '', name: '', coverageLevel: 'EMPLOYEE_ONLY' });
  }
  return (
    <form
      aria-label="Add coverage option"
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(event) => void submit(event)}
    >
      <Field label="Option code">
        <input
          className={inputClass}
          required
          minLength={2}
          maxLength={64}
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.currentTarget.value })}
        />
      </Field>
      <Field label="Option name">
        <input
          className={inputClass}
          required
          maxLength={200}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
        />
      </Field>
      <Field label="Coverage level" hint="Never changes once added.">
        <select
          className={inputClass}
          value={form.coverageLevel}
          onChange={(e) =>
            setForm({ ...form, coverageLevel: e.currentTarget.value as CoverageLevel })
          }
        >
          {COVERAGE_LEVELS.map((level) => (
            <option key={level} value={level}>
              {label(level)}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-end">
        <button type="submit" className={primaryButton} disabled={busy}>
          Add option
        </button>
      </div>
    </form>
  );
}

function EditOptionDialog({
  option,
  busy,
  mutate,
  onClose,
}: {
  option: BenefitOption;
  busy: boolean;
  mutate: Mutate;
  onClose(): void;
}) {
  const [name, setName] = useState(option.name);
  const [sortOrder, setSortOrder] = useState(String(option.sortOrder));
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      title={`Edit option ${option.name}`}
      description={`Code ${option.code} and coverage level (${label(option.coverageLevel)}) never change.`}
      submitLabel="Save option"
      busy={busy}
      canSubmit={name.trim() !== '' && /^\d+$/.test(sortOrder)}
      error={error}
      onSubmit={() =>
        void mutate(
          () =>
            benefitsApi.updateOption(option.id, {
              name: name.trim(),
              sortOrder: Number(sortOrder),
            }),
          'Coverage option updated.',
          { onError: (message) => setError(message) },
        ).then((ok) => ok && onClose())
      }
      onClose={onClose}
    >
      <Field label="Option name">
        <input
          className={inputClass}
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </Field>
      <Field label="Display order" hint="Lower numbers are listed first.">
        <input
          type="number"
          min={0}
          max={10000}
          className={inputClass}
          value={sortOrder}
          onChange={(e) => setSortOrder(e.currentTarget.value)}
        />
      </Field>
    </FormDialog>
  );
}

function RateForm({
  options,
  busy,
  mutate,
}: {
  options: BenefitOption[];
  busy: boolean;
  mutate: Mutate;
}) {
  const [form, setForm] = useState({
    optionId: '',
    effectiveFrom: '',
    effectiveTo: '',
    frequency: 'MONTHLY' as RateFrequency,
    employeeAmount: '',
    employerAmount: '0.00',
    reason: '',
  });
  // An option archived meanwhile is never pre-selected.
  const optionId = options.some((o) => o.id === form.optionId) ? form.optionId : options[0]!.id;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const input: RateInput = {
      effectiveFrom: form.effectiveFrom,
      frequency: form.frequency,
      employeeAmount: form.employeeAmount.trim(),
      employerAmount: form.employerAmount.trim(),
      ...(form.effectiveTo ? { effectiveTo: form.effectiveTo } : {}),
      ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
    };
    const ok = await mutate(() => benefitsApi.addRate(optionId, input), 'Rate added.');
    if (ok)
      setForm((current) => ({
        ...current,
        effectiveFrom: '',
        effectiveTo: '',
        employeeAmount: '',
        reason: '',
      }));
  }
  return (
    <form
      aria-label="Add rate"
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(event) => void submit(event)}
    >
      <Field label="Option">
        <select
          className={inputClass}
          value={optionId}
          onChange={(e) => setForm({ ...form, optionId: e.currentTarget.value })}
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Rate effective from">
        <input
          type="date"
          className={inputClass}
          required
          value={form.effectiveFrom}
          onChange={(e) => setForm({ ...form, effectiveFrom: e.currentTarget.value })}
        />
      </Field>
      <Field label="Rate effective to (optional)" hint="Needed to fill a gap before a later rate.">
        <input
          type="date"
          className={inputClass}
          min={form.effectiveFrom || undefined}
          value={form.effectiveTo}
          onChange={(e) => setForm({ ...form, effectiveTo: e.currentTarget.value })}
        />
      </Field>
      <Field label="Frequency">
        <select
          className={inputClass}
          value={form.frequency}
          onChange={(e) => setForm({ ...form, frequency: e.currentTarget.value as RateFrequency })}
        >
          {FREQUENCIES.map((frequency) => (
            <option key={frequency} value={frequency}>
              {label(frequency)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Employee amount">
        <input
          inputMode="decimal"
          pattern={AMOUNT_PATTERN}
          className={inputClass}
          required
          value={form.employeeAmount}
          onChange={(e) => setForm({ ...form, employeeAmount: e.currentTarget.value })}
        />
      </Field>
      <Field label="Employer amount">
        <input
          inputMode="decimal"
          pattern={AMOUNT_PATTERN}
          className={inputClass}
          required
          value={form.employerAmount}
          onChange={(e) => setForm({ ...form, employerAmount: e.currentTarget.value })}
        />
      </Field>
      <Field label="Note (optional)">
        <input
          className={inputClass}
          maxLength={2000}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.currentTarget.value })}
        />
      </Field>
      <div className="flex items-end">
        <button type="submit" className={primaryButton} disabled={busy}>
          Add rate
        </button>
      </div>
      <p className="text-xs text-slate-600 sm:col-span-2 lg:col-span-4">
        A new rate ends the current one the day before. To fix a wrong rate, use Correct on that
        rate; finalized payroll is never rewritten.
      </p>
    </form>
  );
}

function CorrectRateDialog({
  rate,
  option,
  busy,
  mutate,
  onClose,
}: {
  rate: BenefitRate;
  option: BenefitOption;
  busy: boolean;
  mutate: Mutate;
  onClose(): void;
}) {
  const [form, setForm] = useState({
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo ?? '',
    frequency: rate.frequency,
    employeeAmount: rate.employeeAmount,
    employerAmount: rate.employerAmount,
    reason: '',
  });
  const [error, setError] = useState<string | null>(null);
  const valid =
    form.effectiveFrom !== '' &&
    isAmount(form.employeeAmount) &&
    isAmount(form.employerAmount) &&
    form.reason.trim() !== '';
  return (
    <FormDialog
      open
      title={`Correct the ${option.name} rate`}
      description={`Replaces ${rateText(rate)}. The original stays in the history; open payroll runs become stale and finalized payroll is never rewritten.`}
      submitLabel="Correct rate"
      busy={busy}
      canSubmit={valid}
      error={error}
      size="lg"
      onSubmit={() =>
        void mutate(
          () =>
            benefitsApi.correctRate(rate.id, {
              effectiveFrom: form.effectiveFrom,
              effectiveTo: form.effectiveTo || null,
              frequency: form.frequency,
              employeeAmount: form.employeeAmount.trim(),
              employerAmount: form.employerAmount.trim(),
              reason: form.reason.trim(),
            }),
          'Rate corrected.',
          { onError: (message) => setError(message) },
        ).then((ok) => ok && onClose())
      }
      onClose={onClose}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Effective from">
          <input
            type="date"
            className={inputClass}
            required
            value={form.effectiveFrom}
            onChange={(e) => setForm({ ...form, effectiveFrom: e.currentTarget.value })}
          />
        </Field>
        <Field label="Effective to" hint="Empty: until the next rate or the plan's end.">
          <input
            type="date"
            className={inputClass}
            min={form.effectiveFrom || undefined}
            value={form.effectiveTo}
            onChange={(e) => setForm({ ...form, effectiveTo: e.currentTarget.value })}
          />
        </Field>
        <Field label="Frequency">
          <select
            className={inputClass}
            value={form.frequency}
            onChange={(e) =>
              setForm({ ...form, frequency: e.currentTarget.value as RateFrequency })
            }
          >
            {FREQUENCIES.map((frequency) => (
              <option key={frequency} value={frequency}>
                {label(frequency)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Employee amount (${rate.currency})`}>
          <input
            inputMode="decimal"
            pattern={AMOUNT_PATTERN}
            className={inputClass}
            required
            value={form.employeeAmount}
            onChange={(e) => setForm({ ...form, employeeAmount: e.currentTarget.value })}
          />
        </Field>
        <Field label={`Employer amount (${rate.currency})`}>
          <input
            inputMode="decimal"
            pattern={AMOUNT_PATTERN}
            className={inputClass}
            required
            value={form.employerAmount}
            onChange={(e) => setForm({ ...form, employerAmount: e.currentTarget.value })}
          />
        </Field>
      </div>
      <Field label="Reason for the correction">
        <textarea
          rows={2}
          maxLength={2000}
          className={inputClass}
          required
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.currentTarget.value })}
        />
      </Field>
    </FormDialog>
  );
}
