'use client';

import { checkboxClass } from '../../ui/tokens';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { benefitsApi, type PlanUpdateInput } from '../../../lib/benefits/api';
import type { BenefitPlan, BenefitPlanDetail, BenefitType } from '../../../lib/benefits/types';
import { FormDialog } from '../../ui/form-dialog';
import { useConfirm } from '../../ui/use-confirm';
import {
  coveragePeriod,
  EmptyState,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../benefits-shared';
import { EligibilitySection } from './eligibility';
import { OptionsAndRates } from './options-rates';
import {
  BENEFIT_TYPES,
  Field,
  SectionState,
  useSectionData,
  type Mutate,
  type SectionProps,
} from './shared';
import { DataTable } from '../../ui/data-table';

const statusText = (plan: BenefitPlan) => (plan.archived ? 'Archived' : label(plan.status));

/** Plans of the organization (archived on request), a plan's detail, and plan creation. */
export function PlansTab(props: SectionProps) {
  const { organizationId, canManagePlans, version } = props;
  const [includeArchived, setIncludeArchived] = useState(false);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const plans = useSectionData(
    () => benefitsApi.plans(organizationId, includeArchived),
    [organizationId, includeArchived, version],
  );

  if (openPlanId) {
    return <PlanDetail {...props} planId={openPlanId} onBack={() => setOpenPlanId(null)} />;
  }
  const items = plans.data?.items ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Benefit plans</h2>
        <label className="inline-flex items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.currentTarget.checked)}
          />
          Show archived plans
        </label>
      </div>
      <SectionState
        loading={plans.loading}
        error={plans.error}
        onRetry={plans.reload}
        what="benefit plans"
        hasData={plans.data !== null}
      >
        {items.length === 0 ? (
          <EmptyState>
            {includeArchived
              ? 'No benefit plans yet.'
              : 'No current benefit plans. Archived plans are hidden; show them to see past plans.'}
          </EmptyState>
        ) : (
          <DataTable
            label="Benefit plans"
            minWidth="min-w-[880px]"
            rows={items}
            rowKey={(plan) => plan.id}
            columns={[
              {
                key: 'code',
                header: 'Code',
                cell: (plan) => <>{plan.code}</>,
              },
              {
                key: 'name',
                header: 'Name',
                rowHeader: true,
                cell: (plan) => <>{plan.name}</>,
              },
              {
                key: 'type',
                header: 'Type',
                cell: (plan) => <>{label(plan.benefitType)}</>,
              },
              {
                key: 'status',
                header: 'Status',
                cell: (plan) => <>{statusText(plan)}</>,
              },
              {
                key: 'effective',
                header: 'Effective',
                cell: (plan) => <>{coveragePeriod(plan.effectiveFrom, plan.effectiveTo)}</>,
              },
              {
                key: 'options',
                header: 'Options',
                cell: (plan) => <>{plan.optionCount ?? 0}</>,
              },
              {
                key: 'actions',
                header: 'Actions',
                cell: (plan) => (
                  <>
                    <button
                      type="button"
                      className={secondaryButton}
                      aria-label={`Open ${plan.name}`}
                      onClick={() => setOpenPlanId(plan.id)}
                    >
                      Open
                    </button>
                  </>
                ),
              },
            ]}
          />
        )}
      </SectionState>
      {canManagePlans && <CreatePlanForm {...props} />}
    </div>
  );
}

const EMPTY_PLAN = {
  code: '',
  name: '',
  benefitType: 'HEALTH' as BenefitType,
  currency: 'CAD',
  effectiveFrom: '',
  effectiveTo: '',
  description: '',
  providerName: '',
  providerReference: '',
  dependentChildMaxAge: '',
  showEmployerCostToEmployee: false,
  employerContributionTaxable: false,
};

