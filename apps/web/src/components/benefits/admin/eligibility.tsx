'use client';

import { checkboxClass } from '../../ui/tokens';
import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';
import { benefitsApi } from '../../../lib/benefits/api';
import { benefitOptionSource } from '../../../lib/benefits/pickers';
import type { BenefitPlanDetail, EligibilityRule } from '../../../lib/benefits/types';
import { FormDialog } from '../../ui/form-dialog';
import { RecordCombobox } from '../../ui/record-combobox';
import {
  coveragePeriod,
  EmptyState,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../benefits-shared';
import { EMPLOYMENT_TYPES, Field, type Mutate } from './shared';
import { DataTable } from '../../ui/data-table';

/** A rule's criteria in words, by name (never a raw id). */
export function ruleText(rule: EligibilityRule) {
  const parts: string[] = [];
  if (rule.organizationalUnitId)
    parts.push(
      `Unit: ${rule.organizationalUnitName ?? 'unknown unit'}${
        rule.includeSubunits ? ' (with subunits)' : ''
      }`,
    );
  if (rule.departmentId) parts.push(`Department: ${rule.departmentName ?? 'unknown department'}`);
  if (rule.positionId) parts.push(`Position: ${rule.positionName ?? 'unknown position'}`);
  if (rule.employmentTypes.length > 0)
    parts.push(rule.employmentTypes.map((type) => label(type)).join(' or '));
  if (rule.minimumServiceDays !== null) parts.push(`${rule.minimumServiceDays}+ days of service`);
  return parts.length > 0 ? parts.join(' · ') : 'Everyone in the organization';
}

export function EligibilitySection({
  plan,
  organizationId,
  busy,
  mutate,
}: {
  plan: BenefitPlanDetail;
  organizationId: string;
  busy: boolean;
  mutate: Mutate;
}) {
  const canManage = plan.actions.canManageEligibility;
  const [ending, setEnding] = useState<EligibilityRule | null>(null);
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-slate-900">Eligibility rules</h3>
      <p className="text-sm text-slate-600">
        An employee&apos;s assignment is eligible when every criterion of any rule in effect
        matches. A plan that never had rules is open to everyone in the organization.
      </p>
      {plan.eligibilityRules.length === 0 ? (
        <EmptyState>No eligibility rules: open to all employees.</EmptyState>
      ) : (
        <DataTable
          label={`Eligibility rules of ${plan.name}`}
          rows={plan.eligibilityRules}
          rowKey={(rule) => rule.id}
          columns={[
            {
              key: 'effective',
              header: 'Effective',
              rowHeader: true,
              cell: (rule) => <>{coveragePeriod(rule.effectiveFrom, rule.effectiveTo)}</>,
            },
            {
              key: 'criteria',
              header: 'Criteria',
              cell: (rule) => <>{ruleText(rule)}</>,
            },
            {
              key: 'actions',
              header: 'Actions',
              cell: (rule) => (
                <>
                  {canManage && !rule.effectiveTo && (
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={busy}
                      aria-label={`End rule from ${rule.effectiveFrom}: ${ruleText(rule)}`}
                      onClick={() => setEnding(rule)}
                    >
                      End rule
                    </button>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      {canManage && (
        <RuleForm planId={plan.id} organizationId={organizationId} busy={busy} mutate={mutate} />
      )}
      {ending && (
        <EndRuleDialog rule={ending} busy={busy} mutate={mutate} onClose={() => setEnding(null)} />
      )}
    </div>
  );
}

function RuleForm({
  planId,
  organizationId,
  busy,
  mutate,
}: {
  planId: string;
  organizationId: string;
  busy: boolean;
  mutate: Mutate;
}) {
  const sources = useMemo(
    () => ({
      unit: benefitOptionSource(organizationId, 'unit'),
      department: benefitOptionSource(organizationId, 'department'),
      position: benefitOptionSource(organizationId, 'position'),
    }),
    [organizationId],
  );
  const empty = {
    effectiveFrom: '',
    effectiveTo: '',
    unitId: '',
    includeSubunits: true,
    departmentId: '',
    positionId: '',
    types: [] as string[],
    serviceDays: '',
  };
  const [form, setForm] = useState(empty);
  // Remounts the pickers after a save (clears their typed text).
  const [round, setRound] = useState(0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await mutate(
      () =>
        benefitsApi.addRule(planId, {
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || null,
          organizationalUnitId: form.unitId || null,
          includeSubunits: form.includeSubunits,
          departmentId: form.departmentId || null,
          positionId: form.positionId || null,
          employmentTypes: form.types,
          minimumServiceDays: form.serviceDays ? Number(form.serviceDays) : null,
        }),
      'Eligibility rule added.',
    );
    if (ok) {
      setForm(empty);
      setRound((value) => value + 1);
    }
  }

  return (
    <form
      aria-label="Add eligibility rule"
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2"
      onSubmit={(event) => void submit(event)}
    >
      <Field label="Rule effective from">
        <input
          type="date"
          className={inputClass}
          required
          value={form.effectiveFrom}
          onChange={(e) => setForm({ ...form, effectiveFrom: e.currentTarget.value })}
        />
      </Field>
      <Field label="Rule effective to (optional)">
        <input
          type="date"
          className={inputClass}
          min={form.effectiveFrom || undefined}
          value={form.effectiveTo}
          onChange={(e) => setForm({ ...form, effectiveTo: e.currentTarget.value })}
        />
      </Field>
      <div className="space-y-1">
        <RecordCombobox
          key={`unit-${round}`}
          label="Organizational unit (optional)"
          source={sources.unit}
          value={form.unitId}
          onChange={(id) => setForm((current) => ({ ...current, unitId: id }))}
          placeholder="Any unit"
        />
        {form.unitId && (
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={form.includeSubunits}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setForm((current) => ({ ...current, includeSubunits: checked }));
              }}
            />
            Include its subunits
          </label>
        )}
      </div>
      <RecordCombobox
        key={`department-${round}`}
        label="Department (optional)"
        source={sources.department}
        value={form.departmentId}
        onChange={(id) => setForm((current) => ({ ...current, departmentId: id }))}
        placeholder="Any department"
      />
      <RecordCombobox
        key={`position-${round}`}
        label="Position (optional)"
        source={sources.position}
        value={form.positionId}
        onChange={(id) => setForm((current) => ({ ...current, positionId: id }))}
        placeholder="Any position"
      />
      <Field label="Minimum service days (optional)">
        <input
          type="number"
          min={0}
          className={inputClass}
          value={form.serviceDays}
          onChange={(e) => setForm({ ...form, serviceDays: e.currentTarget.value })}
        />
      </Field>
      <fieldset className="text-sm text-slate-800 sm:col-span-2">
        <legend className="font-medium">Employment types (any when none is chosen)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {EMPLOYMENT_TYPES.map((type) => (
            <label key={type} className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={form.types.includes(type)}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setForm((current) => ({
                    ...current,
                    types: checked
                      ? [...current.types, type]
                      : current.types.filter((t) => t !== type),
                  }));
                }}
              />
              {label(type)}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-slate-600 sm:col-span-2">
        Every criterion you set must match. Rules never change once added; end one and add another
        instead.
      </p>
      <div className="flex items-end">
        <button type="submit" className={primaryButton} disabled={busy}>
          Add rule
        </button>
      </div>
    </form>
  );
}

function EndRuleDialog({
  rule,
  busy,
  mutate,
  onClose,
}: {
  rule: EligibilityRule;
  busy: boolean;
  mutate: Mutate;
  onClose(): void;
}) {
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      tone="destructive"
      title="End this eligibility rule?"
      description={`${ruleText(rule)} — in effect from ${rule.effectiveFrom}. Assignments it made eligible are no longer eligible after the last day (existing elections are flagged, never ended).`}
      submitLabel="End rule"
      busy={busy}
      canSubmit={date !== ''}
      error={error}
      onSubmit={() =>
        void mutate(() => benefitsApi.endRule(rule.id, date), 'Eligibility rule ended.', {
          onError: (message) => setError(message),
        }).then((ok) => ok && onClose())
      }
      onClose={onClose}
    >
      <Field label="Last day of the rule">
        <input
          type="date"
          className={inputClass}
          required
          min={rule.effectiveFrom}
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
        />
      </Field>
    </FormDialog>
  );
}
