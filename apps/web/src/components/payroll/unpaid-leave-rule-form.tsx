'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { z } from '../../lib/forms/zod';
import type { PayrollCalendar, SalaryUnpaidLeaveRuleInput } from '../../lib/payroll/types';
import { buttonClass } from '../ui/button';
import { InputField } from '../ui/form/form-field';

/** Mirrors SalaryUnpaidLeaveRuleDto and the 1–8784 hour check in PayrollCalendarService. */
export const unpaidLeaveRuleSchema = z
  .object({
    rule: z.enum(['UNCONFIGURED', 'HOURLY_EQUIVALENT']),
    standardAnnualHours: z.string().trim(),
  })
  .superRefine((value, context) => {
    if (value.rule !== 'HOURLY_EQUIVALENT') return;
    const hours = Number(value.standardAnnualHours);
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(value.standardAnnualHours) || hours < 1 || hours > 8784) {
      context.addIssue({
        code: 'custom',
        path: ['standardAnnualHours'],
        message: 'Enter the paid hours of a salaried year, from 1 to 8784 (for example 2080).',
      });
    }
  });

type FormValues = z.infer<typeof unpaidLeaveRuleSchema>;

/**
 * How a salary is reduced for unpaid leave on a pay calendar. Until a rule is set, a run with
 * unpaid leave on salaried days reports SALARY_UNPAID_LEAVE_REQUIRES_RULE and cannot be approved.
 */
export function UnpaidLeaveRuleForm({
  calendar,
  busy,
  onSubmit,
  onCancel,
}: {
  calendar: PayrollCalendar;
  busy: boolean;
  onSubmit(input: SalaryUnpaidLeaveRuleInput): Promise<boolean>;
  onCancel(): void;
}) {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(unpaidLeaveRuleSchema),
    defaultValues: {
      rule: calendar.salaryUnpaidLeaveRule,
      standardAnnualHours: calendar.salaryStandardAnnualHours ?? '2080',
    },
  });
  const hourly = useWatch({ control, name: 'rule' }) === 'HOURLY_EQUIVALENT';
  const hoursError = errors.standardAnnualHours?.message;

  return (
    <form
      aria-label={`Unpaid leave rule for ${calendar.payGroup?.name ?? 'the pay calendar'}`}
      noValidate
      onSubmit={handleSubmit((values) =>
        onSubmit(
          values.rule === 'HOURLY_EQUIVALENT'
            ? { rule: values.rule, standardAnnualHours: values.standardAnnualHours }
            : { rule: values.rule, standardAnnualHours: null },
        ),
      )}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="text-base font-semibold text-slate-900">
        Unpaid leave on salaried days — {calendar.payGroup?.name ?? calendar.payGroupId}
      </h3>
      <p className="text-sm text-slate-600">
        Runs with unpaid leave on salaried days stay blocked until a rule is set. After saving,
        recalculate the affected runs.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">Rule</legend>
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input type="radio" value="HOURLY_EQUIVALENT" {...register('rule')} />
          Hourly equivalent — reduce the salary by its hourly rate for each unpaid hour
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input type="radio" value="UNCONFIGURED" {...register('rule')} />
          Not configured — such runs cannot be approved
        </label>
      </fieldset>
      {hourly && (
        <InputField
          className="max-w-xs"
          label="Standard paid hours per year"
          hint="For example 2080 (40 hours × 52 weeks)."
          error={hoursError}
          inputMode="decimal"
          registration={register('standardAnnualHours')}
        />
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
          Save rule
        </button>
        <button type="button" onClick={onCancel} className={buttonClass('secondary', 'sm')}>
          Cancel
        </button>
      </div>
    </form>
  );
}
