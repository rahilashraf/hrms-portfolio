'use client';

import { checkboxClass } from '../../ui/tokens';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ErrorBanner } from '../../organization/shared';
import { onboardingApi } from '../../../lib/onboarding/api';
import { DocumentHandoff } from '../../documents/document-handoff';
import { isOnboardingForbidden, onboardingErrorMessage } from '../../../lib/onboarding/errors';
import { recruitmentApi } from '../../../lib/recruitment/api';
import {
  possibleExistingEmployees,
  recruitmentErrorMessage,
} from '../../../lib/recruitment/errors';
import type {
  ApplicationDetail,
  HireResult,
  PossibleEmployeeMatch,
} from '../../../lib/recruitment/types';
import {
  dateTimeText,
  label,
  primaryButton,
  secondaryButton,
  Section,
} from '../recruitment-shared';
import { employeeSource, payGroupSource } from '../../../lib/pickers/sources';
import { RecordCombobox } from '../../ui/record-combobox';
import { AssignmentIdPicker } from '../../ui/assignment-id-picker';

// Batch 10E-1: hire conversion and the onboarding hand-off (moved from
// application-page.tsx unchanged).
export function HirePanel({
  application,
  hired,
  canStartOnboarding,
  canMoveDocuments = false,
  onHired,
}: {
  application: ApplicationDetail;
  hired: HireResult | null;
  canStartOnboarding: boolean;
  canMoveDocuments?: boolean;
  onHired(result: HireResult): Promise<void>;
}) {
  const payGroups = useMemo(
    () => payGroupSource(application.organization.id),
    [application.organization.id],
  );
  const employees = useMemo(
    () => employeeSource({ organizationId: application.organization.id }),
    [application.organization.id],
  );
  const [form, setForm] = useState({
    isPrimary: true,
    initializeCompensation: true,
    payGroupId: '',
    managerAssignmentId: '',
    existingEmployeeId: application.candidate.internalEmployee?.id ?? '',
    confirmNewPerson: false,
  });
  const [matches, setMatches] = useState<PossibleEmployeeMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hire = application.hire ?? null;

  async function convert(overrides: Partial<typeof form> = {}) {
    const values = { ...form, ...overrides };
    setForm(values);
    setBusy(true);
    setError(null);
    try {
      const result = await recruitmentApi.hire(application.id, {
        isPrimary: values.isPrimary,
        initializeCompensation: values.initializeCompensation,
        payGroupId: values.payGroupId.trim() || null,
        managerAssignmentId: values.managerAssignmentId.trim() || null,
        existingEmployeeId: values.existingEmployeeId.trim() || null,
        ...(values.confirmNewPerson ? { confirmNewPerson: true } : {}),
      });
      setMatches(null);
      await onHired(result);
    } catch (cause) {
      const found = possibleExistingEmployees(cause);
      if (found) {
        setMatches(found);
      } else {
        setError(recruitmentErrorMessage(cause, 'Unable to convert the candidate.'));
      }
    } finally {
      setBusy(false);
    }
  }

  if (hire || hired) {
    const employeeId = hired?.employeeId ?? hire!.employeeId;
    return (
      <Section id="hire" title="Hired">
        <p className="text-sm text-slate-800">
          {hired
            ? `Converted to employee ${hired.employeeNumber}${hired.createdEmployee ? ' (new employee record)' : ''}.`
            : `Converted to an employee on ${dateTimeText(hire!.convertedAt)}.`}
        </p>
        <Link
          href={`/admin/employees/${employeeId}`}
          className="text-sm font-medium text-indigo-700 underline"
        >
          Open employee record
        </Link>
        {canStartOnboarding && <StartOnboarding hireId={hired?.id ?? hire!.id} />}
        {canMoveDocuments && (
          <DocumentHandoff
            hireId={hired?.id ?? hire!.id}
            organizationId={application.organization.id}
            employeeId={employeeId}
            documents={application.documents}
          />
        )}
      </Section>
    );
  }

  return (
    <Section id="hire" title="Convert to employee">
      <p className="text-sm text-slate-600">
        Creates the employment from the accepted offer (and, for an external candidate, the person
        and employee record). Core HR&apos;s employee permissions apply.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {matches && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <p>
            An employee with this candidate&apos;s email may already exist. Choose that employee, or
            confirm that this is a new person.
          </p>
          <ul className="space-y-1">
            {matches.map((match) => (
              <li key={match.employeeId} className="flex flex-wrap items-center gap-2">
                <span>
                  Employee {match.employeeNumber} ({label(match.status)})
                </span>
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy}
                  onClick={() =>
                    void convert({ existingEmployeeId: match.employeeId, confirmNewPerson: false })
                  }
                >
                  Hire as employee {match.employeeNumber}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() => void convert({ existingEmployeeId: '', confirmNewPerson: true })}
          >
            Confirm new person
          </button>
        </div>
      )}
      <form
        aria-label="Convert to employee"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void convert();
        }}
      >
        <label className="inline-flex items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={form.isPrimary}
            onChange={(e) => setForm({ ...form, isPrimary: e.currentTarget.checked })}
          />
          Primary assignment
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={form.initializeCompensation}
            onChange={(e) => setForm({ ...form, initializeCompensation: e.currentTarget.checked })}
          />
          Start compensation from the offer
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={form.confirmNewPerson}
            onChange={(e) => setForm({ ...form, confirmNewPerson: e.currentTarget.checked })}
          />
          Confirm this is a new person
        </label>
        <RecordCombobox
          label="Pay group (optional)"
          source={payGroups}
          value={form.payGroupId}
          onChange={(payGroupId) => setForm({ ...form, payGroupId })}
          placeholder="Search pay groups"
          noResultsText="No matching pay groups."
          manualEntry={{ label: 'Pay group ID' }}
        />
        <AssignmentIdPicker
          label="Manager (optional)"
          hint="Search the manager, then choose their assignment."
          organizationId={application.organization.id}
          value={form.managerAssignmentId}
          onChange={(managerAssignmentId) => setForm({ ...form, managerAssignmentId })}
        />
        <RecordCombobox
          label="Existing employee (optional)"
          hint="Leave empty for a new person."
          source={employees}
          value={form.existingEmployeeId}
          selected={
            application.candidate.internalEmployee
              ? {
                  id: application.candidate.internalEmployee.id,
                  label: application.candidate.internalEmployee.displayName,
                  description: application.candidate.internalEmployee.employeeNumber,
                }
              : null
          }
          onChange={(existingEmployeeId) => setForm({ ...form, existingEmployeeId })}
          placeholder="Name or employee number"
          noResultsText="No matching employees you can read."
          manualEntry={{ label: 'Existing employee ID' }}
        />
        <div>
          <button type="submit" className={primaryButton} disabled={busy}>
            Convert to employee
          </button>
        </div>
      </form>
    </Section>
  );
}

/** The hand-off to Phase 14: starts (or opens, idempotently) the hire's onboarding. */
function StartOnboarding({ hireId }: { hireId: string }) {
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const result = await onboardingApi.startFromHire(hireId);
      setWorkflowId(result.id);
      setCreated(result.created);
    } catch (cause) {
      setError(
        isOnboardingForbidden(cause)
          ? 'You do not have permission to start onboarding for this hire.'
          : onboardingErrorMessage(cause, 'Unable to start onboarding.'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (workflowId) {
    return (
      <p role="status" className="text-sm text-slate-800">
        {created ? 'Onboarding started.' : 'Onboarding was already started for this hire.'}{' '}
        <Link
          href={`/onboarding/workflows/${workflowId}`}
          className="font-medium text-indigo-700 underline"
        >
          Open onboarding
        </Link>
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <button type="button" className={primaryButton} disabled={busy} onClick={() => void start()}>
        Start onboarding
      </button>
    </div>
  );
}