function CreatePlanForm({ organizationId, busy, mutate }: SectionProps) {
  const [form, setForm] = useState(EMPTY_PLAN);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const text = (value: string) => value.trim() || null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await mutate(
      () =>
        benefitsApi.createPlan({
          organizationId,
          code: form.code.trim(),
          name: form.name.trim(),
          benefitType: form.benefitType,
          currency: form.currency.trim().toUpperCase(),
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || null,
          description: text(form.description),
          providerName: text(form.providerName),
          providerReference: text(form.providerReference),
          dependentChildMaxAge: form.dependentChildMaxAge
            ? Number(form.dependentChildMaxAge)
            : null,
          showEmployerCostToEmployee: form.showEmployerCostToEmployee,
          employerContributionTaxable: form.employerContributionTaxable,
        }),
      'Benefit plan created.',
    );
    if (ok) setForm(EMPTY_PLAN);
  }

  return (
    <form
      aria-label="Create benefit plan"
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(event) => void submit(event)}
    >
      <h2 className="text-base font-semibold text-slate-900 sm:col-span-2 lg:col-span-3">
        New plan
      </h2>
      <Field label="Code" hint="2–64 characters; never changes.">
        <input
          className={inputClass}
          required
          minLength={2}
          maxLength={64}
          value={form.code}
          onChange={(e) => set('code', e.currentTarget.value)}
        />
      </Field>
      <Field label="Name">
        <input
          className={inputClass}
          required
          maxLength={200}
          value={form.name}
          onChange={(e) => set('name', e.currentTarget.value)}
        />
      </Field>
      <Field label="Type">
        <select
          className={inputClass}
          value={form.benefitType}
          onChange={(e) => set('benefitType', e.currentTarget.value as BenefitType)}
        >
          {BENEFIT_TYPES.map((type) => (
            <option key={type} value={type}>
              {label(type)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Currency" hint="Three letters, e.g. CAD; never changes.">
        <input
          className={inputClass}
          required
          minLength={3}
          maxLength={3}
          value={form.currency}
          onChange={(e) => set('currency', e.currentTarget.value.toUpperCase())}
        />
      </Field>
      <Field label="Effective from">
        <input
          type="date"
          className={inputClass}
          required
          value={form.effectiveFrom}
          onChange={(e) => set('effectiveFrom', e.currentTarget.value)}
        />
      </Field>
      <Field label="Effective to (optional)" hint="Leave empty for an open-ended plan.">
        <input
          type="date"
          className={inputClass}
          min={form.effectiveFrom || undefined}
          value={form.effectiveTo}
          onChange={(e) => set('effectiveTo', e.currentTarget.value)}
        />
      </Field>
      <Field label="Provider (optional)">
        <input
          className={inputClass}
          maxLength={200}
          value={form.providerName}
          onChange={(e) => set('providerName', e.currentTarget.value)}
        />
      </Field>
      <Field label="Provider reference (optional)" hint="Policy or group number.">
        <input
          className={inputClass}
          maxLength={200}
          value={form.providerReference}
          onChange={(e) => set('providerReference', e.currentTarget.value)}
        />
      </Field>
      <Field label="Children covered up to age (optional)">
        <input
          type="number"
          min={0}
          max={99}
          className={inputClass}
          value={form.dependentChildMaxAge}
          onChange={(e) => set('dependentChildMaxAge', e.currentTarget.value)}
        />
      </Field>
      <div className="sm:col-span-2 lg:col-span-3">
        <Field label="Description (optional)">
          <textarea
            rows={2}
            maxLength={500}
            className={inputClass}
            value={form.description}
            onChange={(e) => set('description', e.currentTarget.value)}
          />
        </Field>
      </div>
      <CostFlags
        show={form.showEmployerCostToEmployee}
        taxable={form.employerContributionTaxable}
        onShow={(value) => set('showEmployerCostToEmployee', value)}
        onTaxable={(value) => set('employerContributionTaxable', value)}
      />
      <div className="flex items-end sm:col-span-2 lg:col-span-3">
        <button type="submit" className={primaryButton} disabled={busy}>
          Create plan
        </button>
      </div>
    </form>
  );
}

function CostFlags({
  show,
  taxable,
  onShow,
  onTaxable,
}: {
  show: boolean;
  taxable: boolean;
  onShow(value: boolean): void;
  onTaxable(value: boolean): void;
}) {
  return (
    <fieldset className="space-y-1 text-sm text-slate-800 sm:col-span-2 lg:col-span-3">
      <legend className="font-medium">Employer cost</legend>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className={checkboxClass}
          checked={show}
          onChange={(e) => onShow(e.currentTarget.checked)}
        />
        Show the employer cost to employees
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className={checkboxClass}
          checked={taxable}
          onChange={(e) => onTaxable(e.currentTarget.checked)}
        />
        Employer contribution is a taxable benefit
      </label>
    </fieldset>
  );
}

function PlanDetail({
  planId,
  onBack,
  ...props
}: SectionProps & { planId: string; onBack(): void }) {
  const { busy, mutate, version } = props;
  const detail = useSectionData(() => benefitsApi.plan(planId), [planId, version]);
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState(false);
  const [discontinuing, setDiscontinuing] = useState(false);
  const plan = detail.data;

  return (
    <div className="space-y-6">
      {confirmDialog}
      <button type="button" className="text-sm text-slate-600 underline" onClick={onBack}>
        ← All plans
      </button>
      <SectionState
        loading={detail.loading}
        error={detail.error}
        onRetry={detail.reload}
        what="the plan"
        hasData={plan !== null}
      >
        {plan && (
          <section aria-label={`${plan.name} plan`} className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-xl font-semibold text-slate-900">
                  {plan.name}{' '}
                  <span className="text-sm font-normal text-slate-500">({plan.code})</span>
                </h2>
                <p className="text-sm text-slate-600">
                  {label(plan.benefitType)} · {statusText(plan)} ·{' '}
                  {coveragePeriod(plan.effectiveFrom, plan.effectiveTo)} · {plan.currency}
                </p>
                <PlanFacts plan={plan} />
              </div>
              <PlanActions
                plan={plan}
                busy={busy}
                mutate={mutate}
                confirm={confirm}
                onEdit={() => setEditing(true)}
                onDiscontinue={() => setDiscontinuing(true)}
              />
            </div>
            {plan.status === 'DRAFT' && !plan.archived && !plan.actions.canActivate && (
              <p className="text-sm text-amber-800">
                Add a coverage option before activating the plan.
              </p>
            )}
            <OptionsAndRates plan={plan} busy={busy} mutate={mutate} confirm={confirm} />
            <EligibilitySection
              plan={plan}
              organizationId={props.organizationId}
              busy={busy}
              mutate={mutate}
            />
            {editing && (
              <EditPlanDialog
                plan={plan}
                busy={busy}
                mutate={mutate}
                onClose={() => setEditing(false)}
              />
            )}
            {discontinuing && (
              <DiscontinueDialog
                plan={plan}
                busy={busy}
                mutate={mutate}
                onClose={() => setDiscontinuing(false)}
              />
            )}
          </section>
        )}
      </SectionState>
    </div>
  );
}

function PlanFacts({ plan }: { plan: BenefitPlanDetail }) {
  const facts: Array<[string, string]> = [
    ['Provider', plan.providerName ?? '—'],
    ['Provider reference', plan.providerReference ?? '—'],
    [
      'Children covered up to age',
      plan.dependentChildMaxAge === null ? 'No limit' : String(plan.dependentChildMaxAge),
    ],
    ['Employer cost shown to employees', plan.showEmployerCostToEmployee ? 'Yes' : 'No'],
    ['Employer contribution taxable', plan.employerContributionTaxable ? 'Yes' : 'No'],
  ];
  return (
    <div className="mt-2 space-y-2">
      {plan.description && <p className="text-sm text-slate-700">{plan.description}</p>}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {facts.map(([term, value]) => (
          <div key={term} className="flex flex-wrap gap-1">
            <dt className="text-slate-500">{term}:</dt>
            <dd className="text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type Confirm = ReturnType<typeof useConfirm>[0];

function PlanActions({
  plan,
  busy,
  mutate,
  confirm,
  onEdit,
  onDiscontinue,
}: {
  plan: BenefitPlanDetail;
  busy: boolean;
  mutate: Mutate;
  confirm: Confirm;
  onEdit(): void;
  onDiscontinue(): void;
}) {
  const { actions } = plan;
  const transition = async (
    action: 'activate' | 'close' | 'archive',
    options: Parameters<Confirm>[0],
    message: string,
  ) => {
    if (await confirm(options))
      await mutate(() => benefitsApi.transitionPlan(plan.id, action), message);
  };
  return (
    <div className="flex flex-wrap gap-2">
      {actions.canEdit && (
        <button type="button" className={secondaryButton} disabled={busy} onClick={onEdit}>
          Edit plan
        </button>
      )}
      {actions.canActivate && (
        <button
          type="button"
          className={primaryButton}
          disabled={busy}
          onClick={() =>
            void transition(
              'activate',
              {
                title: `Activate ${plan.name}?`,
                description: 'Employees can then be enrolled in the plan.',
                confirmLabel: 'Activate plan',
                destructive: false,
              },
              'Plan activated.',
            )
          }
        >
          Activate
        </button>
      )}
      {actions.canClose && (
        <button
          type="button"
          className={secondaryButton}
          disabled={busy}
          onClick={() =>
            void transition(
              'close',
              {
                title: `Close ${plan.name} to new elections?`,
                description:
                  'No new elections can be recorded. Existing coverage continues unchanged; the plan can be reactivated.',
                confirmLabel: 'Close plan',
              },
              'Plan closed to new elections.',
            )
          }
        >
          Close to new elections
        </button>
      )}
      {actions.canEdit && plan.status !== 'DRAFT' && (
        <button type="button" className={secondaryButton} disabled={busy} onClick={onDiscontinue}>
          Discontinue…
        </button>
      )}
      {actions.canArchive && (
        <button
          type="button"
          className={secondaryButton}
          disabled={busy}
          onClick={() =>
            void transition(
              'archive',
              {
                title: `Archive ${plan.name}?`,
                description:
                  'The plan is hidden from new work and can no longer be changed. Its history stays readable. This cannot be undone.',
                confirmLabel: 'Archive plan',
              },
              'Plan archived.',
            )
          }
        >
          Archive
        </button>
      )}
    </div>
  );
}

function EditPlanDialog({
  plan,
  busy,
  mutate,
  onClose,
}: {
  plan: BenefitPlanDetail;
  busy: boolean;
  mutate: Mutate;
  onClose(): void;
}) {
  const [form, setForm] = useState({
    name: plan.name,
    description: plan.description ?? '',
    providerName: plan.providerName ?? '',
    providerReference: plan.providerReference ?? '',
    effectiveFrom: plan.effectiveFrom,
    dependentChildMaxAge:
      plan.dependentChildMaxAge === null ? '' : String(plan.dependentChildMaxAge),
    showEmployerCostToEmployee: plan.showEmployerCostToEmployee,
    employerContributionTaxable: plan.employerContributionTaxable,
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const canEditStart = Boolean(plan.actions.canEditStart);

  function submit() {
    const input: PlanUpdateInput = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      providerName: form.providerName.trim() || null,
      providerReference: form.providerReference.trim() || null,
      dependentChildMaxAge: form.dependentChildMaxAge ? Number(form.dependentChildMaxAge) : null,
      showEmployerCostToEmployee: form.showEmployerCostToEmployee,
      employerContributionTaxable: form.employerContributionTaxable,
      ...(canEditStart && form.effectiveFrom !== plan.effectiveFrom
        ? { effectiveFrom: form.effectiveFrom }
        : {}),
    };
    void mutate(() => benefitsApi.updatePlan(plan.id, input), 'Plan updated.', {
      onError: (message) => setError(message),
    }).then((ok) => ok && onClose());
  }

  return (
    <FormDialog
      open
      title={`Edit ${plan.name}`}
      description="The code, type and currency never change."
      submitLabel="Save plan"
      busy={busy}
      canSubmit={form.name.trim() !== '' && (!canEditStart || form.effectiveFrom !== '')}
      error={error}
      onSubmit={submit}
      onClose={onClose}
      size="lg"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            className={inputClass}
            required
            maxLength={200}
            value={form.name}
            onChange={(e) => set('name', e.currentTarget.value)}
          />
        </Field>
        {canEditStart ? (
          <Field label="Effective from" hint="Only a draft plan's start can move.">
            <input
              type="date"
              className={inputClass}
              required
              value={form.effectiveFrom}
              onChange={(e) => set('effectiveFrom', e.currentTarget.value)}
            />
          </Field>
        ) : (
          <p className="text-sm text-slate-600">
            Starts {coveragePeriod(plan.effectiveFrom, plan.effectiveTo)}; an active plan&apos;s
            dates change only by discontinuing it.
          </p>
        )}
        <Field label="Provider">
          <input
            className={inputClass}
            maxLength={200}
            value={form.providerName}
            onChange={(e) => set('providerName', e.currentTarget.value)}
          />
        </Field>
        <Field label="Provider reference">
          <input
            className={inputClass}
            maxLength={200}
            value={form.providerReference}
            onChange={(e) => set('providerReference', e.currentTarget.value)}
          />
        </Field>
        <Field label="Children covered up to age">
          <input
            type="number"
            min={0}
            max={99}
            className={inputClass}
            value={form.dependentChildMaxAge}
            onChange={(e) => set('dependentChildMaxAge', e.currentTarget.value)}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description">
            <textarea
              rows={2}
              maxLength={500}
              className={inputClass}
              value={form.description}
              onChange={(e) => set('description', e.currentTarget.value)}
            />
          </Field>
        </div>
        <CostFlags
          show={form.showEmployerCostToEmployee}
          taxable={form.employerContributionTaxable}
          onShow={(value) => set('showEmployerCostToEmployee', value)}
          onTaxable={(value) => set('employerContributionTaxable', value)}
        />
      </div>
    </FormDialog>
  );
}

function DiscontinueDialog({
  plan,
  busy,
  mutate,
  onClose,
}: {
  plan: BenefitPlanDetail;
  busy: boolean;
  mutate: Mutate;
  onClose(): void;
}) {
  const [effectiveTo, setEffectiveTo] = useState('');
  const [reason, setReason] = useState('');
  const [endElections, setEndElections] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      tone="destructive"
      title={`Discontinue ${plan.name}?`}
      description="The plan ends on the date you choose. Rates and eligibility rules stop with it. Finalized payroll is never changed."
      submitLabel="Discontinue plan"
      busy={busy}
      canSubmit={effectiveTo !== '' && reason.trim() !== ''}
      error={error}
      onSubmit={() =>
        void mutate(
          () =>
            benefitsApi.discontinuePlan(plan.id, {
              effectiveTo,
              endElections,
              reason: reason.trim(),
            }),
          'Plan discontinued.',
          { onError: (message) => setError(message) },
        ).then((ok) => ok && onClose())
      }
      onClose={onClose}
    >
      <Field label="Last day of the plan">
        <input
          type="date"
          className={inputClass}
          required
          min={plan.effectiveFrom}
          value={effectiveTo}
          onChange={(e) => setEffectiveTo(e.currentTarget.value)}
        />
      </Field>
      <Field label="Reason" hint="Kept with the elections it ends; never in the audit log.">
        <textarea
          rows={2}
          maxLength={2000}
          className={inputClass}
          required
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
      </Field>
      <label className="flex items-start gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          className={`${checkboxClass} mt-1`}
          checked={endElections}
          onChange={(e) => setEndElections(e.currentTarget.checked)}
        />
        <span>
          Also end every election that runs past that day
          <span className="block text-xs font-normal text-slate-600">
            Otherwise the plan is not discontinued while such elections remain.
          </span>
        </span>
      </label>
      {endElections && (
        <p
          role="note"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Employees&apos; coverage ends with the plan, and elections starting after that day are
          rescinded. Open payroll runs will need recalculating.
        </p>
      )}
    </FormDialog>
  );
}
