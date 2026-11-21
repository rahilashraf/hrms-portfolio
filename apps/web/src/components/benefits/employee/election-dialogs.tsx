'use client';

import { checkboxClass } from '../../ui/tokens';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { benefitsApi } from '../../../lib/benefits/api';
import { benefitsErrorMessage } from '../../../lib/benefits/errors';
import { benefitOptionSource } from '../../../lib/benefits/pickers';
import type {
  Dependent,
  Election,
  EligibilityPlan,
  EmployeeBenefits,
} from '../../../lib/benefits/types';
import type { PickerOption } from '../../../lib/pickers/sources';
import type { RecordSource } from '../../../lib/pickers/use-record-search';
import { FormDialog } from '../../ui/form-dialog';
import { RecordCombobox } from '../../ui/record-combobox';
import { inputClass } from '../../ui/tokens';
import {
  dependentBlocker,
  Field,
  fieldLabel,
  fullName,
  hintText,
  levelFor,
  needsOverride,
  nextDay,
  RELATIONSHIP_LABELS,
  saveErrorMessage,
} from './shared';

/**
 * Batch 7C — the election dialogs (change, transfer, correct, end, rescind, remove a dependent,
 * record). Each one is a focus-managed FormDialog that keeps its own busy state and shows the
 * API's refusal inside the dialog, explained (an eligibility override, later coverage, history
 * to be corrected). The section re-reads everything once a save succeeds.
 */

export interface DialogProps {
  election: Election;
  data: EmployeeBenefits;
  dependents: Dependent[];
  onClose(): void;
  onDone(message: string): Promise<void>;
}

/** Busy state and an explained error around one save. */
function useSave(elections: readonly Election[]) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideNeeded, setOverrideNeeded] = useState(false);
  const save = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (cause) {
        if (needsOverride(cause)) setOverrideNeeded(true);
        setError(saveErrorMessage(cause, elections));
      } finally {
        setBusy(false);
      }
    },
    [elections],
  );
  return { busy, error, setError, overrideNeeded, save };
}

/** The plan's options and eligibility through a sponsoring assignment. */
function usePlanEligibility(assignmentId: string, planId: string) {
  const [plan, setPlan] = useState<EligibilityPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(assignmentId));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!assignmentId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      benefitsApi
        .assignmentEligibility(assignmentId)
        .then((result) => {
          if (!active) return;
          setPlan(result.plans.find((row) => row.planId === planId) ?? null);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setPlan(null);
          setError(benefitsErrorMessage(cause, 'Unable to load the plan’s options.'));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [assignmentId, planId, attempt]);
  return { plan, error, loading, retry: () => setAttempt((n) => n + 1) };
}

