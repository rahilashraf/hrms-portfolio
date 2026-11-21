'use client';

import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { ErrorBanner } from '../organization/shared';
import { compensationApi } from '../../lib/compensation/api';
import {
  fixedPeriodEnd,
  formatAmount,
  formatDateOnly,
  formatPeriod,
  formatRecordRate,
  isFirstOfMonth,
  isValidRate,
  multiplyAmount,
  parsePaidMonths,
  todayIso,
} from '../../lib/compensation/format';
import type {
  CompensationChangeInput,
  CompensationCorrectionInput,
  CompensationCreateInput,
  CompensationEndInput,
  CompensationRecord,
  PayBasis,
  PayGroup,
  SalaryArrangement,
} from '../../lib/compensation/types';
import { inputClass, primaryButton, secondaryButton } from './compensation-shared';

/** Active pay groups of an organization for the form's select; empty when they cannot be read. */
function usePayGroups(organizationId: string) {
  const [groups, setGroups] = useState<PayGroup[]>([]);
  useEffect(() => {
    let active = true;
    compensationApi
      .payGroups(organizationId)
      .then((result) => {
        if (active) setGroups(result.items);
      })
      .catch(() => {
        if (active) setGroups([]);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);
  return groups;
}

interface Values {
  payBasis: PayBasis;
  rateAmount: string;
  salaryArrangement: SalaryArrangement;
  salaryPaidMonths: string;
  salaryPeriodStart: string;
  /** Typed for CONTRACT_TOTAL only; FIXED_PERIOD derives it from the start and paid months. */
  salaryPeriodEnd: string;
  currency: string;
  /** '' = none; KEEP = keep the group in effect (change only). */
  payGroupId: string;
}

const KEEP = '__keep__';

function isFixedPeriod(values: Values): boolean {
  return values.payBasis === 'SALARY' && values.salaryArrangement === 'FIXED_PERIOD';
}

/** FIXED_PERIOD or CONTRACT_TOTAL: the record's effective period is the contracted paid period. */
function isContracted(values: Values): boolean {
  return values.payBasis === 'SALARY' && values.salaryArrangement !== 'ANNUAL';
}

/**
 * A fixed-period salary's derived terms: contract total = monthly salary × paid months, and the
 * paid period runs from its start to the end of the final paid calendar month. Null while the
 * typed inputs cannot be derived from; the API re-validates every derived value.
 */
function fixedPeriodTerms(
  values: Values,
): { contractAmount: string; periodStart: string; periodEnd: string } | null {
  const months = parsePaidMonths(values.salaryPaidMonths);
  if (months === null || !isValidRate(values.rateAmount)) return null;
  const periodEnd = fixedPeriodEnd(values.salaryPeriodStart, months);
  const contractAmount = multiplyAmount(values.rateAmount, months);
  if (!periodEnd || !contractAmount) return null;
  return { contractAmount, periodStart: values.salaryPeriodStart, periodEnd };
}

function valuesProblem(values: Values): string | null {
  if (!isValidRate(values.rateAmount)) {
    return 'Enter a positive amount with up to 4 decimals (e.g. 24.50).';
  }
  if (isFixedPeriod(values)) {
    if (parsePaidMonths(values.salaryPaidMonths) === null) {
      return 'Enter the paid months as a whole number from 1 to 120.';
    }
    if (!values.salaryPeriodStart) {
      return 'Choose the paid period start.';
    }
    if (!isFirstOfMonth(values.salaryPeriodStart)) {
      return 'The paid period must start on the first day of a month.';
    }
  }
  if (values.payBasis === 'SALARY' && values.salaryArrangement === 'CONTRACT_TOTAL') {
    if (!values.salaryPeriodStart || !values.salaryPeriodEnd) {
      return 'Choose the contract start and end dates.';
    }
  }
  if (!/^[A-Za-z]{3}$/.test(values.currency.trim())) {
    return 'Enter a three-letter ISO currency code (e.g. CAD).';
  }
  return null;
}

function salaryPayload(values: Values) {
  if (values.payBasis !== 'SALARY') return {};
  if (values.salaryArrangement === 'ANNUAL') {
    return { salaryArrangement: 'ANNUAL' as const };
  }
  if (values.salaryArrangement === 'FIXED_PERIOD') {
    // Only called once valuesProblem passed, so the terms derive.
    const terms = fixedPeriodTerms(values)!;
    return {
      salaryArrangement: 'FIXED_PERIOD' as const,
      salaryMonthlyAmount: values.rateAmount.trim(),
      salaryPaidMonths: parsePaidMonths(values.salaryPaidMonths)!,
      salaryContractAmount: terms.contractAmount,
      salaryPeriodStart: terms.periodStart,
      salaryPeriodEnd: terms.periodEnd,
    };
  }
  return {
    salaryArrangement: 'CONTRACT_TOTAL' as const,
    salaryContractAmount: values.rateAmount.trim(),
    salaryPeriodStart: values.salaryPeriodStart,
    salaryPeriodEnd: values.salaryPeriodEnd,
  };
}

function ValueFields({
  idPrefix,
  values,
  onChange,
  groups,
  keepOption,
  currentGroup,
}: {
  idPrefix: string;
  values: Values;
  onChange(values: Values): void;
  groups: PayGroup[];
  keepOption?: boolean;
  currentGroup?: CompensationRecord['payGroup'];
}) {
  const set = (patch: Partial<Values>) => onChange({ ...values, ...patch });
  // An archived group still in effect stays selectable (it may be kept, never newly chosen).
  const options =
    currentGroup && !groups.some((g) => g.id === currentGroup.id)
      ? [...groups, { ...currentGroup, archived: true }]
      : groups;
  const fixedTerms = isFixedPeriod(values) ? fixedPeriodTerms(values) : null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="text-sm font-medium text-slate-800" htmlFor={`${idPrefix}-basis`}>
        Pay basis
        <select
          id={`${idPrefix}-basis`}
          className={inputClass}
          value={values.payBasis}
          onChange={(event) => set({ payBasis: event.currentTarget.value as PayBasis })}
        >
          <option value="HOURLY">Hourly (per hour)</option>
          <option value="SALARY">Salary</option>
        </select>
      </label>
      {values.payBasis === 'SALARY' && (
        <label
          className="text-sm font-medium text-slate-800"
          htmlFor={`${idPrefix}-salary-arrangement`}
        >
          Salary arrangement
          <select
            id={`${idPrefix}-salary-arrangement`}
            className={inputClass}
            value={values.salaryArrangement}
            onChange={(event) =>
              set({ salaryArrangement: event.currentTarget.value as SalaryArrangement })
            }
          >
            <option value="ANNUAL">Annual</option>
            <option value="FIXED_PERIOD">Fixed period monthly</option>
            <option value="CONTRACT_TOTAL">Contract total</option>
          </select>
        </label>
      )}
      <label className="text-sm font-medium text-slate-800" htmlFor={`${idPrefix}-rate`}>
        {values.payBasis === 'HOURLY'
          ? 'Hourly rate'
          : values.salaryArrangement === 'FIXED_PERIOD'
            ? 'Monthly salary'
            : values.salaryArrangement === 'CONTRACT_TOTAL'
              ? 'Contract total'
              : 'Annual salary'}
        <input
          id={`${idPrefix}-rate`}
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          required
          value={values.rateAmount}
          onChange={(event) => set({ rateAmount: event.currentTarget.value })}
        />
      </label>
      <label className="text-sm font-medium text-slate-800" htmlFor={`${idPrefix}-currency`}>
        Currency
        <input
          id={`${idPrefix}-currency`}
          className={inputClass}
          maxLength={3}
          required
          value={values.currency}
          onChange={(event) => set({ currency: event.currentTarget.value.toUpperCase() })}
        />
      </label>
      {isFixedPeriod(values) && (
        <>
          <label className="text-sm font-medium text-slate-800" htmlFor={`${idPrefix}-paid-months`}>
            Paid months
            <input
              id={`${idPrefix}-paid-months`}
              className={inputClass}
              inputMode="numeric"
              value={values.salaryPaidMonths}
              onChange={(event) => set({ salaryPaidMonths: event.currentTarget.value })}
            />
          </label>
          <div>
            <label
              className="text-sm font-medium text-slate-800"
              htmlFor={`${idPrefix}-salary-period-start`}
            >
              Paid period start
              <input
                id={`${idPrefix}-salary-period-start`}
                type="date"
                className={inputClass}
                aria-describedby={`${idPrefix}-salary-period-start-hint`}
                value={values.salaryPeriodStart}
                onChange={(event) => set({ salaryPeriodStart: event.currentTarget.value })}
              />
            </label>
            <span
              id={`${idPrefix}-salary-period-start-hint`}
              className="mt-1 block text-xs text-slate-500"
            >
              First day of a month.
            </span>
          </div>
          <label
            className="text-sm font-medium text-slate-800"
            htmlFor={`${idPrefix}-contract-total`}
          >
            Contract total
            <input
              id={`${idPrefix}-contract-total`}
              className={inputClass}
              readOnly
              value={fixedTerms ? formatAmount(fixedTerms.contractAmount) : ''}
              placeholder="Monthly salary × paid months"
            />
          </label>
          <label
            className="text-sm font-medium text-slate-800"
            htmlFor={`${idPrefix}-salary-period-end`}
          >
            Paid through
            <input
              id={`${idPrefix}-salary-period-end`}
              className={inputClass}
              readOnly
              value={fixedTerms ? formatDateOnly(fixedTerms.periodEnd) : ''}
              placeholder="End of the final paid month"
            />
          </label>
        </>
      )}
      {values.payBasis === 'SALARY' && values.salaryArrangement === 'CONTRACT_TOTAL' && (
        <>
          <label
            className="text-sm font-medium text-slate-800"
            htmlFor={`${idPrefix}-salary-period-start`}
          >
            Paid period start
            <input
              id={`${idPrefix}-salary-period-start`}
              type="date"
              className={inputClass}
              value={values.salaryPeriodStart}
              onChange={(event) => set({ salaryPeriodStart: event.currentTarget.value })}
            />
          </label>
          <label
            className="text-sm font-medium text-slate-800"
            htmlFor={`${idPrefix}-salary-period-end`}
          >
            Paid period end
            <input
              id={`${idPrefix}-salary-period-end`}
              type="date"
              className={inputClass}
              value={values.salaryPeriodEnd}
              onChange={(event) => set({ salaryPeriodEnd: event.currentTarget.value })}
            />
          </label>
        </>
      )}
      <label className="text-sm font-medium text-slate-800" htmlFor={`${idPrefix}-group`}>
        Pay group
        <select
          id={`${idPrefix}-group`}
          className={inputClass}
          value={values.payGroupId}
          onChange={(event) => set({ payGroupId: event.currentTarget.value })}
        >
          {keepOption && <option value={KEEP}>Keep current pay group</option>}
          <option value="">None</option>
          {options.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name} ({group.code}){'archived' in group ? ' — archived' : ''}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function FormShell({
  title,
  description,
  error,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
  children,
}: {
  title: string;
  description?: string;
  error: string | null;
  busy: boolean;
  submitLabel: string;
  onCancel(): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  children: React.ReactNode;
}) {
  return (
    <form
      onSubmit={onSubmit}
      aria-label={title}
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
      noValidate
    >
      <h4 className="font-semibold text-slate-900">{title}</h4>
      {description && <p className="text-sm text-slate-600">{description}</p>}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {children}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DateField({
  id,
  labelText,
  value,
  onChange,
  required = true,
  hint,
}: {
  id: string;
  labelText: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
  hint?: string;
}) {
  return (
    <label className="block text-sm font-medium text-slate-800" htmlFor={id}>
      {labelText}
      <input
        id={id}
        type="date"
        className={inputClass}
        required={required}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {hint && <span className="mt-1 block text-xs font-normal text-slate-500">{hint}</span>}
    </label>
  );
}

function ReasonField({
  id,
  value,
  onChange,
  required = false,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
}) {
  return (
    <label className="block text-sm font-medium text-slate-800" htmlFor={id}>
      Reason{required ? '' : ' (optional)'}
      <textarea
        id={id}
        className={inputClass}
        rows={2}
        required={required}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

/** For a fixed-period salary the effective period is the derived paid period, never typed. */
function FixedPeriodEffectiveNote({ values }: { values: Values }) {
  const terms = fixedPeriodTerms(values);
  return (
    <p className="text-sm text-slate-600">
      {terms
        ? `Effective ${formatPeriod(terms.periodStart, terms.periodEnd)} — the paid period.`
        : 'The effective period follows the paid period once its start and months are entered.'}
    </p>
  );
}

interface FormProps<T> {
  organizationId: string;
  busy: boolean;
  error: string | null;
  onCancel(): void;
  onSubmit(input: T): void;
}

/** First compensation (or the first after a gap): an INITIAL period. */
export function CompensationCreateForm({
  organizationId,
  defaultStart,
  busy,
  error,
  onCancel,
  onSubmit,
}: FormProps<CompensationCreateInput> & { defaultStart: string }) {
  const groups = usePayGroups(organizationId);
  const [values, setValues] = useState<Values>({
    payBasis: 'HOURLY',
    rateAmount: '',
    salaryArrangement: 'ANNUAL',
    salaryPaidMonths: '',
    salaryPeriodStart: defaultStart,
    salaryPeriodEnd: '',
    currency: '',
    payGroupId: '',
  });
  const [effectiveFrom, setEffectiveFrom] = useState(defaultStart);
  const [effectiveTo, setEffectiveTo] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = valuesProblem(values) ?? (effectiveFrom ? null : 'Choose the effective date.');
    setProblem(issue);
    if (issue) return;
    const terms = isFixedPeriod(values) ? fixedPeriodTerms(values) : null;
    const from = terms ? terms.periodStart : effectiveFrom;
    const to = terms ? terms.periodEnd : effectiveTo;
    onSubmit({
      payBasis: values.payBasis,
      rateAmount: values.rateAmount.trim(),
      ...salaryPayload(values),
      currency: values.currency.trim().toUpperCase(),
      payGroupId: values.payGroupId || null,
      effectiveFrom: from,
      ...(to ? { effectiveTo: to } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  }

  return (
    <FormShell
      title="Add compensation"
      description="Records a compensation period. Periods never overlap; leave the end empty for an ongoing period."
      error={problem ?? error}
      busy={busy}
      submitLabel="Add compensation"
      onCancel={onCancel}
      onSubmit={submit}
    >
      <ValueFields idPrefix="create" values={values} onChange={setValues} groups={groups} />
      {isFixedPeriod(values) ? (
        <FixedPeriodEffectiveNote values={values} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DateField
            id="create-from"
            labelText="Effective from"
            value={effectiveFrom}
            onChange={setEffectiveFrom}
          />
          <DateField
            id="create-to"
            labelText="Effective to (optional)"
            value={effectiveTo}
            onChange={setEffectiveTo}
            required={false}
          />
        </div>
      )}
      <ReasonField id="create-reason" value={reason} onChange={setReason} />
    </FormShell>
  );
}

/** A compensation change: the backend closes the period in effect and opens a new one. */
export function CompensationChangeForm({
  organizationId,
  basis,
  busy,
  error,
  onCancel,
  onSubmit,
}: FormProps<CompensationChangeInput> & { basis: CompensationRecord | null }) {
  const groups = usePayGroups(organizationId);
  const [values, setValues] = useState<Values>({
    payBasis: basis?.payBasis ?? 'HOURLY',
    rateAmount: '',
    salaryArrangement: basis?.salaryArrangement ?? 'ANNUAL',
    salaryPaidMonths: basis?.salaryPaidMonths ? String(basis.salaryPaidMonths) : '',
    salaryPeriodStart: basis?.salaryPeriodStart ?? '',
    salaryPeriodEnd: basis?.salaryPeriodEnd ?? '',
    currency: basis?.currency ?? '',
    payGroupId: KEEP,
  });
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = valuesProblem(values) ?? (effectiveFrom ? null : 'Choose the effective date.');
    setProblem(issue);
    if (issue) return;
    onSubmit({
      payBasis: values.payBasis,
      rateAmount: values.rateAmount.trim(),
      ...salaryPayload(values),
      currency: values.currency.trim().toUpperCase(),
      ...(values.payGroupId === KEEP ? {} : { payGroupId: values.payGroupId || null }),
      // A contracted salary starts on its paid period start; the API then ends the new period on
      // the paid period end (annual changes run to where the closed record ended).
      effectiveFrom: isContracted(values) ? values.salaryPeriodStart : effectiveFrom,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  }

  return (
    <FormShell
      title="Change compensation"
      description={
        basis
          ? `Currently ${formatRecordRate(basis)}. The period in effect on the change date ends the day before; past and future dates are allowed (no retro pay is calculated).`
          : 'The period in effect on the change date ends the day before.'
      }
      error={problem ?? error}
      busy={busy}
      submitLabel="Save change"
      onCancel={onCancel}
      onSubmit={submit}
    >
      <ValueFields
        idPrefix="change"
        values={values}
        onChange={setValues}
        groups={groups}
        keepOption
      />
      {isFixedPeriod(values) ? (
        <FixedPeriodEffectiveNote values={values} />
      ) : isContracted(values) ? (
        <p className="text-sm text-slate-600">
          Effective for the paid period above; the record in effect closes the day before it starts.
        </p>
      ) : (
        <DateField
          id="change-from"
          labelText="Effective from"
          value={effectiveFrom}
          onChange={setEffectiveFrom}
        />
      )}
      <ReasonField id="change-reason" value={reason} onChange={setReason} />
    </FormShell>
  );
}

/**
 * Corrects a recorded mistake. The original is kept (superseded) and a replacement recorded; only
 * changed fields are sent, and a reason is required.
 */
export function CompensationCorrectForm({
  organizationId,
  record,
  busy,
  error,
  onCancel,
  onSubmit,
}: FormProps<CompensationCorrectionInput> & { record: CompensationRecord }) {
  const groups = usePayGroups(organizationId);
  const original: Values = {
    payBasis: record.payBasis,
    rateAmount: record.rateAmount,
    salaryArrangement: record.salaryArrangement ?? 'ANNUAL',
    salaryPaidMonths: record.salaryPaidMonths ? String(record.salaryPaidMonths) : '',
    salaryPeriodStart: record.salaryPeriodStart ?? '',
    salaryPeriodEnd: record.salaryPeriodEnd ?? '',
    currency: record.currency,
    payGroupId: record.payGroup?.id ?? '',
  };
  const [values, setValues] = useState<Values>(original);
  const [effectiveFrom, setEffectiveFrom] = useState(record.effectiveFrom);
  const [effectiveTo, setEffectiveTo] = useState(record.effectiveTo ?? '');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue =
      valuesProblem(values) ??
      (effectiveFrom ? null : 'Choose the effective date.') ??
      (reason.trim() ? null : 'A correction needs a reason.');
    setProblem(issue);
    if (issue) return;
    const input: CompensationCorrectionInput = { reason: reason.trim() };
    if (values.payBasis !== original.payBasis) input.payBasis = values.payBasis;
    if (values.rateAmount.trim() !== original.rateAmount)
      input.rateAmount = values.rateAmount.trim();
    if (
      values.payBasis === 'SALARY' &&
      (values.salaryArrangement !== original.salaryArrangement ||
        values.salaryPaidMonths !== original.salaryPaidMonths ||
        values.salaryPeriodStart !== original.salaryPeriodStart ||
        values.salaryPeriodEnd !== original.salaryPeriodEnd ||
        // The rate is the fixed-period monthly salary or the contract total, so a new rate must
        // resend the arrangement to keep its metadata in step.
        (isContracted(values) && values.rateAmount.trim() !== original.rateAmount))
    ) {
      Object.assign(input, salaryPayload(values));
    }
    if (values.currency.trim().toUpperCase() !== original.currency) {
      input.currency = values.currency.trim().toUpperCase();
    }
    if (values.payGroupId !== original.payGroupId) input.payGroupId = values.payGroupId || null;
    const terms = isFixedPeriod(values) ? fixedPeriodTerms(values) : null;
    const from = terms ? terms.periodStart : effectiveFrom;
    const to = terms ? terms.periodEnd : effectiveTo;
    if (from !== record.effectiveFrom) input.effectiveFrom = from;
    if (to !== (record.effectiveTo ?? '')) input.effectiveTo = to || null;
    onSubmit(input);
  }

  return (
    <FormShell
      title="Correct compensation record"
      description={`Fixes a mistake in the record for ${formatPeriod(record.effectiveFrom, record.effectiveTo)}. The original stays in the history as corrected.`}
      error={problem ?? error}
      busy={busy}
      submitLabel="Save correction"
      onCancel={onCancel}
      onSubmit={submit}
    >
      <ValueFields
        idPrefix="correct"
        values={values}
        onChange={setValues}
        groups={groups}
        currentGroup={record.payGroup}
      />
      {isFixedPeriod(values) ? (
        <FixedPeriodEffectiveNote values={values} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DateField
            id="correct-from"
            labelText="Effective from"
            value={effectiveFrom}
            onChange={setEffectiveFrom}
          />
          <DateField
            id="correct-to"
            labelText="Effective to"
            value={effectiveTo}
            onChange={setEffectiveTo}
            required={false}
            hint="Empty means ongoing."
          />
        </div>
      )}
      <ReasonField id="correct-reason" value={reason} onChange={setReason} required />
    </FormShell>
  );
}

/** Ends a period earlier, leaving no compensation after it. */
export function CompensationEndForm({
  record,
  busy,
  error,
  onCancel,
  onSubmit,
}: Omit<FormProps<CompensationEndInput>, 'organizationId'> & { record: CompensationRecord }) {
  const [effectiveTo, setEffectiveTo] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = effectiveTo ? null : 'Choose the last effective date.';
    setProblem(issue);
    if (issue) return;
    onSubmit({ effectiveTo, ...(reason.trim() ? { reason: reason.trim() } : {}) });
  }

  return (
    <FormShell
      title="End compensation period"
      description={`Ends ${formatRecordRate(record)} (${formatPeriod(record.effectiveFrom, record.effectiveTo)}) earlier. Nothing is recorded after it.`}
      error={problem ?? error}
      busy={busy}
      submitLabel="End period"
      onCancel={onCancel}
      onSubmit={submit}
    >
      <DateField
        id="end-to"
        labelText="Last effective date"
        value={effectiveTo}
        onChange={setEffectiveTo}
      />
      <ReasonField id="end-reason" value={reason} onChange={setReason} />
    </FormShell>
  );
}
