'use client';

import { checkboxClass } from '../ui/tokens';

import type { FormEvent } from 'react';
import { useState } from 'react';
import { hoursToMinutes, label } from '../../lib/leave/format';
import type {
  EmploymentType,
  LeaveAccrualFrequency,
  LeaveAccrualMethod,
  LeaveAmountSource,
  LeaveCarryoverMode,
  LeavePolicy,
  LeavePolicyInput,
  LeavePolicyScopeType,
  LeaveType,
  Weekday,
} from '../../lib/leave/types';
import { inputClass, Panel, primaryButton, secondaryButton } from './leave-shared';
import { AssignmentIdPicker } from '../ui/assignment-id-picker';
import { useStructure, value } from './leave-config-shared';

// Batch 10B: the leave policy editor (moved from leave-config-panels.tsx unchanged).

const WEEKDAYS: Weekday[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];
const EMPLOYMENT_TYPES: EmploymentType[] = ['FULL_TIME', 'PART_TIME', 'CASUAL', 'CONTRACT'];
/** Only settings and dates change on an update; type and scope are fixed once created. */
export function settingsOf(input: LeavePolicyInput) {
  const settings: Partial<LeavePolicyInput> = { ...input };
  for (const key of [
    'leaveTypeId',
    'organizationId',
    'scopeType',
    'organizationalUnitId',
    'departmentId',
    'teamId',
    'employmentAssignmentId',
  ] as const) {
    delete settings[key];
  }
  return { ...settings, effectiveTo: input.effectiveTo ?? null };
}

function minutesField(data: FormData, key: string) {
  const raw = value(data, key);
  return raw === '' ? null : hoursToMinutes(raw);
}

function hoursOf(minutes: number | null | undefined) {
  return minutes === null || minutes === undefined ? '' : String(minutes / 60);
}