function LoadProblem({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {message}{' '}
      <button type="button" className="font-medium underline" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function OverrideField({
  value,
  onChange,
  reason,
}: {
  value: string;
  onChange(value: string): void;
  reason: string;
}) {
  return (
    <Field
      label="Eligibility override reason (required)"
      hint={`${reason} A fresh reason is needed; an earlier override is never reused.`}
    >
      <textarea
        required
        rows={2}
        maxLength={2000}
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

/**
 * Covered dependents as checkboxes: the employee's current dependents, plus anyone the election
 * covers now (even archived or no longer eligible) so they can always be removed. Someone who
 * cannot be covered on the date can be unchecked but not newly added.
 */
function DependentChecklist({
  dependents,
  covered,
  selected,
  date,
  onChange,
}: {
  dependents: Dependent[];
  covered: Election['dependents'];
  selected: string[];
  date: string;
  onChange(ids: string[]): void;
}) {
  const byId = new Map(dependents.map((dependent) => [dependent.id, dependent]));
  const rows = [
    ...covered.map((link) => ({
      id: link.id,
      name: fullName(link),
      relationship: link.relationship,
    })),
    ...dependents
      .filter(
        (dependent) => !dependent.archived && !covered.some((link) => link.id === dependent.id),
      )
      .map((dependent) => ({
        id: dependent.id,
        name: fullName(dependent),
        relationship: dependent.relationship,
      })),
  ];
  if (rows.length === 0)
    return <p className="text-sm text-slate-600">No dependents are recorded for this employee.</p>;
  return (
    <fieldset className="space-y-1 text-sm text-slate-800">
      <legend className={fieldLabel}>Covered dependents</legend>
      {rows.map((row) => {
        const checked = selected.includes(row.id);
        const blocker = dependentBlocker(byId.get(row.id), date);
        return (
          <label key={row.id} className="flex items-start gap-2">
            <input
              type="checkbox"
              className={`${checkboxClass} mt-1`}
              checked={checked}
              disabled={!checked && blocker !== null}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                onChange(next ? [...selected, row.id] : selected.filter((id) => id !== row.id));
              }}
            />
            <span>
              {row.name} ({RELATIONSHIP_LABELS[row.relationship]})
              {blocker && (
                <span className="block text-xs text-amber-800">
                  Cannot be covered: {blocker}
                  {checked ? ' — uncheck to remove' : ''}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function OptionSelect({
  plan,
  election,
  value,
  onChange,
  allowWaive = false,
}: {
  plan: EligibilityPlan | null;
  election: Election;
  value: string;
  onChange(value: string): void;
  allowWaive?: boolean;
}) {
  const options = plan?.options ?? (election.option ? [election.option] : []);
  return (
    <Field label="Coverage option">
      <select
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {allowWaive && <option value="">Waived (no coverage)</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

// ─── Change coverage ────────────────────────────────────────────────────────

export function ChangeDialog({ election, data, dependents, onClose, onDone }: DialogProps) {
  const {
    plan,
    error: loadError,
    retry,
  } = usePlanEligibility(election.sponsoringAssignment.id, election.plan.id);
  const { busy, error, overrideNeeded, save } = useSave(data.items);
  const [date, setDate] = useState('');
  const [optionId, setOptionId] = useState(election.option?.id ?? '');
  const [dependentIds, setDependentIds] = useState(election.dependents.map((d) => d.id));
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const ineligible = plan ? !plan.eligibility.eligible : false;
  const askOverride = ineligible || overrideNeeded;
  return (
    <FormDialog
      open
      size="lg"
      title={`Change ${election.plan.name} coverage`}
      description="Coverage changes from the date; the current coverage ends the day before."
      submitLabel="Change coverage"
      busy={busy}
      canSubmit={Boolean(date && optionId) && (!askOverride || override.trim() !== '')}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void save(async () => {
          await benefitsApi.change(election.id, {
            effectiveDate: date,
            optionId,
            dependentIds,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(askOverride && override.trim()
              ? { eligibilityOverrideReason: override.trim() }
              : {}),
          });
          await onDone('Coverage changed.');
        })
      }
    >
      {loadError && <LoadProblem message={loadError} onRetry={retry} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Effective from">
          <input
            required
            type="date"
            className={inputClass}
            value={date}
            onChange={(event) => setDate(event.currentTarget.value)}
          />
        </Field>
        <OptionSelect plan={plan} election={election} value={optionId} onChange={setOptionId} />
      </div>
      <DependentChecklist
        dependents={dependents}
        covered={election.dependents}
        selected={dependentIds}
        date={date}
        onChange={setDependentIds}
      />
      <Field label="Reason (optional)">
        <input
          className={inputClass}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </Field>
      {askOverride && (
        <OverrideField
          value={override}
          onChange={setOverride}
          reason="The sponsoring assignment is not eligible for this plan on that date."
        />
      )}
    </FormDialog>
  );
}

// ─── Remove a dependent (divorce, loss of eligibility) ─────────────────────

export function RemoveDependentDialog({
  election,
  data,
  dependents,
  onClose,
  onDone,
}: DialogProps) {
  const {
    plan,
    error: loadError,
    retry,
  } = usePlanEligibility(election.sponsoringAssignment.id, election.plan.id);
  const { busy, error, overrideNeeded, save } = useSave(data.items);
  const [dependentId, setDependentId] = useState(election.dependents[0]?.id ?? '');
  const record = dependents.find((d) => d.id === dependentId);
  const [recordEnd, setRecordEnd] = useState(Boolean(record && !record.relationshipEndDate));
  const [endDate, setEndDate] = useState(record?.relationshipEndDate ?? '');
  const [date, setDate] = useState(
    record?.relationshipEndDate ? nextDay(record.relationshipEndDate) : '',
  );
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const [optionChoice, setOptionChoice] = useState('');
  const remaining = election.dependents.filter((link) => link.id !== dependentId);
  const suggested = useMemo(() => {
    const level = levelFor(remaining.map((link) => link.relationship));
    return plan?.options.find((option) => option.coverageLevel === level)?.id ?? '';
  }, [plan, remaining]);
  const optionId = optionChoice || suggested || election.option?.id || '';
  const canRecord = record?.canManage !== false && record !== undefined && !record.archived;
  const askOverride = (plan ? !plan.eligibility.eligible : false) || overrideNeeded;

  return (
    <FormDialog
      open
      size="lg"
      title={`Remove a dependent from ${election.plan.name}`}
      description="For a divorce or a dependent who is no longer eligible: record the relationship end, then the coverage continues without them from the next day."
      submitLabel="Remove from coverage"
      busy={busy}
      canSubmit={
        Boolean(dependentId && date && optionId) &&
        (!recordEnd || endDate !== '') &&
        (!askOverride || override.trim() !== '')
      }
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void save(async () => {
          if (recordEnd && canRecord && endDate !== (record?.relationshipEndDate ?? '')) {
            await benefitsApi.updateDependent(dependentId, { relationshipEndDate: endDate });
          }
          await benefitsApi.change(election.id, {
            effectiveDate: date,
            optionId,
            dependentIds: remaining.map((link) => link.id),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(askOverride && override.trim()
              ? { eligibilityOverrideReason: override.trim() }
              : {}),
          });
          await onDone('Dependent removed from coverage.');
        })
      }
    >
      {loadError && <LoadProblem message={loadError} onRetry={retry} />}
      <Field label="Dependent">
        <select
          className={inputClass}
          value={dependentId}
          onChange={(event) => {
            const id = event.currentTarget.value;
            const next = dependents.find((d) => d.id === id);
            setDependentId(id);
            setRecordEnd(Boolean(next && !next.relationshipEndDate));
            setEndDate(next?.relationshipEndDate ?? '');
            setDate(next?.relationshipEndDate ? nextDay(next.relationshipEndDate) : '');
          }}
        >
          {election.dependents.map((link) => (
            <option key={link.id} value={link.id}>
              {fullName(link)} ({RELATIONSHIP_LABELS[link.relationship]})
            </option>
          ))}
        </select>
      </Field>
      {canRecord ? (
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={recordEnd}
            onChange={(event) => setRecordEnd(event.currentTarget.checked)}
          />
          Record the end of the relationship (for example a divorce)
        </label>
      ) : (
        <p className={hintText}>
          The relationship dates of this dependent are maintained by another administrator.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {recordEnd && canRecord && (
          <Field label="Relationship ended on">
            <input
              required
              type="date"
              className={inputClass}
              value={endDate}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setEndDate(value);
                if (value) setDate(nextDay(value));
              }}
            />
          </Field>
        )}
        <Field
          label="Coverage without them from"
          hint="Usually the day after the relationship ended."
        >
          <input
            required
            type="date"
            className={inputClass}
            value={date}
            onChange={(event) => setDate(event.currentTarget.value)}
          />
        </Field>
        <OptionSelect plan={plan} election={election} value={optionId} onChange={setOptionChoice} />
      </div>
      <p className={hintText}>
        Remaining covered:{' '}
        {remaining.length === 0 ? 'the employee only' : remaining.map(fullName).join(', ')}.
      </p>
      <Field label="Reason (optional)">
        <input
          className={inputClass}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </Field>
      {askOverride && (
        <OverrideField
          value={override}
          onChange={setOverride}
          reason="The sponsoring assignment is not eligible for this plan on that date."
        />
      )}
    </FormDialog>
  );
}

// ─── Transfer sponsorship ───────────────────────────────────────────────────

/** The employee's other assignments, through Benefits' own picker (no employee.read). */
function transferSource(
  organizationId: string,
  employeeId: string,
  currentId: string,
): RecordSource<PickerOption> {
  const source = benefitOptionSource(organizationId, 'assignment', { employeeId });
  return {
    async search(query, cursor) {
      const page = await source.search(query, cursor);
      return { ...page, items: page.items.filter((item) => item.id !== currentId) };
    },
  };
}

export function TransferDialog({ election, data, onClose, onDone }: DialogProps) {
  const organizationId =
    data.sponsoringAssignments.find((row) => row.id === election.sponsoringAssignment.id)
      ?.organizationId ??
    data.sponsoringAssignments[0]?.organizationId ??
    '';
  const source = useMemo(
    () => transferSource(organizationId, data.employeeId, election.sponsoringAssignment.id),
    [organizationId, data.employeeId, election.sponsoringAssignment.id],
  );
  const { busy, error, overrideNeeded, save } = useSave(data.items);
  const [assignmentId, setAssignmentId] = useState('');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const { plan: target } = usePlanEligibility(assignmentId, election.plan.id);
  const askOverride =
    (assignmentId && target ? !target.eligibility.eligible : false) || overrideNeeded;
  return (
    <FormDialog
      open
      title={`Move ${election.plan.name} to another assignment`}
      description={`Coverage continues unchanged from the date, sponsored by another of the employee’s assignments. Currently: ${election.sponsoringAssignment.positionName}.`}
      submitLabel="Move sponsorship"
      busy={busy}
      canSubmit={Boolean(assignmentId && date) && (!askOverride || override.trim() !== '')}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void save(async () => {
          await benefitsApi.transfer(election.id, {
            employmentAssignmentId: assignmentId,
            effectiveDate: date,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(askOverride && override.trim()
              ? { eligibilityOverrideReason: override.trim() }
              : {}),
          });
          await onDone('Sponsorship moved.');
        })
      }
    >
      <RecordCombobox
        label="New sponsoring assignment"
        required
        source={source}
        value={assignmentId}
        onChange={(id) => setAssignmentId(id)}
        noResultsText="No other assignment of this employee is within your benefits access."
      />
      <Field label="Effective from">
        <input
          required
          type="date"
          className={inputClass}
          value={date}
          onChange={(event) => setDate(event.currentTarget.value)}
        />
      </Field>
      <Field label="Reason (optional)">
        <input
          className={inputClass}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </Field>
      {askOverride && (
        <OverrideField
          value={override}
          onChange={setOverride}
          reason="The new assignment is not eligible for this plan on that date."
        />
      )}
    </FormDialog>
  );
}

// ─── Correct ───────────────────────────────────────────────────────────────

export function CorrectDialog({ election, data, dependents, onClose, onDone }: DialogProps) {
  const organizationId =
    data.sponsoringAssignments.find((row) => row.id === election.sponsoringAssignment.id)
      ?.organizationId ??
    data.sponsoringAssignments[0]?.organizationId ??
    '';
  const source = useMemo(
    () => benefitOptionSource(organizationId, 'assignment', { employeeId: data.employeeId }),
    [organizationId, data.employeeId],
  );
  const {
    plan,
    error: loadError,
    retry,
  } = usePlanEligibility(election.sponsoringAssignment.id, election.plan.id);
  const { busy, error, overrideNeeded, save } = useSave(data.items);
  const [reason, setReason] = useState('');
  const [optionId, setOptionId] = useState(election.option?.id ?? '');
  const [dependentIds, setDependentIds] = useState(election.dependents.map((d) => d.id));
  const [start, setStart] = useState(election.coverageStart);
  const [end, setEnd] = useState(election.coverageEnd ?? '');
  const [electedOn, setElectedOn] = useState(election.electedOn);
  const [sponsorId, setSponsorId] = useState(election.sponsoringAssignment.id);
  const [override, setOverride] = useState('');
  const askOverride =
    overrideNeeded ||
    (plan ? !plan.eligibility.eligible && sponsorId === election.sponsoringAssignment.id : false);
  const waived = election.electionType === 'WAIVED';
  const sameDependents =
    dependentIds.length === election.dependents.length &&
    election.dependents.every((link) => dependentIds.includes(link.id));
  return (
    <FormDialog
      open
      size="lg"
      title={`Correct ${election.plan.name} election`}
      description="Fixes a mis-recorded election: it is replaced by a correction and stays readable as history. Finalized payroll is never changed; differences show in payroll as retroactive differences."
      submitLabel="Save correction"
      busy={busy}
      canSubmit={reason.trim() !== '' && Boolean(start) && (!askOverride || override.trim() !== '')}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void save(async () => {
          const input: Parameters<typeof benefitsApi.correct>[1] = { reason: reason.trim() };
          if (optionId !== (election.option?.id ?? '')) input.optionId = optionId || null;
          if (optionId && !sameDependents) input.dependentIds = dependentIds;
          if (start !== election.coverageStart) input.coverageStart = start;
          if ((end || null) !== election.coverageEnd) input.coverageEnd = end || null;
          if (electedOn !== election.electedOn) input.electedOn = electedOn;
          if (sponsorId !== election.sponsoringAssignment.id)
            input.employmentAssignmentId = sponsorId;
          if (askOverride && override.trim()) input.eligibilityOverrideReason = override.trim();
          await benefitsApi.correct(election.id, input);
          await onDone('Election corrected.');
        })
      }
    >
      {loadError && <LoadProblem message={loadError} onRetry={retry} />}
      <Field label="Reason for the correction (required)">
        <textarea
          required
          rows={2}
          maxLength={2000}
          className={inputClass}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Coverage start">
          <input
            required
            type="date"
            className={inputClass}
            value={start}
            onChange={(event) => setStart(event.currentTarget.value)}
          />
        </Field>
        <Field label="Coverage end (optional)">
          <input
            type="date"
            className={inputClass}
            value={end}
            onChange={(event) => setEnd(event.currentTarget.value)}
          />
        </Field>
        <Field label="Elected on">
          <input
            type="date"
            className={inputClass}
            value={electedOn}
            onChange={(event) => setElectedOn(event.currentTarget.value)}
          />
        </Field>
      </div>
      <OptionSelect
        plan={plan}
        election={election}
        value={optionId}
        onChange={setOptionId}
        allowWaive={waived}
      />
      {optionId && (
        <DependentChecklist
          dependents={dependents}
          covered={election.dependents}
          selected={dependentIds}
          date={start}
          onChange={setDependentIds}
        />
      )}
      <RecordCombobox
        label="Sponsoring assignment"
        source={source}
        value={sponsorId}
        selected={{
          id: election.sponsoringAssignment.id,
          label: election.sponsoringAssignment.positionName,
        }}
        onChange={(id) => setSponsorId(id || election.sponsoringAssignment.id)}
      />
      {askOverride && (
        <OverrideField
          value={override}
          onChange={setOverride}
          reason="The assignment is not eligible for this plan on the coverage start."
        />
      )}
    </FormDialog>
  );
}

// ─── End and rescind ───────────────────────────────────────────────────────

export function EndDialog({ election, data, onClose, onDone }: DialogProps) {
  const { busy, error, save } = useSave(data.items);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      tone="destructive"
      title={`End ${election.plan.name} coverage?`}
      description="Coverage stops after the last day; it can only be ended earlier later, never extended (that is a correction). A later election continuing this plan is never ended silently."
      submitLabel="End coverage"
      busy={busy}
      canSubmit={date !== ''}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void save(async () => {
          await benefitsApi.end(election.id, {
            coverageEnd: date,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          });
          await onDone('Coverage ended.');
        })
      }
    >
      <Field label="Last day of coverage">
        <input
          required
          type="date"
          className={inputClass}
          value={date}
          onChange={(event) => setDate(event.currentTarget.value)}
        />
      </Field>
      <Field
        label="Reason (optional)"
        hint="An HR note kept on the election for benefits administrators — never shown to the employee or written to the audit log."
      >
        <textarea
          rows={2}
          maxLength={2000}
          className={inputClass}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </Field>
    </FormDialog>
  );
}

export function RescindDialog({ election, data, onClose, onDone }: DialogProps) {
  const { busy, error, save } = useSave(data.items);
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      tone="destructive"
      title={`Rescind ${election.plan.name} election?`}
      description="The election is withdrawn entirely, as if it was never made; it stays readable as history. Use this only for an election recorded by mistake."
      submitLabel="Rescind election"
      busy={busy}
      canSubmit={reason.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void save(async () => {
          await benefitsApi.rescind(election.id, reason.trim());
          await onDone('Election rescinded.');
        })
      }
    >
      <Field label="Reason (required)">
        <textarea
          required
          rows={2}
          maxLength={2000}
          className={inputClass}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </Field>
    </FormDialog>
  );
}

// ─── Record an election ─────────────────────────────────────────────────────

export function EnrollDialog({ data, dependents, onClose, onDone }: Omit<DialogProps, 'election'>) {
  const [assignmentId, setAssignmentId] = useState(data.sponsoringAssignments[0]?.id ?? '');
  const [plans, setPlans] = useState<EligibilityPlan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [planId, setPlanId] = useState('');
  const [optionId, setOptionId] = useState('');
  const [dependentIds, setDependentIds] = useState<string[]>([]);
  const [coverageStart, setCoverageStart] = useState('');
  const [override, setOverride] = useState('');
  const [waive, setWaive] = useState(false);
  const { busy, error, overrideNeeded, save } = useSave(data.items);

  useEffect(() => {
    if (!assignmentId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setPlans(null);
      benefitsApi
        .assignmentEligibility(assignmentId)
        .then((result) => {
          if (!active) return;
          const accepting = result.plans.filter((plan) => plan.status === 'ACTIVE');
          setPlans(accepting);
          setLoadError(null);
          setPlanId(accepting[0]?.planId ?? '');
          setOptionId(accepting[0]?.options[0]?.id ?? '');
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setPlans([]);
          setLoadError(
            benefitsErrorMessage(cause, 'Unable to load the plans for this assignment.'),
          );
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [assignmentId, attempt]);

  const plan = plans?.find((p) => p.planId === planId);
  const askOverride = (plan ? !plan.eligibility.eligible : false) || overrideNeeded;
  return (
    <FormDialog
      open
      size="lg"
      title="Record election"
      submitLabel={waive ? 'Record waiver' : 'Enroll'}
      busy={busy}
      canSubmit={
        Boolean(planId && coverageStart) &&
        (waive || Boolean(optionId)) &&
        (!askOverride || override.trim() !== '')
      }
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void save(async () => {
          const base = {
            employmentAssignmentId: assignmentId,
            planId,
            coverageStart,
            ...(askOverride && override.trim()
              ? { eligibilityOverrideReason: override.trim() }
              : {}),
          };
          if (waive) await benefitsApi.waive(base);
          else await benefitsApi.enroll({ ...base, optionId, dependentIds });
          await onDone(waive ? 'Waiver recorded.' : 'Enrollment recorded.');
        })
      }
    >
      {data.sponsoringAssignments.length === 0 ? (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          None of this employee’s assignments can sponsor benefits within your access.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Sponsoring assignment">
            <select
              className={inputClass}
              value={assignmentId}
              onChange={(event) => setAssignmentId(event.currentTarget.value)}
            >
              {data.sponsoringAssignments.map((assignment) => (
                <option key={assignment.id} value={assignment.id}>
                  {assignment.positionName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Plan">
            <select
              className={inputClass}
              value={planId}
              disabled={!plans || plans.length === 0}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setPlanId(value);
                setOptionId(plans?.find((p) => p.planId === value)?.options[0]?.id ?? '');
              }}
            >
              {(plans ?? []).map((p) => (
                <option key={p.planId} value={p.planId}>
                  {p.name}
                  {p.eligibility.eligible ? '' : ' (not eligible)'}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {loadError ? (
        <LoadProblem message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
      ) : plans === null && assignmentId ? (
        <p role="status" className="text-sm text-slate-600">
          Loading plans…
        </p>
      ) : plans?.length === 0 && assignmentId ? (
        <p className="text-sm text-slate-600">No active plan is offered through this assignment.</p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Coverage starts">
          <input
            required
            type="date"
            className={inputClass}
            value={coverageStart}
            onChange={(event) => setCoverageStart(event.currentTarget.value)}
          />
        </Field>
        {!waive && (
          <Field label="Coverage option">
            <select
              className={inputClass}
              value={optionId}
              onChange={(event) => setOptionId(event.currentTarget.value)}
            >
              {(plan?.options ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          className={checkboxClass}
          checked={waive}
          onChange={(event) => setWaive(event.currentTarget.checked)}
        />
        Employee waives this plan
      </label>
      {!waive && (
        <DependentChecklist
          dependents={dependents}
          covered={[]}
          selected={dependentIds}
          date={coverageStart}
          onChange={setDependentIds}
        />
      )}
      {askOverride && (
        <OverrideField
          value={override}
          onChange={setOverride}
          reason="The assignment is not eligible for this plan on the coverage start."
        />
      )}
    </FormDialog>
  );
}