export function PolicyForm({
  organizationId,
  policy,
  types,
  structure,
  busy,
  onCancel,
  onSave,
}: {
  organizationId: string;
  policy: LeavePolicy | null;
  types: LeaveType[];
  structure: ReturnType<typeof useStructure>;
  busy: boolean;
  onCancel(): void;
  onSave(input: LeavePolicyInput): void;
}) {
  const [scopeType, setScopeType] = useState<LeavePolicyScopeType>(
    policy?.scopeType ?? 'ORGANIZATION',
  );
  const [accrualMethod, setAccrualMethod] = useState<LeaveAccrualMethod>(
    policy?.accrualMethod ?? 'NONE',
  );
  const [accrualFrequency, setAccrualFrequency] = useState<LeaveAccrualFrequency>(
    policy?.accrualFrequency ?? 'MONTHLY',
  );
  const [carryoverMode, setCarryoverMode] = useState<LeaveCarryoverMode>(
    policy?.carryoverMode ?? 'UNLIMITED',
  );
  const fixed = policy !== null;
  const [assignmentTarget, setAssignmentTarget] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const target = value(data, 'scopeTarget');
    const effectiveTo = value(data, 'effectiveTo');
    onSave({
      leaveTypeId: value(data, 'leaveTypeId') || policy?.leaveTypeId || '',
      organizationId,
      scopeType,
      ...(scopeType === 'ORGANIZATIONAL_UNIT' ? { organizationalUnitId: target } : {}),
      ...(scopeType === 'DEPARTMENT' ? { departmentId: target } : {}),
      ...(scopeType === 'TEAM' ? { teamId: target } : {}),
      ...(scopeType === 'EMPLOYMENT_ASSIGNMENT' ? { employmentAssignmentId: target } : {}),
      effectiveFrom: value(data, 'effectiveFrom'),
      ...(effectiveTo ? { effectiveTo } : {}),
      ...(value(data, 'name') ? { name: value(data, 'name') } : {}),
      employmentTypes: data.getAll('employmentTypes').map(String) as EmploymentType[],
      eligible: data.get('eligible') === 'on',
      waitingPeriodDays: Number(value(data, 'waitingPeriodDays') || 0),
      leaveYearStartMonth: Number(value(data, 'leaveYearStartMonth') || 1),
      leaveYearStartDay: Number(value(data, 'leaveYearStartDay') || 1),
      amountSource: value(data, 'amountSource') as LeaveAmountSource,
      standardWorkdayMinutes: minutesField(data, 'standardWorkdayHours') ?? 480,
      standardWorkdays: data.getAll('standardWorkdays').map(String) as Weekday[],
      excludeHolidays: data.get('excludeHolidays') === 'on',
      allowPartialDay: data.get('allowPartialDay') === 'on',
      accrualMethod,
      annualGrantMinutes:
        accrualMethod === 'ANNUAL_GRANT' ? minutesField(data, 'annualGrantHours') : null,
      accrualFrequency: accrualMethod === 'PERIODIC' ? accrualFrequency : null,
      accrualMinutesPerPeriod:
        accrualMethod === 'PERIODIC' ? minutesField(data, 'accrualHoursPerPeriod') : null,
      accrualAnchorDate:
        accrualMethod === 'PERIODIC' && accrualFrequency === 'BIWEEKLY'
          ? value(data, 'accrualAnchorDate') || null
          : null,
      prorateFirstYear: data.get('prorateFirstYear') === 'on',
      maxBalanceMinutes: minutesField(data, 'maxBalanceHours'),
      negativeBalanceLimitMinutes: minutesField(data, 'negativeBalanceLimitHours') ?? 0,
      carryoverMode,
      carryoverMaxMinutes:
        carryoverMode === 'CAPPED' ? minutesField(data, 'carryoverMaxHours') : null,
      carryoverExpiryDays:
        carryoverMode !== 'NONE' && value(data, 'carryoverExpiryDays')
          ? Number(value(data, 'carryoverExpiryDays'))
          : null,
      employeeMayCancelApprovedFuture: data.get('employeeMayCancelApprovedFuture') === 'on',
    });
  }

  const targets =
    scopeType === 'ORGANIZATIONAL_UNIT'
      ? structure.units
      : scopeType === 'DEPARTMENT'
        ? structure.departments
        : scopeType === 'TEAM'
          ? structure.teams
          : [];
  const currentTarget =
    policy?.organizationalUnitId ??
    policy?.departmentId ??
    policy?.teamId ??
    policy?.employmentAssignmentId ??
    '';

  return (
    <Panel title={policy ? 'Edit policy (not yet in effect)' : 'New leave policy'}>
      <form className="grid grid-cols-1 gap-4 sm:grid-cols-3" onSubmit={submit}>
        <label className="text-sm font-medium text-slate-700">
          Leave type
          <select
            name="leaveTypeId"
            required
            disabled={fixed}
            defaultValue={policy?.leaveTypeId ?? types[0]?.id}
            className={inputClass}
          >
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Scope
          <select
            value={scopeType}
            disabled={fixed}
            onChange={(event) => setScopeType(event.target.value as LeavePolicyScopeType)}
            className={inputClass}
          >
            {(
              [
                'ORGANIZATION',
                'ORGANIZATIONAL_UNIT',
                'DEPARTMENT',
                'TEAM',
                'EMPLOYMENT_ASSIGNMENT',
              ] as const
            ).map((scope) => (
              <option key={scope} value={scope}>
                {label(scope)}
              </option>
            ))}
          </select>
        </label>
        {scopeType === 'EMPLOYMENT_ASSIGNMENT' && fixed ? (
          // Batch 6B (L7): the fixed assignment by name, never its raw id.
          <label className="text-sm font-medium text-slate-700">
            Employee
            <input
              disabled
              defaultValue={
                policy?.assignment
                  ? `${policy.assignment.employeeName} (${policy.assignment.employeeNumber}) · ${policy.assignment.positionName}`
                  : 'One employee assignment'
              }
              className={inputClass}
            />
          </label>
        ) : scopeType === 'EMPLOYMENT_ASSIGNMENT' ? (
          <div>
            <input type="hidden" name="scopeTarget" value={assignmentTarget} />
            <AssignmentIdPicker
              label="Employment assignment"
              organizationId={organizationId}
              required
              value={assignmentTarget}
              onChange={setAssignmentTarget}
            />
          </div>
        ) : scopeType !== 'ORGANIZATION' ? (
          <label className="text-sm font-medium text-slate-700">
            {label(scopeType)}
            <select
              name="scopeTarget"
              required
              disabled={fixed}
              defaultValue={currentTarget}
              className={inputClass}
            >
              <option value="">Select…</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div />
        )}
        <label className="text-sm font-medium text-slate-700">
          Effective from
          <input
            name="effectiveFrom"
            type="date"
            required
            defaultValue={policy?.effectiveFrom ?? ''}
            className={inputClass}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Effective to (optional)
          <input
            name="effectiveTo"
            type="date"
            defaultValue={policy?.effectiveTo ?? ''}
            className={inputClass}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Name (optional)
          <input
            name="name"
            maxLength={200}
            defaultValue={policy?.name ?? ''}
            className={inputClass}
          />
        </label>

        <fieldset className="text-sm text-slate-700 sm:col-span-3">
          <legend className="font-medium">Employment types (none = all)</legend>
          <div className="mt-1 flex flex-wrap gap-4">
            {EMPLOYMENT_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  name="employmentTypes"
                  value={type}
                  defaultChecked={policy?.employmentTypes.includes(type)}
                />
                {label(type)}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            className={checkboxClass}
            name="eligible"
            defaultChecked={policy?.eligible ?? true}
          />
          Eligible
        </label>
        <label className="text-sm font-medium text-slate-700">
          Waiting period (days)
          <input
            name="waitingPeriodDays"
            type="number"
            min={0}
            defaultValue={policy?.waitingPeriodDays ?? 0}
            className={inputClass}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm font-medium text-slate-700">
            Year starts (month)
            <input
              name="leaveYearStartMonth"
              type="number"
              min={1}
              max={12}
              defaultValue={policy?.leaveYearStartMonth ?? 1}
              className={inputClass}
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            (day)
            <input
              name="leaveYearStartDay"
              type="number"
              min={1}
              max={28}
              defaultValue={policy?.leaveYearStartDay ?? 1}
              className={inputClass}
            />
          </label>
        </div>

        <label className="text-sm font-medium text-slate-700">
          Amount source
          <select
            name="amountSource"
            defaultValue={policy?.amountSource ?? 'SCHEDULE_THEN_STANDARD'}
            className={inputClass}
          >
            <option value="SCHEDULE_THEN_STANDARD">Published schedule, else standard day</option>
            <option value="STANDARD_ONLY">Standard day only</option>
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Standard workday (hours)
          <input
            name="standardWorkdayHours"
            type="number"
            step="0.25"
            min={0.25}
            max={24}
            defaultValue={hoursOf(policy?.standardWorkdayMinutes ?? 480)}
            className={inputClass}
          />
        </label>
        <div className="flex flex-col justify-end gap-1 text-sm font-medium text-slate-700">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className={checkboxClass}
              name="excludeHolidays"
              defaultChecked={policy?.excludeHolidays ?? true}
            />
            Exclude holidays
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className={checkboxClass}
              name="allowPartialDay"
              defaultChecked={policy?.allowPartialDay ?? true}
            />
            Allow partial days
          </label>
        </div>
        <fieldset className="text-sm text-slate-700 sm:col-span-3">
          <legend className="font-medium">Standard workdays</legend>
          <div className="mt-1 flex flex-wrap gap-4">
            {WEEKDAYS.map((day) => (
              <label key={day} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  name="standardWorkdays"
                  value={day}
                  defaultChecked={
                    policy
                      ? policy.standardWorkdays.includes(day)
                      : !['SATURDAY', 'SUNDAY'].includes(day)
                  }
                />
                {label(day)}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="text-sm font-medium text-slate-700">
          Accrual
          <select
            value={accrualMethod}
            onChange={(event) => setAccrualMethod(event.target.value as LeaveAccrualMethod)}
            className={inputClass}
          >
            <option value="NONE">None</option>
            <option value="ANNUAL_GRANT">Annual grant</option>
            <option value="PERIODIC">Periodic accrual</option>
          </select>
        </label>
        {accrualMethod === 'ANNUAL_GRANT' && (
          <label className="text-sm font-medium text-slate-700">
            Hours per leave year
            <input
              name="annualGrantHours"
              type="number"
              step="0.25"
              min={0.25}
              required
              defaultValue={hoursOf(policy?.annualGrantMinutes)}
              className={inputClass}
            />
          </label>
        )}
        {accrualMethod === 'PERIODIC' && (
          <>
            <label className="text-sm font-medium text-slate-700">
              Frequency
              <select
                value={accrualFrequency}
                onChange={(event) =>
                  setAccrualFrequency(event.target.value as LeaveAccrualFrequency)
                }
                className={inputClass}
              >
                <option value="MONTHLY">Monthly</option>
                <option value="SEMI_MONTHLY">Semi-monthly</option>
                <option value="BIWEEKLY">Bi-weekly</option>
              </select>
            </label>
            <label className="text-sm font-medium text-slate-700">
              Hours per period
              <input
                name="accrualHoursPerPeriod"
                type="number"
                step="0.25"
                min={0.25}
                required
                defaultValue={hoursOf(policy?.accrualMinutesPerPeriod)}
                className={inputClass}
              />
            </label>
            {accrualFrequency === 'BIWEEKLY' && (
              <label className="text-sm font-medium text-slate-700">
                Bi-weekly anchor date
                <input
                  name="accrualAnchorDate"
                  type="date"
                  required
                  defaultValue={policy?.accrualAnchorDate ?? ''}
                  className={inputClass}
                />
              </label>
            )}
          </>
        )}
        {accrualMethod !== 'NONE' && (
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              className={checkboxClass}
              name="prorateFirstYear"
              defaultChecked={policy?.prorateFirstYear ?? false}
            />
            Prorate partial first periods
          </label>
        )}
        <label className="text-sm font-medium text-slate-700">
          Maximum balance (hours, optional)
          <input
            name="maxBalanceHours"
            type="number"
            step="0.25"
            min={0}
            defaultValue={hoursOf(policy?.maxBalanceMinutes)}
            className={inputClass}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Negative balance allowed (hours)
          <input
            name="negativeBalanceLimitHours"
            type="number"
            step="0.25"
            min={0}
            defaultValue={hoursOf(policy?.negativeBalanceLimitMinutes ?? 0)}
            className={inputClass}
          />
        </label>

        <label className="text-sm font-medium text-slate-700">
          Year-end carryover
          <select
            value={carryoverMode}
            onChange={(event) => setCarryoverMode(event.target.value as LeaveCarryoverMode)}
            className={inputClass}
          >
            <option value="UNLIMITED">Unlimited</option>
            <option value="CAPPED">Capped</option>
            <option value="NONE">None (forfeit)</option>
          </select>
        </label>
        {carryoverMode === 'CAPPED' && (
          <label className="text-sm font-medium text-slate-700">
            Carryover cap (hours)
            <input
              name="carryoverMaxHours"
              type="number"
              step="0.25"
              min={0}
              required
              defaultValue={hoursOf(policy?.carryoverMaxMinutes)}
              className={inputClass}
            />
          </label>
        )}
        {carryoverMode !== 'NONE' && (
          <label className="text-sm font-medium text-slate-700">
            Carried hours expire after (days, optional)
            <input
              name="carryoverExpiryDays"
              type="number"
              min={1}
              defaultValue={policy?.carryoverExpiryDays ?? ''}
              className={inputClass}
            />
          </label>
        )}
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 sm:col-span-3">
          <input
            type="checkbox"
            className={checkboxClass}
            name="employeeMayCancelApprovedFuture"
            defaultChecked={policy?.employeeMayCancelApprovedFuture ?? true}
          />
          Employees may cancel approved future leave
        </label>
        <div className="flex gap-2 sm:col-span-3">
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? 'Saving…' : policy ? 'Save policy' : 'Create policy'}
          </button>
          <button type="button" className={secondaryButton} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}
